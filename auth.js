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
 * Authentication middleware for the /api/* routes.
 *
 * Two kinds of callers are accepted:
 *
 * 1. Interactive users coming through Identity-Aware Proxy (IAP). IAP adds a
 *    signed JWT in the `x-goog-iap-jwt-assertion` header. The JWT signature,
 *    issuer and audience are cryptographically verified here, so a request that
 *    reaches the container without passing through IAP (for example, directly
 *    via the *.run.app URL) is rejected.
 *
 * 2. Cloud Scheduler, which calls `POST /api/sync` with a Google-signed OIDC
 *    token for the service's own service account. For these requests Cloud Run
 *    IAM (`--no-allow-unauthenticated`) verifies the token and only passes it on
 *    with the signature removed, so here we additionally check the token's
 *    claims (issuer, expiry and that the caller is the configured
 *    SERVICE_ACCOUNT). This caller is only allowed to reach `POST /api/sync`.
 *
 * Configuration (environment variables):
 *   IAP_AUDIENCE     Required. Comma-separated list of accepted IAP audiences,
 *                    e.g. "/projects/123456789/global/backendServices/987654321"
 *                    (load balancer + IAP) or
 *                    "/projects/123456789/locations/us-central1/services/my-svc"
 *                    (IAP enabled directly on Cloud Run).
 *   SERVICE_ACCOUNT  Email of the service account used by Cloud Scheduler.
 *   ALLOW_INSECURE_LOCAL_DEV=true
 *                    Disables authentication for local development only. It is
 *                    ignored when running on Cloud Run (K_SERVICE is set).
 */

const { OAuth2Client } = require('google-auth-library');

const IAP_ISSUERS = ['https://cloud.google.com/iap'];
const GOOGLE_ID_TOKEN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const STRIPPED_SIGNATURE = 'SIGNATURE_REMOVED_BY_GOOGLE';
const IAP_KEY_CACHE_MS = 60 * 60 * 1000;

const oauthClient = new OAuth2Client();
let iapKeyCache = { keys: null, fetchedAt: 0 };

async function _getIapPublicKeys() {
    const now = Date.now();
    if (!iapKeyCache.keys || now - iapKeyCache.fetchedAt > IAP_KEY_CACHE_MS) {
        const response = await oauthClient.getIapPublicKeys();
        iapKeyCache = { keys: response.pubkeys, fetchedAt: now };
    }
    return iapKeyCache.keys;
}

function _getIapAudiences() {
    return (process.env.IAP_AUDIENCE || '')
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
}

async function verifyIapJwt(iapJwt, audiences) {
    const keys = await _getIapPublicKeys();
    const ticket = await oauthClient.verifySignedJwtWithCertsAsync(iapJwt, keys, audiences, IAP_ISSUERS);
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
        throw new Error('IAP JWT has no subject.');
    }
    return payload;
}

function _decodeJwtPart(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Validates the OIDC token Cloud Scheduler sends to Cloud Run.
 *
 * If the token still carries a signature it is fully verified. If Cloud Run has
 * already verified it (and replaced the signature with SIGNATURE_REMOVED_BY_GOOGLE),
 * only the claims are checked; this relies on the service being deployed with
 * `--no-allow-unauthenticated`.
 */
async function verifySchedulerToken(authorizationHeader, expectedEmail) {
    if (!expectedEmail) {
        throw new Error('SERVICE_ACCOUNT is not configured.');
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader || '');
    if (!match) {
        throw new Error('Missing bearer token.');
    }
    const token = match[1].trim();
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed bearer token.');
    }

    let payload;
    if (parts[2] === STRIPPED_SIGNATURE) {
        payload = _decodeJwtPart(parts[1]);
        if (!GOOGLE_ID_TOKEN_ISSUERS.includes(payload.iss)) {
            throw new Error('Unexpected token issuer.');
        }
        if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
            throw new Error('Token expired.');
        }
    } else {
        const ticket = await oauthClient.verifyIdToken({ idToken: token });
        payload = ticket.getPayload();
    }

    if (!payload || payload.email !== expectedEmail || payload.email_verified === false) {
        throw new Error('Token was not issued to the configured service account.');
    }
    return payload;
}

function _isSchedulerRoute(req) {
    return req.method === 'POST' && req.path === '/sync';
}

/**
 * Express middleware. Mount with `app.use('/api', requireAuth)`.
 */
async function requireAuth(req, res, next) {
    if (process.env.ALLOW_INSECURE_LOCAL_DEV === 'true' && !process.env.K_SERVICE) {
        req.user = { email: 'local-dev', type: 'local' };
        return next();
    }

    const iapJwt = req.get('x-goog-iap-jwt-assertion');
    if (iapJwt) {
        const audiences = _getIapAudiences();
        if (audiences.length === 0) {
            console.error('IAP_AUDIENCE is not set; refusing all interactive API requests.');
            return res.status(503).send('Service authentication is not configured.');
        }
        try {
            const payload = await verifyIapJwt(iapJwt, audiences);
            req.user = { email: payload.email, sub: payload.sub, type: 'iap' };
            return next();
        } catch (error) {
            console.warn(`Rejected request with invalid IAP JWT: ${error.message}`);
            return res.status(401).send('Unauthorized.');
        }
    }

    if (_isSchedulerRoute(req)) {
        try {
            const payload = await verifySchedulerToken(req.get('authorization'), process.env.SERVICE_ACCOUNT);
            req.user = { email: payload.email, type: 'scheduler' };
            return next();
        } catch (error) {
            console.warn(`Rejected scheduler request: ${error.message}`);
            return res.status(401).send('Unauthorized.');
        }
    }

    console.warn(`Rejected unauthenticated request to ${req.method} ${req.originalUrl}`);
    return res.status(401).send('Unauthorized.');
}

module.exports = {
    requireAuth,
    verifyIapJwt,
    verifySchedulerToken,
    // Exposed for tests.
    _resetIapKeyCacheForTests: () => { iapKeyCache = { keys: null, fetchedAt: 0 }; },
    _setIapKeysForTests: (keys) => { iapKeyCache = { keys, fetchedAt: Date.now() }; },
};
