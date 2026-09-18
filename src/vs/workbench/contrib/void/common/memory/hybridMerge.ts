/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Hybrid score merge for the catalog retrieval pipeline (C4): combine a vector-similarity
 * list and a BM25 (FTS5) list into one ranked map. Pure -- headless-testable.
 */

import { normalizeScores } from './vectorMath.js';

/** Default blend (decision (d)): vectors dominate, BM25 grounds it in exact terms. */
export const HYBRID_WEIGHTS = { vec: 0.7, bm25: 0.3 } as const;

/**
 * Merge vector + BM25 score maps (each MUST be higher=better; the caller converts a
 * BM25 rank into a higher-is-better score first). Each list is min-max normalized to
 * [0,1] independently, then combined as `wVec*vec + wBm25*bm25` over the UNION of ids
 * (an id missing from one list contributes 0 there).
 */
export function hybridMerge(
	vecScores: Map<string, number>,
	bm25Scores: Map<string, number>,
	wVec: number = HYBRID_WEIGHTS.vec,
	wBm25: number = HYBRID_WEIGHTS.bm25,
): Map<string, number> {
	const v = normalizeScores(vecScores);
	const b = normalizeScores(bm25Scores);
	const ids = new Set<string>([...v.keys(), ...b.keys()]);
	const out = new Map<string, number>();
	for (const id of ids) {
		out.set(id, wVec * (v.get(id) ?? 0) + wBm25 * (b.get(id) ?? 0));
	}
	return out;
}
