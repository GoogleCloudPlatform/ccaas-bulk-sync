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

const { google } = require('googleapis');
const { Client, AndFilter, EqualityFilter } = require('ldapts');
const msal = require('@azure/msal-node');
const { Client: GraphClient } = require('@microsoft/microsoft-graph-client');
// fetch, FormData and Blob are built into Node.js 22; the Microsoft Graph
// client uses the global fetch as well.
const { validateCcaasHost, validateLdapUrl } = require('./config-security');
const { buildDirectoryUsers, computeSyncPlan, assertPlanIsSafe } = require('./sync-plan');

const CCAAS_PAGE_SIZE = 1000;
const MAX_PAGES = 1000;

class GroupNotFoundError extends Error {
    constructor(directoryType, groupName) {
        super(`Directory group "${groupName}" was not found in ${directoryType}. Sync aborted to avoid deactivating its members. Check the group mappings.`);
        this.name = 'GroupNotFoundError';
    }
}


// --- CCaaS API Functions ---

async function _callCcaasApi(config, path, method = 'GET', body = null) {
    const { host, apiKey } = config.ccaas;
    if (!host || !apiKey) {
        throw new Error('CCaaS host and API key are required.');
    }
    // Re-validate at use time in case the stored value predates validation.
    const safeHost = validateCcaasHost(host);
    const username = safeHost.split('.')[0];
    const url = `https://${safeHost}${path}`;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${apiKey}`).toString('base64');
    const options = {
        method: method,
        headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
        }
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`CCaaS API Error (${response.status}): ${errorText}`);
        throw new Error(`CCaaS API request failed with status ${response.status}`);
    }
    if (response.status === 204) {
        return {};
    }
    return response.json();
}

async function _callCcaasUploadApi(config, path, usersPayload) {
    const { host, apiKey } = config.ccaas;
    if (!host || !apiKey) {
        throw new Error('CCaaS host and API key are required.');
    }
    // Re-validate at use time in case the stored value predates validation.
    const safeHost = validateCcaasHost(host);
    const username = safeHost.split('.')[0];
    const url = `https://${safeHost}${path}`;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${apiKey}`).toString('base64');

    const form = new FormData();
    console.log(`Uploading bulk user file with ${usersPayload.length} records.`);
    
    form.append('file', new Blob([JSON.stringify(usersPayload)], { type: 'application/json' }), 'users.json');

    // fetch sets the multipart Content-Type (with boundary) from the FormData body.
    const options = {
        method: 'POST',
        body: form,
        headers: {
            'Authorization': authHeader
        }
    };
    
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`CCaaS API Upload Error (${response.status}): ${errorText}`);
        throw new Error(`CCaaS API upload failed with status ${response.status}`);
    }
    if (response.status === 204) {
        return {};
    }
    return response.json();
}


async function testCcaasConnection(config) {
    await _callCcaasApi(config, '/apps/api/v1/bulk/users/jobs', 'GET');
}

async function getCcaasJobs(config) {
    return await _callCcaasApi(config, '/apps/api/v1/bulk/users/jobs', 'GET');
}

async function getCcaasJobStatus(config, jobId) {
    return await _callCcaasApi(config, `/apps/api/v1/bulk/users/jobs/${encodeURIComponent(jobId)}`);
}

async function getCcaasSchemeErrors(config, jobId) {
    return await _callCcaasApi(config, `/apps/api/v1/bulk/users/errors/scheme/${encodeURIComponent(jobId)}`);
}

async function proceedCcaasJob(config, jobId) {
    console.log('Requesting processing for Job ID: %s', String(jobId));
    const response = await _callCcaasApi(config, '/apps/api/v1/bulk/users/proceed', 'POST', { id: jobId });
    console.log('Successfully requested processing for Job ID: %s. Response: %j', String(jobId), response);
    return response;
}

