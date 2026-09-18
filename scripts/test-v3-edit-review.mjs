/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// V3Code - native edit-review lifecycle regression tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/vs/workbench/contrib/void/browser/v3codeToolAdapters.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.members.some(member => member.name?.getText(ast) === '_invokeBuiltinTool'));
const method = declaration.members.find(member => member.name?.getText(ast) === '_invokeBuiltinTool');
class URI { }
const Adapter = vm.runInNewContext(ts.transpileModule(`let nextV3ReviewOperationId = -1; class Adapter { ${method.getText(ast)} } Adapter;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
	URI, Error, EDIT_TOOLS: new Set(['edit_file', 'rewrite_file', 'append_file', 'create_file_or_folder']), TERMINAL_CHAT_TOOLS: new Set(),
	getV3CodeToolPresenter: () => ({ present: () => ({}) }), SLIM_DIFF_LANGUAGE_ID: 'diff',
});

function fixture({ fail = false, review = true } = {}) {
	const events = [];
	const response = {};
	const uri = new URI();
	const adapter = new Adapter();
	const editingSession = {
		async startExternalEdits(actualResponse, id, resources, undoStop) {
			assert.equal(actualResponse, response); assert.equal(resources.length, 1); assert.equal(resources[0], uri);
			assert.ok(id < 0); assert.equal(undoStop, 'call'); events.push('start');
		},
		async stopExternalEdits() { events.push('stop'); },
	};
	Object.assign(adapter, {
		chatService: { getSession: () => ({ getRequests: () => [{ id: 'request', response }], editingSession: review ? editingSession : undefined }) },
		voidModelService: { initializeModel: async () => {} },
		v3ToolsService: {
			validateParams: {}, stringOfResult: {},
			callTool: Object.fromEntries(['edit_file', 'rewrite_file', 'append_file'].map(name => [name, async () => {
				events.push('write'); if (fail) { throw new Error('partial write'); } return { result: { added: 1 } };
			}])),
		},
		_toolContext: () => undefined, _captureFileContent: () => '', _createSnapshotModel: () => uri,
		_emitExternalEdit: () => events.push('card'), _isDebugModeRequest: () => false,
	});
	return { events, run: tool => adapter._invokeBuiltinTool(tool, { parameters: { uri }, context: { sessionResource: uri }, chatRequestId: 'request', callId: 'call' }) };
}

for (const tool of ['edit_file', 'rewrite_file', 'append_file']) {
	test(`${tool} registers review before writing and finalizes before the transcript card`, async () => {
		const f = fixture(); await f.run(tool); assert.deepEqual(f.events, ['start', 'write', 'stop', 'card']);
	});
}
test('failed writes still release review tracking', async () => {
	const f = fixture({ fail: true }); const result = await f.run('edit_file');
	assert.deepEqual(f.events, ['start', 'write', 'stop']); assert.equal(result.toolResultError, 'partial write');
});
test('sessions without native review retain their existing transcript path', async () => {
	const f = fixture({ review: false }); await f.run('edit_file'); assert.deepEqual(f.events, ['write', 'card']);
});
test('successive edits each open and finalize a review operation', async () => {
	const f = fixture();
	await f.run('edit_file'); await f.run('append_file');
	assert.deepEqual(f.events, ['start', 'write', 'stop', 'card', 'start', 'write', 'stop', 'card']);
});
