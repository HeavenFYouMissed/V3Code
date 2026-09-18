/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// V3Code - editor tab identity and measured header regression checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function extract(file, methodName, globals) {
	const source = readFileSync(new URL(file, import.meta.url), 'utf8');
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.members.some(member => member.name?.getText(ast) === methodName));
	const method = declaration.members.find(member => member.name?.getText(ast) === methodName);
	return vm.runInNewContext(ts.transpileModule(`class Subject { ${method.getText(ast)} } Subject;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, globals);
}
const Editor = extract('../src/vs/workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.ts', 'resolveIcon', {
	getExternalAgentSessionIcon: type => type === 'agent-host-acp-grok-build' ? 'grok' : undefined,
	localChatSessionType: 'local', v3AgentMark: 'v3', Codicon: { claude: 'claude' },
});
for (const [type, expected] of [['local', 'v3'], ['agent-host-acp-grok-build', 'grok'], ['agent-host-claude', 'claude'], ['claude-code', 'claude'], ['custom', 'registered']]) {
	test(`editor tab preserves ${type} identity`, () => {
		const editor = new Editor();
		editor.getSessionType = () => type;
		editor.chatSessionsService = { getChatSessionContribution: () => ({ icon: 'registered' }) };
		assert.equal(editor.resolveIcon(), expected);
	});
}
test('tab layout measurement matches the styled header height', () => {
	const Tabs = extract('../src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTabsControl.ts', 'getHeight', {});
	const tabs = new Tabs();
	tabs.visible = true; assert.equal(tabs.getHeight(), 36);
	tabs.visible = false; assert.equal(tabs.getHeight(), 0);
	const css = readFileSync(new URL('../src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewTabsControl.css', import.meta.url), 'utf8');
	assert.match(css, /\.chat-view-tabs\s*\{[^}]*height: 36px/s);
});
