/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SimpleLLMMessage, prepareMessages_openai_tools, prepareMessages_anthropic_tools, prepareGeminiMessages } from '../../common/llmMessageConverters.js';
import { ToolName } from '../../common/toolsServiceTypes.js';
import { LLM_EMPTY_TEXT_PLACEHOLDER } from '../../common/chatMessageContent.js';
import { AnthropicLLMChatMessage } from '../../common/sendLLMMessageTypes.js';

// Helpers ------------------------------------------------------------------
const user = (content: string): SimpleLLMMessage => ({ role: 'user', content });
const assistant = (content: string, reasoning: string | null = null): SimpleLLMMessage => ({ role: 'assistant', content, anthropicReasoning: null, reasoning });
const tool = (id: string, name: string, content: string): SimpleLLMMessage => ({ role: 'tool', id, name: name as ToolName, content, rawParams: {} });

// RC-1 invariant checks ----------------------------------------------------

/** Every OpenAI `role:'tool'` message must reference a tool_call_id declared by some preceding assistant. */
const assertOpenAINoOrphans = (out: any[]) => {
	const declared = new Set<string>();
	for (const m of out) {
		if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
			for (const tc of m.tool_calls) { declared.add(tc.id); }
		}
		if (m.role === 'tool') {
			assert.ok(declared.has(m.tool_call_id), `orphaned tool result ${m.tool_call_id} (no preceding assistant tool_call)`);
		}
	}
};

/** Every Anthropic tool_result block must have a matching tool_use earlier in the transcript. */
const assertAnthropicNoOrphans = (out: any[]) => {
	const declared = new Set<string>();
	for (const m of out) {
		if (m.role === 'assistant' && Array.isArray(m.content)) {
			for (const b of m.content) { if (b.type === 'tool_use') { declared.add(b.id); } }
		}
		if (m.role === 'user' && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.type === 'tool_result') {
					assert.ok(declared.has(b.tool_use_id), `orphaned tool_result ${b.tool_use_id} (no matching tool_use)`);
				}
			}
		}
	}
};

