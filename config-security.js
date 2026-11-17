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
    /** @param {string} message @param {string|null} field  Config path the UI highlights, e.g. "ccaas.host". */
    constructor(message, field = null) {
        super(message);
        this.name = 'ConfigValidationError';
        this.field = field;
    }
}

const SECRET_NAMES = {
    ccaasApiKey: 'ccaas-api-key',
    gcpKey: 'gcp-sa-key',
    bindPassword: 'ad-bind-password',
    clientSecret: 'entra-client-secret',
};

// Fields that hold secret values. They must only live in Secret Manager, never
// in the Firestore config document or in API responses.
const SECRET_VALUE_FIELDS = {
    ccaas: { apiKey: 'apiKeySecretName' },
    directory: { gcpKey: 'gcpKeySecretName', bindPassword: 'bindPasswordSecretName', clientSecret: 'clientSecretSecretName' },
};
const SECRET_NAME_FOR_FIELD = {
    apiKey: SECRET_NAMES.ccaasApiKey,
    gcpKey: SECRET_NAMES.gcpKey,
    bindPassword: SECRET_NAMES.bindPassword,
    clientSecret: SECRET_NAMES.clientSecret,
};

/**
 * Returns a copy of the config with every secret value and secret reference
 * removed, so it is safe to send to the browser.
 */
function redactConfig(config) {
    const copy = JSON.parse(JSON.stringify(config || {}));
    for (const [section, fields] of Object.entries(SECRET_VALUE_FIELDS)) {
        if (!copy[section]) continue;
        for (const [valueField, nameField] of Object.entries(fields)) {
            delete copy[section][valueField];
            delete copy[section][nameField];
        }
    }
    return copy;
}

/**
 * Moves any plaintext secret values found in a stored config (written by
 * older versions) to Secret Manager and removes them from the document.
 * Mutates `config`; returns the secrets that must be written.
 */
function extractLegacyPlaintextSecrets(config) {
    const secrets = [];
    for (const [section, fields] of Object.entries(SECRET_VALUE_FIELDS)) {
        const sec = config[section];
        if (!sec) continue;
        for (const [valueField, nameField] of Object.entries(fields)) {
            if (!(valueField in sec)) continue;
            const value = sec[valueField];
            delete sec[valueField];
            if (typeof value === 'string' && value && !sec[nameField]) {
                sec[nameField] = SECRET_NAME_FOR_FIELD[valueField];
                secrets.push({ name: SECRET_NAME_FOR_FIELD[valueField], value });
            }
        }
    }
    return secrets;
}

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
        throw new ConfigValidationError('CCaaS host must be a plain host name (for example "acme.ccaiplatform.com") without scheme, port, or path.', 'ccaas.host');
    }
    const suffixes = _allowedCcaasHostSuffixes();
    if (suffixes.length > 0 && !suffixes.some(s => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`))) {
        throw new ConfigValidationError(`CCaaS host must end with one of: ${suffixes.join(', ')}.`, 'ccaas.host');
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
        throw new ConfigValidationError('LDAP URL is not a valid URL.', 'directory.url');
    }
    if (parsed.protocol !== 'ldap:' && parsed.protocol !== 'ldaps:') {
        throw new ConfigValidationError('LDAP URL must use the ldap:// or ldaps:// scheme.', 'directory.url');
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
        throw new ConfigValidationError('LDAP URL must contain a host name and no credentials.', 'directory.url');
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
        throw new ConfigValidationError('LDAP URL must not contain a path, query, or fragment.', 'directory.url');
    }
    return `${parsed.protocol}//${parsed.host}`;
}

function validateTenantId(value) {
    const tenantId = _optionalString(value, 'Tenant ID');
    if (tenantId && !TENANT_ID_RE.test(tenantId)) {
        throw new ConfigValidationError('Tenant ID must be a directory (tenant) GUID or domain name.', 'directory.tenantId');
    }
    return tenantId;
}

function validateClientId(value) {
    const clientId = _optionalString(value, 'Client ID');
    if (clientId && !CLIENT_ID_RE.test(clientId)) {
        throw new ConfigValidationError('Client ID must be an application (client) GUID.', 'directory.clientId');
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

/** 'keyless' (default; no stored key) or 'key' (legacy service account JSON key). */
function validateGoogleAuthMode(value) {
    const mode = _optionalString(value, 'Google authentication mode');
    if (mode !== 'keyless' && mode !== 'key') {
        throw new ConfigValidationError('Google authentication mode must be "keyless" or "key".');
    }
    return mode;
}

const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * Basic 5-field cron check (minute hour day-of-month month day-of-week).
 * Each field is a comma-separated list of "*", "N" or "N-M", each optionally
 * followed by "/STEP". Numeric values only (no month/day names).
 */
function isValidCron(expr) {
    if (typeof expr !== 'string') return false;
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    return fields.every((field, i) => {
        const [lo, hi] = CRON_RANGES[i];
        return field.split(',').every((part) => {
            const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
            if (!m) return false;
            const [, , start, end, step] = m;
            if (step !== undefined && Number(step) < 1) return false;
            if (start === undefined) return true; // "*"
            const a = Number(start);
            const b = end === undefined ? a : Number(end);
            return a >= lo && b <= hi && a <= b;
        });
    });
}

function isValidTimeZone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (e) {
        return false;
    }
}

/** Validates the schedule (type, daily time, cron, time zone, poll delay). */
function validateSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
        throw new ConfigValidationError('Schedule settings are missing.', 'schedule.type');
    }
    const type = schedule.type || 'manual';
    if (!['manual', 'hourly', 'daily', 'custom'].includes(type)) {
        throw new ConfigValidationError('Schedule type must be manual, hourly, daily or custom.', 'schedule.type');
    }
    const time = typeof schedule.time === 'string' && schedule.time ? schedule.time : '00:00';
    if (type === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new ConfigValidationError('Daily time must be HH:MM (24-hour).', 'schedule.time');
    }
    const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : '';
    if (type === 'custom' && !isValidCron(cron)) {
        throw new ConfigValidationError('Cron schedule must have 5 fields: minute hour day-of-month month day-of-week (for example "0 6 * * 1-5").', 'schedule.cron');
    }
    const timeZone = schedule.timeZone || 'UTC';
    if (!isValidTimeZone(timeZone)) {
        throw new ConfigValidationError('Time zone must be an IANA time zone such as "UTC" or "Europe/London".', 'schedule.timeZone');
    }
    const delay = schedule.initialPollDelay === undefined || schedule.initialPollDelay === '' ? 15 : Number(schedule.initialPollDelay);
    if (!Number.isFinite(delay) || delay < 5 || delay > 60) {
        throw new ConfigValidationError('Initial poll delay must be between 5 and 60 seconds.', 'schedule.initialPollDelay');
    }
    return { type, time, cron, timeZone, initialPollDelay: Math.round(delay) };
}

