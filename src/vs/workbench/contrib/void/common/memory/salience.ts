/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Salience ranker for the catalog (C5): the single knob that decides what memory the
 * agent actually SEES each turn. It favors what is being actively worked on + the
 * high-value, verified facts, and lets stale low-confidence noise fade out of the live
 * snapshot (decay affects ORDERING only -- nothing is ever deleted from disk). Pure ->
 * headless-testable; the weights live in one const so the C5.2 ledger can measure tuning.
 */

import { decayFactor, isEvergreen, DECAY_HALFLIVES } from './temporalDecay.js';

const DAY = 24 * 60 * 60 * 1000;

/** Tunable salience weights (decision (d)). Overridable later from voidSettingsTypes so
 *  the context-budget ledger can A/B them; defaults here are the shipping values. */
export const SALIENCE_DEFAULTS = {
	wRecency: 0.4,
	wConf: 0.4,
	wStale: 0.2,
	activeMatch: 1.0,      // subject matches an active file / mentioned symbol
	baselineMatch: 0.3,    // everything else
	verifiedBonus: 1.5,    // human-authored or test-verified
	stalenessGraceDays: 7, // no staleness penalty for the first week unused
	stalenessCoef: 0.1,
} as const;
export type SalienceWeights = typeof SALIENCE_DEFAULTS;

export interface SalienceFact {
	subject: string;
	tsLast: number;            // last touched (recency axis)
	confidence: number;        // 0..1
	source?: string;           // 'human' | 'ai_inferred' | 'tool' | ...
	verifiedByTest?: boolean;
	lastUsedAt?: number;       // last time surfaced in a snapshot (0 = never)
	useCount?: number;
}

export interface ActiveContext {
	files?: Set<string> | string[];
	symbols?: Set<string> | string[];
}

function asSet(v?: Set<string> | string[]): Set<string> {
	return v instanceof Set ? v : new Set(v ?? []);
}

/** True if a fact's subject lines up with what the agent is working on right now. */
export function matchesActive(subject: string, ctx?: ActiveContext): boolean {
	if (!ctx) return false;
	const files = asSet(ctx.files);
	const symbols = asSet(ctx.symbols);
	if (files.has(subject) || symbols.has(subject)) return true;
	// subjects can be a path or "file::symbol" -- loose containment either direction.
	for (const f of files) { if (f && (subject.includes(f) || f.includes(subject))) return true; }
	for (const s of symbols) { if (s && subject.includes(s)) return true; }
	return false;
}

/**
 * salience = (wRecency * decay(age, halflife) + wConf * confidence * verifiedBonus) * activeMatch
 *          - wStale * stalenessPenalty
 * `activeMatch` gates the WHOLE relevance term (recency + confidence), not just recency: a
 * high-confidence or evergreen fact about a file the agent is NOT touching is still off-topic
 * for this turn and must not crowd the token budget against a fact that IS in play ("push
 * minimum, pull excellent" — off-topic facts stay on disk, reachable via deep_recall).
 * Evergreen facts (human / verified) do not decay. A brand-new never-surfaced fact has no
 * staleness penalty; one that ages without ever being surfaced gradually fades.
 */
export function salience(
	fact: SalienceFact,
	ctx: ActiveContext | undefined,
	now: number,
	halfLifeMs: number = DECAY_HALFLIVES.workspace,
	w: SalienceWeights = SALIENCE_DEFAULTS,
): number {
	const evergreen = isEvergreen({ source: fact.source, verifiedByTest: fact.verifiedByTest });
	const decay = evergreen ? 1 : decayFactor(Math.max(0, now - fact.tsLast), halfLifeMs);
	const active = matchesActive(fact.subject, ctx) ? w.activeMatch : w.baselineMatch;
	const verifiedBonus = (fact.verifiedByTest || fact.source === 'human') ? w.verifiedBonus : 1.0;
	const lastUsed = fact.lastUsedAt && fact.lastUsedAt > 0 ? fact.lastUsedAt : 0;
	const daysSinceUsed = lastUsed > 0
		? (now - lastUsed) / DAY
		// Never surfaced: mild decay from creation after grace — not a permanent free pass.
		: Math.max(0, (now - fact.tsLast) / DAY - w.stalenessGraceDays);
	const staleness = w.stalenessCoef * Math.max(0, daysSinceUsed - w.stalenessGraceDays) / (1 + (fact.useCount ?? 0));
	const relevance = w.wRecency * decay + w.wConf * fact.confidence * verifiedBonus;
	return relevance * active - w.wStale * staleness;
}
