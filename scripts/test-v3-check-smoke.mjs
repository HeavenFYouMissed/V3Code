/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSmoke, preloads, media } from './v3-check-smoke.mjs';

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), 'v3-smoke-check-'));
	const put = (file, text = '// fixture') => {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	};
	put('out/main.js');
	put('out/nls.messages.json', '[]');
	put('out/vs/workbench/contrib/void/browser/react/out/void-settings-tsx/index.js');
	put('extensions/typescript-language-features/package.json', JSON.stringify({ main: './out/extension' }));
	put('extensions/typescript-language-features/out/extension.js');
	for (const preload of preloads) { put(`out/${preload}.js`, 'require("electron");'); }
	for (const file of media) { put(file); }
	return { root, put };
}

test('complete extension and CommonJS runtime passes', () => {
	assert.deepEqual(checkSmoke(fixture().root, 'linux'), []);
});
test('missing built-in entrypoint blocks launch', () => {
	const { root, put } = fixture();
	put('extensions/typescript-language-features/package.json', '{"main":"./missing"}');
	assert.ok(checkSmoke(root, 'linux').some(item => item.includes('typescript-language-features')));
});
test('ES module preload blocks launch', () => {
	const { root, put } = fixture();
	put(`out/${preloads[2]}.js`, 'export {};');
	assert.ok(checkSmoke(root, 'linux').some(item => /Unexpected token 'export'/.test(item)));
});
test('mac helper must exist and be executable', () => {
	const { root, put } = fixture();
	assert.ok(checkSmoke(root, 'darwin').some(item => item.includes('helper')));
	const helper = 'resources/computerUse/darwin/v3code-computer-use-helper';
	put(helper);
	chmodSync(path.join(root, helper), 0o755);
	assert.deepEqual(checkSmoke(root, 'darwin'), []);
});
test('missing or empty extension media blocks launch', () => {
	const { root, put } = fixture();
	put(media[0], '');
	assert.ok(checkSmoke(root, 'linux').includes(media[0]));
});
test('empty preload cannot pass as valid JavaScript', () => {
	const { root, put } = fixture();
	const preload = `out/${preloads[0]}.js`;
	put(preload, '');
	assert.ok(checkSmoke(root, 'linux').includes(preload));
});
