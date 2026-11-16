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
const { getSecret, setSecret } = require('../secrets');

function fakeClient({ existing = ['1', '2'], addError = null } = {}) {
    const P = 'projects/p/secrets/s';
    const state = { enabled: new Set(existing.map(v => `${P}/versions/${v}`)), disabled: [], next: existing.length + 1 };
    return {
        state,
        getProjectId: async () => 'p',
        accessSecretVersion: async ({ name }) => [{ payload: { data: Buffer.from(`value-of-${name}`) } }],
        addSecretVersion: async ({ parent }) => {
            if (addError) { const e = new Error('x'); e.code = addError; throw e; }
            const name = `${parent}/versions/${state.next++}`;
            state.enabled.add(name);
            return [{ name }];
        },
        listSecretVersions: async () => [[...state.enabled].map(name => ({ name }))],
        disableSecretVersion: async ({ name }) => { state.enabled.delete(name); state.disabled.push(name); },
    };
}

test('setSecret adds a version and disables all previous enabled versions', async () => {
    const c = fakeClient();
    await setSecret(c, 's', 'new');
    assert.deepStrictEqual([...c.state.enabled], ['projects/p/secrets/s/versions/3']);
    assert.deepStrictEqual(c.state.disabled.sort(), ['projects/p/secrets/s/versions/1', 'projects/p/secrets/s/versions/2']);
});

test('setSecret explains missing secrets and missing permissions', async () => {
    await assert.rejects(setSecret(fakeClient({ addError: 5 }), 's', 'v'), /does not exist.*step 4\.1/);
    await assert.rejects(setSecret(fakeClient({ addError: 7 }), 's', 'v'), /secretVersionManager/);
});

test('setSecret does not fail if disabling old versions fails', async () => {
    const c = fakeClient();
    c.disableSecretVersion = async () => { throw new Error('denied'); };
    await setSecret(c, 's', 'new');
});

test('setSecret / getSecret ignore empty names or values', async () => {
    const c = fakeClient();
    await setSecret(c, '', 'v');
    await setSecret(c, 's', '');
    assert.strictEqual(c.state.next, 3);
    assert.strictEqual(await getSecret(c, ''), null);
    assert.strictEqual(await getSecret(c, 's'), 'value-of-projects/p/secrets/s/versions/latest');
});
