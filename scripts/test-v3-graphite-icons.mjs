/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// V3Code: packaged icon associations and accessibility palette regression checks.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const base = new URL('../extensions/theme-v3code/', import.meta.url);
const theme = JSON.parse(readFileSync(new URL('fileicons/vs_graphite-icon-theme.json', base), 'utf8'));
const upstream = JSON.parse(readFileSync(new URL('../extensions/theme-seti/icons/vs-seti-icon-theme.json', import.meta.url), 'utf8'));

test('V3Code Graphite preserves every bundled Seti file association', () => {
	for (const field of ['fileNames', 'fileExtensions', 'languageIds']) {
		assert.deepEqual(theme[field], upstream[field]);
		for (const branch of [theme, theme.light, theme.highContrast]) {
			for (const icon of Object.values(branch[field] ?? {})) {
				assert.ok(theme.iconDefinitions[icon], `Missing icon ${icon}`);
			}
		}
	}
});

test('V3Code Graphite keeps upstream light and high-contrast colors', () => {
	assert.deepEqual(theme.light, upstream.light);
	for (const [name, definition] of Object.entries(upstream.iconDefinitions)) {
		assert.deepEqual(theme.iconDefinitions[name + '_hc'], definition);
		if (name.endsWith('_light')) {
			assert.deepEqual(theme.iconDefinitions[name], definition);
		}
	}
});

test('V3Code Graphite packages font and notices without external asset paths', () => {
	for (const font of theme.fonts) {
		for (const source of font.src) {
			const path = new URL(source.path, new URL('fileicons/', base));
			assert.ok(fileURLToPath(path).startsWith(fileURLToPath(base)));
			assert.ok(existsSync(path));
		}
	}
	assert.match(readFileSync(new URL('fileicons/SETI-NOTICES.txt', base), 'utf8'), /Copyright \(c\) 2014 Jesse Weed/);
});

test('V3Code uses complete icons by default and makes graphite opt-in', () => {
	const manifest = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'));
	assert.equal(manifest.contributes.iconThemes[0].id, 'v3code-minimal');
	assert.equal(manifest.contributes.iconThemes[0].path, './fileicons/complete/theme-complete.json');
	assert.equal(manifest.contributes.iconThemes[1].id, 'v3code-graphite');
	for (const contribution of manifest.contributes.iconThemes) {
		assert.ok(existsSync(new URL(contribution.path, base)));
	}
	assert.equal(theme.hidesExplorerArrows, false);
	assert.equal(theme.folder, undefined);
});

test('V3Code authoritative injected watermark layer retains the compact size', () => {
	const chrome = readFileSync(new URL('../src/vs/workbench/contrib/void/browser/v3codeGreyChromeContribution.ts', import.meta.url), 'utf8');
	const block = chrome.slice(chrome.indexOf('/* V3Code: compact watermark'), chrome.indexOf('function injectGapLayer'));
	assert.match(block, /width: 128px !important/);
	assert.match(block, /min-height: 0 !important/);
	assert.doesNotMatch(block, /width: 400px !important/);
	assert.match(chrome, /const graphiteMarkUri = FileAccess\.asBrowserUri\('vs\/workbench\/contrib\/void\/browser\/media\/v3-welcome-mark\.png'/);
});
