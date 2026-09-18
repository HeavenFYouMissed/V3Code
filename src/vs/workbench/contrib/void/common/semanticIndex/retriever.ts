/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Retrieval orchestrator. Pure logic — owns no I/O.
 *
 * Given an expanded query + an open database + an embedder, runs four ranked
 * channels in parallel and merges them with Reciprocal Rank Fusion (RRF, k=60).
 * Channels:
 *   1. original-embedding vector search
 *   2. terms-embedding vector search   (skipped when codeTerms is empty)
 *   3. hyde-embedding vector search    (skipped when hypotheticalCode is empty)
 *   4. FTS5 BM25 search                (against the original prompt)
 *
 * If the DB has no vec extension, the vector channels are silently skipped and
 * RRF degrades to FTS-only ranking. The retriever never throws because of a
 * missing channel — partial signal is better than no result.
 */

import { SemanticIndexDatabase } from './database.js';
import { Embedder } from './embedder.js';
import { rrfMerge } from './rrf.js';
import { Hit, QueryExpansion } from './semanticIndexTypes.js';

type Signals = Hit['signals'];

export interface RetrieveOptions {
	/** How many results to return after RRF merge. */
	topK?: number;
	/** Per-channel candidate pool size (RRF input size). */
	channelTopK?: number;
}

export interface IRetriever {
	retrieve(expansion: QueryExpansion, opts?: RetrieveOptions): Promise<Hit[]>;
}

export class Retriever implements IRetriever {
	constructor(
		private readonly db: SemanticIndexDatabase,
		private readonly embedder: Embedder,
	) {}

	async retrieve(expansion: QueryExpansion, opts: RetrieveOptions = {}): Promise<Hit[]> {
		const topK = opts.topK ?? 30;
		const channelTopK = opts.channelTopK ?? Math.max(topK * 2, 60);

		const hasVec = this.db.hasVec;
		const ftsQueries = [expansion.original, ...expansion.alternatives].filter(Boolean);
		const ftsQuery = ftsQueries.join(' ');

		// Build embedding inputs lazily — only embed strings we actually need.
		const embedInputs: string[] = [];
		const embedKeys: ('orig' | 'terms' | 'hyde')[] = [];
		if (hasVec) {
			embedInputs.push(expansion.original);
			embedKeys.push('orig');
			if (expansion.codeTerms && expansion.codeTerms.length) {
				embedInputs.push(expansion.codeTerms.join(' '));
				embedKeys.push('terms');
			}
			if (expansion.hypotheticalCode) {
				embedInputs.push(expansion.hypotheticalCode);
				embedKeys.push('hyde');
			}
		}

		const [embeddings, ftsRows] = await Promise.all([
			embedInputs.length ? this.embedder.embed(embedInputs) : Promise.resolve([] as Float32Array[]),
			this.db.queryByFts(ftsQuery || expansion.original, channelTopK),
		]);

		// Run all vector channels in parallel instead of awaiting them one-by-one
		// — each is an independent sqlite-vec round-trip with no shared state.
		const vectorHitArrays = await Promise.all(
			embeddings.map(emb => this.db.queryByVector(emb, channelTopK))
		);
		const vectorChannels: Array<{ kind: 'orig' | 'terms' | 'hyde'; ids: string[] }> = [];
		for (let i = 0; i < vectorHitArrays.length; i++) {
			vectorChannels.push({ kind: embedKeys[i], ids: vectorHitArrays[i].map(h => h.id) });
		}

		const ftsIds = ftsRows.map(r => r.id);

		// Build per-channel rank arrays (RRF needs `{id}` items; identity).
		const rankings: { id: string }[][] = [];
		for (const ch of vectorChannels) rankings.push(ch.ids.map(id => ({ id })));
		if (ftsIds.length) rankings.push(ftsIds.map(id => ({ id })));

		const fused = rrfMerge(rankings, 60).slice(0, topK);
		if (fused.length === 0) return [];

		// Batched hydration: 2 SQL round-trips for the whole result set instead of
		// 2*N. Preserves the fused ranking order.
		const fusedIds = fused.map(f => f.item.id);
		const [chunkMap, contentMap] = await Promise.all([
			this.db.getChunks(fusedIds),
			this.db.getContents(fusedIds),
		]);
		const hits: Hit[] = [];
		for (const f of fused) {
			const chunk = chunkMap.get(f.item.id);
			if (!chunk) continue;
			const content = contentMap.get(f.item.id);
			if (content === undefined) continue;
			hits.push({
				chunk,
				content,
				score: f.score,
				signals: buildSignals(f.ranks, vectorChannels, ftsIds.length > 0),
			});
		}
		return hits;
	}
}

function buildSignals(ranks: number[], vectorChannels: Array<{ kind: string }>, hasFts: boolean): Signals {
	let idx = 0;
	const signals: Signals = {};
	for (const ch of vectorChannels) {
		const r = ranks[idx++];
		if (r === 0) continue;
		if (ch.kind === 'orig') signals.vec = r;
		else if (ch.kind === 'terms') signals.terms = r;
		else if (ch.kind === 'hyde') signals.hyde = r;
	}
	if (hasFts) {
		const r = ranks[idx];
		if (r && r > 0) signals.fts = r;
	}
	return signals;
}

/** Re-export — convenient for callers who only want the type surface here. */
export type { Chunk, Hit, QueryExpansion } from './semanticIndexTypes.js';
