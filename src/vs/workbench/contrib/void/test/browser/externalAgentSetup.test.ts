/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { stageExternalAgentSetup } from '../../browser/externalAgentSetup.js';

suite('External agent setup terminal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('stages a reviewed command without executing it', async () => {
		const calls: unknown[] = [];
		await stageExternalAgentSetup(' fixture-agent login ', async () => ({ sendText: async (text, addNewLine) => { calls.push({ text, addNewLine }); } }));
		assert.deepStrictEqual(calls, [{ text: 'fixture-agent login', addNewLine: false }]);
	});
	test('blank input opens a shell without sending text', async () => {
		let created = false;
		await stageExternalAgentSetup(' ', async () => { created = true; return { sendText: async () => assert.fail('Unexpected terminal input') }; });
		assert.strictEqual(created, true);
	});
	test('rejects pasted execution controls before opening a terminal', async () => {
		for (const command of ['command\nother', 'command\r', '\x1b[200~command', 'command\0']) {
			await assert.rejects(stageExternalAgentSetup(command, async () => { assert.fail('Unexpected terminal creation'); }), /single line/);
		}
	});
	test('terminal failures propagate for the service to surface', async () => {
		await assert.rejects(stageExternalAgentSetup('command', async () => { throw new Error('terminal unavailable'); }), /terminal unavailable/);
	});
});
