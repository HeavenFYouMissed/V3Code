/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/vs/workbench/contrib/browserView/electron-browser/tools/browserAgentScripts.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'ts', format: 'esm' });
const { FILL_FORM_FUNCTION } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
const fill = new Function(`return (${FILL_FORM_FUNCTION})`)();

test('form script dispatches text, select, checkbox and radio operations', async () => {
	const calls = [];
	const kinds = { text: ['input', 'text'], select: ['select', null], check: ['input', 'checkbox'], radio: ['input', 'radio'] };
	const page = { locator: selector => ({ first: () => ({
		evaluate: async fn => fn({ tagName: kinds[selector][0], getAttribute: () => kinds[selector][1] }),
		fill: async value => calls.push(['fill', selector, value]),
		selectOption: async value => calls.push(['select', selector, value]),
		setChecked: async value => calls.push(['checked', selector, value]),
	}) }) };
	const result = await fill(page, { fields: [
		{ selector: 'text', value: 'hello' }, { selector: 'select', value: 'second' },
		{ selector: 'check', value: false }, { selector: 'radio', value: true },
	] });
	assert.equal(result.filled, 4);
	assert.deepEqual(calls, [['fill', 'text', 'hello'], ['select', 'select', 'second'], ['checked', 'check', false], ['checked', 'radio', true]]);
});

test('invalid checkbox value reports a failure without clicking', async () => {
	let clicked = false;
	const page = { locator: () => ({ first: () => ({ evaluate: async () => ({ tag: 'input', type: 'checkbox' }), setChecked: async () => { clicked = true; } }) }) };
	const result = await fill(page, { fields: [{ selector: 'input', value: 'maybe' }] });
	assert.equal(result.filled, 0);
	assert.equal(clicked, false);
});
