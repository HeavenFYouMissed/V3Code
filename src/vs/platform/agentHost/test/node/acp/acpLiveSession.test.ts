/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { fileURLToPath } from 'url';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../files/common/fileService.js';
import { IFileService } from '../../../../files/common/files.js';
import { DiskFileSystemProvider } from '../../../../files/node/diskFileSystemProvider.js';
import { InstantiationService } from '../../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../../log/common/log.js';
import type { AgentSignal } from '../../../common/agentService.js';
import { IDiffComputeService } from '../../../common/diffComputeService.js';
import { sessionReducer } from '../../../common/state/protocol/reducers.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { ResponsePartKind, SessionLifecycle, SessionStatus, ToolCallStatus, ToolResultContentType, TurnState, type SessionState } from '../../../common/state/sessionState.js';
import { getBundledAcpSdkPath } from '../../../node/acp/acpSdkLocation.js';
import { AcpSdkService, type AcpSdkModule } from '../../../node/acp/acpSdkService.js';
import { AcpAuthRequiredError, AcpLiveSession, AcpStartupError, type IAcpSessionStartOptions } from '../../../node/acp/acpSession.js';
import { createSessionDataService, createZeroDiffComputeService } from '../../common/sessionTestHelpers.js';

// out/vs/platform/agentHost/test/node/acp/<file> → repository root
const REPO_ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./acpFixtureAgentMain.js', import.meta.url));
const SDK_PATH = getBundledAcpSdkPath(REPO_ROOT);
const SESSION = URI.parse('acp-fixture:/live-1');

interface IHarness {
	readonly sdk: AcpSdkModule;
	readonly cwd: string;
	start(env?: Record<string, string>, resumeSessionId?: string, options?: Partial<IAcpSessionStartOptions>): Promise<{ session: AcpLiveSession; signals: AgentSignal[] }>;
}

function reduce(signals: readonly AgentSignal[], turnId: string): SessionState {
	let state: SessionState = {
		summary: { resource: SESSION.toString(), provider: 'acp-fixture', title: '', status: SessionStatus.Idle, createdAt: 0, modifiedAt: 0 },
		lifecycle: SessionLifecycle.Ready,
		turns: [],
	};
	state = sessionReducer(state, { type: ActionType.SessionTurnStarted, turnId, userMessage: { text: 'x' } });
	for (const signal of signals) {
		if (signal.kind === 'action') {
			state = sessionReducer(state, signal.action);
		} else if (signal.kind === 'pending_confirmation') {
			state = sessionReducer(state, { type: ActionType.SessionToolCallReady, turnId, toolCallId: signal.state.toolCallId, invocationMessage: signal.state.invocationMessage, toolInput: signal.state.toolInput, confirmationTitle: signal.state.confirmationTitle });
		}
	}
	return state;
}

