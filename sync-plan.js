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
 * Pure functions that work out which users to add, update and deactivate.
 * Nothing here does I/O, so it can be unit-tested directly.
 */

const DEFAULT_MAX_DEACTIVATIONS = 25;

class SyncSafetyError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SyncSafetyError';
        this.details = details;
    }
}

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Merges the members of each mapped group into one entry per user (keyed by
 * normalized email) and collects the roles and teams their mappings grant.
 *
 * @param {Array<{group: string, rules: Array<{type: string, value: string}>, members: Array}>} groupResults
 * @return {{users: Map<string, object>, warnings: string[]}}
 */
function buildDirectoryUsers(groupResults) {
    const users = new Map();
    const warnings = [];
    for (const { group, rules, members } of groupResults) {
        for (const member of members) {
            const key = normalizeEmail(member.email);
            if (!key) continue;
            if (!users.has(key)) {
                users.set(key, {
                    email: member.email.trim(),
                    firstName: member.firstName || '',
                    lastName: member.lastName || '',
                    teams: [],
                    roles: new Set(),
                    groups: [],
                });
            }
            const user = users.get(key);
            user.groups.push(group);
            for (const rule of rules || []) {
                if (!rule || !rule.value) continue;
                if (String(rule.type || '').startsWith('team')) {
                    if (!user.teams.includes(rule.value)) user.teams.push(rule.value);
                } else {
                    user.roles.add(rule.value);
                }
            }
        }
    }
    for (const [, user] of users) {
        if (user.teams.length > 1) {
            warnings.push(`${user.email} matches multiple teams (${user.teams.join(', ')}); only "${user.teams[0]}" is applied.`);
        }
    }
    return { users, warnings };
}

function _isActive(ccaasUser) {
    return ccaasUser.deactivated_at === null || ccaasUser.deactivated_at === undefined;
}

function _stripReadOnlyFields(user) {
    delete user.deactivated_at;
    delete user.id;
    delete user.phone_numbers;
    delete user.extension_numbers;
    return user;
}

function _applyAssignments(user, template, syncRole, roles, team) {
    user.roles = template.roles.map(r => ({ ...r, value: 0 }));
    user.teams = template.teams.map(t => ({ ...t, value: 0 }));
    const wanted = new Set([syncRole, ...roles]);
    for (const role of user.roles) {
        if (wanted.has(role.name)) role.value = 1;
    }
    if (team) {
        const t = user.teams.find(x => x.name === team);
        if (t) t.value = 1;
    }
    return user;
}

function _currentAssignments(ccaasUser, syncRole) {
    const roles = [...new Set((ccaasUser.roles || [])
        .filter(r => r.name !== syncRole && (r.value === undefined || r.value === 1 || r.value === true))
        .map(r => r.name))].sort();
    const activeTeam = (ccaasUser.teams || []).find(t => t.value === undefined || t.value === 1 || t.value === true);
    return { roles, team: activeTeam ? activeTeam.name : '' };
}

/**
 * Works out the sync plan.
 *
 * @param {object} params
 * @param {Map<string, object>} params.directoryUsers  From buildDirectoryUsers().
 * @param {Array<object>} params.ccaasUsers  All CCaaS users (every page).
 * @param {object} params.template  First entry of the CCaaS bulk user template.
 * @param {string} params.syncRole  The role that marks users managed by this tool.
 * @return {{usersToAdd: object[], usersToUpdate: object[], usersToDeactivate: object[], managedActiveCount: number}}
 */
function computeSyncPlan({ directoryUsers, ccaasUsers, template, syncRole }) {
    if (!template || !Array.isArray(template.roles) || !Array.isArray(template.teams)) {
        throw new Error('Invalid CCaaS user template.');
    }
    const managed = new Map();
    for (const u of ccaasUsers) {
        if ((u.roles || []).some(r => r.name === syncRole)) {
            managed.set(normalizeEmail(u.email), u);
        }
    }

    const usersToAdd = [];
    const usersToUpdate = [];
    const usersToDeactivate = [];

    for (const [key, dirUser] of directoryUsers) {
        const roles = [...dirUser.roles].sort();
        const team = dirUser.teams[0] || '';
        const current = managed.get(key);

        if (!current || !_isActive(current)) {
            const user = JSON.parse(JSON.stringify(template));
            user.email = dirUser.email;
            user.new_email = '';
            user.first_name = dirUser.firstName;
            user.last_name = dirUser.lastName;
            user.status = 'Active';
            user.agent_number = '';
            user.location = '';
            user.alias = '';
            usersToAdd.push(_applyAssignments(user, template, syncRole, roles, team));
            continue;
        }

        const now = _currentAssignments(current, syncRole);
        const rolesChanged = JSON.stringify(now.roles) !== JSON.stringify(roles);
        const teamChanged = now.team !== team;
        if (rolesChanged || teamChanged) {
            const user = _stripReadOnlyFields(JSON.parse(JSON.stringify(current)));
            usersToUpdate.push(_applyAssignments(user, template, syncRole, roles, team));
        }
    }

    let managedActiveCount = 0;
    for (const [key, current] of managed) {
        if (!_isActive(current)) continue;
        managedActiveCount++;
        if (!directoryUsers.has(key)) {
            const user = _stripReadOnlyFields(JSON.parse(JSON.stringify(current)));
            user.status = 'Inactive';
            usersToDeactivate.push(user);
        }
    }

    for (const user of [...usersToAdd, ...usersToUpdate, ...usersToDeactivate]) {
        if (Object.prototype.hasOwnProperty.call(user, 'max_chat_limit_enabled')) {
            user.max_chat_limit_enabled = user.max_chat_limit_enabled ? 1 : 0;
        }
    }

    return { usersToAdd, usersToUpdate, usersToDeactivate, managedActiveCount };
}

/**
 * Throws SyncSafetyError if the plan looks like an accident rather than
 * normal joiner/leaver churn.
 *
 * @param {object} plan  From computeSyncPlan().
 * @param {number} directoryUserCount
 * @param {object} options
 * @param {number} [options.maxDeactivations]  Max deactivations per run (default 25). 0 = no deactivations.
 * @param {boolean} [options.allowLargeDeactivation]  Admin override for a single manual run.
 */
function assertPlanIsSafe(plan, directoryUserCount, { maxDeactivations, allowLargeDeactivation = false } = {}) {
    const limit = Number.isInteger(maxDeactivations) && maxDeactivations >= 0 ? maxDeactivations : DEFAULT_MAX_DEACTIVATIONS;
    const count = plan.usersToDeactivate.length;

    if (directoryUserCount === 0 && plan.managedActiveCount > 0) {
        throw new SyncSafetyError(
            `The directory returned no users for any mapped group, which would deactivate all ${plan.managedActiveCount} managed users. Sync aborted.`,
            { reason: 'empty_directory', deactivations: count });
    }
    if (count > limit && !allowLargeDeactivation) {
        throw new SyncSafetyError(
            `This sync would deactivate ${count} users, which exceeds the safety limit of ${limit}. Review with a simulation, then re-run manually and confirm, or raise the limit.`,
            { reason: 'deactivation_limit', deactivations: count, limit });
    }
}

module.exports = {
    DEFAULT_MAX_DEACTIVATIONS,
    SyncSafetyError,
    normalizeEmail,
    buildDirectoryUsers,
    computeSyncPlan,
    assertPlanIsSafe,
};
