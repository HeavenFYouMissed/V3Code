/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Effective-context budget for the agent wire (see docs/V3CODE-MEMORY-CONTRACT.md section 3).
 * Pure -> headless-testable; extracted from convertToLLMMessageService so the curate-then-condense
 * thresholds can be tested without the editor.
 *
 * An editor agent holds the LIVE task in native context and pulls the rest on demand. Models degrade
 * well below their advertised window ("context rot": RULER, NoLiMa, Lost-in-the-Middle), so we let
 * raw history build only up to a headroom-reserved fraction of the input budget, bounded by an
 * effective-context ceiling and floored so small models still function.
 */

export interface HistoryBudgetConfig {
	/** Fraction of the input budget reserved for the live turn + injected context + reply slack. */
	headroomFraction: number;
	/** Hard cap on trusted history regardless of advertised window (context rot). */
	effectiveCeilingTokens: number;
	/** Floor - never condense a thread smaller than this; let small models hold it whole. */
	minHistoryTokens: number;
}

export const DEFAULT_HISTORY_BUDGET: HistoryBudgetConfig = {
	headroomFraction: 0.30,
	// Large-context models must be allowed to use the window the user paid for. The previous global
	// 250k ceiling made every 1M model compact at one quarter of its advertised context even though
	// 30% headroom was already reserved for schemas, injected context, and output. A 700k safety
	// ceiling preserves the same behavior for <=200k models while a 1M model now grows to ~678k
	// history tokens (70% of its real input budget) before compaction.
	effectiveCeilingTokens: 700_000,
	minHistoryTokens: 6_000,
};

/** Tool outputs are the biggest, lowest-signal token hogs - curate them only as a last resort. */
export const TOOL_RESULT_KEEP_RECENT = 6;        // keep this many most-recent tool results verbatim
export const TOOL_RESULT_ELIDE_OVER_CHARS = 600; // only elide tool results bigger than this
// Was 0.6 (routine). At 0.6 the agent's OWN recent tool results were blanked mid-loop, so it re-ran
// the same dir listing, grew past 0.6 again, elided more -> the inspection spiral. Raised to a true
// last-resort so a normal working loop never trips it; the transcript grows raw until ~compaction.
export const TOOL_ELISION_TRIGGER_FRACTION = 0.92;
export const CONDENSE_MESSAGE_BACKSTOP = 1200;    // pure-count backstop for many-tiny-message threads (raised: grow normally)
export const CONDENSE_MIN_MESSAGES = 8;           // never condense fewer messages than this

/**
 * Tokens of raw history to allow before condensing: a headroom-reserved fraction of the input window
 * (contextWindow - reserved output), bounded above by the context-rot ceiling and below by the floor.
 */
export function historyTokenCap(
	contextWindow: number,
	reservedOutputTokens: number,
	cfg: HistoryBudgetConfig = DEFAULT_HISTORY_BUDGET,
): number {
	const inputBudget = Math.max(cfg.minHistoryTokens, contextWindow - reservedOutputTokens);
	const cap = Math.min(Math.round(inputBudget * (1 - cfg.headroomFraction)), cfg.effectiveCeilingTokens);
	return Math.max(cfg.minHistoryTokens, cap);
}

/** Char cap = token cap x chars-per-token estimate (the wire is measured in chars). */
export function historyCharCap(
	contextWindow: number,
	reservedOutputTokens: number,
	charsPerToken: number,
	cfg: HistoryBudgetConfig = DEFAULT_HISTORY_BUDGET,
): number {
	return historyTokenCap(contextWindow, reservedOutputTokens, cfg) * charsPerToken;
}

/**
 * TESTING override (v3code.chat.compaction.testCapTokens, read at the call site — this module
 * stays pure): when the cap is > 0, the condense/elide trigger math treats the token ceiling as
 * ~that value (the floor is lowered with it so it cannot mask the cap), letting automatic
 * condensation be observed on a short, real conversation. 0/undefined returns the config
 * UNCHANGED (the same object), so production thresholds are byte-identical when off.
 */
