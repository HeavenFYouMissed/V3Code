/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure normalizers from provider wire usage shapes to our LLMUsage. Kept in common/ (no SDK
 * imports) so the fold-in invariants are unit-testable:
 *
 *   prompt_tokens = fresh(miss) + cache_read + cache_write   (matches OpenAI semantics)
 *
 * Anthropic reports input_tokens as the NON-cached portion only; OpenAI-compatible providers
 * report prompt_tokens as the TOTAL with the cached subset in prompt_tokens_details. Everything
 * downstream (context meter, cost math) assumes the OpenAI total-with-subsets shape.
 */

import { LLMUsage } from '../sendLLMMessageTypes.js';

/** The usage shape on Anthropic message_start / final message responses. */
export type AnthropicRawUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	/** Tokens served from cache this turn (billed ~0.1x input). */
	cache_read_input_tokens?: number | null;
	/** Legacy TOTAL tokens written to cache this turn, across all TTLs. */
	cache_creation_input_tokens?: number | null;
	/** Per-TTL write split. 5m writes bill at 1.25x input; 1h writes at 2x input. */
	cache_creation?: {
		ephemeral_5m_input_tokens?: number | null;
		ephemeral_1h_input_tokens?: number | null;
	} | null;
};

export const anthropicUsageToLLMUsage = (u: AnthropicRawUsage): LLMUsage => {
	const cacheReadTokens = u.cache_read_input_tokens ?? 0;
	const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
	const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	// The legacy total is authoritative when present (it always accompanies the split on current
	// API versions); the split-sum covers hypothetical responses that only carry cache_creation.
	const cacheWriteTokens = u.cache_creation_input_tokens ?? (write5m + write1h);
	return {
		// Fold cached tokens back into the total: Anthropic's input_tokens alone collapses to a
		// handful of tokens on cache-hot turns (e.g. 12 of a real 326k prompt), which is the
		// "context meter reads ~0% forever" bug.
		prompt_tokens: (u.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens,
		completion_tokens: u.output_tokens ?? 0,
		prompt_cache_hit_tokens: cacheReadTokens,
		prompt_cache_write_tokens: cacheWriteTokens,
		// The 1h-TTL subset bills at 2x input (vs 1.25x for 5m). Without the split, gap-heavy
		// sessions that use ttl:'1h' on their stable prefix under-count every cache write.
		prompt_cache_write_1h_tokens: write1h > 0 ? Math.min(write1h, cacheWriteTokens) : undefined,
	};
};

/** The usage shape on OpenAI-compatible streams (final chunk with stream_options.include_usage). */
export type OpenAICompatRawUsage = {
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	total_tokens?: number | null;
	/** OpenAI / xAI / OpenRouter / Groq report the cached subset here. */
	prompt_tokens_details?: { cached_tokens?: number | null } | null;
	/** DeepSeek's non-standard spelling of the same thing. */
	prompt_cache_hit_tokens?: number | null;
	/** OpenRouter passes Anthropic cache writes through at the top level. */
	cache_creation_input_tokens?: number | null;
};

export const openAICompatUsageToLLMUsage = (u: OpenAICompatRawUsage): LLMUsage => {
	// Standard spelling first (OpenAI/xAI/OpenRouter), DeepSeek's legacy field as fallback.
	// Reading ONLY the DeepSeek field meant cache-heavy GPT/Grok sessions metered every cached
	// token at the full input rate — a 2-4x over-bill in the meter.
	const cacheHit = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
	const cacheWrite = u.cache_creation_input_tokens;
	return {
		prompt_tokens: u.prompt_tokens ?? undefined,
		completion_tokens: u.completion_tokens ?? undefined,
		total_tokens: u.total_tokens ?? undefined,
		prompt_cache_hit_tokens: cacheHit ?? undefined,
		prompt_cache_write_tokens: cacheWrite ?? undefined,
	};
};
