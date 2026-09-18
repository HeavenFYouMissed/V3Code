/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { AgentSignal } from '../../../common/agentService.js';
import { sessionReducer } from '../../../common/state/protocol/reducers.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { ResponsePartKind, SessionLifecycle, SessionStatus, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type SessionState, type ToolCallState } from '../../../common/state/sessionState.js';
import { AcpTurnTracker, commandFromRawInput, mapSessionUpdate, mapStopReason, permissionKindForToolKind } from '../../../node/acp/acpUpdateMapper.js';

const SESSION = URI.parse('acp-fixture:/session-1');
const TURN = 'turn-1';

function makeSession(): SessionState {
	let state: SessionState = {
		summary: {
			resource: SESSION.toString(),
			provider: 'acp-fixture',
			title: 'Test',
			status: SessionStatus.Idle,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
		},
		lifecycle: SessionLifecycle.Ready,
		turns: [],
	};
	state = sessionReducer(state, { type: ActionType.SessionTurnStarted, turnId: TURN, userMessage: { text: 'hello' } });
	return state;
}

/** Applies signals the way the host does: actions go straight to the reducer, permission requests become a confirmation card. */
function apply(state: SessionState, signals: AgentSignal[]): SessionState {
	for (const signal of signals) {
		if (signal.kind === 'action') {
			state = sessionReducer(state, signal.action);
		} else if (signal.kind === 'pending_confirmation') {
			state = sessionReducer(state, {
				type: ActionType.SessionToolCallReady,
				turnId: TURN,
				toolCallId: signal.state.toolCallId,
				invocationMessage: signal.state.invocationMessage,
				toolInput: signal.state.toolInput,
				confirmationTitle: signal.state.confirmationTitle,
			});
		} else {
			assert.fail(`unexpected signal kind ${signal.kind}`);
		}
	}
	return state;
}

function parts(state: SessionState) {
	return state.activeTurn?.responseParts ?? state.turns[state.turns.length - 1]?.responseParts ?? [];
}

function toolCall(state: SessionState, id: string): ToolCallState {
	for (const part of parts(state)) {
		if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === id) {
			return part.toolCall;
		}
	}
	assert.fail(`tool call ${id} not found`);
}

function tracker(): AcpTurnTracker {
	return new AcpTurnTracker(SESSION, TURN, { text: 'hello' });
}

function text(text: string): acp.ContentBlock {
	return { type: 'text', text };
}