async function getCcaasDetails(config) {
    const templateData = await _callCcaasApi(config, '/apps/api/v1/bulk/users/template', 'GET');
    if (!Array.isArray(templateData) || templateData.length === 0) {
        console.error('Invalid or empty response from CCaaS template API.');
        return { teams: [], roles: [] };
    }
    const firstUser = templateData[0];
    const teams = (firstUser.teams || []).map(team => team.name).sort();
    const roles = (firstUser.roles || []).map(role => role.name).sort();
    return { teams, roles };
}

/**
 * Fetches every CCaaS user, following pagination (`page` / `per`).
 *
 * Keeps requesting pages until one comes back empty, rather than stopping at
 * the first page shorter than `per`, because the API may cap the page size
 * below what was asked for. Stops with an error if the API ignores `page` and
 * keeps returning the same records.
 */
async function getAllCcaasUsers(config) {
    const all = [];
    let previousFirstKey = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await _callCcaasApi(config, `/apps/api/v1/users?page=${page}&per=${CCAAS_PAGE_SIZE}`);
        if (!Array.isArray(batch)) {
            throw new Error('Unexpected response from CCaaS users API (expected an array).');
        }
        if (batch.length === 0) return all;
        const firstKey = String(batch[0].id ?? batch[0].email);
        if (firstKey === previousFirstKey) {
            throw new Error('CCaaS users API returned the same page twice; pagination is not working. Sync aborted.');
        }
        previousFirstKey = firstKey;
        all.push(...batch);
    }
    throw new Error(`CCaaS users API returned more than ${MAX_PAGES} pages; aborting.`);
}

// --- Directory User Fetching & Testing Logic ---

// Microsoft Entra ID Helper Functions
async function getGraphClient(directoryConfig) {
    const { tenantId, clientId, clientSecret } = directoryConfig;
    if (!tenantId || !clientId || !clientSecret) {
        throw new Error('Tenant ID, Client ID, and Client Secret are required for Entra ID.');
    }
    
    const cca = new msal.ConfidentialClientApplication({
        auth: {
            clientId: clientId,
            authority: `https://login.microsoftonline.com/${tenantId}`,
            clientSecret: clientSecret,
        },
    });

    const authProvider = {
        getAccessToken: async () => {
            const result = await cca.acquireTokenByClientCredential({
                scopes: ["https://graph.microsoft.com/.default"],
            });
            return result.accessToken;
        },
    };

    return GraphClient.initWithMiddleware({ authProvider });
}

/** Runs a Graph request and follows @odata.nextLink to collect every page. */
async function _graphGetAll(graphClient, request) {
    const items = [];
    let response = await request.get();
    for (let page = 0; page < MAX_PAGES; page++) {
        items.push(...(response.value || []));
        const next = response['@odata.nextLink'];
        if (!next) return items;
        response = await graphClient.api(next).get();
    }
    throw new Error('Microsoft Graph returned too many pages; aborting.');
}

