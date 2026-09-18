/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Context-budget ledger (catalog C5.2 / Phase 11.2): the scoreboard for what actually
 * goes into the model's prompt each turn, broken down by source with its token weight.
 * It makes tuning the memory spine MEASURABLE instead of guesswork -- and is the honest
 * answer to "why did the agent do that" (you can see exactly what it knew). Pure; the
 * caller (the prompt injection point) feeds it the assembled source strings and logs the
 * result. The budget is about model FOCUS + latency, not money -- tokens are ~free; the
 * goal is to keep the live-task facts from drowning in noise the model then ignores.
 */

export interface ContextSource {
	name: string;   // 'memory' | 'grounding' | 'system' | 'rules' | ...
	text: string;
	why?: string;   // a short human reason this source is present
}

export interface ContextLedgerEntry {
	name: string;
	chars: number;
	tokens: number;  // estimate (chars / 4)
	share: number;   // fraction of the total prompt this source occupies (0..1)
	why?: string;
}

export interface ContextLedger {
	entries: ContextLedgerEntry[]; // largest source first
	totalChars: number;
	totalTokens: number;
}

export const LEDGER_CHARS_PER_TOKEN = 4;

/** Rough token estimate (chars/4) -- the same convention the snapshot budget uses. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / LEDGER_CHARS_PER_TOKEN);
}

/** Build the per-source breakdown. Empty sources are dropped; shares are of the total. */
export function buildContextLedger(sources: ContextSource[]): ContextLedger {
	const entries: ContextLedgerEntry[] = sources
		.filter(s => s.text && s.text.length > 0)
		.map(s => ({ name: s.name, chars: s.text.length, tokens: estimateTokens(s.text), share: 0, why: s.why }));
	const totalChars = entries.reduce((a, e) => a + e.chars, 0);
	const totalTokens = entries.reduce((a, e) => a + e.tokens, 0);
	for (const e of entries) { e.share = totalTokens > 0 ? e.tokens / totalTokens : 0; }
	entries.sort((a, b) => b.tokens - a.tokens);
	return { entries, totalChars, totalTokens };
}

/** A one-line, log-friendly summary (ASCII only). */
export function formatContextLedger(ledger: ContextLedger): string {
	const parts = ledger.entries.map(e => `${e.name}=${e.tokens}t(${Math.round(e.share * 100)}%)`);
	return `[context-ledger] total~${ledger.totalTokens}t across ${ledger.entries.length} sources | ${parts.join(' ')}`;
}