suite('ACP update mapper – through the real session reducer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('message chunks stream into one markdown part', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: text('Hello') }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: text(', world') }, t));
		const p = parts(state);
		assert.strictEqual(p.length, 1);
		assert.strictEqual(p[0].kind, ResponsePartKind.Markdown);
		assert.strictEqual(p[0].kind === ResponsePartKind.Markdown && p[0].content, 'Hello, world');
	});

	test('thought chunks become a reasoning part, later text starts a new markdown part', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: text('thinking ') }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: text('more') }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: text('answer') }, t));
		const p = parts(state);
		assert.deepStrictEqual(p.map(x => x.kind), [ResponsePartKind.Reasoning, ResponsePartKind.Markdown]);
		assert.strictEqual(p[0].kind === ResponsePartKind.Reasoning && p[0].content, 'thinking more');
	});

	test('a tool call breaks the markdown stream so later text is a new part', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: text('before') }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file', kind: 'read', status: 'in_progress' }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: text('after') }, t));
		assert.deepStrictEqual(parts(state).map(x => x.kind), [ResponsePartKind.Markdown, ResponsePartKind.ToolCall, ResponsePartKind.Markdown]);
	});

	test('pending → in_progress → content-only update → completed', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } }, t));
		assert.strictEqual(toolCall(state, 'tc-1').status, ToolCallStatus.Streaming);

		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' }, t));
		const running = toolCall(state, 'tc-1');
		assert.strictEqual(running.status, ToolCallStatus.Running);
		assert.strictEqual(running.status === ToolCallStatus.Running && running.confirmed, ToolCallConfirmationReason.NotNeeded);

		// Partial update: content only, status omitted → still Running, content replaced.
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', content: [{ type: 'content', content: text('1 passing') }] }, t));
		const withContent = toolCall(state, 'tc-1');
		assert.strictEqual(withContent.status, ToolCallStatus.Running);
		assert.deepStrictEqual(withContent.status === ToolCallStatus.Running && withContent.content, [{ type: ToolResultContentType.Text, text: '1 passing' }]);

		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' }, t));
		const done = toolCall(state, 'tc-1');
		assert.strictEqual(done.status, ToolCallStatus.Completed);
		assert.strictEqual(done.status === ToolCallStatus.Completed && done.success, true);
		assert.deepStrictEqual(done.status === ToolCallStatus.Completed && done.content, [{ type: ToolResultContentType.Text, text: '1 passing' }]);
	});

	test('a completed update for an unknown call still produces Start → Ready → Complete', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-late', title: 'Search', kind: 'search', status: 'completed' }, t));
		assert.strictEqual(toolCall(state, 'tc-late').status, ToolCallStatus.Completed);
	});

	test('failed calls complete with success=false and carry the raw output as the error', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Edit', kind: 'edit', status: 'in_progress' }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed', rawOutput: 'permission denied' }, t));
		const tc = toolCall(state, 'tc-1');
		assert.strictEqual(tc.status, ToolCallStatus.Completed);
		assert.strictEqual(tc.status === ToolCallStatus.Completed && tc.success, false);
		assert.strictEqual(tc.status === ToolCallStatus.Completed && tc.error?.message, 'permission denied');
	});

	test('permission request renders a confirmation card, approval runs the call', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run command', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } }, t));
		const record = t.getToolCall('tc-1')!;
		const signals = t.requestPermission(record, 'Allow this command?');
		assert.strictEqual(signals.length, 1);
		assert.strictEqual(signals[0].kind, 'pending_confirmation');
		if (signals[0].kind === 'pending_confirmation') {
			assert.strictEqual(signals[0].permissionKind, 'shell');
			assert.strictEqual(signals[0].state.toolInput, 'rm -rf build');
		}
		state = apply(state, signals);
		assert.strictEqual(toolCall(state, 'tc-1').status, ToolCallStatus.PendingConfirmation);
		assert.strictEqual(state.summary.status, SessionStatus.InputNeeded);

		t.permissionAnswered(record, true);
		state = sessionReducer(state, { type: ActionType.SessionToolCallConfirmed, turnId: TURN, toolCallId: 'tc-1', approved: true, confirmed: ToolCallConfirmationReason.UserAction });
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: [{ type: 'content', content: text('ok') }] }, t));
		assert.strictEqual(toolCall(state, 'tc-1').status, ToolCallStatus.Completed);
	});

	test('permission on an edit carries a write kind and the first location as the path', () => {
		const t = tracker();
		makeSession();
		t.startToolCall({ toolCallId: 'tc-1', title: 'Write', kind: 'edit', status: 'pending', locations: [{ path: '/repo/a.ts' }], rawInput: { path: '/repo/a.ts' } });
		const [signal] = t.requestPermission(t.getToolCall('tc-1')!, 'Allow edit?');
		assert.strictEqual(signal.kind, 'pending_confirmation');
		if (signal.kind === 'pending_confirmation') {
			assert.strictEqual(signal.permissionKind, 'write');
			assert.strictEqual(signal.permissionPath, '/repo/a.ts');
		}
	});

	test('plan renders as a live card and completes when all entries are done', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Read code', priority: 'high', status: 'in_progress' }, { content: 'Fix bug', priority: 'medium', status: 'pending' }] }, t));
		const card = parts(state).find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(card && card.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(card.toolCall.status, ToolCallStatus.Running);
		assert.ok(card.toolCall.status === ToolCallStatus.Running && card.toolCall.content?.[0].type === ToolResultContentType.Text && card.toolCall.content[0].text.includes('Read code'));

		state = apply(state, mapSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Read code', priority: 'high', status: 'completed' }, { content: 'Fix bug', priority: 'medium', status: 'completed' }] }, t));
		const done = parts(state).find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(done && done.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(done.toolCall.status, ToolCallStatus.Completed);
		// finishPlan after completion is a no-op.
		assert.deepStrictEqual(t.finishPlan(), []);
	});

	test('end_turn completes the turn and settles an open plan card', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Step', priority: 'low', status: 'pending' }] }, t));
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: text('done') }, t));
		const outcome = mapStopReason('end_turn', t);
		assert.strictEqual(outcome.turnState, TurnState.Complete);
		state = apply(state, outcome.signals);
		assert.strictEqual(state.activeTurn, undefined);
		assert.strictEqual(state.turns.length, 1);
		assert.strictEqual(state.turns[0].state, TurnState.Complete);
		const card = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(card && card.kind === ResponsePartKind.ToolCall && card.toolCall.status === ToolCallStatus.Completed);
	});

	test('cancelled stop reason cancels the turn and skips unfinished tool calls', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Slow', kind: 'execute', status: 'in_progress' }, t));
		const outcome = mapStopReason('cancelled', t);
		assert.strictEqual(outcome.turnState, TurnState.Cancelled);
		state = apply(state, outcome.signals);
		assert.strictEqual(state.turns[0].state, TurnState.Cancelled);
		const tc = state.turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(tc && tc.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(tc.toolCall.status, ToolCallStatus.Cancelled);
		// The transcript snapshot mirrors the reducer.
		const turn = t.toTurn(outcome.turnState);
		const snap = turn.responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(snap && snap.kind === ResponsePartKind.ToolCall && snap.toolCall.status === ToolCallStatus.Cancelled && snap.toolCall.reason === ToolCallCancellationReason.Skipped);
	});

	test('refusal and limits surface as a session error', () => {
		for (const reason of ['refusal', 'max_tokens', 'max_turn_requests'] as const) {
			const t = tracker();
			let state = makeSession();
			const outcome = mapStopReason(reason, t);
			assert.strictEqual(outcome.turnState, TurnState.Error);
			assert.strictEqual(outcome.error?.errorType, `acp_stop_${reason}`);
			state = apply(state, outcome.signals);
			assert.strictEqual(state.turns[0].state, TurnState.Error);
		}
	});

	test('session title updates map to SessionTitleChanged; metadata-only updates produce nothing', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({ sessionUpdate: 'session_info_update', title: 'Fix the parser' }, t));
		assert.strictEqual(state.summary.title, 'Fix the parser');
		assert.deepStrictEqual(mapSessionUpdate({ sessionUpdate: 'user_message_chunk', content: text('echo') }, t), []);
		assert.deepStrictEqual(mapSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] }, t), []);
		assert.deepStrictEqual(mapSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'code' }, t), []);
	});

	test('diff content is summarized as text and terminal content is named', () => {
		const t = tracker();
		let state = makeSession();
		state = apply(state, mapSessionUpdate({
			sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Edit', kind: 'edit', status: 'in_progress',
			content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }, { type: 'terminal', terminalId: 'term-1' }],
		}, t));
		const tc = toolCall(state, 'tc-1');
		assert.strictEqual(tc.status, ToolCallStatus.Running);
		const content = tc.status === ToolCallStatus.Running ? tc.content ?? [] : [];
		assert.strictEqual(content.length, 2);
		assert.ok(content[0].type === ToolResultContentType.Text && content[0].text.includes('/repo/a.ts'));
		assert.ok(content[1].type === ToolResultContentType.Text && content[1].text.includes('term-1'));
	});
});

