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
 * Validation and merge logic for saving the configuration.
 *
 * Stored credentials (CCaaS API key, AD bind password, Entra client secret) are
 * bound to the destination they are sent to. If a request changes a
 * destination (CCaaS host, LDAP URL, Entra tenant/client) it must also supply
 * the matching credential again. Otherwise a caller could point the service at
 * a server they control and have it send the previously stored secret there.
 */

class ConfigValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}

const SECRET_NAMES = {
    ccaasApiKey: 'ccaas-api-key',
    gcpKey: 'gcp-sa-key',
    bindPassword: 'ad-bind-password',
    clientSecret: 'entra-client-secret',
};

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TENANT_ID_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
const CLIENT_ID_RE = /^[a-z0-9-]{1,64}$/i;

function _norm(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function _optionalString(value, field) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new ConfigValidationError(`${field} must be a string.`);
    }
    return value.trim();
}

function _allowedCcaasHostSuffixes() {
    return (process.env.ALLOWED_CCAAS_HOST_SUFFIXES || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

/** Returns a normalized CCaaS host name, or '' if empty. Throws if invalid. */
function validateCcaasHost(value) {
    const host = _optionalString(value, 'CCaaS host').toLowerCase();
    if (!host) return '';
    if (!HOSTNAME_RE.test(host)) {
        throw new ConfigValidationError('CCaaS host must be a plain host name (for example "acme.ccaiplatform.com") without scheme, port, or path.');
    }
    const suffixes = _allowedCcaasHostSuffixes();
    if (suffixes.length > 0 && !suffixes.some(s => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`))) {
        throw new ConfigValidationError(`CCaaS host must end with one of: ${suffixes.join(', ')}.`);
    }
    return host;
}

/** Returns a normalized LDAP URL, or '' if empty. Throws if invalid. */
function validateLdapUrl(value) {
    const raw = _optionalString(value, 'LDAP URL');
    if (!raw) return '';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (e) {
        throw new ConfigValidationError('LDAP URL is not a valid URL.');
    }
    if (parsed.protocol !== 'ldap:' && parsed.protocol !== 'ldaps:') {
        throw new ConfigValidationError('LDAP URL must use the ldap:// or ldaps:// scheme.');
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
        throw new ConfigValidationError('LDAP URL must contain a host name and no credentials.');
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
        throw new ConfigValidationError('LDAP URL must not contain a path, query, or fragment.');
    }
    return `${parsed.protocol}//${parsed.host}`;
}

function validateTenantId(value) {
    const tenantId = _optionalString(value, 'Tenant ID');
    if (tenantId && !TENANT_ID_RE.test(tenantId)) {
        throw new ConfigValidationError('Tenant ID must be a directory (tenant) GUID or domain name.');
    }
    return tenantId;
}

function validateClientId(value) {
    const clientId = _optionalString(value, 'Client ID');
    if (clientId && !CLIENT_ID_RE.test(clientId)) {
        throw new ConfigValidationError('Client ID must be an application (client) GUID.');
    }
    return clientId;
}

// Normalizes a previously stored LDAP URL the same way new input is normalized,
// so that saving an unchanged config does not count as a destination change.
function _normalizeStoredLdapUrl(value) {
    try {
        return validateLdapUrl(value);
    } catch (e) {
        return _norm(value);
    }
}

/** Validates the sync safety settings. */
function validateSafety(safety) {
    if (!safety || typeof safety !== 'object' || Array.isArray(safety)) {
        throw new ConfigValidationError('Safety settings must be an object.');
    }
    const max = safety.maxDeactivations;
    if (!Number.isInteger(max) || max < 0 || max > 100000) {
        throw new ConfigValidationError('Max deactivations per sync must be a whole number between 0 and 100000.');
    }
    return { maxDeactivations: max };
}

function _requireSecretOnDestinationChange({ destinationChanged, hasStoredSecret, newSecretProvided, message }) {
    if (destinationChanged && hasStoredSecret && !newSecretProvided) {
        throw new ConfigValidationError(message);
    }
}

/**
 * Merges an incoming config (from POST /api/config) into the currently stored
 * config.
 *
 * @param {object} current   The stored config document (may be {}).
 * @param {object} incoming  The request body.
 * @return {{configToSave: object, secretsToSet: Array<{name: string, value: string}>}}
 * @throws {ConfigValidationError}
 */
function buildConfigToSave(current, incoming) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new ConfigValidationError('Request body must be a JSON object.');
    }
    const configToSave = JSON.parse(JSON.stringify(current || {}));
    const secretsToSet = [];

    if (incoming.ccaas) {
        const stored = configToSave.ccaas || {};
        const host = validateCcaasHost(incoming.ccaas.host);
        const apiKey = _optionalString(incoming.ccaas.apiKey, 'CCaaS API key');

        _requireSecretOnDestinationChange({
            destinationChanged: host !== _norm(stored.host).toLowerCase(),
            hasStoredSecret: !!stored.apiKeySecretName,
            newSecretProvided: !!apiKey,
            message: 'The CCaaS API key must be re-entered when the CCaaS host is changed.',
        });

        configToSave.ccaas = { ...stored, host };
        if (apiKey) {
            configToSave.ccaas.apiKeySecretName = SECRET_NAMES.ccaasApiKey;
            secretsToSet.push({ name: SECRET_NAMES.ccaasApiKey, value: apiKey });
        }
    }

    if (incoming.directory) {
        const stored = configToSave.directory || {};
        const dir = incoming.directory;
        const url = validateLdapUrl(dir.url);
        const tenantId = validateTenantId(dir.tenantId);
        const clientId = validateClientId(dir.clientId);
        const gcpKey = _optionalString(dir.gcpKey, 'Service account key');
        const bindPassword = _optionalString(dir.bindPassword, 'Bind password');
        const clientSecret = _optionalString(dir.clientSecret, 'Client secret');

        _requireSecretOnDestinationChange({
            destinationChanged: url !== _normalizeStoredLdapUrl(stored.url),
            hasStoredSecret: !!stored.bindPasswordSecretName,
            newSecretProvided: !!bindPassword,
            message: 'The Active Directory bind password must be re-entered when the LDAP URL is changed.',
        });
        _requireSecretOnDestinationChange({
            destinationChanged: tenantId !== _norm(stored.tenantId) || clientId !== _norm(stored.clientId),
            hasStoredSecret: !!stored.clientSecretSecretName,
            newSecretProvided: !!clientSecret,
            message: 'The Entra ID client secret must be re-entered when the Tenant ID or Client ID is changed.',
        });

        configToSave.directory = {
            ...stored,
            type: _optionalString(dir.type, 'Directory type'),
            adminEmail: _optionalString(dir.adminEmail, 'Admin email'),
            url,
            bindDN: _optionalString(dir.bindDN, 'Bind DN'),
            searchBase: _optionalString(dir.searchBase, 'Search base'),
            tenantId,
            clientId,
            entraIdEmailField: _optionalString(dir.entraIdEmailField, 'Entra ID email field'),
        };

        if (gcpKey) {
            configToSave.directory.gcpKeySecretName = SECRET_NAMES.gcpKey;
            secretsToSet.push({ name: SECRET_NAMES.gcpKey, value: gcpKey });
        }
        if (bindPassword) {
            configToSave.directory.bindPasswordSecretName = SECRET_NAMES.bindPassword;
            secretsToSet.push({ name: SECRET_NAMES.bindPassword, value: bindPassword });
        }
        if (clientSecret) {
            configToSave.directory.clientSecretSecretName = SECRET_NAMES.clientSecret;
            secretsToSet.push({ name: SECRET_NAMES.clientSecret, value: clientSecret });
        }
    }

    configToSave.mappings = incoming.mappings;
    configToSave.schedule = incoming.schedule;
    configToSave.syncRole = incoming.syncRole;
    if (incoming.safety !== undefined) {
        configToSave.safety = validateSafety(incoming.safety);
    }

    return { configToSave, secretsToSet };
}

module.exports = {
    ConfigValidationError,
    buildConfigToSave,
    validateCcaasHost,
    validateLdapUrl,
    validateTenantId,
    validateClientId,
    validateSafety,
};
