/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import {
	COMPACT_LLM_SYSTEM,
	buildCompactSystemPrompt,
	extractCompactSummary,
	serializeThreadForCompaction,
	findCompactionTailStart,
	buildCompactedMessages,
} from '../../common/memory/compaction.js';
import { buildCompactionBoundaryChannelParams } from '../../common/memory/compactionBoundaryContract.js';

const user = (content: string): ChatMessage => ({
	role: 'user', content, displayContent: content, selections: null,
	state: { stagingSelections: [], isBeingEdited: false },
});
const assistant = (content: string): ChatMessage => ({
	role: 'assistant', displayContent: content, reasoning: '', anthropicReasoning: null,
});

// u0 a1 u2 a3 u4 a5 u6 a7
const convo = (): ChatMessage[] => [
	user('u0'), assistant('a1'), user('u2'), assistant('a3'),
	user('u4'), assistant('a5'), user('u6'), assistant('a7'),
];

suite('memory compaction (/compact)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('tail start snaps back to the nearest user boundary; nothing to drop when tail covers all', () => {
		assert.deepStrictEqual(
			[
				findCompactionTailStart(convo(), 3),  // start=5 (a5) → snap back to u4 = 4
				findCompactionTailStart(convo(), 10), // start=0 → 0 (drop nothing)
				findCompactionTailStart([], 6),        // empty → 0
			],
			[4, 0, 0],
		);
	});

	test('build compacted messages: head replaced by one marker, tail kept verbatim', () => {
		assert.deepStrictEqual(
			buildCompactedMessages(convo(), '  THE SUMMARY  ', { timestamp: 123, targetTail: 3 }),
			{
				droppedCount: 4,
				messages: [
					{ role: 'compaction', content: 'THE SUMMARY', droppedCount: 4, timestamp: 123 },
					user('u4'), assistant('a5'), user('u6'), assistant('a7'),
				],
			},
		);
	});

	test('build compacted messages: no-op on a short thread or empty summary', () => {
		assert.deepStrictEqual(
			[
				buildCompactedMessages(convo(), '', { timestamp: 1, targetTail: 3 }).droppedCount,
				buildCompactedMessages([user('only')], 'S', { timestamp: 1, targetTail: 3 }).droppedCount,
			],
			[0, 0],
		);
	});

	test('extract summary: prefers the <summary> block, drops the <analysis> scratchpad, falls back to raw', () => {
		assert.deepStrictEqual(
			[
				extractCompactSummary('<analysis>walk</analysis>\n<summary>KEEP ME</summary>'),
				extractCompactSummary('no fences here'),
				extractCompactSummary('<summary>truncated output with no close'),
			],
			['KEEP ME', 'no fences here', 'truncated output with no close'],
		);
	});

	test('system prompt: bare returns the base; focus is appended as extra instructions', () => {
		assert.strictEqual(buildCompactSystemPrompt(), COMPACT_LLM_SYSTEM);
		assert.strictEqual(buildCompactSystemPrompt('   ').trim(), COMPACT_LLM_SYSTEM);
		assert.ok(buildCompactSystemPrompt('keep the failing tests').includes('keep the failing tests'));
	});

	test('serialize thread: labelled lines the summary model reads', () => {
		assert.strictEqual(
			serializeThreadForCompaction([user('hi'), assistant('there')]),
			'[user] hi\n\n[assistant] there',
		);
	});

	test('serialize thread: oversized histories are totally bounded while beginning and newest exchange survive', () => {
		const messages = Array.from({ length: 400 }, (_, index) => index % 2 === 0
			? user(`user-${index} ${'x'.repeat(1_800)}`)
			: assistant(`assistant-${index} ${'y'.repeat(1_800)}`));
		const payload = serializeThreadForCompaction(messages, { maxChars: 12_000 });
		assert.ok(payload.length <= 12_000, `payload was ${payload.length} chars`);
		assert.ok(payload.includes('user-0'), 'conversation beginning survives');
		assert.ok(payload.includes('assistant-399'), 'newest exchange survives');
		assert.ok(payload.includes('SAMPLED MIDDLE'), 'oversize behavior is explicit to the summarizer');
	});

	test('atomic boundary IPC contract carries the resolved workspace on the transaction and event', () => {
		const params = buildCompactionBoundaryChannelParams(
			{ dbPath: '/tmp/disposable-memory.db', workspaceId: 'workspace-A' },
			{ sessionId: 'chat-1', kind: 'note', title: 'Compaction', body: 'summary' },
			{ trigger: 'explicit-compact', summary: 'summary' },
		);
		assert.strictEqual(params.workspaceId, 'workspace-A');
		assert.strictEqual(params.noteInput.workspaceId, 'workspace-A');
		assert.strictEqual(params.checkpointInput.sessionId, 'chat-1');
	});

	test('atomic boundary IPC contract rejects an empty workspace before IPC', () => {
		assert.throws(() => buildCompactionBoundaryChannelParams(
			{ dbPath: '/tmp/disposable-memory.db', workspaceId: '' },
			{ sessionId: 'chat-1', kind: 'note', title: 'Compaction', body: 'summary' },
			{ trigger: 'explicit-compact', summary: 'summary' },
		), /requires a workspaceId/);
	});
});
