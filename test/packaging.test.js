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

// Guards against the production image missing a module. v1.0.1 and v1.1.0
// shipped a Dockerfile that copied only index.js and sync-logic.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function localRequires(file, seen = new Set()) {
    if (seen.has(file)) return seen;
    seen.add(file);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
        const dep = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
        localRequires(dep, seen);
    }
    return seen;
}

test('Dockerfile copies every local module that index.js loads', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const copiesAllJs = /COPY --from=builder \/usr\/src\/app\/\*\.js \.\//.test(dockerfile);
    for (const mod of localRequires('index.js')) {
        assert.ok(!mod.includes('/'), `${mod} is in a subdirectory; update the Dockerfile COPY rules`);
        assert.ok(copiesAllJs || dockerfile.includes(`/usr/src/app/${mod}`), `Dockerfile does not copy ${mod}`);
    }
});
