/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Reciprocal Rank Fusion — Cormack, Clarke & Büttcher (SIGIR 2009).
 *
 *     score(d) = Σ_q  1 / (k + rank_q(d))
 *
 * `k = 60` is the de-facto default and the one used by every well-known hybrid
 * retriever (Elastic, Vespa, Weaviate, sqlite-vec docs). Do not change without
 * evidence — the constant exists to dampen the head of each list so a doc that
 * appears in position 1 of one ranking and position 50 of another still beats
 * a doc that appears only in position 1 of one ranking.
 *
 * Pure function. No I/O. Trivially testable.
 */

export interface RankedItem {
	id: string;
}

export interface FusedItem<T extends RankedItem> {
	item: T;
	score: number;
	/** 1-indexed rank in each input list (0 if absent from that list). */
	ranks: number[];
}

/**
 * Merge multiple ranked lists into a single RRF-scored list.
 *
 * @param rankings    Each input list, ordered best-first. Lists may have different lengths.
 * @param k           Fusion constant (default 60).
 * @returns           Items sorted by RRF score descending. An item present in any input list
 *                    appears exactly once in the output; its `ranks` array preserves the
 *                    original 1-indexed rank per channel (0 = absent).
 *
 * Complexity: O(Σ|L|) over input lists.
 */
export function rrfMerge<T extends RankedItem>(rankings: T[][], k: number = 60): FusedItem<T>[] {
	if (k <= 0) {
		throw new Error(`rrfMerge: k must be positive (got ${k})`);
	}

	const channelCount = rankings.length;
	const acc = new Map<string, FusedItem<T>>();

	for (let channel = 0; channel < channelCount; channel++) {
		const list = rankings[channel];
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			const rank = i + 1; // 1-indexed
			const contribution = 1 / (k + rank);

			let entry = acc.get(item.id);
			if (entry === undefined) {
				entry = {
					item,
					score: 0,
					ranks: new Array<number>(channelCount).fill(0),
				};
				acc.set(item.id, entry);
			}
			entry.score += contribution;
			entry.ranks[channel] = rank;
		}
	}

	return [...acc.values()].sort((a, b) => b.score - a.score);
}
