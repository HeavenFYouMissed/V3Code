/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { editorBriefing, editorMcpServers } from '../../../node/acp/acpEditorContext.js';
import { completeAcpCommands } from '../../../node/acp/acpCommands.js';
import { CompletionItemKind } from '../../../common/state/protocol/commands.js';

suite('ACP editor context and commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const params = (text: string) => ({ kind: CompletionItemKind.UserMessage, channel: 'acp-fixture:/one', text, offset: text.length });
	const commands = [{ name: 'inspect', description: 'Inspect a target', input: { hint: 'path' } }, { name: 'clear', description: 'Clear agent context' }];
	test('advertised commands retain arguments and descriptions', () => {
		const result = completeAcpCommands(commands, params('/ins'));
		assert.strictEqual(result.items.length, 1);
		assert.strictEqual(result.items[0].insertText, '/inspect ');
		assert.strictEqual(result.items[0].attachment._meta?.description, 'Inspect a target (path)');
		assert.strictEqual(result.items[0].rangeEnd, 4);
	});
	test('slash offers all advertised commands', () => assert.strictEqual(completeAcpCommands(commands, params('/')).items.length, 2));
	test('ordinary text never offers commands', () => assert.deepStrictEqual(completeAcpCommands(commands, params('hello /')), { items: [] }));
	test('argument text never reopens command suggestions', () => assert.deepStrictEqual(completeAcpCommands(commands, params('/inspect path')), { items: [] }));
	test('unknown command is not fabricated', () => assert.deepStrictEqual(completeAcpCommands(commands, params('/invented')), { items: [] }));
	test('duplicate and malformed commands are dropped', () => assert.strictEqual(completeAcpCommands([...commands, commands[0], { name: '../bad', description: '' }], params('/')).items.length, 2));
	test('both disabled means no host MCP', () => assert.deepStrictEqual(editorMcpServers('/app', '/runtime', '123', '/workspace', false, false), []));
	test('missing editor identity fails closed', () => assert.deepStrictEqual(editorMcpServers('/app', '/runtime', undefined, '/workspace', true, true), []));
	test('host connection pins PID and workspace without credentials', () => {
		const [server] = editorMcpServers('/app', '/runtime', '123', '/workspace', true, false);
		assert.ok(hasKey(server, { command: true }));
		assert.strictEqual(server.command, '/runtime');
		assert.ok(server.env.some(v => v.name === 'V3CODE_MCP_PARENT_PID' && v.value === '123'));
		assert.ok(server.env.some(v => v.name === 'V3CODE_MCP_BROWSER' && v.value === '0'));
		assert.ok(!JSON.stringify(server).includes('Authorization'));
	});
	test('host identity survives disabled MCP', () => {
		const text = editorBriefing('/workspace', false, false, false);
		assert.ok(text.includes('V3Code\'s native chat'));
		assert.ok(text.includes('No host MCP connection'));
	});
	test('browser briefing promises observation not fabricated verification', () => assert.ok(editorBriefing('/workspace', true, true, true).includes('Never claim visual verification')));
	test('workspace guidance preserves scope and explains the user workflow', () => {
		for (const configured of [false, true]) {
			const text = editorBriefing('/target folder', configured, false, configured);
			assert.ok(text.includes('"/target folder"'));
			assert.ok(text.includes('Reading files outside this workspace does not retarget'));
			assert.ok(text.includes('open its folder in V3Code (or another window)'));
			assert.ok(text.includes('start a new ACP chat there'));
			assert.ok(text.includes('No other agent is needed'));
			assert.ok(text.includes('Check index readiness'));
			assert.ok(text.includes('Do not silently switch projects'));
		}
	});
});
