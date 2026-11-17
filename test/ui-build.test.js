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
const fs = require('fs');
const path = require('path');
const { extractTemplate, compileTemplate } = require('../scripts/build-ui');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the #app template in index.html precompiles without errors or with()', () => {
    const template = extractTemplate(read('public/index.html'));
    assert.match(template, /CCaaS Bulk Sync/);
    const code = compileTemplate(template);
    assert.match(code, /window\.__ccaasRender = /);
    assert.match(code, /return function render\(/);
    assert.doesNotMatch(code, /\bwith \(/, 'render code must not use with()');
});

test('template compile errors fail the build', () => {
    assert.throws(() => compileTemplate('<div v-if="">{{ unclosed </div>'), /Template compile errors/);
});

test('the UI uses the precompiled render and Vue runtime-only build', () => {
    const html = read('public/index.html');
    assert.match(html, /<script src="\/vendor\/vue\.runtime\.global\.prod\.js"><\/script>/);
    assert.ok(html.indexOf('/app-render.js') < html.indexOf('/app.js'), 'app-render.js must load before app.js');
    assert.match(read('public/app.js'), /render: window\.__ccaasRender/);
});

test('the Content Security Policy has no unsafe-eval or unsafe-inline', () => {
    const src = read('index.js');
    const scriptSrc = /scriptSrc:\s*\[([^\]]*)\]/.exec(src);
    assert.ok(scriptSrc, 'scriptSrc directive not found');
    // Directive values are written as "'...'" strings; comments may mention the words.
    assert.doesNotMatch(src, /"'unsafe-(eval|inline)'"/);
    assert.deepStrictEqual(scriptSrc[1].trim(), `"'self'"`);
});

test('the Docker image builds the precompiled template', () => {
    assert.match(read('Dockerfile'), /RUN npm run build\b/);
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.build, /scripts\/build-ui\.js/);
});
