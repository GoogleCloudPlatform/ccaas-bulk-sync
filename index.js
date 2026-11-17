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
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const { Firestore } = require('@google-cloud/firestore');
const { CloudSchedulerClient } = require('@google-cloud/scheduler');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const path = require('path');
const syncLogic = require('./sync-logic');
const { createConfigStore } = require('./config-store');
const { executeSync } = require('./sync-runner');
const { launchSyncJob } = require('./job-launcher');
const { requireAuth } = require('./auth');
const { roleFor, requireAdmin, requireSyncPermission, isAdminListConfigured, warnIfAdminListMissing } = require('./authz');
const { buildConfigToSave, ConfigValidationError, redactConfig } = require('./config-security');
const { isSyncLocked } = require('./sync-lock');
const runHistory = require('./run-history');
const { DEFAULT_MAX_DEACTIVATIONS, DEFAULT_SYNC_OPTIONS } = require('./sync-plan');

const app = express();
app.disable('x-powered-by');

// Security headers. The UI loads only same-origin resources. Vue's in-browser
// template compiler needs 'unsafe-eval'; there are no inline scripts or styles.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-eval'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            fontSrc: ["'self'"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(express.json());

// Cloud Run (and the load balancer) put the client IP in X-Forwarded-For.
// Trusting one hop lets the rate limiter key on the real client IP.
app.set('trust proxy', 1);

// Basic abuse protection in front of authentication, JWT verification and
// Secret Manager access. IAP limits who can reach the service; this limits
// how fast any one client can call it.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const staticLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', apiLimiter);

// Every API route requires an authenticated caller (IAP user, or Cloud
// Scheduler for POST /api/sync). See auth.js.
app.use('/api', requireAuth);

// --- Clients ---
const firestore = new Firestore();
const schedulerClient = new CloudSchedulerClient();
const secretClient = new SecretManagerServiceClient();
const store = createConfigStore({ firestore, secretClient });
const configDocRef = store.configDocRef;
const _getHydratedConfig = (bodyWithSecrets = null) => store.getHydratedConfig(bodyWithSecrets);
const _setSecret = store.setSecret;

// --- API Endpoints ---

function isValidJobId(jobId) {
    return (typeof jobId === 'string' || typeof jobId === 'number') && /^[A-Za-z0-9_-]{1,64}$/.test(String(jobId));
}

app.get('/api/me', (req, res) => {
    res.status(200).json({
        email: req.user?.email || null,
        role: roleFor(req.user),
        adminListConfigured: isAdminListConfigured(),
        serviceAccount: process.env.SERVICE_ACCOUNT || null,
    });
});

app.get('/api/config', async (req, res) => {
    try {
        const defaultConfig = {
            ccaas: { host: '' },
            directory: { type: 'google', adminEmail: '', url: '', bindDN: '', searchBase: '', tenantId: '', clientId: '', entraIdEmailField: 'mail' },
            mappings: [],
            schedule: { type: 'manual', time: '00:00', cron: '* * * * *', initialPollDelay: 15 },
            safety: { maxDeactivations: DEFAULT_MAX_DEACTIVATIONS },
            syncOptions: { ...DEFAULT_SYNC_OPTIONS },
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
            safety: { ...defaultConfig.safety, ...storedConfig.safety },
            syncOptions: { ...defaultConfig.syncOptions, ...storedConfig.syncOptions },
        };
        
        // Effective Google auth mode (older configs have a key but no mode).
        configToReturn.directory.googleAuthMode = configToReturn.directory.googleAuthMode
            || (configToReturn.directory.gcpKeySecretName ? 'key' : 'keyless');

        // Never send secret values (or references) to the browser.
        res.status(200).json(redactConfig(configToReturn));
    } catch (error) {
        console.error('Error fetching config:', error);
        res.status(500).send('Error fetching configuration.');
    }
});


app.post('/api/config', requireAdmin, async (req, res) => {
    try {
        const currentDoc = await configDocRef.get();
        const currentConfig = currentDoc.exists ? currentDoc.data() : {};

        let configToSave, secretsToSet;
        try {
            ({ configToSave, secretsToSet } = buildConfigToSave(currentConfig, req.body));
        } catch (error) {
            if (error instanceof ConfigValidationError) {
                return res.status(400).send(error.message);
            }
            throw error;
        }

        for (const { name, value } of secretsToSet) {
            await _setSecret(name, value);
        }

        // Write the full document (no merge) so the stored config always matches
        // exactly what was validated above.
        await configDocRef.set(configToSave);
        await setupScheduler(configToSave.schedule);
        console.log(`Configuration updated by ${req.user ? req.user.email : 'unknown'}`);
        res.status(200).send('Configuration saved successfully.');
    } catch (error) {
        console.error('Error saving config:', error);
        res.status(500).send('Error saving configuration. Check the service logs for details.');
    }
});

