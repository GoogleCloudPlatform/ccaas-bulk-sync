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

// --- Fakes -------------------------------------------------------------------

/** Minimal in-memory Firestore with serialized transactions. */
function fakeFirestore() {
    const docs = new Map();
    let chain = Promise.resolve();
    const ref = (key) => ({ key });
    return {
        docs,
        collection: (c) => ({ doc: (d) => ref(`${c}/${d}`) }),
        runTransaction(fn) {
            const run = chain.then(() => fn({
                get: async (r) => ({ exists: docs.has(r.key), data: () => docs.get(r.key) }),
                set: (r, v) => docs.set(r.key, v),
                delete: (r) => docs.delete(r.key),
            }));
            chain = run.catch(() => {});
            return run;
        },
    };
}

// Stub the global fetch (Node.js 22 built-in) that sync-logic uses.
const fetchCalls = [];
let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
    fetchCalls.push(url);
    return fetchHandler(url, options);
};
test.after(() => { globalThis.fetch = realFetch; });
const syncLogic = require('../sync-logic');
const { acquireSyncLock, SyncInProgressError } = require('../sync-lock');

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const CONFIG = { ccaas: { host: 'acme.ccaiplatform.com', apiKey: 'k' } };

// --- Lock --------------------------------------------------------------------

test('sync lock: second acquire fails while the first is held, succeeds after release', async () => {
    const fs = fakeFirestore();
    const lock = await acquireSyncLock(fs, { startedBy: 'a' });
    await assert.rejects(acquireSyncLock(fs, { startedBy: 'b' }), SyncInProgressError);
    await lock.release();
    const lock2 = await acquireSyncLock(fs, { startedBy: 'b' });
    await lock2.release();
});

test('sync lock: concurrent acquires, only one wins', async () => {
    const fs = fakeFirestore();
    const results = await Promise.allSettled([acquireSyncLock(fs), acquireSyncLock(fs), acquireSyncLock(fs)]);
    assert.strictEqual(results.filter(r => r.status === 'fulfilled').length, 1);
});

test('sync lock: expired lease can be taken over', async () => {
    const fs = fakeFirestore();
    await acquireSyncLock(fs, { leaseMs: -1 });
    const lock = await acquireSyncLock(fs);
    await lock.release();
});

test('sync lock: stale holder release does not remove a newer lock', async () => {
    const fs = fakeFirestore();
    const stale = await acquireSyncLock(fs, { leaseMs: -1 });
    const fresh = await acquireSyncLock(fs);
    await stale.release();
    await assert.rejects(acquireSyncLock(fs), SyncInProgressError);
    await fresh.release();
});

// --- Pagination --------------------------------------------------------------

test('getAllCcaasUsers follows pages until an empty page', async () => {
    fetchCalls.length = 0;
    fetchHandler = async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        const size = page <= 3 ? 1000 : (page === 4 ? 7 : 0);
        return jsonResponse(Array.from({ length: size }, (_, i) => ({ id: `${page}-${i}`, email: `u${page}-${i}@x.com` })));
    };
    const users = await syncLogic.getAllCcaasUsers(CONFIG);
    assert.strictEqual(users.length, 3007);
    assert.strictEqual(fetchCalls.length, 5);
    assert.match(fetchCalls[0], /^https:\/\/acme\.ccaiplatform\.com\/apps\/api\/v1\/users\?page=1&per=1000$/);
});

test('getAllCcaasUsers handles an API that caps the page size below `per` (e.g. 100)', async () => {
    fetchHandler = async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        const size = page <= 2 ? 100 : (page === 3 ? 42 : 0);
        return jsonResponse(Array.from({ length: size }, (_, i) => ({ id: `${page}-${i}` })));
    };
    const users = await syncLogic.getAllCcaasUsers(CONFIG);
    assert.strictEqual(users.length, 242);
});

test('getAllCcaasUsers aborts if the API ignores the page parameter', async () => {
    fetchHandler = async () => jsonResponse([{ id: 1 }, { id: 2 }]);
    await assert.rejects(syncLogic.getAllCcaasUsers(CONFIG), /same page twice/);
});

test('getAllCcaasUsers rejects a non-array response', async () => {
    fetchHandler = async () => jsonResponse({ error: 'nope' });
    await assert.rejects(syncLogic.getAllCcaasUsers(CONFIG), /expected an array/);
});

test('Graph pagination follows @odata.nextLink', async () => {
    const pages = {
        next1: { value: [{ id: 3 }], '@odata.nextLink': 'next2' },
        next2: { value: [{ id: 4 }] },
    };
    const graphClient = { api: (link) => ({ get: async () => pages[link] }) };
    const first = { get: async () => ({ value: [{ id: 1 }, { id: 2 }], '@odata.nextLink': 'next1' }) };
    const items = await syncLogic._graphGetAll(graphClient, first);
    assert.deepStrictEqual(items.map(i => i.id), [1, 2, 3, 4]);
});

// --- runSync safety integration ----------------------------------------------

