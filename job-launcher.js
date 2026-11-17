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
 * Starts the Cloud Run Job that performs live syncs, so the HTTP request that
 * triggered it can return immediately (browsers and IAP stop waiting after
 * about 30 seconds; a live sync can take several minutes).
 */

const { GoogleAuth } = require('google-auth-library');

async function launchSyncJob({ jobName, region, runId, trigger, startedBy, allowLargeDeactivation }, deps = {}) {
    const auth = deps.auth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const projectId = deps.projectId || await auth.getProjectId();
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(jobName)}:run`;
    const env = [
        { name: 'SYNC_RUN_ID', value: runId },
        { name: 'SYNC_TRIGGER', value: trigger },
        { name: 'SYNC_STARTED_BY', value: startedBy },
        { name: 'SYNC_ALLOW_LARGE_DEACTIVATION', value: allowLargeDeactivation ? 'true' : 'false' },
    ];
    const res = await client.request({ url, method: 'POST', data: { overrides: { containerOverrides: [{ env }] } } });
    return res.data && res.data.name;
}

module.exports = { launchSyncJob };
