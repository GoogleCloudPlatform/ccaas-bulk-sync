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
 * Loads the configuration from Firestore and hydrates it with secret values
 * from Secret Manager. Shared by the web service (index.js) and the sync job
 * (job.js).
 */

const secrets = require('./secrets');

function createConfigStore({ firestore, secretClient }) {
    const configDocRef = firestore.collection('ccaas-sync-config').doc('latest');
    const getSecret = (name) => secrets.getSecret(secretClient, name);
    const setSecret = (name, value) => secrets.setSecret(secretClient, name, value);

    async function getHydratedConfig(bodyWithSecrets = null) {
        const doc = await configDocRef.get();
        if (!doc.exists && !bodyWithSecrets) {
            return null;
        }
        const config = doc.exists ? doc.data() : {};

        config.ccaas = config.ccaas || {};
        config.directory = config.directory || {};

        config.ccaas.apiKey = (bodyWithSecrets?.ccaas?.apiKey)
            ? bodyWithSecrets.ccaas.apiKey
            : await getSecret(config.ccaas.apiKeySecretName);

        // Google Workspace: keyless delegation unless a stored JSON key is selected.
        const googleAuthMode = bodyWithSecrets?.directory?.googleAuthMode
            || config.directory.googleAuthMode
            || (config.directory.gcpKeySecretName ? 'key' : 'keyless');
        config.directory.googleAuthMode = googleAuthMode;

        if (bodyWithSecrets?.directory) {
            config.directory.gcpKey = googleAuthMode === 'key'
                ? (bodyWithSecrets.directory.gcpKey || await getSecret(config.directory.gcpKeySecretName))
                : null;
            config.directory.bindPassword = bodyWithSecrets.directory.bindPassword || await getSecret(config.directory.bindPasswordSecretName);
            config.directory.clientSecret = bodyWithSecrets.directory.clientSecret || await getSecret(config.directory.clientSecretSecretName);
        } else {
            config.directory.gcpKey = googleAuthMode === 'key' ? await getSecret(config.directory.gcpKeySecretName) : null;
            config.directory.bindPassword = await getSecret(config.directory.bindPasswordSecretName);
            config.directory.clientSecret = await getSecret(config.directory.clientSecretSecretName);
        }

        return config;
    }

    return { configDocRef, getHydratedConfig, getSecret, setSecret };
}

module.exports = { createConfigStore };
