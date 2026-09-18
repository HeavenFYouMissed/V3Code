/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// V3Code - restored agent ownership and explicit continuation regression tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/vs/workbench/contrib/void/browser/externalAgentPicker.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('picker.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(ts.isClassDeclaration);
const members = declaration.members.filter(member => ['currentType', 'currentIdentity', 'getActions'].includes(member.name?.getText(ast)));
const icon = id => ({ id });
const Picker = vm.runInNewContext(ts.transpileModule(`class Picker { ${members.map(member => member.getText(ast)).join('\n')} } Picker;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
	getChatSessionType: resource => resource, localize: (_key, text, ...args) => text.replace(/\{(\d+)\}/g, (_, n) => args[n]),
	Codicon: { claude: icon('claude'), plug: icon('plug'), plus: icon('plus'), account: icon('account'), terminal: icon('terminal') },
	v3AgentMark: icon('v3'), ThemeIcon: { isThemeIcon: value => !!value?.id },
	getExternalAgentSessionIcon: type => type === 'agent-host-acp-claude-acp' ? icon('acp-claude') : undefined,
	getExternalAgentPickerItems: (state, current) => state.catalogue.agents.map(entry => ({ ...entry, type: `agent-host-acp-${entry.id}`, checked: current === `agent-host-acp-${entry.id}`, enabled: true })),
	LocalChatSessionUri: { getNewSessionUri: () => 'new-local' }, ACTIVE_GROUP: 1,
});

function fixture(type) {
	const events = [];
	const picker = new Picker();
	picker.widget = { viewModel: { sessionResource: type, model: { getRequests: () => [{ message: { text: 'hello' }, response: { response: { toString: () => 'answer' } } }] } } };
	picker.agents = { state: { catalogue: { agents: [{ id: 'claude-acp', name: 'Claude Agent' }] } }, openSetupTerminal: id => events.push(['setup', id]), openChat: () => events.push(['new-acp']) };
	picker.sessions = { getChatSessionContribution: () => undefined };
	picker.account = { signIn: () => events.push(['sign-in']) };
	picker.widgets = { openSession: async resource => { events.push(['open', resource]); return { setInput: draft => events.push(['draft', draft]), focusInput() {} }; } };
	return { picker, events };
}

test('legacy Claude retains its identity and is the checked current row', () => {
	const { picker } = fixture('agent-host-claude');
	assert.equal(picker.currentIdentity.name, 'Claude');
	assert.equal(picker.currentIdentity.icon.id, 'claude');
	assert.equal(picker.getActions().find(action => action.checked).id, 'agent-host-claude');
});
test('unknown external providers never become V3Code', () => {
	const { picker } = fixture('custom-provider');
	assert.equal(picker.currentIdentity.name, 'custom-provider');
	assert.equal(picker.currentIdentity.icon.id, 'plug');
});
test('ACP identity is preserved and current-row selection does not create another chat', async () => {
	const { picker, events } = fixture('agent-host-acp-claude-acp');
	assert.equal(picker.currentIdentity.name, 'Claude Agent');
	await picker.getActions().find(action => action.checked).run();
	assert.equal(events.length, 0);
});
test('continuation creates an unsent draft without changing original ownership', async () => {
	const { picker, events } = fixture('agent-host-claude');
	await picker.getActions().find(action => action.id === 'continue-local').run();
	assert.equal(events[0][0], 'open');
	assert.match(events[1][1], /User: hello\nAssistant: answer/);
	assert.equal(picker.currentType, 'agent-host-claude');
	assert.equal(events.length, 2);
});
test('legacy reconnect invokes account sign-in without opening a new chat', () => {
	const { picker, events } = fixture('agent-host-claude');
	picker.getActions().find(action => action.id === 'reconnect-claude').run();
	assert.deepEqual(events, [['sign-in']]);
});