/** Validates sync behavior options. */
function validateSyncOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new ConfigValidationError('Sync options must be an object.');
    }
    const existingUsers = options.existingUsers ?? 'skip';
    if (existingUsers !== 'skip' && existingUsers !== 'adopt') {
        throw new ConfigValidationError('Existing CCaaS users must be "skip" or "adopt".');
    }
    const syncNames = options.syncNames ?? true;
    if (typeof syncNames !== 'boolean') {
        throw new ConfigValidationError('Sync names must be true or false.');
    }
    return { existingUsers, syncNames };
}

/** Validates the sync safety settings. */
function validateSafety(safety) {
    if (!safety || typeof safety !== 'object' || Array.isArray(safety)) {
        throw new ConfigValidationError('Safety settings must be an object.');
    }
    const max = safety.maxDeactivations;
    if (!Number.isInteger(max) || max < 0 || max > 100000) {
        throw new ConfigValidationError('Max deactivations per sync must be a whole number between 0 and 100000.', 'safety.maxDeactivations');
    }
    return { maxDeactivations: max };
}

function _requireSecretOnDestinationChange({ destinationChanged, hasStoredSecret, newSecretProvided, message, field = null }) {
    if (destinationChanged && hasStoredSecret && !newSecretProvided) {
        throw new ConfigValidationError(message, field);
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
    // Never keep plaintext secrets in Firestore (older versions stored some).
    const secretsToSet = extractLegacyPlaintextSecrets(configToSave);

    if (incoming.ccaas) {
        const stored = configToSave.ccaas || {};
        const host = validateCcaasHost(incoming.ccaas.host);
        const apiKey = _optionalString(incoming.ccaas.apiKey, 'CCaaS API key');

        _requireSecretOnDestinationChange({
            destinationChanged: host !== _norm(stored.host).toLowerCase(),
            hasStoredSecret: !!stored.apiKeySecretName,
            newSecretProvided: !!apiKey,
            message: 'The CCaaS API key must be re-entered when the CCaaS host is changed.',
            field: 'ccaas.apiKey',
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
            field: 'directory.bindPassword',
        });
        _requireSecretOnDestinationChange({
            destinationChanged: tenantId !== _norm(stored.tenantId) || clientId !== _norm(stored.clientId),
            hasStoredSecret: !!stored.clientSecretSecretName,
            newSecretProvided: !!clientSecret,
            message: 'The Entra ID client secret must be re-entered when the Tenant ID or Client ID is changed.',
            field: 'directory.clientSecret',
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
            // Keep existing key-based deployments on their key unless the admin switches.
            googleAuthMode: dir.googleAuthMode !== undefined && dir.googleAuthMode !== null && dir.googleAuthMode !== ''
                ? validateGoogleAuthMode(dir.googleAuthMode)
                : (stored.googleAuthMode || (stored.gcpKeySecretName ? 'key' : 'keyless')),
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
    if (incoming.schedule !== undefined) {
        configToSave.schedule = validateSchedule(incoming.schedule);
    }
    configToSave.syncRole = incoming.syncRole;
    if (incoming.safety !== undefined) {
        configToSave.safety = validateSafety(incoming.safety);
    }
    if (incoming.syncOptions !== undefined) {
        configToSave.syncOptions = validateSyncOptions(incoming.syncOptions);
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
    validateSyncOptions,
    validateSchedule,
    isValidCron,
    validateGoogleAuthMode,
    redactConfig,
    extractLegacyPlaintextSecrets,
};
