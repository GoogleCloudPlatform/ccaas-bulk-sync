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
 * Runs one sync end to end: lock (live runs), sync, run-history record and
 * structured log. Used inline by the web service (simulations, or live syncs
 * when no Cloud Run Job is configured) and by the Cloud Run Job (job.js).
 *
 * Returns { status, body } for an HTTP-style response.
 */

const syncLogic = require('./sync-logic');
const runHistory = require('./run-history');
const { acquireSyncLock, SyncInProgressError } = require('./sync-lock');
const { SyncSafetyError } = require('./sync-plan');

async function executeSync({ firestore, getHydratedConfig, trigger, startedBy, simulate, allowLargeDeactivation, runId = null, leaseMs, deps = {} }) {
    const startedAt = Date.now();
    const runSync = deps.runSync || syncLogic.runSync;
    let lock = null;

    const finish = async (fields) => {
        const record = runHistory.buildRunRecord({ startedAt, finishedAt: Date.now(), trigger, startedBy, simulate, ...fields });
        runHistory.logRun(record);
        await runHistory.recordRun(firestore, record, runId);
        return record;
    };

    try {
        const config = await getHydratedConfig();
        if (!config) {
            await finish({ outcome: 'error', error: new Error('Configuration must be saved before running a sync.') });
            return { status: 400, body: 'Configuration must be saved before running a sync.' };
        }
        if (!simulate) {
            lock = await acquireSyncLock(firestore, leaseMs ? { startedBy, leaseMs } : { startedBy });
        }
        console.log('Sync requested by %s (trigger=%s, simulate=%s, allowLargeDeactivation=%s).', startedBy, trigger, simulate, allowLargeDeactivation);
        const result = await runSync(config, { simulate, allowLargeDeactivation });
        await finish({ result });
        return { status: 200, body: result };
    } catch (error) {
        if (error instanceof SyncInProgressError) {
            await finish({ outcome: 'in_progress', error });
            return { status: 409, body: error.message };
        }
        if (error instanceof SyncSafetyError) {
            await finish({ outcome: 'blocked', error, extra: { blockedReason: error.details.reason || null } });
            return { status: 422, body: { blocked: true, reason: error.details.reason, message: error.message, ...error.details } };
        }
        if (error instanceof syncLogic.GroupNotFoundError) {
            await finish({ outcome: 'group_not_found', error });
            return { status: 422, body: error.message };
        }
        console.error('Error during sync:', error);
        await finish({ outcome: 'error', error });
        return { status: 500, body: `Error during sync: ${error.message}` };
    } finally {
        if (lock) await lock.release();
    }
}

module.exports = { executeSync };
