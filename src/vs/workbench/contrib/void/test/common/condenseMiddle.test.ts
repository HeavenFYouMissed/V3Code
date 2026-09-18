/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { condenseMiddle, elideOldToolResults, stripEphemeralUserTail } from '../../common/memory/condenseMiddle.js';

type Msg = {
	role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
	id?: string; name?: string; rawParams?: Record<string, unknown>;
	reasoning?: string | null; anthropicReasoning?: Array<{ type: string; thinking?: string; signature?: string }> | null;
	images?: Array<{ data: string; mimeType: string }>;
};

function msg(role: Msg['role'], content: string): Msg {
	return { role, content };
}

/** The incident's wire shape: system + first user (throwaway command) + 7 prior turns +
 *  a live user request + a 20-message tool loop that pushes the live request into the middle. */
function incidentWire(): Msg[] {
	const messages: Msg[] = [
		msg('system', 'system prompt'),
		msg('user', 'Open this exact folder in V3Code using File\n\n/some/path'),
	];
	for (let i = 0; i < 7; i++) {
		messages.push(msg('user', `earlier user turn ${i} with enough content to matter`));
		messages.push(msg('assistant', `assistant reply ${i} with enough content to matter`));
	}
	messages.push(msg('user', 'this exactly the font i want — its in the harness we are in, not the terminal'));
	for (let i = 0; i < 20; i++) {
		messages.push(msg(i % 2 === 0 ? 'assistant' : 'tool', `tool loop message ${i} padding padding padding`));
	}
	return messages;
}

const DURABLE_BLOCK = '\n\n<durable_task>\nPrimary goal (the user\'s words, task dt_abc rev 3, status active): "Execute the Bot/Agent capability swap per the handoff"\n</durable_task>';