function stubCcaas({ users }) {
    fetchHandler = async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/bulk/users/template')) {
            return jsonResponse([{ roles: [{ name: 'Synced', value: 0 }, { name: 'Agent', value: 0 }], teams: [{ name: 'Sales', value: 0 }] }]);
        }
        if (u.pathname.endsWith('/apps/api/v1/users')) {
            return jsonResponse(Number(u.searchParams.get('page')) === 1 ? users : []);
        }
        throw new Error(`Unexpected fetch ${url}`);
    };
}

const USERS_30 = Array.from({ length: 30 }, (_, i) => ({ email: `u${i}@x.com`, deactivated_at: null, roles: [{ name: 'Synced' }], teams: [] }));
const BASE = { ...CONFIG, syncRole: 'Synced', schedule: { initialPollDelay: 5 }, mappings: [{ group: 'g', rules: [] }], directory: { type: 'ad' } };

test('runSync (live) is blocked over the deactivation limit and uploads nothing', async () => {
    stubCcaas({ users: USERS_30 });
    fetchCalls.length = 0;
    const deps = { getDirectoryUsersByGroup: async () => [{ email: 'u0@x.com' }] }; // 29 would be deactivated
    await assert.rejects(
        syncLogic.runSync({ ...BASE, safety: { maxDeactivations: 5 } }, { simulate: false }, deps),
        (e) => e.name === 'SyncSafetyError' && /deactivate 29 users/.test(e.message));
    assert.ok(!fetchCalls.some(u => u.includes('/bulk/users/upload')));
});

test('runSync (simulate) reports what would be blocked and returns a preview', async () => {
    stubCcaas({ users: USERS_30 });
    const deps = { getDirectoryUsersByGroup: async () => [{ email: 'U0@X.com' }, { email: 'new@x.com' }] };
    const result = await syncLogic.runSync({ ...BASE, safety: { maxDeactivations: 5 } }, { simulate: true }, deps);
    assert.deepStrictEqual(result.counts, { add: 1, update: 0, deactivate: 29, skipped: 0 });
    assert.match(result.blockedBy, /exceeds the safety limit of 5/);
    assert.deepStrictEqual(result.preview.add, ['new@x.com']);
});

test('runSync aborts when a mapped group is not found', async () => {
    stubCcaas({ users: USERS_30 });
    const deps = { getDirectoryUsersByGroup: async (g) => { throw new syncLogic.GroupNotFoundError('Active Directory', g); } };
    await assert.rejects(syncLogic.runSync(BASE, { simulate: false }, deps), syncLogic.GroupNotFoundError);
});

test('runSync aborts when the directory returns no users at all', async () => {
    stubCcaas({ users: USERS_30 });
    const deps = { getDirectoryUsersByGroup: async () => [] };
    await assert.rejects(
        syncLogic.runSync({ ...BASE, safety: { maxDeactivations: 1000 } }, { simulate: false, allowLargeDeactivation: true }, deps),
        /returned no users/);
});

test('bulk upload sends a multipart file named users.json with Basic auth', async () => {
    let captured;
    fetchHandler = async (url, options) => { captured = { url, options }; return jsonResponse({ id: 'job-1' }); };
    const { _callCcaasUploadApi } = syncLogic;
    await _callCcaasUploadApi(CONFIG, '/apps/api/v1/bulk/users/upload', [{ email: 'a@x.com' }]);
    assert.match(captured.url, /\/apps\/api\/v1\/bulk\/users\/upload$/);
    assert.match(captured.options.headers.Authorization, /^Basic /);
    assert.ok(captured.options.body instanceof FormData);
    const file = captured.options.body.get('file');
    assert.strictEqual(file.name, 'users.json');
    assert.strictEqual(file.type, 'application/json');
    assert.deepStrictEqual(JSON.parse(await file.text()), [{ email: 'a@x.com' }]);
});

test('nested groups: AD uses the in-chain matching rule, Entra uses transitiveMembers', () => {
    const dn = 'CN=Sales (EMEA),OU=Groups,DC=x,DC=com';
    assert.strictEqual(syncLogic._adMemberOfFilter(dn, false).toString(), '(memberOf=CN=Sales \\28EMEA\\29,OU=Groups,DC=x,DC=com)');
    assert.strictEqual(syncLogic._adMemberOfFilter(dn, true).toString(), '(memberOf:1.2.840.113556.1.4.1941:=CN=Sales \\28EMEA\\29,OU=Groups,DC=x,DC=com)');
    assert.strictEqual(syncLogic._entraMembersPath('g1', false), '/groups/g1/members/microsoft.graph.user');
    assert.strictEqual(syncLogic._entraMembersPath('g1', true), '/groups/g1/transitiveMembers/microsoft.graph.user');
});

test('runSync passes each mapping\'s includeNested setting to the directory lookup', async () => {
    stubCcaas({ users: USERS_30 });
    const seen = [];
    const deps = { getDirectoryUsersByGroup: async (g, _dir, _cache, opts) => { seen.push([g, opts.includeNested]); return USERS_30.map(u => ({ email: u.email })); } };
    const config = { ...BASE, mappings: [{ group: 'flat', rules: [] }, { group: 'nested', rules: [], includeNested: true }] };
    await syncLogic.runSync(config, { simulate: true }, deps);
    assert.deepStrictEqual(seen, [['flat', false], ['nested', true]]);
});
