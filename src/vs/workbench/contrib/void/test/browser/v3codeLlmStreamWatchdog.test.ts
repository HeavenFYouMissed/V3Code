/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	LLM_COMPACT_LOCAL_STALL_MS,
	LLM_SLOW_FIRST_TOKEN_STALL_MS,
	LLM_STANDARD_LOCAL_STALL_MS,
	LLM_STREAM_STALL_MS,
	llmStreamStallMs,
} from '../../browser/v3codeLlmStreamWatchdog.js';

suite('V3Code LLM stream watchdog', () => {
	test('adapts local silence budgets by model size', () => {
		for (const provider of ['ollama', 'vLLM', 'lmStudio', 'v3code-local']) {
			assert.strictEqual(llmStreamStallMs(provider, 'gemma3:4b'), LLM_COMPACT_LOCAL_STALL_MS, provider);
			assert.strictEqual(llmStreamStallMs(provider, 'qwen3:8b'), LLM_STANDARD_LOCAL_STALL_MS, provider);
			assert.strictEqual(llmStreamStallMs(provider, 'qwen3-coder:30b-a3b'), LLM_SLOW_FIRST_TOKEN_STALL_MS, provider);
		}
	});

	test('gives subscription proxy lanes a cold-start budget', () => {
		for (const provider of ['claudePlan', 'grokPlan', 'geminiPlan', 'copilot', 'cursorLocal', 'openaiPlan']) {
			assert.strictEqual(llmStreamStallMs(provider, 'anything'), LLM_SLOW_FIRST_TOKEN_STALL_MS, provider);
		}
	});

	test('keeps the default budget for direct cloud providers', () => {
		for (const provider of ['anthropic', 'openAI', 'gemini', 'xAI', undefined]) {
			assert.strictEqual(llmStreamStallMs(provider), LLM_STREAM_STALL_MS, provider);
		}
	});
});
