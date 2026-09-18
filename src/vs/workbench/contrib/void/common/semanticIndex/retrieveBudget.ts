/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Chat-path retrieval budget (first-token latency guard).
 *
 * The chat send path awaits auto-context BEFORE the LLM request goes out, so a
 * cold semantic index — embedder GGUF load (3-8s Metal init, 5-15s+ when the
 * model is still downloading), a node-backend open, a cold reranker, or a
 * locked DB — must never be awaited unbounded there. This helper gives the
 * full retrieve a hard wall-clock budget; on overrun it degrades to a short
 * lexical-only quickPath retrieve, and past that returns [] (no auto-context
 * this turn). Once warm the full retrieve settles well inside the budget, so
 * behavior is identical to an unbudgeted call.
 */

import { raceTimeout } from '../../../../../base/common/async.js';

/** Overall budget for the full retrieve (node IPC / query embed / rerank). */
export const CHAT_RETRIEVE_BUDGET_MS = 3_000;
/** Budget for the lexical-only fallback after the full retrieve overruns. */
export const CHAT_RETRIEVE_QUICK_BUDGET_MS = 500;

/**
 * Run `fullRetrieve` under a hard budget, degrading to `quickRetrieve`
 * (expected to be a cheap lexical-only path) and finally to `[]`. The quick
 * thunk is only invoked when the full retrieve overran or failed, so the warm
 * path does no double work. Never rejects — the chat pipeline treats a missing
 * auto-context block as "skip", not as an error.
 */
export async function retrieveWithinChatBudget<T>(
	fullRetrieve: () => Promise<T[]>,
	quickRetrieve: () => Promise<T[]>,
	budgets?: { fullMs?: number; quickMs?: number },
): Promise<T[]> {
	const fullMs = budgets?.fullMs ?? CHAT_RETRIEVE_BUDGET_MS;
	const quickMs = budgets?.quickMs ?? CHAT_RETRIEVE_QUICK_BUDGET_MS;
	try {
		const full = await raceTimeout(fullRetrieve(), fullMs);
		if (full !== undefined) return full;
	} catch {
		// Fast failure (IPC error, disabled index) — a lexical fallback is still
		// better than no context; fall through.
	}
	try {
		return await raceTimeout(quickRetrieve(), quickMs) ?? [];
	} catch {
		return [];
	}
}
