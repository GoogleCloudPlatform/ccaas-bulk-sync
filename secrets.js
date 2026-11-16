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
 * Secret Manager helpers, written to work with least-privilege IAM:
 * per-secret roles/secretmanager.secretAccessor and
 * roles/secretmanager.secretVersionManager (see README step 4.2).
 *
 * The secrets themselves are created during setup (README step 4.1), so the
 * service does not need permission to create secrets.
 */

const NOT_FOUND = 5;
const PERMISSION_DENIED = 7;

async function getSecret(client, secretName) {
    if (!secretName) return null;
    const projectId = await client.getProjectId();
    const [version] = await client.accessSecretVersion({
        name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    return version.payload.data.toString('utf8');
}

/**
 * Adds a new version of the secret, then disables every older enabled version
 * so that replaced credentials can no longer be read.
 */
async function setSecret(client, secretName, secretValue) {
    if (!secretName || !secretValue) return;
    const projectId = await client.getProjectId();
    const parent = `projects/${projectId}/secrets/${secretName}`;

    let added;
    try {
        [added] = await client.addSecretVersion({
            parent,
            payload: { data: Buffer.from(secretValue, 'utf8') },
        });
    } catch (error) {
        if (error.code === NOT_FOUND) {
            throw new Error(`Secret "${secretName}" does not exist. Create it first (README step 4.1).`);
        }
        if (error.code === PERMISSION_DENIED) {
            throw new Error(`The service account cannot add versions to secret "${secretName}". Grant it roles/secretmanager.secretVersionManager on that secret (README step 4.2).`);
        }
        throw error;
    }
    console.log('Updated secret: %s', secretName);

    try {
        const [versions] = await client.listSecretVersions({ parent, filter: 'state:ENABLED' });
        for (const v of versions) {
            if (added && v.name === added.name) continue;
            await client.disableSecretVersion({ name: v.name });
            console.log('Disabled previous version %s of secret %s', v.name.split('/').pop(), secretName);
        }
    } catch (error) {
        // The new value is already in place; failing to disable old versions
        // must not fail the save.
        console.warn('Could not disable previous versions of secret %s: %s', secretName, error.message);
    }
}

module.exports = { getSecret, setSecret };
