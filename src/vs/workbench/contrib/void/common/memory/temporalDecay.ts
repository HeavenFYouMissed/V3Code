/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Temporal decay for the catalog retrieval pipeline (C4): old, low-value memories fade
 * out of the ranked set (they are NEVER deleted -- decay only affects ordering). Pure;
 * headless-testable. The full salience ranker (recency*active + conf*verified - stale)
 * is C5; this module is just the time-decay piece it builds on.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Half-life (ms) by memory layer. permanent/editorial = evergreen (no decay). */
export const DECAY_HALFLIVES = {
	permanent: Infinity,
	workspace: 30 * DAY,
	chat: 3 * DAY,
} as const;
export type MemoryLayer = keyof typeof DECAY_HALFLIVES;

/** Exponential decay in (0,1]: exactly 0.5 at one half-life, -> 0 as age grows. An
 *  infinite half-life (evergreen layer) returns 1; non-positive age returns 1. */
export function decayFactor(ageMs: number, halfLifeMs: number): number {
	if (!isFinite(halfLifeMs)) return 1;
	if (ageMs <= 0) return 1;
	return Math.pow(0.5, ageMs / halfLifeMs);
}

/** Evergreen-exempt: a human-authored or test-verified fact never decays. */
export function isEvergreen(provenance: { source?: string; verifiedByTest?: boolean }): boolean {
	return provenance.source === 'human' || provenance.verifiedByTest === true;
}

/** Apply decay to a base relevance score: evergreen facts keep their score; others are
 *  multiplied by the exponential decay for their age + layer half-life. */
export function applyDecay(baseScore: number, ageMs: number, halfLifeMs: number, evergreen: boolean): number {
	return evergreen ? baseScore : baseScore * decayFactor(ageMs, halfLifeMs);
}
