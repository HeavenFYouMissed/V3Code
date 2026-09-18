/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Token budget estimation utilities.
// Used by the chat UI to show users how much of their context window is in use.

export interface TokenBudgetEstimate {
	usedTokens: number;
	maxTokens: number;
	percentUsed: number;
	formattedUsed: string;
	formattedMax: string;
	isWarning: boolean;
	isCritical: boolean;
}

const CHARS_PER_TOKEN = 4;
const WARNING_THRESHOLD = 0.75;
const CRITICAL_THRESHOLD = 0.90;

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}k`;
	}
	return `${tokens}`;
}

export function estimateTokens(text: string): number {
	return estimateTokensFromChars(text.length);
}

/** Same estimate when you already counted the characters and never held the string. */
export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: Array<{ content: string }>): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg.content || '');
		total += 4; // per-message overhead (role tokens, separators)
	}
	return total;
}

export function computeTokenBudget(
	usedChars: number,
	contextWindow: number,
): TokenBudgetEstimate {
	const usedTokens = Math.ceil(usedChars / CHARS_PER_TOKEN);
	const maxTokens = contextWindow;
	const percentUsed = maxTokens > 0 ? usedTokens / maxTokens : 0;

	return {
		usedTokens,
		maxTokens,
		percentUsed,
		formattedUsed: formatTokenCount(usedTokens),
		formattedMax: formatTokenCount(maxTokens),
		isWarning: percentUsed >= WARNING_THRESHOLD && percentUsed < CRITICAL_THRESHOLD,
		isCritical: percentUsed >= CRITICAL_THRESHOLD,
	};
}