app.post('/api/sync', requireSyncPermission, async (req, res) => {
    const simulate = req.body?.simulate === true;
    const isScheduler = req.user?.type === 'scheduler'
        || (!!process.env.SERVICE_ACCOUNT && (req.user?.email || '').toLowerCase() === process.env.SERVICE_ACCOUNT.toLowerCase());
    // Only an interactive admin can override the deactivation limit, never the scheduler.
    const allowLargeDeactivation = req.body?.allowLargeDeactivation === true && !isScheduler;
    const startedBy = req.user?.email || 'unknown';
    const trigger = isScheduler ? 'scheduled' : 'manual';

    // Live syncs run in the Cloud Run Job when one is configured: start it and
    // return 202 with a run ID the UI can poll. Simulations stay inline.
    const jobName = process.env.SYNC_JOB_NAME;
    if (!simulate && jobName) {
        try {
            if (await isSyncLocked(firestore)) {
                return res.status(409).send('Another sync is already running.');
            }
            const runId = await runHistory.createQueuedRun(firestore, { trigger, startedBy });
            await launchSyncJob({ jobName, region: process.env.REGION || 'us-central1', runId, trigger, startedBy, allowLargeDeactivation });
            console.log('Started sync job %s for run %s (trigger=%s, by %s).', jobName, runId, trigger, startedBy);
            return res.status(202).json({ queued: true, runId });
        } catch (error) {
            console.error('Could not start the sync job:', error.message);
            return res.status(500).send(`Could not start the sync job: ${error.message}`);
        }
    }

    const { status, body } = await executeSync({ firestore, getHydratedConfig: () => _getHydratedConfig(), trigger, startedBy, simulate, allowLargeDeactivation });
    if (typeof body === 'string') return res.status(status).send(body);
    return res.status(status).json(body);
});

app.get('/api/sync-runs/:runId', async (req, res) => {
    if (!/^[A-Za-z0-9]{1,64}$/.test(req.params.runId)) return res.status(400).send('Invalid run ID.');
    try {
        const run = await runHistory.getRun(firestore, req.params.runId);
        if (!run) return res.status(404).send('Run not found.');
        res.status(200).json(run);
    } catch (error) {
        console.error('Error reading sync run:', error);
        res.status(500).send('Error reading sync run.');
    }
});

