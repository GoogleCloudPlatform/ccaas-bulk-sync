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
const crypto = require('node:crypto');
const auth = require('../auth');

const AUDIENCE = '/projects/123/global/backendServices/456';
const SA = 'ccaas-sync-sa@proj.iam.gserviceaccount.com';
const KID = 'test-kid';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const { privateKey: otherKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

function b64(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signEs256(payload, key = privateKey) {
    const header = b64({ alg: 'ES256', typ: 'JWT', kid: KID });
    const body = b64(payload);
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    return `${header}.${body}.${sig.toString('base64url')}`;
}

function iapPayload(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: 'https://cloud.google.com/iap', aud: AUDIENCE, sub: 'accounts.google.com:1', email: 'admin@example.com', iat: now, exp: now + 600, ...overrides };
}

function strippedSchedulerToken(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: 'https://accounts.google.com', email: SA, email_verified: true, aud: 'https://svc.run.app', iat: now, exp: now + 600, ...overrides };
    return `Bearer ${b64({ alg: 'RS256' })}.${b64(payload)}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

function run(req) {
    const headers = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const fullReq = { method: 'GET', path: '/config', originalUrl: '/api/config', ...req, get: (h) => headers[h.toLowerCase()] };
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            send() { resolve({ nextCalled: false, status: this.statusCode }); },
        };
        auth.requireAuth(fullReq, res, () => resolve({ nextCalled: true, user: fullReq.user }));
    });
}

test.beforeEach(() => {
    process.env.IAP_AUDIENCE = AUDIENCE;
    process.env.SERVICE_ACCOUNT = SA;
    delete process.env.ALLOW_INSECURE_LOCAL_DEV;
    delete process.env.K_SERVICE;
    auth._setIapKeysForTests({ [KID]: publicKey.export({ type: 'spki', format: 'pem' }) });
});

test('b/585246936: request with no credentials is rejected', async () => {
    const r = await run({ headers: {} });
    assert.strictEqual(r.nextCalled, false);
    assert.strictEqual(r.status, 401);
});

test('valid IAP JWT is accepted', async () => {
    const r = await run({ headers: { 'x-goog-iap-jwt-assertion': signEs256(iapPayload()) } });
    assert.strictEqual(r.nextCalled, true);
    assert.strictEqual(r.user.email, 'admin@example.com');
});

test('IAP JWT signed with wrong key is rejected', async () => {
    const r = await run({ headers: { 'x-goog-iap-jwt-assertion': signEs256(iapPayload(), otherKey) } });
    assert.strictEqual(r.status, 401);
});

test('IAP JWT with wrong audience is rejected', async () => {
    const r = await run({ headers: { 'x-goog-iap-jwt-assertion': signEs256(iapPayload({ aud: '/projects/9/global/backendServices/9' })) } });
    assert.strictEqual(r.status, 401);
});

test('expired IAP JWT is rejected', async () => {
    const r = await run({ headers: { 'x-goog-iap-jwt-assertion': signEs256(iapPayload({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 })) } });
    assert.strictEqual(r.status, 401);
});

test('missing IAP_AUDIENCE fails closed', async () => {
    delete process.env.IAP_AUDIENCE;
    const r = await run({ headers: { 'x-goog-iap-jwt-assertion': signEs256(iapPayload()) } });
    assert.strictEqual(r.status, 503);
});

test('scheduler token is accepted only for POST /api/sync', async () => {
    const ok = await run({ method: 'POST', path: '/sync', headers: { authorization: strippedSchedulerToken() } });
    assert.strictEqual(ok.nextCalled, true);
    const denied = await run({ method: 'POST', path: '/config', headers: { authorization: strippedSchedulerToken() } });
    assert.strictEqual(denied.status, 401);
});

test('scheduler token for a different service account is rejected', async () => {
    const r = await run({ method: 'POST', path: '/sync', headers: { authorization: strippedSchedulerToken({ email: 'attacker@evil.iam.gserviceaccount.com' }) } });
    assert.strictEqual(r.status, 401);
});

test('local dev bypass is ignored on Cloud Run', async () => {
    process.env.ALLOW_INSECURE_LOCAL_DEV = 'true';
    process.env.K_SERVICE = 'ccaas-sync-service';
    const r = await run({ headers: {} });
    assert.strictEqual(r.status, 401);
});

test('local dev bypass works off Cloud Run', async () => {
    process.env.ALLOW_INSECURE_LOCAL_DEV = 'true';
    const r = await run({ headers: {} });
    assert.strictEqual(r.nextCalled, true);
});
