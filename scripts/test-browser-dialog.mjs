/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/vs/platform/browserView/node/playwrightTab.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { PlaywrightTab } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture() {
	const listeners = new Map();
	const page = {
		on(name, listener) { listeners.set(name, listener); return this; },
		off(name) { listeners.delete(name); },
		consoleMessages: async () => [], pageErrors: async () => [], url: () => 'about:blank',
		waitForFunction: async () => true,
	};
	const tab = new PlaywrightTab(page, { activeCalls: 0 }, { isUriAllowed: () => true });
	// Isolate dialog dispatch from page-load settling; the real dispatch and
	// one-shot response storage are exercised below.
	tab.safeRunAgainstPage = async action => action(page);
	return { tab, open: dialog => listeners.get('dialog')(dialog) };
}

test('pre-armed response is consumed once on its own page', async () => {
	const first = fixture();
	const second = fixture();
	let accepted;
	assert.equal(await first.tab.replyToDialog(true, 'answer'), true);
	first.open({ accept: async value => { accepted = value; }, dismiss: async () => assert.fail('wrong response') });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(accepted, 'answer');
	assert.equal(first.tab._nextDialogResponse, undefined);
	assert.equal(second.tab._nextDialogResponse, undefined);
});

test('expired response cannot answer a later dialog', async () => {
	const f = fixture();
	let accepted = false;
	await f.tab.replyToDialog(true);
	f.tab._nextDialogResponse.expiresAt = 0;
	f.open({ accept: async () => { accepted = true; }, dismiss: async () => {} });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(accepted, false);
});

test('pre-armed rejection dismisses instead of accepting', async () => {
	const f = fixture();
	let dismissed = false;
	await f.tab.replyToDialog(false);
	f.open({ accept: async () => assert.fail('must not accept'), dismiss: async () => { dismissed = true; } });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(dismissed, true);
});
