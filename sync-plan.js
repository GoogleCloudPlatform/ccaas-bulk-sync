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
                    teams: new Set(),
                    roles: new Set(),
                    groups: [],
                });
            }
            const user = users.get(key);
            user.groups.push(group);
            for (const rule of rules || []) {
                if (!rule || !rule.value) continue;
                if (String(rule.type || '').startsWith('team')) {
                    user.teams.add(rule.value);
                } else {
                    user.roles.add(rule.value);
                }
            }
        }
    }
    // Roles and teams accumulate: a user gets every role and joins every team
    // from every mapping whose group they are in.
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

function _isOn(entry) {
    return entry.value === undefined || entry.value === 1 || entry.value === true;
}

function _applyAssignments(user, template, syncRole, roles, teams) {
    user.roles = template.roles.map(r => ({ ...r, value: 0 }));
    user.teams = template.teams.map(t => ({ ...t, value: 0 }));
    const wantedRoles = new Set([syncRole, ...roles]);
    const wantedTeams = new Set(teams);
    for (const role of user.roles) {
        if (wantedRoles.has(role.name)) role.value = 1;
    }
    for (const team of user.teams) {
        if (wantedTeams.has(team.name)) team.value = 1;
    }
    return user;
}

function _currentAssignments(ccaasUser, syncRole) {
    const roles = [...new Set((ccaasUser.roles || []).filter(r => r.name !== syncRole && _isOn(r)).map(r => r.name))].sort();
    const teams = [...new Set((ccaasUser.teams || []).filter(_isOn).map(t => t.name))].sort();
    return { roles, teams };
}

function _norm(s) {
    return typeof s === 'string' ? s.trim() : '';
}

/** Name fields to update; an empty directory value never blanks a CCaaS name. */
function _nameChanges(current, dirUser) {
    const changes = {};
    const first = _norm(dirUser.firstName);
    const last = _norm(dirUser.lastName);
    if (first && first !== _norm(current.first_name)) changes.first_name = first;
    if (last && last !== _norm(current.last_name)) changes.last_name = last;
    return changes;
}

const DEFAULT_SYNC_OPTIONS = { existingUsers: 'skip', syncNames: true };

/**
 * Works out the sync plan.
 *
 * Roles and teams accumulate across all mappings a user matches. Users who
 * exist in CCaaS but aren't managed by this tool (no sync role) are skipped
 * and reported by default; with existingUsers = 'adopt' they get the sync
 * role and become managed (their roles and teams are then set from the
 * mappings).
 *
 * @param {object} params
 * @param {Map<string, object>} params.directoryUsers  From buildDirectoryUsers().
 * @param {Array<object>} params.ccaasUsers  All CCaaS users (every page).
 * @param {object} params.template  First entry of the CCaaS bulk user template.
 * @param {string} params.syncRole  The role that marks users managed by this tool.
 * @param {{existingUsers?: 'skip'|'adopt', syncNames?: boolean}} [params.options]
 */
