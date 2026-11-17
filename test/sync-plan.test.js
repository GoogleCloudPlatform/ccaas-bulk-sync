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

const test = require('node:test');
const assert = require('node:assert');
const {
    buildDirectoryUsers,
    computeSyncPlan,
    assertPlanIsSafe,
    SyncSafetyError,
    normalizeEmail,
} = require('../sync-plan');

const SYNC_ROLE = 'Synced';
const TEMPLATE = {
    email: '', first_name: '', last_name: '',
    roles: [{ name: SYNC_ROLE, value: 0 }, { name: 'Agent', value: 0 }, { name: 'Supervisor', value: 0 }],
    teams: [{ name: 'Sales', value: 0 }, { name: 'Support', value: 0 }],
    max_chat_limit_enabled: true,
};

function ccaasUser(email, { roles = ['Agent'], team = 'Sales', deactivated = false, synced = true } = {}) {
    return {
        id: Math.floor(Math.random() * 1e6),
        email,
        first_name: 'F', last_name: 'L',
        deactivated_at: deactivated ? '2026-01-01T00:00:00Z' : null,
        roles: [...(synced ? [{ name: SYNC_ROLE }] : []), ...roles.map(name => ({ name }))],
        teams: team ? [{ name: team }] : [],
        phone_numbers: ['+1555'],
        max_chat_limit_enabled: false,
    };
}

function dir(groups) {
    return buildDirectoryUsers(groups.map(([group, rules, emails]) => ({
        group,
        rules,
        members: emails.map(email => ({ email, firstName: 'F', lastName: 'L' })),
    })));
}

const AGENT_SALES = [{ type: 'role', value: 'Agent' }, { type: 'team', value: 'Sales' }];

test('normalizeEmail trims and lowercases', () => {
    assert.strictEqual(normalizeEmail('  John.Doe@Example.COM '), 'john.doe@example.com');
    assert.strictEqual(normalizeEmail(undefined), '');
});

