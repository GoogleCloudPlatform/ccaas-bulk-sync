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
 * Cloud Run Job entrypoint: performs one live sync and exits.
 *
 * Started by the web service (job-launcher.js) with these environment
 * variables: SYNC_RUN_ID, SYNC_TRIGGER, SYNC_STARTED_BY,
 * SYNC_ALLOW_LARGE_DEACTIVATION. The run's progress and result are written to
 * the run-history document SYNC_RUN_ID, which the UI polls.
 */

const { Firestore } = require('@google-cloud/firestore');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { createConfigStore } = require('./config-store');
const { executeSync } = require('./sync-runner');
const runHistory = require('./run-history');

async function main() {
    const firestore = new Firestore();
    const store = createConfigStore({ firestore, secretClient: new SecretManagerServiceClient() });
    const runId = process.env.SYNC_RUN_ID || null;
    if (runId) await runHistory.markRunning(firestore, runId);
    const { status } = await executeSync({
        firestore,
        getHydratedConfig: () => store.getHydratedConfig(),
        trigger: process.env.SYNC_TRIGGER || 'manual',
        startedBy: process.env.SYNC_STARTED_BY || 'unknown',
        simulate: false,
        allowLargeDeactivation: process.env.SYNC_ALLOW_LARGE_DEACTIVATION === 'true',
        runId,
        // Longer than the job's task timeout (README / Terraform: 3600s), so the
        // lock can't expire while this job is still running.
        leaseMs: 65 * 60 * 1000,
    });
    // Exit 0 for any recorded outcome (including blocked or in progress), so
    // Cloud Run doesn't retry; failures are reported through run history and alerts.
    return status === 500 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
    console.error('Sync job failed:', error);
    process.exit(1);
});
