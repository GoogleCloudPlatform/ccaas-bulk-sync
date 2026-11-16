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
 * Authorization: who may change things.
 *
 * IAP decides who can reach the app at all. On top of that:
 *  - "admin": may save the configuration (including credentials), run live
 *    syncs, proceed CCaaS jobs and run connection tests.
 *  - "viewer": may view the configuration, CCaaS details, jobs and directory
 *    groups, and run simulations.
 *
 * ADMIN_EMAILS (comma-separated) lists the admins. Entries may be full email
 * addresses or "domain:example.com". If ADMIN_EMAILS is not set, every
 * IAP-authenticated user is an admin (the pre-1.3.0 behavior) and a warning is
 * logged; set it in production.
 *
 * The scheduler service account (SERVICE_ACCOUNT) is always allowed to run
 * live syncs, whether it arrives through IAP or with a Cloud Run OIDC token.
 */

function _adminEntries() {
    return (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
}

function isAdminListConfigured() {
    return _adminEntries().length > 0;
}

function _isSchedulerIdentity(user) {
    const sa = (process.env.SERVICE_ACCOUNT || '').toLowerCase();
    return !!user && (user.type === 'scheduler' || (!!sa && (user.email || '').toLowerCase() === sa));
}

/** Returns 'admin' or 'viewer' for an authenticated request user. */
function roleFor(user) {
    if (!user) return 'viewer';
    if (user.type === 'local') return 'admin';
    const entries = _adminEntries();
    if (entries.length === 0) return 'admin';
    const email = (user.email || '').toLowerCase();
    const domain = email.includes('@') ? email.split('@').pop() : '';
    return entries.some(e => e === email || (domain && e === `domain:${domain}`)) ? 'admin' : 'viewer';
}

/** Express middleware: only admins may continue. */
function requireAdmin(req, res, next) {
    if (roleFor(req.user) === 'admin') return next();
    console.warn('Forbidden: %s (viewer) attempted %s %s', req.user?.email || 'unknown', req.method, req.originalUrl);
    return res.status(403).send('This action requires an administrator. Ask an admin to add you to ADMIN_EMAILS.');
}

/** Live syncs: admins and the scheduler service account. Simulations: anyone. */
function requireSyncPermission(req, res, next) {
    if (req.body?.simulate === true) return next();
    if (_isSchedulerIdentity(req.user) || roleFor(req.user) === 'admin') return next();
    console.warn('Forbidden: %s (viewer) attempted a live sync', req.user?.email || 'unknown');
    return res.status(403).send('Running a live sync requires an administrator. Viewers can run a simulation.');
}

function warnIfAdminListMissing() {
    if (!isAdminListConfigured()) {
        console.warn('ADMIN_EMAILS is not set: every IAP-authenticated user has admin rights. Set ADMIN_EMAILS to restrict changes.');
    }
}

module.exports = { roleFor, requireAdmin, requireSyncPermission, isAdminListConfigured, warnIfAdminListMissing };
