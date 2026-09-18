/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	LOCAL_AGENT_TRANSCRIPT_METADATA_KEY,
	LocalAgentTranscriptRecorder,
	reconstructLocalAgentTranscript,
} from '../../common/localAgentHistory.js';

suite('V3Code local agent history', () => {
	test('reconstructs assistant tool calls, results, and ask_user answers from result metadata', () => {
		const recorder = new LocalAgentTranscriptRecorder();
		recorder.recordAssistant({
			content: 'I am checking the project first.',
			reasoning: null,
			toolCalls: [{ id: 'read-1', name: 'read_file', rawParams: { uri: '/workspace/package.json' } }],
		});
		recorder.recordToolResult({ id: 'read-1', name: 'read_file', content: '{"scripts":{"test":"mocha"}}' });
		recorder.recordAssistant({
			content: '',
			reasoning: null,
			toolCalls: [{ id: 'ask-1', name: 'ask_user', rawParams: { question: 'Pick one?', options: ['A', 'B'] } }],
		});
		recorder.recordToolResult({ id: 'ask-1', name: 'ask_user', content: 'The user chose: B' });
		recorder.recordAssistant({ content: 'I will use B and continue.', reasoning: null, toolCalls: [] });

		const value = recorder.metadataValue();
		assert.ok(value);
		const reconstructed = reconstructLocalAgentTranscript({ [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: value });
		assert.deepStrictEqual(reconstructed, [
			{ role: 'assistant', content: 'I am checking the project first.', reasoning: null },
			{ role: 'tool', id: 'read-1', name: 'read_file', content: '{"scripts":{"test":"mocha"}}', rawParams: { uri: '/workspace/package.json' } },
			{ role: 'assistant', content: '', reasoning: null },
			{ role: 'tool', id: 'ask-1', name: 'ask_user', content: 'The user chose: B', rawParams: { question: 'Pick one?', options: ['A', 'B'] } },
			{ role: 'assistant', content: 'I will use B and continue.', reasoning: null },
		]);
	});

	test('keeps metadata bounded by whole recent exchanges', () => {
		const recorder = new LocalAgentTranscriptRecorder();
		for (let i = 0; i < 20; i++) {
			recorder.recordAssistant({
				content: `step ${i}`,
				reasoning: null,
				toolCalls: [{ id: `call-${i}`, name: 'read_file', rawParams: { uri: `/workspace/${i}.ts` } }],
			});
			recorder.recordToolResult({ id: `call-${i}`, name: 'read_file', content: 'x'.repeat(8_000) });
		}
		const value = recorder.metadataValue();
		assert.ok(value);
		assert.ok(value.exchanges.length <= 12);
		assert.ok(JSON.stringify(value).length <= 48_000);
		assert.strictEqual(value.exchanges.at(-1)?.assistant.content, 'step 19');
		const messages = reconstructLocalAgentTranscript({ [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: value });
		assert.strictEqual(messages?.at(-1)?.role, 'tool');
	});

	test('never persists or replays completed hidden reasoning', () => {
		const recorder = new LocalAgentTranscriptRecorder();
		recorder.recordAssistant({ content: 'Verified result.', reasoning: 'discarded dead-end chain', toolCalls: [] });
		const value = recorder.metadataValue();
		assert.strictEqual(value?.exchanges[0].assistant.reasoning, null);
		assert.deepStrictEqual(reconstructLocalAgentTranscript({ [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: value }), [
			{ role: 'assistant', content: 'Verified result.', reasoning: null },
		]);

		const legacy = {
			version: 1,
			exchanges: [{ assistant: { content: 'Old answer.', reasoning: 'legacy hidden thought', toolCalls: [] }, tools: [] }],
		};
		assert.deepStrictEqual(reconstructLocalAgentTranscript({ [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: legacy }), [
			{ role: 'assistant', content: 'Old answer.', reasoning: null },
		]);
	});
});
