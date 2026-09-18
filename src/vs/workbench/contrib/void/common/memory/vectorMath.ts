/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure vector / score helpers for the catalog retrieval pipeline (C4). No sqlite, no
 * native, no IO -- so the whole retrieval brain stays headless-testable (test-node).
 */

/** Cosine similarity of two equal-length vectors. Compares over the shorter length;
 *  returns 0 (never NaN) when either side is empty or zero-magnitude. */
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i], y = b[i];
		dot += x * y; na += x * x; nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Min-max normalize a score map into [0,1] (higher in -> higher out). BM25 ranks and
 *  cosine sims live on different scales, so each list is normalized before merging. If
 *  every score is equal, all present ids map to 1 (equally relevant). */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
	const out = new Map<string, number>();
	if (scores.size === 0) return out;
	let min = Infinity, max = -Infinity;
	for (const v of scores.values()) { if (v < min) min = v; if (v > max) max = v; }
	const range = max - min;
	for (const [id, v] of scores) {
		out.set(id, range === 0 ? 1 : (v - min) / range);
	}
	return out;
}
