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
 * Sync run history (Firestore collection "ccaas-sync-runs") and a structured
 * log line per run for Cloud Logging metrics and alerts.
 *
 * Records contain counts, outcome and who/what triggered the run, never user
 * emails or names.
 */

const COLLECTION = 'ccaas-sync-runs';
const KEEP_RUNS = 200;

/** Outcomes that should alert (see README "Alerting"). */
const ALERT_OUTCOMES = new Set(['error', 'blocked', 'group_not_found', 'job_failed', 'job_timeout']);

function severityFor(outcome) {
    if (outcome === 'error' || outcome === 'job_failed' || outcome === 'job_timeout') return 'ERROR';
    if (ALERT_OUTCOMES.has(outcome) || outcome === 'in_progress') return 'WARNING';
    return 'INFO';
}

/**
 * Builds the stored/logged run record. `result` is runSync()'s return value
 * (for successful runs); `error` is set for runs that threw.
 */
function buildRunRecord({ startedAt, finishedAt, trigger, startedBy, simulate, result = null, outcome = null, error = null, extra = {} }) {
    return {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        trigger,
        startedBy: startedBy || 'unknown',
        simulate: !!simulate,
        outcome: outcome || result?.outcome || 'error',
        message: String(error ? error.message : (result?.message || '')).slice(0, 500),
        counts: result?.counts || null,
        jobId: result?.jobId || null,
        warningsCount: result?.warnings?.length || 0,
        blockedBy: result?.blockedBy ? String(result.blockedBy).slice(0, 300) : null,
        ...extra,
    };
}

/** Writes one JSON line to stdout; Cloud Run turns it into a structured log entry. */
function logRun(record, log = console.log) {
    log(JSON.stringify({ severity: severityFor(record.outcome), message: `sync_run ${record.outcome}: ${record.message}`, event: 'sync_run', ...record }));
}

async function recordRun(firestore, record) {
    try {
        await firestore.collection(COLLECTION).add(record);
        await _prune(firestore);
    } catch (error) {
        console.warn('Could not record sync run: %s', error.message);
    }
}

async function _prune(firestore) {
    const snap = await firestore.collection(COLLECTION).orderBy('startedAt', 'desc').offset(KEEP_RUNS).limit(50).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
}

async function listRuns(firestore, limit = 20) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const snap = await firestore.collection(COLLECTION).orderBy('startedAt', 'desc').limit(n).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = { buildRunRecord, logRun, recordRun, listRuns, severityFor, ALERT_OUTCOMES, COLLECTION };
