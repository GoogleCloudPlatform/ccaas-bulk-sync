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
    buildConfigToSave,
    ConfigValidationError,
    validateCcaasHost,
    validateLdapUrl,
} = require('../config-security');

const STORED = {
    ccaas: { host: 'acme.ccaiplatform.com', apiKeySecretName: 'ccaas-api-key' },
    directory: {
        type: 'ad',
        url: 'ldaps://dc.example.com:636',
        bindDN: 'CN=svc,DC=example,DC=com',
        searchBase: 'DC=example,DC=com',
        bindPasswordSecretName: 'ad-bind-password',
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        clientSecretSecretName: 'entra-client-secret',
    },
    mappings: [],
    schedule: { type: 'manual' },
    syncRole: '',
};

function incomingFrom(stored, overrides = {}) {
    const base = JSON.parse(JSON.stringify(stored));
    delete base.ccaas.apiKeySecretName;
    delete base.directory.bindPasswordSecretName;
    delete base.directory.clientSecretSecretName;
    return {
        ...base,
        ccaas: { ...base.ccaas, ...(overrides.ccaas || {}) },
        directory: { ...base.directory, ...(overrides.directory || {}) },
    };
}

test('saving an unchanged config without secrets succeeds and keeps secret references', () => {
    const { configToSave, secretsToSet } = buildConfigToSave(STORED, incomingFrom(STORED));
    assert.deepStrictEqual(secretsToSet, []);
    assert.strictEqual(configToSave.directory.bindPasswordSecretName, 'ad-bind-password');
    assert.strictEqual(configToSave.ccaas.apiKeySecretName, 'ccaas-api-key');
});

test('b/585247402: changing LDAP URL without re-entering bind password is rejected', () => {
    const incoming = incomingFrom(STORED, { directory: { url: 'ldap://attacker.example.net' } });
    assert.throws(() => buildConfigToSave(STORED, incoming), ConfigValidationError);
});

test('changing LDAP URL with a new bind password is allowed', () => {
    const incoming = incomingFrom(STORED, { directory: { url: 'ldaps://dc2.example.com', bindPassword: 'new-pw' } });
    const { configToSave, secretsToSet } = buildConfigToSave(STORED, incoming);
    assert.strictEqual(configToSave.directory.url, 'ldaps://dc2.example.com');
    assert.deepStrictEqual(secretsToSet, [{ name: 'ad-bind-password', value: 'new-pw' }]);
});

test('changing CCaaS host without re-entering API key is rejected', () => {
    const incoming = incomingFrom(STORED, { ccaas: { host: 'attacker.example.net' } });
    assert.throws(() => buildConfigToSave(STORED, incoming), /CCaaS API key must be re-entered/);
});

test('changing Entra tenant without re-entering client secret is rejected', () => {
    const incoming = incomingFrom(STORED, { directory: { tenantId: 'attacker.onmicrosoft.com' } });
    assert.throws(() => buildConfigToSave(STORED, incoming), /client secret must be re-entered/);
});

test('first-time configuration (no stored secrets) works', () => {
    const incoming = incomingFrom(STORED, { ccaas: { apiKey: 'k' }, directory: { bindPassword: 'p' } });
    const { configToSave, secretsToSet } = buildConfigToSave({}, incoming);
    assert.strictEqual(configToSave.ccaas.apiKeySecretName, 'ccaas-api-key');
    assert.strictEqual(secretsToSet.length, 2);
});

test('stored LDAP URL with trailing slash is not treated as a change', () => {
    const stored = { ...STORED, directory: { ...STORED.directory, url: 'ldaps://dc.example.com:636/' } };
    const incoming = incomingFrom(stored);
    assert.doesNotThrow(() => buildConfigToSave(stored, incoming));
});

test('validateLdapUrl', () => {
    assert.strictEqual(validateLdapUrl('ldap://dc.example.com'), 'ldap://dc.example.com');
    assert.strictEqual(validateLdapUrl('ldaps://dc.example.com:636'), 'ldaps://dc.example.com:636');
    assert.strictEqual(validateLdapUrl(''), '');
    for (const bad of ['http://dc.example.com', 'ldap://user:pw@dc.example.com', 'ldap://dc.example.com/x', 'not a url', 'file:///etc/passwd']) {
        assert.throws(() => validateLdapUrl(bad), ConfigValidationError, bad);
    }
});

test('validateCcaasHost', () => {
    assert.strictEqual(validateCcaasHost('Acme.CCAIPlatform.com'), 'acme.ccaiplatform.com');
    for (const bad of ['https://acme.ccaiplatform.com', 'acme.ccaiplatform.com:8443', 'acme.ccaiplatform.com/x', 'evil.com@acme', 'localhost']) {
        assert.throws(() => validateCcaasHost(bad), ConfigValidationError, bad);
    }
});

test('validateCcaasHost honors ALLOWED_CCAAS_HOST_SUFFIXES', () => {
    process.env.ALLOWED_CCAAS_HOST_SUFFIXES = '.ccaiplatform.com';
    try {
        assert.strictEqual(validateCcaasHost('acme.ccaiplatform.com'), 'acme.ccaiplatform.com');
        assert.throws(() => validateCcaasHost('evilccaiplatform.com'), ConfigValidationError);
        assert.throws(() => validateCcaasHost('attacker.example.net'), ConfigValidationError);
    } finally {
        delete process.env.ALLOWED_CCAAS_HOST_SUFFIXES;
    }
});
