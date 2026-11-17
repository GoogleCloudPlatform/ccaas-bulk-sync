/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A Firestore lease that makes sure only one live sync runs at a time, so
 * "Run Now", the scheduler and any retries can't submit duplicate jobs.
 * The lease expires on its own, so a crashed instance can't block syncs forever.
 */

const crypto = require('crypto');

const DEFAULT_LEASE_MS = 20 * 60 * 1000;

class SyncInProgressError extends Error {
    constructor(lease) {
        super(`Another sync is already running (started ${lease.startedAt} by ${lease.startedBy}).`);
        this.name = 'SyncInProgressError';
        this.lease = lease;
    }
}

/**
 * @param {import('@google-cloud/firestore').Firestore} firestore
 * @param {object} [options]
 * @param {string} [options.startedBy]
 * @param {number} [options.leaseMs]
 * @return {Promise<{release: function(): Promise<void>}>}
 */
async function acquireSyncLock(firestore, { startedBy = 'unknown', leaseMs = DEFAULT_LEASE_MS } = {}) {
    const ref = firestore.collection('ccaas-sync-lock').doc('sync');
    const holder = crypto.randomUUID();

    await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const now = Date.now();
        if (snap.exists) {
            const lease = snap.data();
            if (lease.expiresAtMs > now) {
                throw new SyncInProgressError(lease);
            }
        }
        tx.set(ref, {
            holder,
            startedBy,
            startedAt: new Date(now).toISOString(),
            expiresAtMs: now + leaseMs,
        });
    });

    return {
        release: async () => {
            try {
                await firestore.runTransaction(async (tx) => {
                    const snap = await tx.get(ref);
                    if (snap.exists && snap.data().holder === holder) {
                        tx.delete(ref);
                    }
                });
            } catch (error) {
                console.error('Failed to release sync lock (it will expire on its own):', error.message);
            }
        },
    };
}

/** True if a live sync currently holds an unexpired lease (read-only check). */
async function isSyncLocked(firestore) {
    const snap = await firestore.collection('ccaas-sync-lock').doc('sync').get();
    return snap.exists && snap.data().expiresAtMs > Date.now();
}

module.exports = { acquireSyncLock, isSyncLocked, SyncInProgressError, DEFAULT_LEASE_MS };