export function historyBudgetWithTestCap(testCapTokens: number | undefined, cfg: HistoryBudgetConfig = DEFAULT_HISTORY_BUDGET): HistoryBudgetConfig {
	if (!testCapTokens || testCapTokens <= 0) { return cfg; }
	return {
		...cfg,
		effectiveCeilingTokens: Math.min(cfg.effectiveCeilingTokens, testCapTokens),
		minHistoryTokens: Math.min(cfg.minHistoryTokens, testCapTokens),
	};
}

/** Stage 1: shed old tool-result bodies once history crosses the trigger fraction of the cap. */
export function shouldElideToolResults(historyChars: number, condenseCharCap: number): boolean {
	return historyChars > condenseCharCap * TOOL_ELISION_TRIGGER_FRACTION;
}

/** Stage 2: condense the conversation middle only if still over budget (or a pathological count). */
export function shouldCondense(historyChars: number, messageCount: number, condenseCharCap: number): boolean {
	const overBudget = historyChars > condenseCharCap || messageCount > CONDENSE_MESSAGE_BACKSTOP;
	return overBudget && messageCount > CONDENSE_MIN_MESSAGES;
}

/**
 * T2 workspace-memory auto-push budget scaled to the model (contract section 8, B3): models that can hold
 * more get a slightly richer memory block; never below the floor. Conservative - only scales UP, and
 * the block is still salience-ranked + capped, so this cannot crowd a small window.
 */
export function workspaceMemoryBudgetTokens(contextWindow: number, floor = 450, ceil = 1200): number {
	if (!contextWindow || contextWindow <= 32_000) { return floor; }
	const clamped = Math.min(contextWindow, 400_000);
	const scaled = Math.round(floor + ((clamped - 32_000) / (400_000 - 32_000)) * (ceil - floor));
	return Math.max(floor, Math.min(ceil, scaled));
}

/**
 * Auto-gathered injected context (semantic-index snippets, memory, plan, digest — the ephemeral
 * tail) spends the HEADROOM slice of the budget, never the history slice. Its cap derives from the
 * SAME config as the history cap so it can never push the assembled input past the ceiling:
 *  - absolute cap: the long-standing 2,500-token / 10k-character tail remains fixed even when a
 *    million-token model is allowed to keep more relevant raw conversation;
 *  - ceiling share: at most AUTO_CONTEXT_CEILING_FRACTION of effectiveCeilingTokens;
 *  - headroom share: at most AUTO_CONTEXT_HEADROOM_FRACTION of the turn headroom, so on a small
 *    window the live turn + reply slack always keep at least half the reserved headroom instead
 *    of drowning in injected context (the old flat 10k-char cap could exceed a small window's
 *    entire headroom — injected text the condenser can never shed, since it only drops history).
 */
export const AUTO_CONTEXT_CEILING_FRACTION = 0.01;
export const AUTO_CONTEXT_HEADROOM_FRACTION = 0.5;
export const AUTO_CONTEXT_MAX_TOKENS = 2_500;
/** The retrieved-snippet block gets this share of the injected-context cap (60% of 10k chars = the long-standing 6k-char snippet budget). */
export const AUTO_CONTEXT_SNIPPET_FRACTION = 0.6;

/** Hard token cap for ALL auto-injected context this turn, bounded by ceiling share and headroom share. */
export function autoContextTokenCap(
	contextWindow: number,
	reservedOutputTokens: number,
	cfg: HistoryBudgetConfig = DEFAULT_HISTORY_BUDGET,
): number {
	const inputBudget = Math.max(cfg.minHistoryTokens, contextWindow - reservedOutputTokens);
	const headroomTokens = inputBudget * cfg.headroomFraction;
	const cap = Math.min(
		AUTO_CONTEXT_MAX_TOKENS,
		Math.round(cfg.effectiveCeilingTokens * AUTO_CONTEXT_CEILING_FRACTION),
		Math.round(headroomTokens * AUTO_CONTEXT_HEADROOM_FRACTION),
	);
	return Math.max(0, cap);
}