function computeSyncPlan({ directoryUsers, ccaasUsers, template, syncRole, options = {} }) {
    if (!template || !Array.isArray(template.roles) || !Array.isArray(template.teams)) {
        throw new Error('Invalid CCaaS user template.');
    }
    const opts = { ...DEFAULT_SYNC_OPTIONS, ...options };
    const isManaged = (u) => (u.roles || []).some(r => r.name === syncRole);

    // Index every CCaaS user by email; prefer an active, managed record if there are duplicates.
    const byEmail = new Map();
    const rank = (u) => (isManaged(u) ? 2 : 0) + (_isActive(u) ? 1 : 0);
    for (const u of ccaasUsers) {
        const key = normalizeEmail(u.email);
        if (!key) continue;
        const existing = byEmail.get(key);
        if (!existing || rank(u) > rank(existing)) byEmail.set(key, u);
    }

    const usersToAdd = [];
    const usersToUpdate = [];
    const usersToDeactivate = [];
    const usersSkipped = [];
    // Human-readable change details for the simulation preview (never sent to CCaaS).
    const details = [];
    let adoptedCount = 0;
    const diff = (before, after) => ({ added: after.filter(x => !before.includes(x)), removed: before.filter(x => !after.includes(x)) });

    const newUser = (dirUser, roles, teams) => {
        const user = JSON.parse(JSON.stringify(template));
        user.email = dirUser.email;
        user.new_email = '';
        user.first_name = dirUser.firstName;
        user.last_name = dirUser.lastName;
        user.status = 'Active';
        user.agent_number = '';
        user.location = '';
        user.alias = '';
        return _applyAssignments(user, template, syncRole, roles, teams);
    };

    for (const [key, dirUser] of directoryUsers) {
        const roles = [...dirUser.roles].sort();
        const teams = [...dirUser.teams].sort();
        const current = byEmail.get(key);

        if (!current) {
            usersToAdd.push(newUser(dirUser, roles, teams));
            details.push({ action: 'add', email: dirUser.email, roles, teams });
            continue;
        }

        if (!isManaged(current)) {
            if (opts.existingUsers !== 'adopt') {
                usersSkipped.push({ email: current.email, reason: _isActive(current) ? 'exists_unmanaged' : 'exists_unmanaged_inactive' });
                continue;
            }
            adoptedCount++;
            if (!_isActive(current)) {
                usersToAdd.push(newUser(dirUser, roles, teams));
                details.push({ action: 'add', email: dirUser.email, roles, teams, note: 'adopted (reactivated)' });
                continue;
            }
            const before = _currentAssignments(current, syncRole);
            const names = opts.syncNames ? _nameChanges(current, dirUser) : {};
            const user = _stripReadOnlyFields(JSON.parse(JSON.stringify(current)));
            Object.assign(user, names);
            usersToUpdate.push(_applyAssignments(user, template, syncRole, roles, teams));
            details.push({ action: 'update', email: current.email, note: 'adopted', roles: diff(before.roles, roles), teams: diff(before.teams, teams), names });
            continue;
        }

        if (!_isActive(current)) {
            usersToAdd.push(newUser(dirUser, roles, teams));
            details.push({ action: 'add', email: dirUser.email, roles, teams, note: 'reactivated' });
            continue;
        }

        const now = _currentAssignments(current, syncRole);
        const rolesChanged = JSON.stringify(now.roles) !== JSON.stringify(roles);
        const teamsChanged = JSON.stringify(now.teams) !== JSON.stringify(teams);
        const names = opts.syncNames ? _nameChanges(current, dirUser) : {};
        if (rolesChanged || teamsChanged || Object.keys(names).length > 0) {
            const user = _stripReadOnlyFields(JSON.parse(JSON.stringify(current)));
            Object.assign(user, names);
            usersToUpdate.push(_applyAssignments(user, template, syncRole, roles, teams));
            details.push({ action: 'update', email: current.email, roles: diff(now.roles, roles), teams: diff(now.teams, teams), names });
        }
    }

    let managedActiveCount = 0;
    for (const [key, current] of byEmail) {
        if (!isManaged(current) || !_isActive(current)) continue;
        managedActiveCount++;
        if (!directoryUsers.has(key)) {
            const user = _stripReadOnlyFields(JSON.parse(JSON.stringify(current)));
            user.status = 'Inactive';
            usersToDeactivate.push(user);
            details.push({ action: 'deactivate', email: current.email });
        }
    }

    for (const user of [...usersToAdd, ...usersToUpdate, ...usersToDeactivate]) {
        if (Object.prototype.hasOwnProperty.call(user, 'max_chat_limit_enabled')) {
            user.max_chat_limit_enabled = user.max_chat_limit_enabled ? 1 : 0;
        }
    }

    for (const s of usersSkipped) details.push({ action: 'skip', email: s.email, note: s.reason });

    return { usersToAdd, usersToUpdate, usersToDeactivate, usersSkipped, adoptedCount, managedActiveCount, details };
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
    DEFAULT_SYNC_OPTIONS,
    SyncSafetyError,
    normalizeEmail,
    buildDirectoryUsers,
    computeSyncPlan,
    assertPlanIsSafe,
};
