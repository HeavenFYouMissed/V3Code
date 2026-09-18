/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Maximal Marginal Relevance (MMR) for the catalog retrieval pipeline (C4): pick a small
 * DIVERSE top-k instead of k near-duplicates, so the snapshot is a tight, varied set
 * rather than the same fact five ways. Pure; headless-testable.
 */

import { cosineSim } from './vectorMath.js';

/** Diversity/relevance trade-off (decision (d)): 1 = pure relevance, 0 = pure diversity. */
export const MMR_LAMBDA = 0.7;

export interface MmrItem {
	id: string;
	relevance: number;        // query-relevance score (higher = better)
	vec?: ArrayLike<number>;  // for diversity; absent -> treated as fully distinct
}

/**
 * Greedy MMR. Each step picks the item maximizing
 *   lambda*relevance - (1-lambda)*maxCosineSimilarityToAlreadyPicked.
 * The first pick is the most relevant; later picks are penalized for resembling what is
 * already chosen. Items without a vector contribute 0 similarity (counted as distinct).
 * Stable: earlier input order wins ties. Returns the selected ids in pick order.
 */
export function mmrSelect(items: MmrItem[], k: number, lambda: number = MMR_LAMBDA): string[] {
	const pool = items.slice();
	const selected: MmrItem[] = [];
	const out: string[] = [];
	const limit = Math.min(k, pool.length);
	while (out.length < limit && pool.length > 0) {
		let bestIdx = 0;
		let bestScore = -Infinity;
		for (let i = 0; i < pool.length; i++) {
			const cand = pool[i];
			let maxSim = 0;
			if (cand.vec) {
				for (const s of selected) {
					if (s.vec) {
						const sim = cosineSim(cand.vec, s.vec);
						if (sim > maxSim) maxSim = sim;
					}
				}
			}
			const score = lambda * cand.relevance - (1 - lambda) * maxSim;
			if (score > bestScore) { bestScore = score; bestIdx = i; }
		}
		const [picked] = pool.splice(bestIdx, 1);
		selected.push(picked);
		out.push(picked.id);
	}
	return out;
}