suite('ACP live session – fixture agent over stdio', function () {

	this.timeout(30_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let harness: IHarness;
	let tempDirs: string[] = [];

	suiteSetup(async function () {
		if (!SDK_PATH) {
			this.skip();
		}
	});

	setup(async () => {
		const logService = new NullLogService();
		const sdk = await new AcpSdkService(SDK_PATH!, logService).load();
		const fileService = disposables.add(new FileService(logService));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new DiskFileSystemProvider(logService))));
		const instantiationService = disposables.add(new InstantiationService(new ServiceCollection(
			[ILogService, logService],
			[IFileService, fileService],
			[IDiffComputeService, createZeroDiffComputeService()],
		)));
		const sessionDataService = createSessionDataService();
		const cwd = mkdtempSync(join(tmpdir(), 'acp-live-'));
		tempDirs.push(cwd);
		harness = {
			sdk,
			cwd,
			start: async (env = {}, resumeSessionId, options = {}) => {
				const session = await AcpLiveSession.start(sdk, {
					sessionUri: SESSION,
					command: process.execPath,
					args: [FIXTURE],
					cwd,
					env: { ...process.env, ...env },
					clientInfo: { name: 'acp-tests', version: '0.0.0' },
					resumeSessionId,
					...options,
				}, instantiationService, fileService, sessionDataService, logService);
				disposables.add(session);
				const signals: AgentSignal[] = [];
				disposables.add(session.onDidSignal(s => signals.push(s)));
				return { session, signals };
			},
		};
	});

	teardown(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function prompt(session: AcpLiveSession, turnId: string, text: string) {
		return session.prompt(turnId, { text }, [{ type: 'text', text }]);
	}

	test('initialize + session/new expose agent info and capabilities', async () => {
		const { session } = await harness.start();
		assert.strictEqual(session.info.agentInfo?.name, 'fixture-agent');
		assert.strictEqual(session.info.capabilities.loadSession, true);
		assert.strictEqual(session.info.resumed, false);
		assert.ok(session.info.acpSessionId.startsWith('fixture-session-'));
		assert.strictEqual(session.exited, false);
		// stdout and stderr are independent pipes; protocol readiness does not order stderr delivery.
		for (let attempt = 0; attempt < 50 && !session.stderrTail.includes('new session'); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		assert.ok(session.stderrTail.includes('new session'), `stderr tail: ${session.stderrTail}`);
	});

	test('a prompt streams markdown and completes the turn', async () => {
		const { session, signals } = await harness.start();
		const result = await prompt(session, 't1', 'echo hi there');
		assert.strictEqual(result.turnState, TurnState.Complete);
		assert.strictEqual(result.turn.id, 't1');
		assert.strictEqual(result.turn.responseParts.length, 1);
		const state = reduce(signals, 't1');
		assert.strictEqual(state.activeTurn, undefined);
		assert.strictEqual(state.turns[0].state, TurnState.Complete);
		const part = state.turns[0].responseParts[0];
		assert.ok(part.kind === ResponsePartKind.Markdown && part.content === 'echo: hi there');
	});

	test('thought chunks become reasoning parts', async () => {
		const { session, signals } = await harness.start();
		await prompt(session, 't1', 'think');
		const state = reduce(signals, 't1');
		assert.deepStrictEqual(state.turns[0].responseParts.map(p => p.kind), [ResponsePartKind.Reasoning, ResponsePartKind.Markdown]);
	});

	test('tool calls ask for permission; approval runs the tool', async () => {
		const { session, signals } = await harness.start();
		disposables.add(session.onDidSignal(s => {
			if (s.kind === 'pending_confirmation') {
				assert.strictEqual(s.permissionKind, 'shell');
				assert.strictEqual(s.state.toolInput, 'fixture --run');
				assert.ok(session.respondPermission(s.state.toolCallId, true));
			}
		}));
		const result = await prompt(session, 't1', 'tool');
		assert.strictEqual(result.turnState, TurnState.Complete);
		const state = reduce(signals, 't1');
		const card = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(card && card.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(card.toolCall.status, ToolCallStatus.Completed);
		assert.ok(card.toolCall.status === ToolCallStatus.Completed && card.toolCall.success);
		assert.deepStrictEqual(card.toolCall.status === ToolCallStatus.Completed && card.toolCall.content, [{ type: ToolResultContentType.Text, text: 'fixture output' }]);
		const last = state.turns[0].responseParts[state.turns[0].responseParts.length - 1];
		assert.ok(last.kind === ResponsePartKind.Markdown && last.content === 'ran');
	});

	test('denying permission fails the tool call with the agent error', async () => {
		const { session, signals } = await harness.start();
		disposables.add(session.onDidSignal(s => {
			if (s.kind === 'pending_confirmation') {
				session.respondPermission(s.state.toolCallId, false);
			}
		}));
		await prompt(session, 't1', 'tool');
		const state = reduce(signals, 't1');
		const card = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(card && card.kind === ResponsePartKind.ToolCall && card.toolCall.status === ToolCallStatus.Completed);
		assert.strictEqual(card.toolCall.success, false);
		assert.strictEqual(card.toolCall.error?.message, 'denied by user');
	});

	test('answering an unknown permission id is reported as not pending', async () => {
		const { session } = await harness.start();
		assert.strictEqual(session.respondPermission('nope', true), false);
	});

	test('fs/write_text_file writes to disk and attaches the edit to the running tool call', async () => {
		const { session, signals } = await harness.start();
		disposables.add(session.onDidSignal(s => {
			if (s.kind === 'pending_confirmation') {
				assert.strictEqual(s.permissionKind, 'write');
				session.respondPermission(s.state.toolCallId, true);
			}
		}));
		const target = join(harness.cwd, 'out.txt');
		await prompt(session, 't1', `write ${target}`);
		assert.strictEqual(readFileSync(target, 'utf8'), 'written by fixture\n');
		const state = reduce(signals, 't1');
		const card = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(card && card.kind === ResponsePartKind.ToolCall && card.toolCall.status === ToolCallStatus.Completed);
		assert.ok((card.toolCall.content ?? []).length >= 1, 'edit content attached');
	});

	test('fs/read_text_file honours line and limit', async () => {
		const { session, signals } = await harness.start();
		disposables.add(session.onDidSignal(s => {
			if (s.kind === 'pending_confirmation') {
				assert.strictEqual(s.permissionKind, 'read');
				session.respondPermission(s.state.toolCallId, true);
			}
		}));
		const target = join(harness.cwd, 'in.txt');
		writeFileSync(target, 'first\nsecond\nthird\n');
		await prompt(session, 't1', `read ${target}`);
		const state = reduce(signals, 't1');
		const part = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.Markdown);
		assert.ok(part?.kind === ResponsePartKind.Markdown && part.content === 'line2=second');
	});

	test('denied filesystem writes leave existing contents untouched', async () => {
		const { session } = await harness.start();
		const target = join(harness.cwd, 'protected.txt');
		writeFileSync(target, 'unchanged');
		disposables.add(session.onDidSignal(s => {
			if (s.kind === 'pending_confirmation') {
				session.respondPermission(s.state.toolCallId, false);
			}
		}));
		await assert.rejects(prompt(session, 't1', `write ${target}`), /File access denied/);
		assert.strictEqual(readFileSync(target, 'utf8'), 'unchanged');
	});

	test('cancel releases pending permissions without a user response', async () => {
		const { session } = await harness.start();
		const permission = Event.toPromise(Event.filter(session.onDidSignal, s => s.kind === 'pending_confirmation'));
		const pending = prompt(session, 't1', 'tool');
		await permission;
		await session.cancel();
		await pending;
		assert.strictEqual(session.isPromptActive, false);
	});

	test('plans render as a completed card', async () => {
		const { session, signals } = await harness.start();
		await prompt(session, 't1', 'plan');
		const state = reduce(signals, 't1');
		const card = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(card && card.kind === ResponsePartKind.ToolCall && card.toolCall.status === ToolCallStatus.Completed);
		assert.ok(card.toolCall.content?.[0].type === ToolResultContentType.Text && card.toolCall.content[0].text.includes('second'));
	});

	test('session title updates reach the reducer', async () => {
		const { session, signals } = await harness.start();
		await prompt(session, 't1', 'title Renamed by agent');
		assert.strictEqual(reduce(signals, 't1').summary.title, 'Renamed by agent');
	});

	test('cancel() ends a hanging prompt with a cancelled turn', async () => {
		const { session, signals } = await harness.start();
		const pending = prompt(session, 't1', 'hang');
		await Event.toPromise(Event.filter(session.onDidSignal, s => s.kind === 'action' && s.action.type === ActionType.SessionResponsePart));
		assert.strictEqual(session.isPromptActive, true);
		await session.cancel();
		const result = await pending;
		assert.strictEqual(result.turnState, TurnState.Cancelled);
		assert.strictEqual(session.isPromptActive, false);
		assert.strictEqual(reduce(signals, 't1').turns[0].state, TurnState.Cancelled);
		// The session is still usable afterwards.
		const next = await prompt(session, 't2', 'echo again');
		assert.strictEqual(next.turnState, TurnState.Complete);
	});

	test('a refusal is surfaced as a session error, not a crash', async () => {
		const { session, signals } = await harness.start();
		const result = await prompt(session, 't1', 'refuse');
		assert.strictEqual(result.turnState, TurnState.Error);
		assert.strictEqual(result.error?.errorType, 'acp_stop_refusal');
		assert.strictEqual(reduce(signals, 't1').turns[0].state, TurnState.Error);
	});

	test('an agent crash mid-turn rejects the prompt and exposes exit info and stderr', async () => {
		const { session } = await harness.start();
		const exited = Event.toPromise(session.onDidExit);
		await assert.rejects(prompt(session, 't1', 'crash'));
		const exit = await exited;
		assert.strictEqual(exit.code, 7);
		assert.strictEqual(session.exited, true);
		assert.deepStrictEqual(session.exitInfo, exit);
		assert.ok(session.stderrTail.includes('fatal error'));
	});

	test('session/load is used when resuming and the agent supports it', async () => {
		const { session } = await harness.start({}, 'fixture-session-resume');
		assert.strictEqual(session.info.resumed, true);
		assert.strictEqual(session.info.acpSessionId, 'fixture-session-resume');
	});

	test('model config options are exposed and can be changed', async () => {
		const { session } = await harness.start({ ACP_FIXTURE_MODELS: '1' });
		const model = session.info.configOptions.find(o => o.category === 'model');
		assert.ok(model && model.type === 'select');
		assert.strictEqual(model.currentValue, 'fixture-small');
		const changed = Event.toPromise(session.onDidChangeConfigOptions);
		await session.setConfigOption('model', 'fixture-large');
		const options = await changed;
		const updated = options.find(o => o.id === 'model');
		assert.ok(updated && updated.type === 'select' && updated.currentValue === 'fixture-large');
	});

	test('authentication required is reported with the method names', async () => {
		await assert.rejects(harness.start({ ACP_FIXTURE_AUTH: '1' }), (err: unknown) => err instanceof AcpAuthRequiredError && err.authMethods.length === 1 && err.authMethods[0].name === 'Fixture login');
	});

	test('advertised commands arrive before the first prompt', async () => {
		const { session } = await harness.start();
		assert.strictEqual(session.availableCommands[0]?.name, 'inspect');
	});

	test('editor MCP is passed to session creation', async () => {
		const { session } = await harness.start({ ACP_FIXTURE_EXPECT_MCP: '1' }, undefined, { mcpServers: [{ name: 'v3code', command: 'fixture', args: [], env: [] }] });
		assert.ok(session.info.acpSessionId);
	});

	test('briefing is sent once without replacing user text', async () => {
		const { session } = await harness.start({}, undefined, { briefing: 'V3Code host briefing' });
		const first = await prompt(session, 'context-1', 'context');
		const second = await prompt(session, 'context-2', 'context');
		assert.ok(JSON.stringify(first.turn).includes('V3Code host briefing'));
		assert.ok(!JSON.stringify(second.turn).includes('V3Code host briefing'));
	});

	test('managed authentication waits for consent and retries session creation', async () => {
		let asked = false;
		const { session } = await harness.start({ ACP_FIXTURE_AUTH: 'agent' }, undefined, { requestAuthentication: async method => { asked = true; assert.strictEqual(method.id, 'fixture-login'); return true; } });
		assert.ok(asked && session.info.acpSessionId);
	});

	test('declined managed authentication does not start a session', async () => {
		await assert.rejects(harness.start({ ACP_FIXTURE_AUTH: 'agent' }, undefined, { requestAuthentication: async () => false }), AcpAuthRequiredError);
	});

	test('a protocol version mismatch is a startup error naming both versions', async () => {
		await assert.rejects(harness.start({ ACP_FIXTURE_PROTOCOL: '99' }), (err: unknown) => err instanceof AcpStartupError && /99/.test(err.message) && new RegExp(String(harness.sdk.PROTOCOL_VERSION)).test(err.message));
	});

	test('an agent that exits during startup is a startup error carrying its stderr', async () => {
		await assert.rejects(harness.start({ ACP_FIXTURE_STARTUP: 'exit' }), (err: unknown) => err instanceof AcpStartupError && err.exit?.code === 2 && err.stderrTail.includes('refusing to start'));
	});

	test('dispose() stops the agent process', async () => {
		const store = new DisposableStore();
		const { session } = await harness.start();
		store.add(session);
		store.dispose();
		const exit = await session.whenExited();
		assert.notStrictEqual(exit.code, 0);
		assert.strictEqual(session.exited, true);
	});
});