suite('condenseMiddle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('durable-before-drop: nothing leaves the wire until the listener reports it durable', () => {
		const wire = incidentWire();
		const outcome = condenseMiddle(wire, { durableTaskBlock: DURABLE_BLOCK, onCondense: () => 0 });
		assert.strictEqual(outcome.acceptedDroppedCount, 0);
		assert.strictEqual(outcome.messages, wire, 'same array, untouched');
		assert.ok(outcome.digestText.length > 0, 'digest was still built (for persistence)');
	});

	test('T7 + scenario 1: condense mid tool-loop drops the middle but the DURABLE TASK — not the stale first command — is pinned', () => {
		const wire = incidentWire();
		const outcome = condenseMiddle(wire, {
			durableTaskBlock: DURABLE_BLOCK,
			onCondense: (_digest, dropped) => dropped, // fully durable
		});
		assert.ok(outcome.acceptedDroppedCount > 0);
		assert.strictEqual(outcome.messages[0].content, 'system prompt');
		// The safe tail expands back to the live user turn instead of cutting its tool loop.
		assert.strictEqual(outcome.messages[1].role, 'user');
		assert.strictEqual(outcome.messages[0].content, 'system prompt');
		assert.ok(outcome.messages[1].content.includes('<durable_task>'));
		assert.ok(outcome.messages[1].content.includes('capability swap'));
		assert.ok(!outcome.messages.some(m => m.content === 'Open this exact folder in V3Code using File\n\n/some/path'),
			'the bare first-user pin no longer survives');
		// Tail intact:
		assert.strictEqual(outcome.messages.length, 22, 'system + complete live user/tool turn');
	});

	test('the digest RIDES the wire notice (no mid-turn digest gap, no false "latest turn" promise)', () => {
		const outcome = condenseMiddle(incidentWire(), {
			durableTaskBlock: DURABLE_BLOCK,
			onCondense: (_d, dropped) => dropped,
		});
		const carrier = outcome.messages[1].content;
		assert.ok(carrier.includes('[Conversation condensed:'), 'notice present');
		assert.ok(carrier.includes('<session_digest>'), 'digest embedded in the same message');
		assert.ok(!carrier.includes('on the latest turn'), 'the false promise is gone');
	});

	test('a live user message at the safe tail boundary survives verbatim', () => {
		const outcome = condenseMiddle(incidentWire(), {
			durableTaskBlock: DURABLE_BLOCK,
			onCondense: (_d, dropped) => dropped,
		});
		assert.ok(outcome.messages.some(message => message.content.includes('this exactly the font i want')),
			'the live request stays in the complete preserved user/tool turn');
	});

	test('without a durable task the legacy first-user pin remains (fallback)', () => {
		const outcome = condenseMiddle(incidentWire(), { onCondense: (_d, dropped) => dropped });
		assert.strictEqual(outcome.messages[1].content, 'Open this exact folder in V3Code using File\n\n/some/path');
	});

	test('partial durability drops only the durable prefix and keeps the grown tail verbatim', () => {
		const wire = incidentWire();
		const outcome = condenseMiddle(wire, {
			durableTaskBlock: DURABLE_BLOCK,
			onCondense: (_d, dropped) => dropped - 3, // only a prefix is durable
		});
		assert.ok(outcome.acceptedDroppedCount <= outcome.requestedDroppedCount - 3, 'rounded back, never forward');
		assert.strictEqual(outcome.messages[1].role, 'user', 'partial checkpoint still starts on a user boundary');
		assert.ok(!outcome.digestText.includes('tool loop message 0'), 'digest covers only the actually removed prefix');
	});

	test('only a durable-task-linked Status Block wins the digest over the fact sheet', () => {
		const wire = incidentWire();
		wire.splice(6, 0, msg('assistant', '## Status\n**Task:** dt_abc capability swap — Phase 1 in progress\n' + 'x'.repeat(40)));
		const outcome = condenseMiddle(wire, { durableTaskBlock: DURABLE_BLOCK, onCondense: (_d, dropped) => dropped });
		assert.ok(outcome.digestText.includes('Last known state:'), outcome.digestText);
		assert.ok(outcome.digestText.includes('**Task:** dt_abc capability swap'));
	});

	test('unlinked side-task Status Block cannot take over the durable digest', () => {
		const wire = incidentWire();
		wire.splice(6, 0, msg('assistant', '## Status\n**Task:** wordmark polish\n' + 'x'.repeat(40)));
		const outcome = condenseMiddle(wire, { durableTaskBlock: DURABLE_BLOCK, onCondense: (_d, dropped) => dropped });
		assert.ok(!outcome.digestText.includes('Last known state:'));
	});

	test('short wire is a no-op', () => {
		const wire = [msg('system', 's'), msg('user', 'hello'), msg('assistant', 'hi'), msg('user', 'next')];
		const outcome = condenseMiddle(wire, { durableTaskBlock: DURABLE_BLOCK });
		assert.strictEqual(outcome.acceptedDroppedCount, 0);
		assert.strictEqual(outcome.messages.length, 4);
	});

	test('stripEphemeralUserTail cuts the injected tail incl. <durable_task>', () => {
		assert.strictEqual(
			stripEphemeralUserTail('the real ask\n\n<CURRENT_ENVIRONMENT>\nstuff'),
			'the real ask',
		);
		assert.strictEqual(
			stripEphemeralUserTail('the real ask\n\n<durable_task>\nPrimary goal...'),
			'the real ask',
		);
	});

	test('Anthropic reasoning plus parallel tool_use/tool_result messages stay in one accepted tail', () => {
		const wire: Msg[] = [msg('system', 's')];
		for (let i = 0; i < 12; i++) wire.push(msg('user', `old user ${i}`), msg('assistant', `old answer ${i}`));
		wire.push(
			msg('user', 'inspect both files'),
			{ role: 'assistant', content: '', anthropicReasoning: [{ type: 'thinking', thinking: 'inspect', signature: 'sig' }] },
			{ role: 'tool', content: 'A', id: 'tool-a', name: 'read_file', rawParams: { uri: 'a.ts' } },
			{ role: 'tool', content: 'B', id: 'tool-b', name: 'read_file', rawParams: { uri: 'b.ts' } },
			msg('assistant', 'Both files inspected'),
			msg('user', 'continue with the fix'),
			msg('assistant', 'working'),
		);
		const outcome = condenseMiddle(wire, { preserveEnd: 4, durableTaskBlock: DURABLE_BLOCK, onCondense: (_d, count) => count });
		assert.strictEqual(outcome.messages[1].role, 'user');
		assert.strictEqual(outcome.messages[1].content.includes('inspect both files'), true);
		assert.deepStrictEqual(outcome.messages.filter(m => m.role === 'tool').map(m => m.id), ['tool-a', 'tool-b']);
		assert.ok(outcome.messages.some(m => m.role === 'assistant' && m.anthropicReasoning?.[0]?.signature === 'sig'));
	});

	test('OpenAI Responses function call/output pairs and continuation remain valid', () => {
		const wire: Msg[] = [msg('system', 's')];
		for (let i = 0; i < 10; i++) wire.push(msg('user', `old ${i}`), msg('assistant', `answer ${i}`));
		wire.push(
			msg('user', 'run both checks'),
			msg('assistant', ''),
			{ role: 'tool', content: 'one', id: 'call_1', name: 'run_tests', rawParams: {} },
			{ role: 'tool', content: 'two', id: 'call_2', name: 'get_build_errors', rawParams: {} },
			msg('assistant', 'Checks passed'),
			msg('user', '<current_turn>now make the edit</current_turn>'),
			msg('assistant', 'editing'),
		);
		const outcome = condenseMiddle(wire, { preserveEnd: 5, durableTaskBlock: DURABLE_BLOCK, onCondense: (_d, count) => count });
		assert.strictEqual(outcome.messages[1].role, 'user');
		const callIds = outcome.messages.filter(m => m.role === 'tool').map(m => m.id);
		assert.deepStrictEqual(callIds, ['call_1', 'call_2']);
		assert.strictEqual((outcome.messages.map(m => m.content).join('\n').match(/<durable_task>/g) ?? []).length, 1);
	});

	test('Plan-mode image turn is preserved with its image and complete tool sequence', () => {
		const wire: Msg[] = [msg('system', 'plan system')];
		for (let i = 0; i < 12; i++) wire.push(msg('user', `old plan ${i}`), msg('assistant', `old result ${i}`));
		wire.push(
			{ role: 'user', content: '<plan_mode>inspect screenshot</plan_mode>', images: [{ data: 'base64pixels', mimeType: 'image/png' }] },
			msg('assistant', 'I will inspect it'),
			{ role: 'tool', content: 'screen structure', id: 'screen-1', name: 'read_page', rawParams: {} },
			msg('assistant', 'Plan ready'),
		);
		const outcome = condenseMiddle(wire, { preserveEnd: 2, durableTaskBlock: DURABLE_BLOCK, onCondense: (_d, count) => count });
		assert.strictEqual(outcome.messages[1].role, 'user');
		assert.strictEqual(outcome.messages[1].images?.[0].data, 'base64pixels');
		assert.ok(outcome.messages.some(m => m.id === 'screen-1'));
	});
});

suite('elideOldToolResults', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('T8: the 6 newest tool results stay verbatim; older big ones are elided', () => {
		const messages: Msg[] = [msg('system', 's')];
		for (let i = 0; i < 8; i++) messages.push(msg('tool', 'x'.repeat(1_000) + `-${i}`));
		const { messages: out, elidedCount } = elideOldToolResults(messages);
		assert.strictEqual(elidedCount, 2, 'exactly the two oldest over-size results elided');
		assert.ok(out[1].content.includes('[tool output elided'), 'oldest elided');
		assert.ok(out[2].content.includes('[tool output elided'), 'second oldest elided');
		for (let i = 3; i <= 8; i++) {
			assert.ok(out[i].content.endsWith(`-${i - 1}`), `newest 6 untouched (idx ${i})`);
		}
	});

	test('small results are never elided, and message count is preserved', () => {
		const messages: Msg[] = [msg('system', 's')];
		for (let i = 0; i < 10; i++) messages.push(msg('tool', `tiny ${i}`));
		const { messages: out, elidedCount } = elideOldToolResults(messages);
		assert.strictEqual(elidedCount, 0);
		assert.strictEqual(out.length, messages.length);
	});
});
