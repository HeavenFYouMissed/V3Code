/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual view's async methods with narrow service doubles. The full
// view imports Electron/DOM services unavailable to this headless race fixture.
const source = readFileSync(new URL('../src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('chatViewPane.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ChatViewPane');
const names = ['applyModel', '_applyModel', 'showModel', 'updateWidgetLockState', 'clear', 'loadSession'];
const methods = names.map(name => {
	const method = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
	assert.ok(method, `Missing method ${name}`);
	return method.getText(ast);
});
class CancellationTokenSource {
	token = { isCancellationRequested: false, onCancellationRequested: listener => { this.listeners.push(listener); return { dispose() { } }; } };
	listeners = [];
	cancel() { this.token.isCancellationRequested = true; for (const listener of this.listeners) { listener(); } }
}
const View = vm.runInNewContext(ts.transpileModule(`class View { ${methods.join('\n')} }\nView;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
	CancellationTokenSource, ChatAgentLocation: { Chat: 'chat' }, ChatViewId: 'chat', localChatSessionType: 'local',
	getChatSessionType: resource => resource.scheme,
	disposableTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); return { dispose: () => clearTimeout(timer) }; },
	localize: (_key, text) => text, toErrorMessage: String,
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function ref(scheme) { return { object: { sessionResource: { scheme, toString: () => scheme } }, disposed: false, dispose() { this.disposed = true; } }; }
function fixture() {
	const view = new View();
	Object.assign(view, {
		restoreSessionCts: {}, loadSessionCts: {}, modelRef: {}, viewState: {},
		logService: { trace() { }, warn() { }, error() { } }, notificationService: { error: assert.fail },
		progressService: { withProgress: (_options, fn) => fn() },
		chatSessionsService: { canResolveChatSession: async () => true, getChatSessionContribution: type => ({ name: type, displayName: type }) },
		chatService: { startNewLocalSession: () => ref('local') },
		_widget: { setModel(model) { this.model = model; }, unlockFromCodingAgent() { this.lock = undefined; }, lockToCodingAgent(type) { this.lock = type; } },
		updateActions() { }, updateViewState() { }, _register(disposable) { disposable.dispose(); },
	});
	return view;
}
test('an explicit load does not wait for an unresponsive startup restore', async () => {
	const view = fixture();
	const stale = deferred();
	const old = ref('old-provider');
	const selected = ref('agent-host-acp-test');
	view.getTransferredOrPersistedSessionInfo = () => old.object.sessionResource;
	view.chatService.acquireOrLoadSession = async resource => resource === old.object.sessionResource ? stale.promise : selected;
	view.applyModel();
	const restoration = view.restoringSession;
	await view.loadSession(selected.object.sessionResource);
	assert.equal(view._widget.model, selected.object);
	stale.resolve(old);
	await restoration;
	assert.equal(old.disposed, true);
	assert.equal(view._widget.model, selected.object);
});
test('new local chat supersedes restore and does not reopen a transferred provider', async () => {
	const view = fixture();
	const stale = deferred();
	const old = ref('old-provider');
	view.getTransferredOrPersistedSessionInfo = () => old.object.sessionResource;
	view.chatService.transferredSessionResource = old.object.sessionResource;
	view.chatService.acquireOrLoadSession = () => stale.promise;
	view.applyModel();
	const restoration = view.restoringSession;
	await view.clear();
	const selected = view._widget.model;
	assert.equal(selected.sessionResource.scheme, 'local');
	stale.resolve(old);
	await restoration;
	assert.equal(old.disposed, true);
	assert.equal(view._widget.model, selected);
});
test('late provider lock resolution cannot relock or clear the new local model', async () => {
	const view = fixture();
	const resolution = deferred();
	view.chatSessionsService.canResolveChatSession = () => resolution.promise;
	const cts = new CancellationTokenSource();
	const old = ref('old-provider');
	const pending = view.showModel(cts.token, old);
	cts.cancel();
	await view.clear();
	const selected = view.modelRef.value;
	resolution.resolve(true);
	await pending;
	assert.equal(old.disposed, true);
	assert.equal(view.modelRef.value, selected);
	assert.equal(view._widget.lock, undefined);
});
test('failed startup restore falls back to a usable local model', async () => {
	const view = fixture();
	view.getTransferredOrPersistedSessionInfo = () => ref('missing').object.sessionResource;
	view.chatService.acquireOrLoadSession = async () => { throw new Error('provider unavailable'); };
	view.applyModel();
	await view.restoringSession;
	assert.equal(view._widget.model.sessionResource.scheme, 'local');
});
