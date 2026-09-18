/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { InternalToolInfo } from '../../common/prompt/prompts.js';
import { extractLocalTextToolCalls, localTextToolFallbackPrompt } from '../../electron-main/llmMessage/localToolCallFallback.js';

suite('local text tool fallback', () => {
	const tools: InternalToolInfo[] = [
		{ name: 'read_file', description: 'Read a file.', params: { uri: { description: 'Path.' } } },
		{ name: 'find_text', description: 'Find text.', params: { query: { description: 'Query.' } } },
	];

	test('parses Continue-style fenced calls and removes the payload from visible text', () => {
		const result = extractLocalTextToolCalls('Checking.\n```tool\nTOOL_NAME: read_file\nBEGIN_ARG: uri\n/tmp/a.ts\nEND_ARG\n```', tools);
		assert.deepStrictEqual(result, {
			text: 'Checking.',
			toolCalls: [{ name: 'read_file', rawParams: { uri: '/tmp/a.ts' } }],
		});
	});

	test('parses strict OpenAI-shaped JSON but rejects unselected tools', () => {
		assert.deepStrictEqual(
			extractLocalTextToolCalls('{"name":"find_text","arguments":{"query":"needle"}}', tools)?.toolCalls,
			[{ name: 'find_text', rawParams: { query: 'needle' } }],
		);
		assert.strictEqual(
			extractLocalTextToolCalls('{"name":"run_command","arguments":{"command":"pwd"}}', tools),
			undefined,
		);
	});

	test('does not reinterpret ordinary prose containing JSON', () => {
		assert.strictEqual(
			extractLocalTextToolCalls('Here is an example: {"name":"read_file","arguments":{"uri":"/tmp/a"}}', tools),
			undefined,
		);
	});

	test('fallback prompt contains only the filtered tools', () => {
		const prompt = localTextToolFallbackPrompt(tools);
		assert.match(prompt, /read_file\(uri\)/);
		assert.match(prompt, /find_text\(query\)/);
		assert.doesNotMatch(prompt, /run_command/);
	});
});
