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
 * Authentication to the Google Workspace Admin SDK (Directory API).
 *
 * Two modes:
 *  - Keyless (recommended): no key is stored. The service's own service
 *    account (SERVICE_ACCOUNT) signs a domain-wide delegation JWT with the IAM
 *    Credentials signJwt API, and exchanges it for an access token that acts
 *    as the configured Workspace admin. Requires
 *    roles/iam.serviceAccountTokenCreator on the service account itself, and
 *    the service account's client ID authorized for domain-wide delegation in
 *    the Workspace Admin Console (see README).
 *  - Key (legacy): a service account JSON key stored in Secret Manager.
 *    Used when a key is configured.
 */

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const SCOPES = [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.group.readonly',
    'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const tokenCache = new Map();

/** Signs a JWT as `serviceAccount` using the IAM Credentials API. */
async function _signJwtWithIam(serviceAccount, claims) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const res = await client.request({
        url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`,
        method: 'POST',
        data: { payload: JSON.stringify(claims) },
    });
    return res.data.signedJwt;
}

/**
 * Returns a domain-wide delegation access token for `subject`, signed without a
 * key. Tokens are cached until shortly before they expire.
 */
async function getKeylessAccessToken({ serviceAccount, subject, scopes = SCOPES }, deps = {}) {
    const signJwt = deps.signJwt || _signJwtWithIam;
    const doFetch = deps.fetch || fetch;
    const now = deps.now ? deps.now() : Date.now();

    if (!serviceAccount) throw new Error('SERVICE_ACCOUNT is not configured; keyless Google Workspace access needs it.');
    if (!subject) throw new Error('Admin Email is required for Google Workspace.');

    const cacheKey = `${serviceAccount}|${subject}|${scopes.join(' ')}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.token;

    const iat = Math.floor(now / 1000);
    let assertion;
    try {
        assertion = await signJwt(serviceAccount, {
            iss: serviceAccount,
            sub: subject,
            scope: scopes.join(' '),
            aud: TOKEN_URL,
            iat,
            exp: iat + TOKEN_LIFETIME_S,
        });
    } catch (error) {
        throw new Error(`Could not sign the delegation token. Grant the service account roles/iam.serviceAccountTokenCreator on itself (README). Details: ${error.message}`);
    }

    const response = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
        const reason = body.error_description || body.error || `HTTP ${response.status}`;
        const hint = body.error === 'unauthorized_client'
            ? ' Authorize the service account\'s client ID for domain-wide delegation with the Directory API read-only scopes in the Workspace Admin Console (README).'
            : '';
        throw new Error(`Google Workspace token exchange failed: ${reason}.${hint}`);
    }
    const token = body.access_token;
    tokenCache.set(cacheKey, { token, expiresAt: now + (body.expires_in || TOKEN_LIFETIME_S) * 1000 });
    return token;
}

/**
 * Returns an Admin SDK Directory client acting as directoryConfig.adminEmail.
 * Uses the stored JSON key if there is one, otherwise keyless delegation.
 */
async function getDirectoryClient(directoryConfig, deps = {}) {
    if (!directoryConfig.adminEmail) {
        throw new Error('Admin Email is required for Google Workspace.');
    }
    let auth;
    if (directoryConfig.gcpKey) {
        auth = google.auth.fromJSON(JSON.parse(directoryConfig.gcpKey));
        auth.scopes = SCOPES;
        auth.subject = directoryConfig.adminEmail;
    } else {
        const token = await getKeylessAccessToken({
            serviceAccount: deps.serviceAccount || process.env.SERVICE_ACCOUNT,
            subject: directoryConfig.adminEmail,
        }, deps);
        auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: token });
    }
    return google.admin({ version: 'directory_v1', auth });
}

module.exports = {
    SCOPES,
    getKeylessAccessToken,
    getDirectoryClient,
    _clearTokenCacheForTests: () => tokenCache.clear(),
};