test('new directory user is added with sync role, roles and team', () => {
    const { users } = dir([['g', AGENT_SALES, ['new@x.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.strictEqual(plan.usersToAdd.length, 1);
    const u = plan.usersToAdd[0];
    assert.strictEqual(u.email, 'new@x.com');
    assert.deepStrictEqual(u.roles.filter(r => r.value === 1).map(r => r.name).sort(), ['Agent', SYNC_ROLE]);
    assert.deepStrictEqual(u.teams.filter(t => t.value === 1).map(t => t.name), ['Sales']);
    assert.strictEqual(u.max_chat_limit_enabled, 1);
});

test('email matching is case-insensitive (no add + deactivate for the same person)', () => {
    const { users } = dir([['g', AGENT_SALES, ['John@X.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [ccaasUser('john@x.com')], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.strictEqual(plan.usersToAdd.length, 0);
    assert.strictEqual(plan.usersToDeactivate.length, 0);
    assert.strictEqual(plan.usersToUpdate.length, 0);
});

test('user in two groups mapping the same role does not cause an update every run', () => {
    const { users } = dir([['g1', AGENT_SALES, ['a@x.com']], ['g2', [{ type: 'role', value: 'Agent' }], ['a@x.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [ccaasUser('a@x.com')], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.strictEqual(plan.usersToUpdate.length, 0);
});

test('role change produces an update without read-only fields', () => {
    const { users } = dir([['g', [{ type: 'role', value: 'Supervisor' }, { type: 'team', value: 'Sales' }], ['a@x.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [ccaasUser('a@x.com')], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.strictEqual(plan.usersToUpdate.length, 1);
    const u = plan.usersToUpdate[0];
    assert.strictEqual(u.id, undefined);
    assert.strictEqual(u.phone_numbers, undefined);
    assert.strictEqual(u.deactivated_at, undefined);
    assert.deepStrictEqual(u.roles.filter(r => r.value === 1).map(r => r.name).sort(), ['Supervisor', SYNC_ROLE]);
});

test('managed user missing from directory is deactivated; unmanaged users are ignored', () => {
    const { users } = dir([['g', AGENT_SALES, ['keep@x.com']]]);
    const ccaas = [ccaasUser('keep@x.com'), ccaasUser('leaver@x.com'), ccaasUser('manual@x.com', { synced: false }), ccaasUser('old@x.com', { deactivated: true })];
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: ccaas, template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.deepStrictEqual(plan.usersToDeactivate.map(u => u.email), ['leaver@x.com']);
    assert.strictEqual(plan.usersToDeactivate[0].status, 'Inactive');
    assert.strictEqual(plan.managedActiveCount, 2);
});

test('previously deactivated managed user who is back in the directory is re-added', () => {
    const { users } = dir([['g', AGENT_SALES, ['back@x.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [ccaasUser('back@x.com', { deactivated: true })], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.strictEqual(plan.usersToAdd.length, 1);
});

test('roles and teams accumulate across all mappings a user matches', () => {
    const { users, warnings } = dir([
        ['g1', [{ type: 'team', value: 'Sales' }, { type: 'role', value: 'Agent' }], ['a@x.com']],
        ['g2', [{ type: 'team', value: 'Support' }, { type: 'role', value: 'Supervisor' }], ['a@x.com']],
    ]);
    assert.deepStrictEqual(warnings, []);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [], template: TEMPLATE, syncRole: SYNC_ROLE });
    const u = plan.usersToAdd[0];
    assert.deepStrictEqual(u.teams.filter(t => t.value === 1).map(t => t.name).sort(), ['Sales', 'Support']);
    assert.deepStrictEqual(u.roles.filter(r => r.value === 1).map(r => r.name).sort(), ['Agent', 'Supervisor', SYNC_ROLE]);
});

test('team set changes are detected; unchanged team sets do not update', () => {
    const both = dir([['g1', AGENT_SALES, ['a@x.com']], ['g2', [{ type: 'team', value: 'Support' }], ['a@x.com']]]);
    const inSales = ccaasUser('a@x.com', { team: 'Sales' });
    assert.strictEqual(computeSyncPlan({ directoryUsers: both.users, ccaasUsers: [inSales], template: TEMPLATE, syncRole: SYNC_ROLE }).usersToUpdate.length, 1, 'adds Support');
    const inBoth = { ...inSales, teams: [{ name: 'Support' }, { name: 'Sales' }] };
    assert.strictEqual(computeSyncPlan({ directoryUsers: both.users, ccaasUsers: [inBoth], template: TEMPLATE, syncRole: SYNC_ROLE }).usersToUpdate.length, 0);
});

test('existing unmanaged CCaaS users are skipped and reported by default', () => {
    const { users } = dir([['g', AGENT_SALES, ['Manual@x.com', 'new@x.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [ccaasUser('manual@x.com', { synced: false, roles: ['Supervisor'] })], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.deepStrictEqual(plan.usersSkipped, [{ email: 'manual@x.com', reason: 'exists_unmanaged' }]);
    assert.deepStrictEqual(plan.usersToAdd.map(u => u.email), ['new@x.com']);
    assert.strictEqual(plan.usersToUpdate.length, 0);
});

test('existingUsers=adopt gives existing users the sync role and mapped roles/teams', () => {
    const { users } = dir([['g', AGENT_SALES, ['manual@x.com']]]);
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [ccaasUser('manual@x.com', { synced: false, roles: ['Supervisor'], team: 'Support' })], template: TEMPLATE, syncRole: SYNC_ROLE, options: { existingUsers: 'adopt' } });
    assert.strictEqual(plan.adoptedCount, 1);
    assert.strictEqual(plan.usersToUpdate.length, 1);
    const u = plan.usersToUpdate[0];
    assert.deepStrictEqual(u.roles.filter(r => r.value === 1).map(r => r.name).sort(), ['Agent', SYNC_ROLE]);
    assert.deepStrictEqual(u.teams.filter(t => t.value === 1).map(t => t.name), ['Sales']);
    assert.strictEqual(u.id, undefined);
});

test('name changes are synced (never blanked), and can be turned off', () => {
    const users = new Map([['a@x.com', { email: 'a@x.com', firstName: 'Alicia', lastName: '', teams: new Set(['Sales']), roles: new Set(['Agent']), groups: ['g'] }]]);
    const current = { ...ccaasUser('a@x.com'), first_name: 'Alice', last_name: 'Smith' };
    const plan = computeSyncPlan({ directoryUsers: users, ccaasUsers: [current], template: TEMPLATE, syncRole: SYNC_ROLE });
    assert.strictEqual(plan.usersToUpdate.length, 1);
    assert.strictEqual(plan.usersToUpdate[0].first_name, 'Alicia');
    assert.strictEqual(plan.usersToUpdate[0].last_name, 'Smith', 'empty directory last name keeps the CCaaS value');
    const off = computeSyncPlan({ directoryUsers: users, ccaasUsers: [current], template: TEMPLATE, syncRole: SYNC_ROLE, options: { syncNames: false } });
    assert.strictEqual(off.usersToUpdate.length, 0);
});

test('safety: empty directory with managed users is always blocked', () => {
    const plan = { usersToDeactivate: [{}, {}], managedActiveCount: 2 };
    assert.throws(() => assertPlanIsSafe(plan, 0, { maxDeactivations: 100, allowLargeDeactivation: true }), SyncSafetyError);
});

test('safety: deactivations over the limit are blocked unless overridden', () => {
    const plan = { usersToDeactivate: new Array(26).fill({}), managedActiveCount: 100 };
    assert.throws(() => assertPlanIsSafe(plan, 74, {}), /exceeds the safety limit of 25/);
    assert.doesNotThrow(() => assertPlanIsSafe(plan, 74, { allowLargeDeactivation: true }));
    assert.doesNotThrow(() => assertPlanIsSafe(plan, 74, { maxDeactivations: 30 }));
});

test('safety: limit 0 blocks any deactivation', () => {
    assert.throws(() => assertPlanIsSafe({ usersToDeactivate: [{}], managedActiveCount: 5 }, 4, { maxDeactivations: 0 }), SyncSafetyError);
    assert.doesNotThrow(() => assertPlanIsSafe({ usersToDeactivate: [], managedActiveCount: 5 }, 5, { maxDeactivations: 0 }));
});