app.get('/api/sync-runs', async (req, res) => {
    try {
        res.status(200).json(await runHistory.listRuns(firestore, req.query.limit));
    } catch (error) {
        console.error('Error listing sync runs:', error);
        res.status(500).send('Error listing sync runs.');
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

app.post('/api/ccaas-test', requireAdmin, async (req, res) => {
    try {
        const config = await _getHydratedConfig({ ccaas: req.body || {} });
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

app.post('/api/ccaas-jobs/proceed', requireAdmin, async (req, res) => {
    try {
        const { jobId } = req.body || {};
        if (!isValidJobId(jobId)) {
            return res.status(400).send('A valid Job ID is required.');
        }
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).send('Configuration must be saved first.');
        await syncLogic.proceedCcaasJob(config, jobId);
        res.status(200).json({ success: true, message: `Job ${jobId} is now processing.` });
    } catch (error) {
        console.error('Error proceeding job %s:', String(req.body?.jobId), error);
        res.status(500).send(`Error proceeding job: ${error.message}`);
    }
});

app.get('/api/ccaas-jobs/scheme-errors/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        if (!isValidJobId(jobId)) {
            return res.status(400).send('A valid Job ID is required.');
        }
        const config = await _getHydratedConfig();
        if (!config) return res.status(400).send('Configuration must be saved first.');
        const errors = await syncLogic.getCcaasSchemeErrors(config, jobId);
        res.status(200).json(errors);
    } catch (error) {
        console.error('Error fetching scheme errors for job %s:', String(req.params.jobId), error);
        res.status(500).send(`Error fetching scheme errors: ${error.message}`);
    }
});


app.post('/api/directory-test', requireAdmin, async (req, res) => {
    try {
        const config = await _getHydratedConfig({ directory: req.body || {} });
         if (!config) return res.status(400).send('Configuration must be saved before testing.');
        const type = req.body?.type;
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

// A live sync can poll the CCaaS job for several minutes. Give the scheduler
// enough time (and no automatic retries) so it doesn't start a second sync.
// Keep this in line with the Cloud Run --timeout in cloudbuild.yaml.
const SCHEDULER_ATTEMPT_DEADLINE_SECONDS = 900;

function _cronFor(scheduleConfig) {
    if (scheduleConfig.type === 'hourly') return '0 * * * *';
    if (scheduleConfig.type === 'daily') {
        const [hour, minute] = String(scheduleConfig.time || '00:00').split(':');
        return `${Number(minute) || 0} ${Number(hour) || 0} * * *`;
    }
    if (scheduleConfig.type === 'custom') return scheduleConfig.cron;
    return null;
}

// Before v1.1.0, REGION wasn't passed to the service, so the job was always
// created in us-central1. If the service now runs elsewhere, remove that old job
// so two schedulers don't both trigger syncs.
const LEGACY_SCHEDULER_LOCATION = 'us-central1';

async function _removeLegacySchedulerJob(projectId, location) {
    if (location === LEGACY_SCHEDULER_LOCATION) return;
    const legacyName = schedulerClient.jobPath(projectId, LEGACY_SCHEDULER_LOCATION, 'ccaas-sync-scheduler');
    try {
        await schedulerClient.deleteJob({ name: legacyName });
        console.log(`Removed legacy scheduler job ${legacyName}.`);
    } catch (error) {
        if (error.code !== 5) {
            console.warn(`Could not remove legacy scheduler job ${legacyName}: ${error.message}`);
        }
    }
}

async function setupScheduler(scheduleConfig = { type: 'manual' }) {
    const projectId = await schedulerClient.getProjectId();
    const location = process.env.REGION || 'us-central1';
    const serviceUrl = process.env.SERVICE_URL;
    const cloudRunSaEmail = process.env.SERVICE_ACCOUNT;

    if (!serviceUrl || !cloudRunSaEmail) {
        console.error('SERVICE_URL or SERVICE_ACCOUNT env vars not set. Cannot manage scheduler.');
        return;
    }

    const jobName = schedulerClient.jobPath(projectId, location, 'ccaas-sync-scheduler');
    await _removeLegacySchedulerJob(projectId, location);
    let exists = true;
    try {
        await schedulerClient.getJob({ name: jobName });
    } catch (error) {
        if (error.code !== 5) {
            console.error('Error checking scheduler job:', error);
            throw error;
        }
        exists = false;
    }

    if (scheduleConfig.type === 'manual') {
        if (exists) {
            await schedulerClient.deleteJob({ name: jobName });
            console.log('Schedule set to manual. Deleted scheduler job.');
        }
        return;
    }

    const cronSchedule = _cronFor(scheduleConfig);
    if (!cronSchedule) {
        console.log(`Invalid schedule type: ${scheduleConfig.type}`);
        return;
    }

    // When IAP is turned on directly on the Cloud Run service, IAP only accepts
    // Google-signed ID tokens whose audience is an OAuth client ID it trusts
    // (IAP "programmatic clients"). Set SCHEDULER_OIDC_AUDIENCE to that client
    // ID. Leave it unset for the load balancer setup, where Cloud Run IAM checks
    // the token and the default audience (the target URL) is correct.
    const oidcToken = { serviceAccountEmail: cloudRunSaEmail };
    if (process.env.SCHEDULER_OIDC_AUDIENCE) {
        oidcToken.audience = process.env.SCHEDULER_OIDC_AUDIENCE;
    }

    const job = {
        name: jobName,
        httpTarget: {
            uri: `${serviceUrl}/api/sync`,
            httpMethod: 'POST',
            oidcToken,
        },
        schedule: cronSchedule,
        timeZone: 'UTC',
        attemptDeadline: { seconds: SCHEDULER_ATTEMPT_DEADLINE_SECONDS },
        retryConfig: { retryCount: 0 },
    };

    // Update in place so the schedule never disappears between delete and create.
    if (exists) {
        await schedulerClient.updateJob({ job });
    } else {
        await schedulerClient.createJob({ parent: schedulerClient.locationPath(projectId, location), job });
    }
    console.log(`Scheduler job ${exists ? 'updated' : 'created'} with schedule "${cronSchedule}" (UTC).`);
}


// --- Health check (no auth; no configuration or secrets touched) ---
const APP_VERSION = require('./package.json').version;
app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', version: APP_VERSION });
});

// --- Static File Server ---
const publicPath = path.join(__dirname, 'public');
// Serve Vue from the installed package instead of a third-party CDN.
const vuePath = require.resolve('vue/dist/vue.global.prod.js');
app.get('/vendor/vue.global.prod.js', staticLimiter, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(vuePath);
});
app.use(staticLimiter, express.static(publicPath));

app.get(/^(?!\/api).*/, staticLimiter, (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    warnIfAdminListMissing();
});

