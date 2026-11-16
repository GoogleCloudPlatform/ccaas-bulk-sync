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
const { buildRunRecord, logRun, recordRun, listRuns, severityFor } = require('../run-history');

function fakeFirestore() {
    const docs = [];
    let id = 0;
    const query = (offset = 0, limit = Infinity) => ({
        offset: (n) => query(n, limit),
        limit: (n) => query(offset, n),
        get: async () => {
            const sorted = [...docs].sort((a, b) => b.data.startedAt.localeCompare(a.data.startedAt));
            const page = sorted.slice(offset, offset + limit);
            return { docs: page.map(d => ({ id: d.id, data: () => d.data, ref: { delete: async () => docs.splice(docs.indexOf(d), 1) } })) };
        },
    });
    return {
        docs,
        collection: () => ({
            add: async (data) => { docs.push({ id: `r${++id}`, data }); },
            orderBy: () => query(),
        }),
    };
}

const T0 = Date.parse('2026-11-16T10:00:00Z');

test('buildRunRecord: successful run has counts and outcome, but no user emails', () => {
    const result = { outcome: 'job_finished', message: 'Sync job 7 finished', counts: { add: 1, update: 2, deactivate: 0 }, jobId: '7', warnings: ['w'], preview: { add: ['secret@x.com'] } };
    const r = buildRunRecord({ startedAt: T0, finishedAt: T0 + 1500, trigger: 'scheduled', startedBy: 'sa@x', simulate: false, result });
    assert.deepStrictEqual(r.counts, { add: 1, update: 2, deactivate: 0 });
    assert.strictEqual(r.outcome, 'job_finished');
    assert.strictEqual(r.durationMs, 1500);
    assert.strictEqual(r.warningsCount, 1);
    assert.ok(!JSON.stringify(r).includes('secret@x.com'));
});

test('buildRunRecord: failed run records the error message and outcome', () => {
    const r = buildRunRecord({ startedAt: T0, finishedAt: T0, trigger: 'manual', startedBy: 'a@x', simulate: false, outcome: 'blocked', error: new Error('would deactivate 30') });
    assert.strictEqual(r.outcome, 'blocked');
    assert.match(r.message, /would deactivate 30/);
});

test('severityFor and logRun emit structured JSON for Cloud Logging', () => {
    assert.strictEqual(severityFor('job_finished'), 'INFO');
    assert.strictEqual(severityFor('blocked'), 'WARNING');
    assert.strictEqual(severityFor('job_failed'), 'ERROR');
    let line;
    logRun(buildRunRecord({ startedAt: T0, finishedAt: T0, trigger: 'scheduled', simulate: false, outcome: 'error', error: new Error('boom') }), (l) => { line = l; });
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.severity, 'ERROR');
    assert.strictEqual(parsed.event, 'sync_run');
    assert.strictEqual(parsed.outcome, 'error');
});

test('recordRun keeps the newest 200 runs; listRuns returns newest first with a clamped limit', async () => {
    const fs = fakeFirestore();
    for (let i = 0; i < 205; i++) {
        await recordRun(fs, buildRunRecord({ startedAt: T0 + i * 1000, finishedAt: T0 + i * 1000, trigger: 'scheduled', simulate: false, outcome: 'no_changes' }));
    }
    assert.strictEqual(fs.docs.length, 200);
    const runs = await listRuns(fs, 5);
    assert.strictEqual(runs.length, 5);
    assert.ok(runs[0].startedAt > runs[1].startedAt);
    assert.strictEqual((await listRuns(fs, 9999)).length, 100);
});
