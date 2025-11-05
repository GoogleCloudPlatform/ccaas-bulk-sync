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

const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { CloudSchedulerClient } = require('@google-cloud/scheduler');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const path = require('path');
const syncLogic = require('./sync-logic');

const app = express();
app.use(express.json());

// --- Clients ---
const firestore = new Firestore();
const schedulerClient = new CloudSchedulerClient();
const secretClient = new SecretManagerServiceClient();
const configDocRef = firestore.collection('ccaas-sync-config').doc('latest');

// --- Helper Functions ---

async function _getSecret(secretName) {
    if (!secretName) return null;
    const projectId = await secretClient.getProjectId();
    const [version] = await secretClient.accessSecretVersion({
        name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    return version.payload.data.toString('utf8');
}

async function _setSecret(secretName, secretValue) {
    if (!secretName || !secretValue) return;
    const projectId = await secretClient.getProjectId();
    const parent = `projects/${projectId}`;
    
    try {
         await secretClient.addSecretVersion({
            parent: `${parent}/secrets/${secretName}`,
            payload: { data: Buffer.from(secretValue, 'utf8') },
        });
    } catch (error) {
       if (error.code === 5) { // NOT_FOUND
            await secretClient.createSecret({
                parent,
                secretId: secretName,
                secret: { replication: { automatic: {} } },
            });
            await secretClient.addSecretVersion({
                parent: `${parent}/secrets/${secretName}`,
                payload: { data: Buffer.from(secretValue, 'utf8') },
            });
        } else {
            throw error;
        }
    }
    console.log(`Updated secret: ${secretName}`);
}


async function _getHydratedConfig(bodyWithSecrets = null) {
    const doc = await configDocRef.get();
    if (!doc.exists && !bodyWithSecrets) {
        return null; 
    }
    const config = doc.exists ? doc.data() : {};

    config.ccaas = config.ccaas || {};
    config.directory = config.directory || {};

    config.ccaas.apiKey = (bodyWithSecrets?.ccaas?.apiKey) 
        ? bodyWithSecrets.ccaas.apiKey 
        : await _getSecret(config.ccaas.apiKeySecretName);
    
    if(bodyWithSecrets?.directory) {
        config.directory.gcpKey = bodyWithSecrets.directory.gcpKey || await _getSecret(config.directory.gcpKeySecretName);
        config.directory.bindPassword = bodyWithSecrets.directory.bindPassword || await _getSecret(config.directory.bindPasswordSecretName);
        config.directory.clientSecret = bodyWithSecrets.directory.clientSecret || await _getSecret(config.directory.clientSecretSecretName);
    } else {
        config.directory.gcpKey = await _getSecret(config.directory.gcpKeySecretName);
        config.directory.bindPassword = await _getSecret(config.directory.bindPasswordSecretName);
        config.directory.clientSecret = await _getSecret(config.directory.clientSecretSecretName);
    }

    return config;
}

// --- API Endpoints ---

app.get('/api/config', async (req, res) => {
    try {
        const defaultConfig = {
            ccaas: { host: '' },
            directory: { type: 'google', adminEmail: '', url: '', bindDN: '', searchBase: '', tenantId: '', clientId: '', entraIdEmailField: 'mail' },
            mappings: [],
            schedule: { type: 'manual', time: '00:00', cron: '* * * * *', initialPollDelay: 15 },
            syncRole: ''
        };

        const doc = await configDocRef.get();
        if (!doc.exists) {
            console.log('No configuration found, returning default.');
            return res.status(200).json(defaultConfig);
        }
        
        const storedConfig = doc.data();
        const configToReturn = {
            ...defaultConfig,
            ...storedConfig,
            ccaas: { ...defaultConfig.ccaas, ...storedConfig.ccaas },
            directory: { ...defaultConfig.directory, ...storedConfig.directory },
            schedule: { ...defaultConfig.schedule, ...storedConfig.schedule },
        };
        
        delete configToReturn.ccaas.apiKeySecretName;
        delete configToReturn.directory.gcpKeySecretName;
        delete configToReturn.directory.bindPasswordSecretName;
        delete configToReturn.directory.clientSecretSecretName;


        res.status(200).json(configToReturn);
    } catch (error) {
        console.error('Error fetching config:', error);
        res.status(500).send('Error fetching configuration.');
    }
});


app.post('/api/config', async (req, res) => {
    try {
        const incomingConfig = req.body;
        const currentDoc = await configDocRef.get();
        const configToSave = currentDoc.exists ? currentDoc.data() : {};

        if (incomingConfig.ccaas) configToSave.ccaas = { ...configToSave.ccaas, host: incomingConfig.ccaas.host };
        if (incomingConfig.directory) {
            configToSave.directory = {
                ...configToSave.directory, 
                type: incomingConfig.directory.type,
                adminEmail: incomingConfig.directory.adminEmail,
                url: incomingConfig.directory.url,
                bindDN: incomingConfig.directory.bindDN,
                searchBase: incomingConfig.directory.searchBase,
                tenantId: incomingConfig.directory.tenantId,
                clientId: incomingConfig.directory.clientId,
                entraIdEmailField: incomingConfig.directory.entraIdEmailField,
            };
        }
        configToSave.mappings = incomingConfig.mappings;
        configToSave.schedule = incomingConfig.schedule;
        configToSave.syncRole = incomingConfig.syncRole;
        
        if (incomingConfig.ccaas && incomingConfig.ccaas.apiKey) {
            configToSave.ccaas.apiKeySecretName = 'ccaas-api-key';
            await _setSecret(configToSave.ccaas.apiKeySecretName, incomingConfig.ccaas.apiKey);
        }
        if (incomingConfig.directory) {
            if (incomingConfig.directory.gcpKey) {
                configToSave.directory.gcpKeySecretName = 'gcp-sa-key';
                await _setSecret(configToSave.directory.gcpKeySecretName, incomingConfig.directory.gcpKey);
            }
            if (incomingConfig.directory.bindPassword) {
                configToSave.directory.bindPasswordSecretName = 'ad-bind-password';
                await _setSecret(configToSave.directory.bindPasswordSecretName, incomingConfig.directory.bindPassword);
            }
            if (incomingConfig.directory.clientSecret) {
                configToSave.directory.clientSecretSecretName = 'entra-client-secret';
                await _setSecret(configToSave.directory.clientSecretSecretName, incomingConfig.directory.clientSecret);
            }
        }
        
        await configDocRef.set(configToSave, { merge: true });
        await setupScheduler(configToSave.schedule);
        res.status(200).send('Configuration saved successfully.');
    } catch (error)        {
        console.error('Error saving config:', error);
        res.status(500).send(`Error saving configuration: ${error.message}`);
    }
});

app.post('/api/sync', async (req, res) => {
    try {
        const { simulate } = req.body; 
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).send('Configuration must be saved before running a sync.');
        const result = await syncLogic.runSync(config, simulate); 
        res.status(200).json(result);
    } catch (error) {
        console.error('Error during manual sync:', error);
        res.status(500).send(`Error during manual sync: ${error.message}`);
    }
});


app.post('/api/ccaas-details', async (req, res) => {
    try {
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).send('Configuration must be saved before fetching details.');
        const details = await syncLogic.getCcaasDetails(config);
        res.status(200).json(details);
    } catch (error) {
        res.status(500).send(`Error fetching CCaaS details: ${error.message}`);
    }
});