/** Char cap = auto-context token cap x chars-per-token estimate (the wire is measured in chars). */
export function autoContextCharCap(
	contextWindow: number,
	reservedOutputTokens: number,
	charsPerToken: number,
	cfg: HistoryBudgetConfig = DEFAULT_HISTORY_BUDGET,
): number {
	return autoContextTokenCap(contextWindow, reservedOutputTokens, cfg) * charsPerToken;
}

/**
 * Chars-per-token for the final fit-into-window LIMIT check only — NOT for budgeting.
 * Real tokenizers are denser than the optimistic 4 chars/token on code-heavy payloads: the
 * 2026-07 incident sent a request the old limit ((window - reserved) x 4 = 4,177,920 chars on a
 * 1,048,576-token model) considered in-bounds, and the API measured it at 1,289,064 tokens
 * (~3.24 chars/token) — a hard "1M token limit" failure the trim pass could never prevent.
 * 3.2 keeps that same window's allowance at ~1.03M real tokens at the measured density, back
 * inside the window. The budgeting caps above (history / auto-context) keep the optimistic 4:
 * they are bounded far below the window by effectiveCeilingTokens, so they cannot overshoot the
 * API limit, and tightening them would only condense/trim conversations earlier for no safety gain.
 */
export const LIMIT_CHARS_PER_TOKEN = 3.2;

/**
 * Hard char allowance for the assembled wire (all messages) in the final fit-into-window trim.
 * Conservative by construction (LIMIT_CHARS_PER_TOKEN): the allowance can no longer exceed the
 * model's real token window on code-heavy content. Floored at 5k chars so a zero/negative input
 * budget never means "trim everything".
 */
export function wireCharLimit(contextWindow: number, reservedOutputTokens: number): number {
	return Math.max(
		Math.floor((contextWindow - reservedOutputTokens) * LIMIT_CHARS_PER_TOKEN),
		5_000,
	);
}

// ================ composition-aware final gate ================
// LIMIT_CHARS_PER_TOKEN (3.2) killed the incident, but any single global chars/token ratio is
// still "a better wrong number": the density tail (dense minified JS, base64 blobs, CJK text,
// token-hostile identifiers) can all tokenize denser than 3.2 chars/token, so a payload can pass
// the 3.2 check and still exceed the real window. Ground truth (2026-08): no true offline
// tokenizer ships in the bundle — @xenova/transformers carries code only (tokenizer.json is a
// runtime HF download, and the wrong model's vocabulary anyway), node-llama-cpp needs a loaded
// GGUF, and there is no tiktoken/gpt-tokenizer in node_modules. So the final gate uses a
// WORST-CASE-AWARE character-class bound instead: classify the actual assembled payload's
// composition in one O(n) scan and charge each class its conservative (minimum measured)
// chars/token density, so the bound is >= the real token count on every class mix we ship to.

