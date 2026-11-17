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

const test = require('node:test');
const assert = require('node:assert');
const { executeSync } = require('../sync-runner');
const { launchSyncJob } = require('../job-launcher');
const runHistory = require('../run-history');
const { isSyncLocked, acquireSyncLock } = require('../sync-lock');
const { SyncSafetyError } = require('../sync-plan');

/** In-memory Firestore: collections of docs, auto IDs, set with merge, transactions. */
function fakeFirestore() {
    const store = new Map();
    let n = 0;
    const docRef = (col, id) => ({
        id,
        get: async () => ({ id, exists: store.has(`${col}/${id}`), data: () => store.get(`${col}/${id}`) }),
        set: async (data, opts) => { const k = `${col}/${id}`; store.set(k, opts?.merge ? { ...(store.get(k) || {}), ...data } : data); },
        delete: async () => store.delete(`${col}/${id}`),
    });
    const fs = {
        store,
        collection: (col) => ({
            doc: (id) => docRef(col, id || `auto${++n}`),
            add: async (data) => { const id = `auto${++n}`; store.set(`${col}/${id}`, data); return { id }; },
            orderBy: () => ({ offset: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }), limit: () => ({ get: async () => ({ docs: [] }) }) }),
        }),
        runTransaction: async (fn) => fn({
            get: (ref) => ref.get(),
            set: (ref, v) => { store.set(`ccaas-sync-lock/${ref.id}`, v); },
            delete: (ref) => { store.delete(`ccaas-sync-lock/${ref.id}`); },
        }),
    };
    return fs;
}

const quiet = (fn) => async (...a) => { const log = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = log; } };

test('executeSync records the final result into the queued run document', quiet(async () => {
    const fs = fakeFirestore();
    const runId = await runHistory.createQueuedRun(fs, { trigger: 'manual', startedBy: 'a@x.com' });
    assert.strictEqual((await runHistory.getRun(fs, runId)).outcome, 'queued');
    await runHistory.markRunning(fs, runId);
    assert.strictEqual((await runHistory.getRun(fs, runId)).outcome, 'running');
    const result = { outcome: 'job_finished', message: 'Sync job 9 finished', counts: { add: 0, update: 1, deactivate: 0, skipped: 0 }, jobId: 9, warnings: [] };
    const out = await executeSync({ firestore: fs, getHydratedConfig: async () => ({}), trigger: 'manual', startedBy: 'a@x.com', simulate: false, runId, deps: { runSync: async () => result } });
    assert.strictEqual(out.status, 200);
    const run = await runHistory.getRun(fs, runId);
    assert.strictEqual(run.outcome, 'job_finished');
    assert.strictEqual(run.jobId, 9);
    assert.strictEqual(await isSyncLocked(fs), false, 'lock released');
}));

test('executeSync maps safety blocks to 422 and records blockedReason', quiet(async () => {
    const fs = fakeFirestore();
    const out = await executeSync({ firestore: fs, getHydratedConfig: async () => ({}), trigger: 'scheduled', simulate: false, runId: 'r1',
        deps: { runSync: async () => { throw new SyncSafetyError('too many', { reason: 'deactivation_limit', deactivations: 30, limit: 25 }); } } });
    assert.strictEqual(out.status, 422);
    const run = await runHistory.getRun(fs, 'r1');
    assert.strictEqual(run.outcome, 'blocked');
    assert.strictEqual(run.blockedReason, 'deactivation_limit');
}));

test('executeSync reports in_progress when another live sync holds the lock', quiet(async () => {
    const fs = fakeFirestore();
    await acquireSyncLock(fs, { startedBy: 'other' });
    assert.strictEqual(await isSyncLocked(fs), true);
    const out = await executeSync({ firestore: fs, getHydratedConfig: async () => ({}), trigger: 'manual', simulate: false, runId: 'r2', deps: { runSync: async () => ({}) } });
    assert.strictEqual(out.status, 409);
    assert.strictEqual((await runHistory.getRun(fs, 'r2')).outcome, 'in_progress');
}));

test('launchSyncJob calls jobs:run with run metadata as env overrides', async () => {
    let req;
    const auth = { getClient: async () => ({ request: async (r) => { req = r; return { data: { name: 'operations/1' } }; } }) };
    await launchSyncJob({ jobName: 'ccaas-sync-service-sync', region: 'us-central1', runId: 'abc', trigger: 'manual', startedBy: 'a@x.com', allowLargeDeactivation: true }, { auth, projectId: 'p1' });
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, 'https://run.googleapis.com/v2/projects/p1/locations/us-central1/jobs/ccaas-sync-service-sync:run');
    const env = Object.fromEntries(req.data.overrides.containerOverrides[0].env.map(e => [e.name, e.value]));
    assert.deepStrictEqual(env, { SYNC_RUN_ID: 'abc', SYNC_TRIGGER: 'manual', SYNC_STARTED_BY: 'a@x.com', SYNC_ALLOW_LARGE_DEACTIVATION: 'true' });
});