app.post('/api/ccaas-test', async (req, res) => {
    try {
        const config = await _getHydratedConfig({ ccaas: req.body });
        if (!config) return res.status(400).send('Configuration must be saved before testing.');
        await syncLogic.testCcaasConnection(config);
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/ccaas-jobs', async (req, res) => {
    try {
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).json([]);
        const jobs = await syncLogic.getCcaasJobs(config);
        res.status(200).json(jobs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/ccaas-jobs/proceed', async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) {
            return res.status(400).send('Job ID is required.');
        }
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).send('Configuration must be saved first.');
        await syncLogic.proceedCcaasJob(config, jobId);
        res.status(200).json({ success: true, message: `Job ${jobId} is now processing.` });
    } catch (error) {
        console.error(`Error proceeding job ${req.body.jobId}:`, error);
        res.status(500).send(`Error proceeding job: ${error.message}`);
    }
});

app.get('/api/ccaas-jobs/scheme-errors/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        if (!jobId) {
            return res.status(400).send('Job ID is required.');
        }
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).send('Configuration must be saved first.');
        const errors = await syncLogic.getCcaasSchemeErrors(config, jobId);
        res.status(200).json(errors);
    } catch (error) {
        console.error(`Error fetching scheme errors for job ${req.params.jobId}:`, error);
        res.status(500).send(`Error fetching scheme errors: ${error.message}`);
    }
});