function _odataString(value) {
    return String(value).replace(/'/g, "''");
}

async function testEntraIdConnection(directoryConfig) {
    const graphClient = await getGraphClient(directoryConfig);
    // A simple query to test the connection and permissions
    await graphClient.api('/users').select('id').top(1).get();
}


async function testGoogleWorkspaceConnection(directoryConfig) {
    if (!directoryConfig.gcpKey || !directoryConfig.adminEmail) {
        throw new Error('Service Account JSON Key and Admin Email are required.');
    }
    try {
        const auth = google.auth.fromJSON(JSON.parse(directoryConfig.gcpKey));
        auth.scopes = [
            'https://www.googleapis.com/auth/admin.directory.user.readonly',
            'https://www.googleapis.com/auth/admin.directory.group.readonly',
            'https://www.googleapis.com/auth/admin.directory.group.member.readonly'
        ];
        auth.subject = directoryConfig.adminEmail;

        const admin = google.admin({ version: 'directory_v1', auth: auth });
        
        await admin.users.list({
            customer: 'my_customer',
            maxResults: 1,
            orderBy: 'email'
        });
    } catch (e) {
        console.error('Google Workspace Auth Error:', e);
        throw new Error(`Google Workspace connection failed: ${e.message}`);
    }
}

async function testActiveDirectoryConnection(directoryConfig) {
    if (!directoryConfig.url || !directoryConfig.bindDN || !directoryConfig.bindPassword) {
        throw new Error('LDAP URL, Bind DN, and Bind Password are required.');
    }
    const client = new Client({ url: validateLdapUrl(directoryConfig.url) });
    try {
        await client.bind(directoryConfig.bindDN, directoryConfig.bindPassword);
    } catch (e) {
        console.error('AD Bind Error:', e);
        throw new Error(`Active Directory connection failed: ${e.message || 'Check credentials and LDAP URL.'}`);
    } finally {
        await client.unbind();
    }
}

async function getGoogleWorkspaceGroups(directoryConfig) {
    if (!directoryConfig.gcpKey || !directoryConfig.adminEmail) {
        throw new Error('Service Account JSON Key and Admin Email are required for fetching groups.');
    }
    try {
        const auth = google.auth.fromJSON(JSON.parse(directoryConfig.gcpKey));
        auth.scopes = ['https://www.googleapis.com/auth/admin.directory.group.readonly'];
        auth.subject = directoryConfig.adminEmail;
        const admin = google.admin({ version: 'directory_v1', auth: auth });
        
        let allGroups = [];
        let pageToken = null;
        do {
            const res = await admin.groups.list({
                customer: 'my_customer',
                maxResults: 200,
                pageToken: pageToken,
            });
            if (res.data.groups) {
                allGroups = allGroups.concat(res.data.groups);
            }
            pageToken = res.data.nextPageToken;
        } while (pageToken);
        
        return allGroups.map(group => group.name).sort();

    } catch (e) {
        console.error('Google Workspace Get Groups Error:', e);
        throw new Error(`Failed to get Google Workspace groups: ${e.message}`);
    }
}

async function getActiveDirectoryGroups(directoryConfig) {
    if (!directoryConfig.url || !directoryConfig.bindDN || !directoryConfig.bindPassword || !directoryConfig.searchBase) {
        throw new Error('LDAP URL, Bind DN, Bind Password, and Search Base are required for fetching groups.');
    }
    const client = new Client({ url: validateLdapUrl(directoryConfig.url) });
    try {
        await client.bind(directoryConfig.bindDN, directoryConfig.bindPassword);
        const { searchEntries } = await client.search(directoryConfig.searchBase, {
            scope: 'sub',
            filter: '(objectClass=group)',
            attributes: ['cn'],
            paged: true,
        });
        return searchEntries.map(entry => entry.cn).sort();
    } catch (e) {
        console.error('AD Get Groups Error:', e);
        throw new Error(`Failed to get Active Directory groups: ${e.message}`);
    } finally {
        await client.unbind();
    }
}

async function getEntraIdGroups(directoryConfig) {
    const graphClient = await getGraphClient(directoryConfig);
    const groups = await _graphGetAll(graphClient, graphClient.api('/groups').select('displayName').top(999));
    return groups.map(g => g.displayName).sort();
}


async function getDirectoryGroups(config) {
    if (config.directory.type === 'google') {
        return await getGoogleWorkspaceGroups(config.directory);
    } else if (config.directory.type === 'ad') {
        return await getActiveDirectoryGroups(config.directory);
    } else if (config.directory.type === 'entra') {
        return await getEntraIdGroups(config.directory);
    }
    return [];
}


// --- Main Sync Logic ---

function _googleAdmin(directoryConfig) {
    const auth = google.auth.fromJSON(JSON.parse(directoryConfig.gcpKey));
    auth.scopes = [
        'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
        'https://www.googleapis.com/auth/admin.directory.group.readonly',
        'https://www.googleapis.com/auth/admin.directory.user.readonly'
    ];
    auth.subject = directoryConfig.adminEmail;
    return google.admin({ version: 'directory_v1', auth: auth });
}

async function _mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

async function getGoogleWorkspaceGroupMembers(groupName, directoryConfig, cache = {}) {
    const admin = _googleAdmin(directoryConfig);

    // Match the group by exact name from the full group list. This avoids
    // building an Admin SDK query string from user-supplied text.
    if (!cache.googleGroups) {
        const groups = [];
        let pageToken = null;
        do {
            const res = await admin.groups.list({ customer: 'my_customer', maxResults: 200, pageToken });
            groups.push(...(res.data.groups || []));
            pageToken = res.data.nextPageToken;
        } while (pageToken);
        cache.googleGroups = groups;
    }
    const group = cache.googleGroups.find(g => g.name === groupName);
    if (!group) {
        throw new GroupNotFoundError('Google Workspace', groupName);
    }

    let allMembers = [];
    let pageToken = null;
    do {
        const res = await admin.members.list({
            groupKey: group.id,
            maxResults: 200,
            pageToken: pageToken,
        });
        if (res.data.members) {
            allMembers = allMembers.concat(res.data.members.filter(m => m.type === 'USER'));
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    const userDetailsResponses = await _mapWithConcurrency(allMembers, 10, member =>
        admin.users.get({ userKey: member.id, fields: 'name,primaryEmail' })
    );

    return userDetailsResponses.map(res => ({
        email: res.data.primaryEmail,
        firstName: res.data.name?.givenName || '',
        lastName: res.data.name?.familyName || ''
    }));
}

async function getActiveDirectoryGroupMembers(groupName, directoryConfig) {
    const { url, bindDN, bindPassword, searchBase } = directoryConfig;
    const client = new Client({ url: validateLdapUrl(url) });
    try {
        await client.bind(bindDN, bindPassword);

        // Filter objects escape values (RFC 4515), so names like "Sales (EMEA)" work.
        const { searchEntries: groupEntries } = await client.search(searchBase, {
            scope: 'sub',
            filter: new AndFilter({ filters: [
                new EqualityFilter({ attribute: 'objectClass', value: 'group' }),
                new EqualityFilter({ attribute: 'cn', value: groupName }),
            ] }),
            attributes: ['distinguishedName']
        });

        if (groupEntries.length === 0) {
            throw new GroupNotFoundError('Active Directory', groupName);
        }
        const groupDN = groupEntries[0].distinguishedName;

        const { searchEntries: userEntries } = await client.search(searchBase, {
            scope: 'sub',
            filter: new AndFilter({ filters: [
                new EqualityFilter({ attribute: 'objectClass', value: 'user' }),
                new EqualityFilter({ attribute: 'memberOf', value: groupDN }),
            ] }),
            attributes: ['mail', 'givenName', 'sn'],
            paged: true,
        });

        return userEntries.filter(u => u.mail).map(u => ({ 
            email: u.mail,
            firstName: u.givenName || '',
            lastName: u.sn || ''
        }));

    } catch (e) {
        if (e instanceof GroupNotFoundError) throw e;
        console.error(`AD Get Group Members Error for "${groupName}":`, e);
        throw new Error(`Failed to get AD group members: ${e.message}`);
    } finally {
        await client.unbind();
    }
}

async function getEntraIdGroupMembers(groupName, directoryConfig) {
    const graphClient = await getGraphClient(directoryConfig);
    
    const groups = await graphClient.api('/groups')
        .filter(`displayName eq '${_odataString(groupName)}'`)
        .select('id')
        .get();

    if (!groups.value || groups.value.length === 0) {
        throw new GroupNotFoundError('Microsoft Entra ID', groupName);
    }
    const groupId = encodeURIComponent(groups.value[0].id);

    const members = await _graphGetAll(graphClient,
        graphClient.api(`/groups/${groupId}/members/microsoft.graph.user`)
            .select('displayName,mail,givenName,surname,userPrincipalName')
            .top(999));

    return members.map(user => {
        const email = directoryConfig.entraIdEmailField === 'userPrincipalName' ? user.userPrincipalName : user.mail;
        return {
            email: email,
            firstName: user.givenName || '',
            lastName: user.surname || ''
        }
    });
}


async function getDirectoryUsersByGroup(groupName, directoryConfig, cache = {}) {
    console.log(`Fetching users for group "${groupName}" from ${directoryConfig.type}...`);
    let users = [];
    if (directoryConfig.type === 'google') {
        users = await getGoogleWorkspaceGroupMembers(groupName, directoryConfig, cache);
    } else if (directoryConfig.type === 'ad') {
        users = await getActiveDirectoryGroupMembers(groupName, directoryConfig);
    } else if (directoryConfig.type === 'entra') {
        users = await getEntraIdGroupMembers(groupName, directoryConfig);
    } else {
        throw new Error(`Unsupported directory type: ${directoryConfig.type}`);
    }
    console.log(`Found ${users.length} users in group "${groupName}".`);
    return users;
}

const PREVIEW_LIMIT = 200;

function _preview(users) {
    return users.slice(0, PREVIEW_LIMIT).map(u => u.email);
}

/**
 * Runs a sync.
 *
 * @param {object} config  Hydrated config (with secrets).
 * @param {object|boolean} [options]  `{simulate, allowLargeDeactivation}`. A boolean is treated as `simulate`.
 * @param {object} [deps]  Test hooks, e.g. `{getDirectoryUsersByGroup}`.
 */
async function runSync(config, options = {}, deps = {}) {
    const fetchGroupMembers = deps.getDirectoryUsersByGroup || getDirectoryUsersByGroup;
    if (typeof options === 'boolean') options = { simulate: options };
    const { simulate = false, allowLargeDeactivation = false } = options;
    console.log(`Starting synchronization process... (Simulate: ${simulate})`);

    if (!config.syncRole) {
        throw new Error('User Sync Custom Role is not configured. Please select a role in the UI and save.');
    }
    if (!Array.isArray(config.mappings) || config.mappings.length === 0) {
        throw new Error('No group mappings are configured. Add at least one mapping and save.');
    }

    const templateResponse = await _callCcaasApi(config, '/apps/api/v1/bulk/users/template');
    if (!Array.isArray(templateResponse) || templateResponse.length === 0) {
        throw new Error('Failed to fetch user template from CCaaS.');
    }
    const template = templateResponse[0];

    const ccaasUsers = await getAllCcaasUsers(config);
    console.log(`Fetched ${ccaasUsers.length} CCaaS users.`);

    // Any directory error (including a missing group) aborts the whole sync
    // before anything is submitted.
    const cache = {};
    const groupResults = [];
    for (const mapping of config.mappings) {
        const members = await fetchGroupMembers(mapping.group, config.directory, cache);
        groupResults.push({ group: mapping.group, rules: mapping.rules, members });
    }
    const { users: directoryUsers, warnings } = buildDirectoryUsers(groupResults);
    console.log(`Found ${directoryUsers.size} unique users in directory groups.`);

    const plan = computeSyncPlan({ directoryUsers, ccaasUsers, template, syncRole: config.syncRole });
    const usersToAdd = plan.usersToAdd;
    const usersToUpdate = plan.usersToUpdate;
    const usersToDelete = plan.usersToDeactivate;
    const counts = { add: usersToAdd.length, update: usersToUpdate.length, deactivate: usersToDelete.length };
    console.log(`Sync plan: add=${counts.add} update=${counts.update} deactivate=${counts.deactivate} (managed active=${plan.managedActiveCount}).`);

    const preview = { add: _preview(usersToAdd), update: _preview(usersToUpdate), deactivate: _preview(usersToDelete) };
    const safety = config.safety || {};

    let blockedBy = null;
    try {
        assertPlanIsSafe(plan, directoryUsers.size, { maxDeactivations: safety.maxDeactivations, allowLargeDeactivation });
    } catch (error) {
        if (!simulate) throw error;
        blockedBy = error.message;
    }

    const combinedPayload = [...usersToAdd, ...usersToDelete, ...usersToUpdate];
    let jobId = null;
    let message = `Sync complete. Users to add: ${counts.add}, to update: ${counts.update}, to deactivate: ${counts.deactivate}. No changes to submit.`;

    if (combinedPayload.length > 0) {
        if (simulate) {
            message = `Simulation complete. Users to add: ${counts.add}, to update: ${counts.update}, to deactivate: ${counts.deactivate}.`;
            if (blockedBy) message += ` WARNING: a live sync would be blocked: ${blockedBy}`;
        } else {
            console.log("Submitting combined payload to CCaaS bulk upload...");
            const uploadResponse = await _callCcaasUploadApi(config, '/apps/api/v1/bulk/users/upload', combinedPayload);
            jobId = uploadResponse.id;
            console.log(`Successfully submitted job with ID: ${jobId}`);
            
            const initialDelay = Math.min(Math.max(Number(config.schedule?.initialPollDelay) || 15, 5), 60) * 1000;
            console.log(`Waiting ${initialDelay / 1000} seconds before polling...`);
            await new Promise(resolve => setTimeout(resolve, initialDelay));

            let jobState = 'validating'; 
            let finalStateReached = false;
            
            for (let i = 0; i < 60; i++) { 
                const jobStatus = await getCcaasJobStatus(config, jobId);
                console.log(`Polling status for Job ID: ${jobId}... State: ${jobState}, Status: ${jobStatus.status}, Attempt ${i + 1}`);
                
                if (jobStatus.status === 'failed' || jobStatus.status === 'invalid_scheme') {
                    console.error(`Job ID: ${jobId} failed with status: ${jobStatus.status}.`);
                    let errorMessage = `Sync job ${jobId} failed with status '${jobStatus.status}'.`;
                    if (jobStatus.status === 'invalid_scheme') {
                        const schemeErrors = await getCcaasSchemeErrors(config, jobId);
                        if (schemeErrors && schemeErrors.length > 0) {
                            errorMessage += ` First error: ${schemeErrors[0].message}`;
                        }
                    }
                    message = errorMessage;
                    finalStateReached = true;
                    break;
                }

                if (jobState === 'validating') {
                    if (jobStatus.status === 'valid_scheme') {
                        console.log(`Job ID: ${jobId} is ready for processing. Proceeding...`);
                        await proceedCcaasJob(config, jobId);
                        jobState = 'proceeding';
                    }
                } else if (jobState === 'proceeding') {
                    if (jobStatus.status === 'in_progress' || jobStatus.status === 'processing') {
                        console.log(`Job ID: ${jobId} is now in progress.`);
                        jobState = 'finishing';
                    } else if (jobStatus.status === 'finished' || jobStatus.status === 'completed') {
                        console.log(`Job ID: ${jobId} has finished successfully (skipped in_progress).`);
                        message = `Sync job ${jobId} finished successfully. Users to add: ${usersToAdd.length}, to update: ${usersToUpdate.length}, to deactivate: ${usersToDelete.length}.`;
                        finalStateReached = true;
                        break;
                    }
                } else if (jobState === 'finishing') {
                    if (jobStatus.status === 'finished' || jobStatus.status === 'completed') {
                        console.log(`Job ID: ${jobId} has finished successfully.`);
                        message = `Sync job ${jobId} finished successfully. Users to add: ${usersToAdd.length}, to update: ${usersToUpdate.length}, to deactivate: ${usersToDelete.length}.`;
                        finalStateReached = true;
                        break;
                    }
                }
                
                if (!finalStateReached) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
            
            if (!finalStateReached) {
                console.log(`Job ID: ${jobId} timed out. Last state: ${jobState}.`);
                message = `Sync job ${jobId} timed out while in state '${jobState}'. Please check CCaaS job logs.`;
            }
        }
    } else {
        console.log("No users to add or update.");
    }

    return { message, simulate, counts, preview, warnings, blockedBy, jobId };
}


module.exports = {
    runSync,
    getCcaasDetails,
    testCcaasConnection,
    getCcaasJobs,
    testGoogleWorkspaceConnection,
    testActiveDirectoryConnection,
    testEntraIdConnection, 
    getDirectoryGroups,
    proceedCcaasJob,
    getCcaasSchemeErrors,
    getAllCcaasUsers,
    GroupNotFoundError,
    // Exposed for tests.
    _graphGetAll,
    _callCcaasUploadApi,
};

