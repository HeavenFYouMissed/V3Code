/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// V3Code: ensure bundled complete icons resolve locally in both palettes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const base = new URL('../extensions/theme-v3code/fileicons/complete/', import.meta.url);
const theme = JSON.parse(readFileSync(new URL('theme-complete.json', base), 'utf8'));

test('complete theme maps every association to a packaged static SVG', () => {
	for (const definition of Object.values(theme.iconDefinitions)) {
		assert.match(definition.iconPath, /^\.\/[a-z0-9-]+\.svg$/);
		const svg = readFileSync(new URL(definition.iconPath, base), 'utf8');
		assert.match(svg, /<svg/);
		assert.doesNotMatch(svg, /<script|<foreignObject|(?:href|src)=["']https?:/i);
	}
	for (const branch of [theme, theme.light]) {
		for (const field of ['fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded']) {
			for (const id of Object.values(branch[field] ?? {})) {
				assert.ok(theme.iconDefinitions[id], `${field}: ${id}`);
			}
		}
		for (const field of ['file', 'folder', 'folderExpanded']) {
			assert.ok(theme.iconDefinitions[branch[field]]);
		}
	}
});

test('complete theme preserves colored language and tooling icons and license', () => {
	for (const extension of ['ts', 'tsx', 'py']) {
		const id = theme.fileExtensions[extension];
		assert.match(theme.iconDefinitions[id].iconPath, /-color\.svg$/);
		assert.match(theme.iconDefinitions[theme.light.fileExtensions[extension]].iconPath, /-color-light\.svg$/);
	}
	assert.equal(theme.iconDefinitions[theme.fileExtensions.md].iconPath, './lang-markdown.svg');
	assert.equal(theme.iconDefinitions[theme.fileExtensions.json].iconPath, './braces.svg');
	for (const [name, color] of Object.entries({ 'lang-markdown.svg': '#5ecc71', 'lang-markdown-light.svg': '#199f43', 'braces.svg': '#ffa359', 'braces-light.svg': '#d47628' })) {
		assert.ok(readFileSync(new URL(name, base), 'utf8').includes(`fill="${color}"`));
	}
	assert.match(readFileSync(new URL('LICENSE.md', base), 'utf8'), /Copyright \(c\) 2026 The Pierre Computer Company/);
});