/**
 * Conservative chars/token per character class — each value is a floor of the measured density
 * for that class across the deployed tokenizer families (o200k/cl100k BPE, Claude, Gemini
 * SentencePiece, Llama-3/Qwen), so dividing a class's char count by it OVER-estimates its tokens.
 * Anchor for all of this: a byte-level BPE can never emit more tokens than UTF-8 bytes (every
 * token covers >= 1 byte), and these floors sit far inside that ceiling where it matters.
 *  - whitespace 2.5: a leading space merges into the following word token (" the" is ONE token in
 *    every modern vocab) and indentation/newline runs have dedicated run tokens; isolated
 *    pathological alternation can cost ~1/char but never dominates a real payload (safety factor).
 *  - asciiWord 3.0: English prose measures ~4-4.5 (the classic "4 chars/token"); the worst
 *    letter-heavy cases — random lowercase gibberish, agglutinative Latin-script prose,
 *    token-hostile short identifiers — measure ~2.9-3.3 on cl100k. 3.0 is the floor.
 *  - digit 2.0: modern BPEs chunk digit runs 1-3 digits/token (~2.5-3 measured on long runs).
 *    (Legacy single-digit SentencePiece vocabs (Llama-2 era) can hit 1.0 — accepted residual;
 *    those models pair with small windows where the token-budget floor dominates anyway.)
 *  - asciiPunct 1.4: worst case is one token per symbol (1.0), but code punctuation merges
 *    heavily ("));", "=>", "://", dash/equals runs), lifting real payloads well above 2.
 *  - blobRun 2.0: high-entropy base64/hex measures ~2.5-2.8 chars/token (no long merges exist
 *    for random alphanumerics) — the 2026-07 incident class. 2.0 is the floor with margin.
 *  - cjk 0.9: common ideographs/kana/hangul are ~1 char/token (o200k often better, packing
 *    2-char words); rare ideographs byte-fallback to 2-3 tokens/char — 0.9 + the safety factor
 *    covers everything except pure rare-glyph soup.
 *  - otherNonAscii 1.0: accented Latin/Cyrillic/Greek/Arabic usually >= 2 chars/token in modern
 *    vocabs but byte-fallback singles exist; surrogate halves (emoji) count per UTF-16 unit.
 */
export const TOKEN_BOUND_CHARS_PER_TOKEN = {
	whitespace: 2.5,
	asciiWord: 3.0,
	digit: 2.0,
	asciiPunct: 1.4,
	blobRun: 2.0,
	cjk: 0.9,
	otherNonAscii: 1.0,
} as const;

/** Safety divisor on the summed bound (+~11%) absorbing per-class residuals documented above. */
export const TOKEN_BOUND_SAFETY = 0.9;

/** An unbroken [A-Za-z0-9+/=_-] run at least this long is charged as a base64-ish blob. */
const BLOB_MIN_RUN_CHARS = 40;

/** Structural per-message wire overhead (role scaffolding, ~4-8 tokens in ChatML/Anthropic framing). */
export const WIRE_MESSAGE_OVERHEAD_TOKENS = 8;

/**
 * Engage the tight composition-aware gate only when the coarse 3.2 estimate puts the payload
 * above this fraction of the window's char allowance; below the band, behavior is unchanged
 * (the coarse limit could not have trimmed there either).
 */
export const TIGHT_BOUND_TRIGGER_FRACTION = 0.6;

const isCjkCodeUnit = (c: number): boolean =>
	(c >= 0x2E80 && c <= 0x9FFF)        // CJK radicals, punctuation, kana, CJK unified ideographs
	|| (c >= 0xAC00 && c <= 0xD7AF)     // Hangul syllables
	|| (c >= 0xF900 && c <= 0xFAFF)     // CJK compatibility ideographs
	|| (c >= 0xFF00 && c <= 0xFFEF);    // full/half-width forms

/**
 * Conservative upper bound on the token count of `text`: single O(n) scan, no allocation.
 * Provably >= the real count whenever each class's real density stays at or above its floor in
 * TOKEN_BOUND_CHARS_PER_TOKEN (see the table's reasoning); the safety divisor absorbs the
 * documented residuals. Over-estimating (over-trimming) is the safe direction — under-estimating
 * re-opens the "1M token limit" bug class.
 */
