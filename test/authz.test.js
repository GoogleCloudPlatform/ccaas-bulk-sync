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
const { roleFor, requireAdmin, requireSyncPermission } = require('../authz');

const SA = 'ccaas-sync-sa@proj.iam.gserviceaccount.com';

function run(mw, user, body) {
    return new Promise((resolve) => {
        const req = { user, body, method: 'POST', originalUrl: '/api/x' };
        const res = { status(c) { this.code = c; return this; }, send() { resolve(this.code); } };
        mw(req, res, () => resolve('next'));
    });
}

test.beforeEach(() => {
    process.env.ADMIN_EMAILS = 'Admin@Example.com, domain:ops.example.com';
    process.env.SERVICE_ACCOUNT = SA;
});
test.after(() => { delete process.env.ADMIN_EMAILS; delete process.env.SERVICE_ACCOUNT; });

test('roleFor: listed emails (case-insensitive) and domain entries are admins; others are viewers', () => {
    assert.strictEqual(roleFor({ type: 'iap', email: 'admin@example.com' }), 'admin');
    assert.strictEqual(roleFor({ type: 'iap', email: 'someone@ops.example.com' }), 'admin');
    assert.strictEqual(roleFor({ type: 'iap', email: 'viewer@example.com' }), 'viewer');
    assert.strictEqual(roleFor({ type: 'iap', email: 'x@evil-ops.example.com' }), 'viewer');
    assert.strictEqual(roleFor(undefined), 'viewer');
});

test('roleFor: without ADMIN_EMAILS everyone authenticated is admin (backwards compatible)', () => {
    delete process.env.ADMIN_EMAILS;
    assert.strictEqual(roleFor({ type: 'iap', email: 'anyone@example.com' }), 'admin');
});

test('requireAdmin blocks viewers with 403 and allows admins', async () => {
    assert.strictEqual(await run(requireAdmin, { type: 'iap', email: 'viewer@example.com' }), 403);
    assert.strictEqual(await run(requireAdmin, { type: 'iap', email: 'admin@example.com' }), 'next');
});

test('requireSyncPermission: viewers may simulate but not run live syncs', async () => {
    const viewer = { type: 'iap', email: 'viewer@example.com' };
    assert.strictEqual(await run(requireSyncPermission, viewer, { simulate: true }), 'next');
    assert.strictEqual(await run(requireSyncPermission, viewer, { simulate: false }), 403);
    assert.strictEqual(await run(requireSyncPermission, viewer, undefined), 403);
});

test('requireSyncPermission: the scheduler service account may run live syncs (via IAP or Cloud Run OIDC)', async () => {
    assert.strictEqual(await run(requireSyncPermission, { type: 'iap', email: SA }, undefined), 'next');
    assert.strictEqual(await run(requireSyncPermission, { type: 'scheduler', email: SA }, undefined), 'next');
    assert.strictEqual(await run(requireAdmin, { type: 'iap', email: SA }), 403, 'scheduler SA is not a config admin');
});