suite('ACP update mapper – helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('permission kinds follow the tool kind', () => {
		assert.strictEqual(permissionKindForToolKind('edit'), 'write');
		assert.strictEqual(permissionKindForToolKind('delete'), 'write');
		assert.strictEqual(permissionKindForToolKind('move'), 'write');
		assert.strictEqual(permissionKindForToolKind('read'), 'read');
		assert.strictEqual(permissionKindForToolKind('search'), 'read');
		assert.strictEqual(permissionKindForToolKind('execute'), 'shell');
		assert.strictEqual(permissionKindForToolKind('fetch'), 'url');
		assert.strictEqual(permissionKindForToolKind('think'), undefined);
		assert.strictEqual(permissionKindForToolKind('other'), undefined);
		assert.strictEqual(permissionKindForToolKind(undefined), undefined);
	});

	test('shell commands are extracted from common raw input shapes', () => {
		assert.strictEqual(commandFromRawInput('ls -la'), 'ls -la');
		assert.strictEqual(commandFromRawInput({ command: 'git status' }), 'git status');
		assert.strictEqual(commandFromRawInput({ cmd: ['npm', 'test'] }), 'npm test');
		assert.strictEqual(commandFromRawInput({ path: '/x' }), undefined);
		assert.strictEqual(commandFromRawInput(undefined), undefined);
	});
});
