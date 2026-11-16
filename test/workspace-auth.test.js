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
const { getKeylessAccessToken, getDirectoryClient, SCOPES, _clearTokenCacheForTests } = require('../workspace-auth');

const SA = 'ccaas-sync-sa@proj.iam.gserviceaccount.com';
const ADMIN = 'admin@example.com';

function deps({ tokenResponse = { access_token: 'tok-1', expires_in: 3600 }, ok = true, status = 200, signError = null, now = 1_800_000_000_000 } = {}) {
    const calls = { sign: [], fetch: [] };
    return {
        calls,
        now: () => now,
        signJwt: async (sa, claims) => { if (signError) throw signError; calls.sign.push({ sa, claims }); return 'signed.jwt.value'; },
        fetch: async (url, opts) => { calls.fetch.push({ url, opts }); return { ok, status, json: async () => tokenResponse }; },
    };
}

test.beforeEach(() => _clearTokenCacheForTests());

test('keyless: signs DWD claims as the service account and exchanges them for a token', async () => {
    const d = deps();
    const token = await getKeylessAccessToken({ serviceAccount: SA, subject: ADMIN }, d);
    assert.strictEqual(token, 'tok-1');
    const { sa, claims } = d.calls.sign[0];
    assert.strictEqual(sa, SA);
    assert.strictEqual(claims.iss, SA);
    assert.strictEqual(claims.sub, ADMIN);
    assert.strictEqual(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.strictEqual(claims.scope, SCOPES.join(' '));
    assert.strictEqual(claims.exp - claims.iat, 3600);
    const body = new URLSearchParams(d.calls.fetch[0].opts.body);
    assert.strictEqual(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.strictEqual(body.get('assertion'), 'signed.jwt.value');
});

test('keyless: tokens are cached until close to expiry', async () => {
    const d = deps();
    await getKeylessAccessToken({ serviceAccount: SA, subject: ADMIN }, d);
    await getKeylessAccessToken({ serviceAccount: SA, subject: ADMIN }, d);
    assert.strictEqual(d.calls.sign.length, 1);
    const later = { ...d, now: () => 1_800_000_000_000 + 56 * 60 * 1000 };
    await getKeylessAccessToken({ serviceAccount: SA, subject: ADMIN }, later);
    assert.strictEqual(d.calls.sign.length, 2, 'refreshes within 5 minutes of expiry');
});

test('keyless: helpful errors for missing delegation and missing signJwt permission', async () => {
    await assert.rejects(
        getKeylessAccessToken({ serviceAccount: SA, subject: ADMIN }, deps({ ok: false, status: 401, tokenResponse: { error: 'unauthorized_client', error_description: 'Client is unauthorized' } })),
        /domain-wide delegation/);
    await assert.rejects(
        getKeylessAccessToken({ serviceAccount: SA, subject: ADMIN }, deps({ signError: new Error('PERMISSION_DENIED') })),
        /serviceAccountTokenCreator/);
    await assert.rejects(getKeylessAccessToken({ serviceAccount: '', subject: ADMIN }, deps()), /SERVICE_ACCOUNT/);
});

test('getDirectoryClient uses keyless auth when no key is configured', async () => {
    const d = deps();
    const admin = await getDirectoryClient({ adminEmail: ADMIN }, { ...d, serviceAccount: SA });
    assert.strictEqual(d.calls.sign.length, 1);
    assert.strictEqual(typeof admin.users.list, 'function');
    await assert.rejects(getDirectoryClient({}, d), /Admin Email is required/);
});