suite('RC-1 LLM message converters', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ===================== OpenAI =====================

	test('openai: text-less tool turn (assistant not persisted) synthesizes a placeholder and pairs the result', () => {
		// In native function-calling, the assistant turn is often pure tool call (empty text) and is
		// NOT persisted to the thread, so the wire arrives as [user, tool] with no assistant between.
		const out = prepareMessages_openai_tools([user('list the files'), tool('call_1', 'ls_dir', 'a.ts\nb.ts')]) as any[];
		assertOpenAINoOrphans(out);
		const a = out.find(m => m.role === 'assistant');
		assert.ok(a, 'a placeholder assistant should be synthesized');
		assert.strictEqual(a.content, LLM_EMPTY_TEXT_PLACEHOLDER);
		assert.strictEqual(a.tool_calls.length, 1);
		assert.strictEqual(a.tool_calls[0].id, 'call_1');
		assert.strictEqual(out[out.length - 1].role, 'tool');
		assert.strictEqual(out[out.length - 1].tool_call_id, 'call_1');
	});

	test('openai: parallel tool calls aggregate onto ONE assistant and keep both results', () => {
		const out = prepareMessages_openai_tools([
			assistant('calling two tools'),
			tool('call_1', 'read_file', 'contents of a'),
			tool('call_2', 'read_file', 'contents of b'),
		]) as any[];
		assertOpenAINoOrphans(out);
		const a = out.find(m => m.role === 'assistant');
		assert.strictEqual(a.tool_calls.length, 2, 'both parallel calls must attach to the same assistant');
		assert.deepStrictEqual(a.tool_calls.map((t: any) => t.id), ['call_1', 'call_2']);
		const toolMsgs = out.filter(m => m.role === 'tool');
		assert.strictEqual(toolMsgs.length, 2);
		assert.deepStrictEqual(toolMsgs.map((t: any) => t.tool_call_id), ['call_1', 'call_2']);
	});

	test('openai: leading orphan tool (post-abort) does not crash and is paired via synthesis', () => {
		const out = prepareMessages_openai_tools([tool('call_x', 'read_file', 'partial')]) as any[];
		assertOpenAINoOrphans(out);
		assert.strictEqual(out[0].role, 'assistant');
		assert.strictEqual(out[1].role, 'tool');
	});

	test('openai: a user turn between tool runs resets ownership (no cross-pairing)', () => {
		const out = prepareMessages_openai_tools([
			assistant('first'),
			tool('call_1', 'read_file', 'r1'),
			user('now do something else'),
			tool('call_2', 'read_file', 'r2'), // orphan after the user turn -> own synthesized assistant
		]) as any[];
		assertOpenAINoOrphans(out);
		const assistants = out.filter(m => m.role === 'assistant');
		// call_1 on the real assistant; call_2 on a fresh synthesized assistant after the user turn
		const owner1 = assistants.find(a => a.tool_calls?.some((t: any) => t.id === 'call_1'));
		const owner2 = assistants.find(a => a.tool_calls?.some((t: any) => t.id === 'call_2'));
		assert.ok(owner1 && owner2 && owner1 !== owner2, 'call_2 must NOT attach to the pre-user assistant');
	});

	// ===================== Anthropic =====================

	test('anthropic: text-less tool turn synthesizes assistant; no orphaned tool_result (the 400 bug)', () => {
		const out = prepareMessages_anthropic_tools([user('list the files'), tool('call_1', 'ls_dir', 'a.ts')], false) as any[];
		assertAnthropicNoOrphans(out);
		const a = out.find(m => m.role === 'assistant');
		assert.ok(Array.isArray(a.content) && a.content.some((b: any) => b.type === 'tool_use' && b.id === 'call_1'));
	});

	test('anthropic: parallel tool calls -> one assistant with N tool_use, one user with N tool_result', () => {
		const out = prepareMessages_anthropic_tools([
			assistant('doing two things'),
			tool('call_1', 'read_file', 'r1'),
			tool('call_2', 'read_file', 'r2'),
		], false) as any[];
		assertAnthropicNoOrphans(out);
		const a = out.find(m => m.role === 'assistant');
		const toolUses = a.content.filter((b: any) => b.type === 'tool_use');
		assert.strictEqual(toolUses.length, 2);
		const userResultMsgs = out.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'));
		assert.strictEqual(userResultMsgs.length, 1, 'parallel tool_results must collapse into a single user message');
		assert.strictEqual(userResultMsgs[0].content.length, 2);
	});

	test('anthropic: input is not mutated in place (fresh array returned)', () => {
		const input: SimpleLLMMessage[] = [assistant('x'), tool('call_1', 'read_file', 'r1')];
		const snapshot = JSON.stringify(input);
		prepareMessages_anthropic_tools(input, false);
		assert.strictEqual(JSON.stringify(input), snapshot, 'converter must not mutate its input');
	});

	test('anthropic: tool result can carry screenshot image blocks for vision models', () => {
		const out = prepareMessages_anthropic_tools([
			assistant('capture the page'),
			{
				role: 'tool',
				id: 'call_shot',
				name: 'screenshot_page' as ToolName,
				content: 'screenshot_page captured a screenshot.',
				rawParams: { page_id: 'p1' },
				images: [{ mimeType: 'image/jpeg', data: 'ZmFrZWpwZWc=' }],
			},
		], false) as any[];
		assertAnthropicNoOrphans(out);
		const userResult = out.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'));
		assert.ok(userResult, 'tool_result user message expected');
		const block = userResult.content.find((b: any) => b.type === 'tool_result');
		assert.ok(Array.isArray(block.content), 'tool_result content should be multimodal blocks');
		assert.ok(block.content.some((b: any) => b.type === 'image' && b.source?.media_type === 'image/jpeg'), 'jpeg image block expected');
	});

	// ===================== Gemini =====================

	test('gemini: parallel results get their OWN tool name by id (not the last-seen name)', () => {
		// Build the anthropic shape first (gemini consumes it), then convert.
		const anthropic = prepareMessages_anthropic_tools([
			assistant('two different tools'),
			tool('call_1', 'read_file', 'r1'),
			tool('call_2', 'ls_dir', 'r2'),
		], false) as AnthropicLLMChatMessage[];
		const out = prepareGeminiMessages(anthropic) as any[];
		const responses: any[] = [];
		for (const m of out) {
			if (m.role === 'user') { for (const p of m.parts) { if (p.functionResponse) { responses.push(p.functionResponse); } } }
		}
		const byId = new Map(responses.map(r => [r.id, r.name]));
		assert.strictEqual(byId.get('call_1'), 'read_file');
		assert.strictEqual(byId.get('call_2'), 'ls_dir', 'second result must keep its own tool name, not call_1/last name');
	});
});
