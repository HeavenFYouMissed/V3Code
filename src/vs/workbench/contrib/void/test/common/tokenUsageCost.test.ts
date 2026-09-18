/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { calcTurnCostUsd, COST_SAFETY_MARGIN, ModelCostRates } from '../../common/tokenUsageService.js';
import { anthropicUsageToLLMUsage, openAICompatUsageToLLMUsage } from '../../common/helpers/llmUsage.js';
import { getModelCapabilities, OPUS_HYBRID_MODEL_NAME } from '../../common/modelCapabilities.js';

const assertApprox = (actual: number, expected: number, msg?: string) => {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? 'value'}: expected ~${expected}, got ${actual}`);
};

// Sonnet-4.6 rates: the canonical cache-priced row.
const SONNET: ModelCostRates = { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 };

suite('void tokenUsage cost math', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('flat rate when no cache info is reported', () => {
		const cost = calcTurnCostUsd(SONNET, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
		assertApprox(cost, (3 + 15) * COST_SAFETY_MARGIN, 'flat 1M in + 1M out');
	});

	test('cache-aware split: miss at input rate, hit at cache_read, write at 5m cache_write', () => {
		// 1M prompt = 200k fresh + 600k cache hit + 200k cache write (5m)
		const cost = calcTurnCostUsd(SONNET, {
			promptTokens: 1_000_000, completionTokens: 0,
			cacheHitTokens: 600_000, cacheWriteTokens: 200_000,
		});
		const raw = (200_000 * 3 + 600_000 * 0.30 + 200_000 * 3.75) / 1_000_000;
		assertApprox(cost, raw * COST_SAFETY_MARGIN, 'cache-aware turn');
	});

	test('1h-TTL cache writes bill at 2x input, not the 5m rate', () => {
		// Same turn, but ALL writes carry the 1h TTL: 2 * $3 = $6/Mtok, not $3.75/Mtok.
		const cost = calcTurnCostUsd(SONNET, {
			promptTokens: 1_000_000, completionTokens: 0,
			cacheHitTokens: 600_000, cacheWriteTokens: 200_000, cacheWrite1hTokens: 200_000,
		});
		const raw = (200_000 * 3 + 600_000 * 0.30 + 200_000 * 6.00) / 1_000_000;
		assertApprox(cost, raw * COST_SAFETY_MARGIN, '1h write turn');
	});

	test('mixed 5m/1h write split prices each TTL at its own rate', () => {
		const cost = calcTurnCostUsd(SONNET, {
			promptTokens: 300_000, completionTokens: 0,
			cacheWriteTokens: 300_000, cacheWrite1hTokens: 100_000, // 200k @5m + 100k @1h, 0 fresh
		});
		const raw = (200_000 * 3.75 + 100_000 * 6.00) / 1_000_000;
		assertApprox(cost, raw * COST_SAFETY_MARGIN, 'mixed TTL turn');
	});

	test('cacheWrite1hTokens clamps to the write total (defensive against bad provider data)', () => {
		const cost = calcTurnCostUsd(SONNET, {
			promptTokens: 100_000, completionTokens: 0,
			cacheWriteTokens: 100_000, cacheWrite1hTokens: 999_999,
		});
		const raw = (100_000 * 6.00) / 1_000_000; // all 100k at the 1h rate, none double-counted
		assertApprox(cost, raw * COST_SAFETY_MARGIN, 'clamped 1h writes');
	});

	test('unpriced rates cost $0 (callers must surface the unpriced flag, not the number)', () => {
		assert.strictEqual(calcTurnCostUsd({ input: 0, output: 0, unpriced: true }, { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 0);
		assert.strictEqual(calcTurnCostUsd(undefined, { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 0);
	});
});

suite('void anthropic usage fold-in invariant', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prompt_tokens = fresh(miss) + cache_read + cache_write', () => {
		// The real-world shape of a cache-hot turn: input_tokens collapses to a handful.
		const usage = anthropicUsageToLLMUsage({
			input_tokens: 12,
			output_tokens: 450,
			cache_read_input_tokens: 300_000,
			cache_creation_input_tokens: 26_000,
			cache_creation: { ephemeral_5m_input_tokens: 6_000, ephemeral_1h_input_tokens: 20_000 },
		});
		assert.strictEqual(usage.prompt_tokens, 12 + 300_000 + 26_000);
		assert.strictEqual(usage.completion_tokens, 450);
		assert.strictEqual(usage.prompt_cache_hit_tokens, 300_000);
		assert.strictEqual(usage.prompt_cache_write_tokens, 26_000);
		assert.strictEqual(usage.prompt_cache_write_1h_tokens, 20_000);
		// the invariant the cost math relies on: subtracting the subsets recovers the fresh input
		assert.strictEqual(
			usage.prompt_tokens! - usage.prompt_cache_hit_tokens! - usage.prompt_cache_write_tokens!,
			12,
		);
	});

	test('legacy cache_creation_input_tokens without the TTL split still folds in', () => {
		const usage = anthropicUsageToLLMUsage({
			input_tokens: 100, output_tokens: 10,
			cache_read_input_tokens: 5_000, cache_creation_input_tokens: 2_000,
		});
		assert.strictEqual(usage.prompt_tokens, 7_100);
		assert.strictEqual(usage.prompt_cache_write_tokens, 2_000);
		assert.strictEqual(usage.prompt_cache_write_1h_tokens, undefined);
	});

	test('TTL split alone (no legacy total) sums to the write total', () => {
		const usage = anthropicUsageToLLMUsage({
			input_tokens: 100, output_tokens: 10,
			cache_creation: { ephemeral_5m_input_tokens: 1_500, ephemeral_1h_input_tokens: 500 },
		});
		assert.strictEqual(usage.prompt_cache_write_tokens, 2_000);
		assert.strictEqual(usage.prompt_cache_write_1h_tokens, 500);
		assert.strictEqual(usage.prompt_tokens, 2_100);
	});

	test('no cache fields at all collapses to plain input/output', () => {
		const usage = anthropicUsageToLLMUsage({ input_tokens: 1_000, output_tokens: 200 });
		assert.strictEqual(usage.prompt_tokens, 1_000);
		assert.strictEqual(usage.completion_tokens, 200);
		assert.strictEqual(usage.prompt_cache_hit_tokens, 0);
		assert.strictEqual(usage.prompt_cache_write_tokens, 0);
	});
});

suite('void openai-compatible usage normalization', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads prompt_tokens_details.cached_tokens (OpenAI / xAI / OpenRouter)', () => {
		const usage = openAICompatUsageToLLMUsage({
			prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500,
			prompt_tokens_details: { cached_tokens: 8_000 },
		});
		assert.strictEqual(usage.prompt_tokens, 10_000);
		assert.strictEqual(usage.prompt_cache_hit_tokens, 8_000);
	});

	test('falls back to DeepSeek prompt_cache_hit_tokens', () => {
		const usage = openAICompatUsageToLLMUsage({
			prompt_tokens: 10_000, completion_tokens: 500,
			prompt_cache_hit_tokens: 7_000,
		});
		assert.strictEqual(usage.prompt_cache_hit_tokens, 7_000);
	});

	test('prefers the standard field when both spellings are present', () => {
		const usage = openAICompatUsageToLLMUsage({
			prompt_tokens: 10_000,
			prompt_tokens_details: { cached_tokens: 8_000 },
			prompt_cache_hit_tokens: 1,
		});
		assert.strictEqual(usage.prompt_cache_hit_tokens, 8_000);
	});

	test('passes OpenRouter anthropic cache writes through', () => {
		const usage = openAICompatUsageToLLMUsage({
			prompt_tokens: 10_000, cache_creation_input_tokens: 2_500,
		});
		assert.strictEqual(usage.prompt_cache_write_tokens, 2_500);
	});

	test('null fields normalize to undefined, not 0', () => {
		const usage = openAICompatUsageToLLMUsage({ prompt_tokens: 100, prompt_tokens_details: null, prompt_cache_hit_tokens: null });
		assert.strictEqual(usage.prompt_cache_hit_tokens, undefined);
	});
});

suite('void model price table regressions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Sonnet-4-family output is $15/Mtok, not $6 (matches claude-sonnet-4-6)', () => {
		const sonnet4 = getModelCapabilities('anthropic', 'claude-sonnet-4-20250514', undefined);
		assert.strictEqual(sonnet4.cost.output, 15.00);
		assert.strictEqual(sonnet4.cost.input, 3.00);
		const sonnet46 = getModelCapabilities('anthropic', 'claude-sonnet-4-6', undefined);
		assert.strictEqual(sonnet46.cost.output, 15.00);
	});

	test('Opus Hybrid display price matches its hard executor (Sonnet 4.6 rates)', () => {
		const hybrid = getModelCapabilities('anthropic', OPUS_HYBRID_MODEL_NAME, undefined);
		assert.strictEqual(hybrid.cost.output, 15.00);
		assert.strictEqual(hybrid.cost.input, 3.00);
	});

	test('fallback-matched models are flagged unpriced, not silently $0', () => {
		// vLLM/ollama/lmStudio/openRouter route unknown names through extensiveModelOptionsFallback
		const caps = getModelCapabilities('vLLM', 'llama3.3-70b-instruct', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, false);
		assert.strictEqual(caps.cost.unpriced, true);
	});

	test('fully unrecognized models are flagged unpriced', () => {
		const caps = getModelCapabilities('vLLM', 'totally-unknown-model-xyz', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, true);
		assert.strictEqual(caps.cost.unpriced, true);
	});

	test('genuinely free local models are NOT flagged unpriced ($0 is their real price)', () => {
		const caps = getModelCapabilities('v3code-local', 'qwen2.5-coder-1.5b', undefined);
		assert.strictEqual(caps.cost.input, 0);
		assert.strictEqual(caps.cost.unpriced, undefined);
	});
});
