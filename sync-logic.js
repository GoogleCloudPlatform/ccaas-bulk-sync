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
const { Client } = require('ldapts');
const fetch = require('node-fetch');
const FormData = require('form-data');
const msal = require('@azure/msal-node');
const { Client: GraphClient } = require('@microsoft/microsoft-graph-client');
require("isomorphic-fetch");
const { validateCcaasHost, validateLdapUrl } = require('./config-security');


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
    console.log("Bulk update request body (content of file):", JSON.stringify(usersPayload, null, 2));
    
    const payloadBuffer = Buffer.from(JSON.stringify(usersPayload), 'utf8');
    
    form.append('file', payloadBuffer, {
        filename: 'users.json',
        contentType: 'application/json'
    });

    const options = {
        method: 'POST',
        body: form,
        headers: {
            ...form.getHeaders(),
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
    console.log(`Requesting processing for Job ID: ${jobId}`);
    const response = await _callCcaasApi(config, '/apps/api/v1/bulk/users/proceed', 'POST', { id: jobId });
    console.log(`Successfully requested processing for Job ID: ${jobId}. Response:`, response);
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
            attributes: ['cn']
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
    const groups = await graphClient.api('/groups').select('displayName').get();
    return groups.value.map(g => g.displayName).sort();
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

async function getGoogleWorkspaceGroupMembers(groupName, directoryConfig) {
    const auth = google.auth.fromJSON(JSON.parse(directoryConfig.gcpKey));
    auth.scopes = [
        'https://www.googleapis.com/auth/admin.directory.group.member.readonly', 
        'https://www.googleapis.com/auth/admin.directory.group.readonly',
        'https://www.googleapis.com/auth/admin.directory.user.readonly'
    ];
    auth.subject = directoryConfig.adminEmail;
    const admin = google.admin({ version: 'directory_v1', auth: auth });

    const groupsRes = await admin.groups.list({ customer: 'my_customer', query: `name='${groupName}'` });
    if (!groupsRes.data.groups || groupsRes.data.groups.length === 0) {
        console.warn(`Google Workspace group "${groupName}" not found.`);
        return [];
    }
    const groupKey = groupsRes.data.groups[0].id;

    let allMembers = [];
    let pageToken = null;
    do {
        const res = await admin.members.list({
            groupKey: groupKey,
            maxResults: 200,
            pageToken: pageToken,
        });
        if (res.data.members) {
            const users = res.data.members.filter(m => m.type === 'USER');
            allMembers = allMembers.concat(users);
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    const userDetailsPromises = allMembers.map(member => 
        admin.users.get({ userKey: member.id, fields: 'name,primaryEmail' })
    );
    const userDetailsResponses = await Promise.all(userDetailsPromises);
    
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

        const { searchEntries: groupEntries } = await client.search(searchBase, {
            scope: 'sub',
            filter: `(&(objectClass=group)(cn=${groupName}))`,
            attributes: ['distinguishedName']
        });

        if (groupEntries.length === 0) {
            console.warn(`Active Directory group "${groupName}" not found.`);
            return [];
        }
        const groupDN = groupEntries[0].distinguishedName;

        const { searchEntries: userEntries } = await client.search(searchBase, {
            scope: 'sub',
            filter: `(&(objectClass=user)(memberOf=${groupDN}))`,
            attributes: ['mail', 'givenName', 'sn']
        });

        return userEntries.filter(u => u.mail).map(u => ({ 
            email: u.mail,
            firstName: u.givenName || '',
            lastName: u.sn || ''
        }));

    } catch (e) {
        console.error(`AD Get Group Members Error for "${groupName}":`, e);
        throw new Error(`Failed to get AD group members: ${e.message}`);
    } finally {
        await client.unbind();
    }
}

async function getEntraIdGroupMembers(groupName, directoryConfig) {
    const graphClient = await getGraphClient(directoryConfig);
    
    const groups = await graphClient.api('/groups')
        .filter(`displayName eq '${groupName}'`)
        .select('id')
        .get();

    if (!groups.value || groups.value.length === 0) {
        console.warn(`Entra ID group "${groupName}" not found.`);
        return [];
    }
    const groupId = groups.value[0].id;
    
    const members = await graphClient.api(`/groups/${groupId}/members/microsoft.graph.user`)
        .select('displayName,mail,givenName,surname,userPrincipalName')
        .get();
        
    return members.value.map(user => {
        const email = directoryConfig.entraIdEmailField === 'userPrincipalName' ? user.userPrincipalName : user.mail;
        return {
            email: email,
            firstName: user.givenName || '',
            lastName: user.surname || ''
        }
    });
}


async function getDirectoryUsersByGroup(groupName, directoryConfig) {
    console.log(`Fetching users for group "${groupName}" from ${directoryConfig.type}...`);
    let users = [];
    if (directoryConfig.type === 'google') {
        users = await getGoogleWorkspaceGroupMembers(groupName, directoryConfig);
    } else if (directoryConfig.type === 'ad') {
        users = await getActiveDirectoryGroupMembers(groupName, directoryConfig);
    } else if (directoryConfig.type === 'entra') {
        users = await getEntraIdGroupMembers(groupName, directoryConfig);
    }
    console.log(`Found ${users.length} users in group "${groupName}".`);
    return users;
}

async function runSync(config, simulate = false) {
    console.log(`Starting synchronization process... (Simulate: ${simulate})`);
    
    if (!config.syncRole) {
        throw new Error('User Sync Custom Role is not configured. Please select a role in the UI and save.');
    }

    const templateResponse = await _callCcaasApi(config, '/apps/api/v1/bulk/users/template');
    if (!templateResponse || templateResponse.length === 0) {
        throw new Error('Failed to fetch user template from CCaaS.');
    }
    const emptyUser = { ...templateResponse[0] };
    emptyUser.roles = emptyUser.roles.map(role => ({ ...role, value: 0 }));
    emptyUser.teams = emptyUser.teams.map(team => ({ ...team, value: 0 }));

    const allCcaasUsers = await _callCcaasApi(config, '/apps/api/v1/users');
    
    const currentUserList = allCcaasUsers.filter(user => 
        user.roles?.some(role => role.name === config.syncRole)
    );
    const currentUserMap = new Map(currentUserList.map(user => [user.email, user]));
    console.log(`Found ${currentUserList.length} existing users managed by sync role "${config.syncRole}".`);

    const directoryUserList = new Map();
    for (const mappingGroup of config.mappings) {
        const members = await getDirectoryUsersByGroup(mappingGroup.group, config.directory);
        for (const member of members) {
            if (!directoryUserList.has(member.email)) {
                directoryUserList.set(member.email, {
                    email: member.email,
                    firstName: member.firstName,
                    lastName: member.lastName,
                    teams: [],
                    roles: []
                });
            }
            const user = directoryUserList.get(member.email);
            for(const rule of mappingGroup.rules) {
                 if (rule.type.startsWith('team')) {
                    user.teams.push(rule.value);
                } else {
                    user.roles.push(rule.value);
                }
            }
        }
    }
    console.log(`Found ${directoryUserList.size} unique users in directory groups.`);

    const usersToAdd = [];
    const usersToDelete = [];
    const usersToUpdate = [];

    for (const [email, dirUser] of directoryUserList.entries()) {
        const currentUser = currentUserMap.get(email);
        if (!currentUser || currentUser.deactivated_at !== null) {
            const userToAdd = JSON.parse(JSON.stringify(emptyUser));
            userToAdd.email = email;
            userToAdd.new_email = "";
            userToAdd.first_name = dirUser.firstName;
            userToAdd.last_name = dirUser.lastName;
            userToAdd.status = 'Active';
            userToAdd.agent_number = '';
            userToAdd.location = '';
            userToAdd.alias = '';
            
            const syncRole = userToAdd.roles.find(r => r.name === config.syncRole);
            if (syncRole) syncRole.value = 1;
            
            dirUser.roles.forEach(roleName => {
                const role = userToAdd.roles.find(r => r.name === roleName);
                if (role) role.value = 1;
            });
            if (dirUser.teams.length > 0) {
                 const teamName = dirUser.teams[0];
                 const team = userToAdd.teams.find(t => t.name === teamName);
                 if (team) team.value = 1;
            }
            usersToAdd.push(userToAdd);
        }
    }

    for (const [email, currentUser] of currentUserMap.entries()) {
        if (currentUser.deactivated_at === null && !directoryUserList.has(email)) {
            const userToDelete = JSON.parse(JSON.stringify(currentUser));
            userToDelete.status = 'Inactive';
            delete userToDelete.deactivated_at;
            delete userToDelete.id;
            delete userToDelete.phone_numbers;
            delete userToDelete.extension_numbers;
            usersToDelete.push(userToDelete);
        }
    }

    for (const [email, dirUser] of directoryUserList.entries()) {
        if (currentUserMap.has(email) && currentUserMap.get(email).deactivated_at === null) {
            const currentUser = currentUserMap.get(email);
            const userToUpdate = JSON.parse(JSON.stringify(currentUser));
            
            delete userToUpdate.deactivated_at;
            delete userToUpdate.id;
            if(userToUpdate.phone_numbers) delete userToUpdate.phone_numbers;
            if(userToUpdate.extension_numbers) delete userToUpdate.extension_numbers;


            const currentRoles = (currentUser.roles || []).filter(r => r.name !== config.syncRole).map(r => r.name).sort();
            const targetRoles = dirUser.roles.sort();
            const rolesChanged = JSON.stringify(currentRoles) !== JSON.stringify(targetRoles);

            let currentTeam = '';
            if (currentUser.teams && currentUser.teams.length > 0) {
                 const activeTeam = currentUser.teams.find(t => t.value === 1 || typeof t.value === 'undefined');
                 if(activeTeam) {
                    currentTeam = activeTeam.name;
                 }
            }
            const targetTeam = dirUser.teams[0] || '';
            const teamChanged = currentTeam !== targetTeam;

            if (rolesChanged || teamChanged) {
                userToUpdate.roles = emptyUser.roles.map(r => ({ ...r, value: 0 }));
                userToUpdate.teams = emptyUser.teams.map(t => ({ ...t, value: 0 }));

                const syncRole = userToUpdate.roles.find(r => r.name === config.syncRole);
                if (syncRole) syncRole.value = 1;
                
                targetRoles.forEach(roleName => {
                    const role = userToUpdate.roles.find(r => r.name === roleName);
                    if(role) role.value = 1;
                });
                if(targetTeam) {
                    const team = userToUpdate.teams.find(t => t.name === targetTeam);
                    if(team) team.value = 1;
                }
                usersToUpdate.push(userToUpdate);
            }
        }
    }

    const combinedPayload = [...usersToAdd, ...usersToDelete, ...usersToUpdate].map(user => {
        if (user.hasOwnProperty('max_chat_limit_enabled')) {
            user.max_chat_limit_enabled = user.max_chat_limit_enabled ? 1 : 0;
        }
        return user;
    });
    
    let jobId = null;
    let message = `Sync complete. Users to add: ${usersToAdd.length}, to update: ${usersToUpdate.length}, to deactivate: ${usersToDelete.length}. No changes to submit.`;

    if (combinedPayload.length > 0) {
        if (simulate) {
            console.log("--- SIMULATION ONLY ---");
            console.log("Simulated Payload:", JSON.stringify(combinedPayload, null, 2));
            message = `Simulation complete. Users to add: ${usersToAdd.length}, to update: ${usersToUpdate.length}, to deactivate: ${usersToDelete.length}.`;
        } else {
            console.log("Submitting combined payload to CCaaS bulk upload...");
            const uploadResponse = await _callCcaasUploadApi(config, '/apps/api/v1/bulk/users/upload', combinedPayload);
            jobId = uploadResponse.id;
            console.log(`Successfully submitted job with ID: ${jobId}`);
            
            const initialDelay = (config.schedule.initialPollDelay || 15) * 1000;
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
    
    return { message };
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
    getCcaasSchemeErrors
};