app.post('/api/directory-test', async (req, res) => {
    try {
        const config = await _getHydratedConfig({ directory: req.body });
         if (!config) return res.status(400).send('Configuration must be saved before testing.');
        const type = req.body.type;
        if (type === 'google') {
            await syncLogic.testGoogleWorkspaceConnection(config.directory);
        } else if (type === 'ad') {
            await syncLogic.testActiveDirectoryConnection(config.directory);
        } else if (type === 'entra') {
            await syncLogic.testEntraIdConnection(config.directory);
        }
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/directory-groups', async (req, res) => {
    try {
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).json([]);
        const groups = await syncLogic.getDirectoryGroups(config);
        res.status(200).json(groups);
    } catch (error) {
        console.error('Error fetching directory groups:', error);
        res.status(500).send(`Error fetching directory groups: ${error.message}`);
    }
});

async function setupScheduler(scheduleConfig) {
    const projectId = await schedulerClient.getProjectId();
    const location = process.env.REGION || 'us-central1';
    const serviceUrl = process.env.SERVICE_URL;
    const cloudRunSaEmail = process.env.SERVICE_ACCOUNT;

    if (!serviceUrl || !cloudRunSaEmail) {
        console.error('SERVICE_URL or SERVICE_ACCOUNT env vars not set. Cannot manage scheduler.');
        return;
    }

    const jobName = schedulerClient.jobPath(projectId, location, 'ccaas-sync-scheduler');

    try {
        await schedulerClient.getJob({ name: jobName });
        console.log(`Found existing job: ${jobName}. Deleting before recreation.`);
        await schedulerClient.deleteJob({ name: jobName });
    } catch (error) {
        if (error.code !== 5) { 
            console.error('Error checking/deleting scheduler job:', error);
            throw error;
        }
        console.log('No existing scheduler job found. A new one will be created if needed.');
    }

    if (scheduleConfig.type === 'manual') {
        console.log('Schedule set to manual. No job will be created.');
        return;
    }

    let cronSchedule;
    if (scheduleConfig.type === 'hourly') {
        cronSchedule = '0 * * * *';
    } else if (scheduleConfig.type === 'daily') {
        const [hour, minute] = scheduleConfig.time.split(':');
        cronSchedule = `${minute} ${hour} * * *`;
    } else if (scheduleConfig.type === 'custom') {
        cronSchedule = scheduleConfig.cron;
    }

    if (!cronSchedule) {
        console.log(`Invalid schedule type: ${scheduleConfig.type}`);
        return;
    }

    const job = {
        name: jobName,
        httpTarget: {
            uri: `${serviceUrl}/api/sync`,
            httpMethod: 'POST',
            oidcToken: {
                serviceAccountEmail: cloudRunSaEmail,
            },
        },
        schedule: cronSchedule,
        timeZone: 'UTC',
    };

    console.log(`Creating/updating scheduler job with schedule: "${cronSchedule}"`);
    await schedulerClient.createJob({
        parent: schedulerClient.locationPath(projectId, location),
        job: job,
    });
    console.log(`Successfully created/updated job: ${jobName}`);
}


// --- Static File Server ---
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