export function conservativeTokenBound(text: string): number {
	let ws = 0, word = 0, digit = 0, punct = 0, blob = 0, cjk = 0, other = 0;
	// Current unbroken [A-Za-z0-9+/=_-] run, tracked per sub-class so a short run can be
	// redistributed to the word/digit/punct counters and a long, alnum-dominated one charged as blob.
	let runWord = 0, runDigit = 0, runPunct = 0;
	const flushRun = () => {
		const runLen = runWord + runDigit + runPunct;
		// Only alnum-DOMINATED long runs are base64-ish; a pure "+/+/=" soup stays punct (1.4 is
		// the stricter charge there — blob's 2.0 would under-count it).
		if (runLen >= BLOB_MIN_RUN_CHARS && runPunct <= runLen / 4) {
			blob += runLen;
		} else {
			word += runWord; digit += runDigit; punct += runPunct;
		}
		runWord = 0; runDigit = 0; runPunct = 0;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { runWord++; continue; }
		if (c >= 48 && c <= 57) { runDigit++; continue; }
		if (c === 43 || c === 47 || c === 61 || c === 45 || c === 95) { runPunct++; continue; } // + / = - _
		flushRun();
		if (c === 32 || c === 9 || c === 10 || c === 13) { ws++; }
		else if (c < 128) { punct++; }
		else if (isCjkCodeUnit(c)) { cjk++; }
		else { other++; }
	}
	flushRun();
	const d = TOKEN_BOUND_CHARS_PER_TOKEN;
	const bound = ws / d.whitespace + word / d.asciiWord + digit / d.digit + punct / d.asciiPunct
		+ blob / d.blobRun + cjk / d.cjk + other / d.otherNonAscii;
	return Math.ceil(bound / TOKEN_BOUND_SAFETY);
}

/**
 * Token allowance for the assembled wire: the real input window, floored so a zero/negative
 * input budget never means "trim everything" (the token twin of wireCharLimit's 5k-char floor).
 */
export function wireTokenBudget(contextWindow: number, reservedOutputTokens: number): number {
	return Math.max(contextWindow - reservedOutputTokens, Math.ceil(5_000 / LIMIT_CHARS_PER_TOKEN));
}

/** The wire being fitted, as the trim loop sees it — backed by the caller's real trim machinery. */
export interface WireTrimHooks {
	/** Total chars currently on the wire. */
	totalChars(): number;
	/** Conservative token bound of the wire as currently assembled (composition-aware). */
	tokenBound(): number;
	/** Trim ~charsToTrim chars with the caller's machinery; false = nothing more can be trimmed. */
	trim(charsToTrim: number): boolean;
}

/** Convergence backstop; the linear projection normally lands in 1-3 passes. */
export const WIRE_BOUND_MAX_PASSES = 32;

/**
 * The final gate as a LOOP, not a one-shot estimate: recompute the bound on the ACTUAL assembled
 * payload, trim toward the budget, and repeat until the bound fits or nothing is left to trim.
 * Terminates: every continuing pass removes >= 1 char (trim() returning false exits), plus the
 * pass cap. Each pass projects the wire to (budget / bound) of its current size — linear in the
 * current mix — then re-measures, because trimming whole messages shifts the mix.
 */
export function enforceWireTokenBudget(wire: WireTrimHooks, tokenBudget: number, maxPasses: number = WIRE_BOUND_MAX_PASSES): number {
	let bound = wire.tokenBound();
	for (let pass = 0; pass < maxPasses && bound > tokenBudget; pass++) {
		const total = wire.totalChars();
		if (total <= 0) { break; }
		const target = Math.floor(total * (tokenBudget / bound));
		const charsToTrim = Math.max(1, total - target);
		if (!wire.trim(charsToTrim)) { break; } // exhausted the trimmable wire — ship best effort
		bound = wire.tokenBound();
	}
	return bound;
}

/**
 * Deterministic whole-item fit for auto-gathered context: keep items in the order the gatherer
 * ranked them (highest relevance first), drop any whole item that no longer fits (never truncate
 * mid-item), and report how many were dropped so the caller can append a visible trim marker
 * instead of trimming silently.
 */
export function fitAutoContextItems(items: readonly string[], charBudget: number): { kept: string[]; droppedCount: number } {
	const kept: string[] = [];
	let remaining = charBudget;
	let droppedCount = 0;
	for (const item of items) {
		if (item.length <= remaining) {
			kept.push(item);
			remaining -= item.length;
		} else {
			droppedCount++;
		}
	}
	return { kept, droppedCount };
}
