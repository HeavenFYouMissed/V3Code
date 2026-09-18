/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// allow-any-unicode-comment-file

/**
 * Hybrid retriever: lexical (token-overlap) + vector (dynamic int8 cosine)
 * channels fused with weighted Reciprocal Rank Fusion, then collapsed from
 * precise CHILD matches up to their enclosing PARENT blocks, then augmented
 * with dependency-graph NEIGHBORS (callers + referenced definitions).
 *
 * Scoring pipeline (one pass):
 *   1. Score every `scored` chunk on both channels.
 *   2. RRF-merge each channel (k=30 — steep top-of-list curve for code search),
 *      weight lexical 0.4 / vector 0.6. Chunks from recently-edited files then
 *      get a small MULTIPLICATIVE boost (1.25x for the most recent file,
 *      harmonic decay) — Continue's recently-edited retrieval channel, adapted:
 *      Continue injects recent-file chunks unconditionally and lets a reranker
 *      filter the noise; this hot path has no reranker, so we only promote
 *      chunks that already matched, and multiplicatively so a weak match can
 *      never leap a decisively stronger one (additive RRF weight would let it —
 *      adjacent RRF ranks differ by only ~3% regardless of match quality).
 *   3. Collapse child→parent. A parent's score is the SUM OF ITS TOP-3 child
 *      fused scores (not max) — a parent matched by 6 children should outrank a
 *      parent matched by 1, but capped so a 20-child parent can't dominate.
 *   4. Apply a language boost, sort, take topK.
 *   5. Graph neighbor expansion: pull in up to NEIGHBOR_MAX caller/definition
 *      chunks that did NOT match directly, as extra context.
 *
 * Dynamic widening: if the first pass yields fewer than MIN_RESULTS primary
 * hits, re-run with a wider candidate pool + relaxed vector floor (widening the
 * POOL, not just k — k alone never adds candidates).
 */

import { rrfMerge } from './rrf.js';
import { Chunk, Hit } from './semanticIndexTypes.js';
import { IndexedChunk } from './browserIndexTypes.js';
import { cosineQueryToInt8 } from './quantizer.js';
import { DependencyGraph } from './dependencyGraph.js';

const LEX_WEIGHT = 0.4;
const VEC_WEIGHT = 0.6;
/** Weight for the PREVIOUS-model vector channel during a model-swap backfill.
 *  Slightly below VEC_WEIGHT: the old space (potion static) is lower quality
 *  than the new one, but far better than no vector signal at all. */
const VEC_PREV_WEIGHT = 0.5;
/** Max multiplicative boost for the most recently edited file; decays 1/(1+rank). */
const REC_BOOST = 0.25;
const RRF_K = 30;
const RRF_K_WIDE = 150;
const VEC_FLOOR = 0.25;
const VEC_FLOOR_WIDE = 0.05;
const MIN_RESULTS_BEFORE_WIDEN = 5;
const NEIGHBOR_MAX = 10;
const TOP_CHILDREN_PER_PARENT = 3;
/** Decay for the 2nd/3rd child contributing to a parent's fused score. A straight
 *  sum lets a large block with several mediocre sub-chunks out-mass a small,
 *  precise single-chunk answer (live repro: notebook `computeFullSymbols`, three
 *  vec-only children summing to 0.072, beat `getNotesForSymbol` at vec=0.64 +
 *  terms=3 on a memory query). Max-only would discard convergent evidence;
 *  a decayed sum keeps both.  */
const CHILD_SCORE_DECAY = [1, 0.5, 0.25];
/** Seeds for one-hop graph score propagation (top fused chunk ids). */
const GRAPH_SEED_COUNT = 20;
const GRAPH_ALPHA = 0.3;
/** Relative score below top hit required to qualify as a knee candidate. */
const KNEE_REL_TO_TOP = 0.35;
/** Minimum primary hits before a knee cut is allowed. */
const KNEE_MIN_STRONG = 5;

export interface RetrieveContext {
	chunks: Map<string, IndexedChunk>;
	graph: DependencyGraph;
	embeddingsAvailable: boolean;
}

export interface RetrieveQuery {
	queryTokens: string[];
	queryEmbedding: Float32Array | null;
	/** Query embedded in the PREVIOUS model's space (dual-space retrieval during
	 *  a model-swap backfill). Scored against chunks that still carry only a
	 *  `prevEmbedding`; fused as a separate RRF channel. */
	queryEmbeddingPrev?: Float32Array | null;
	/** file → recency rank (0 = most recently edited). Chunks from these files
	 *  that matched a primary channel get a small multiplicative boost. */
	recentFiles?: ReadonlyMap<string, number> | null;
}

export interface RetrieveOptions {
	topK: number;
	fileFilter: Set<string> | null;
}

interface PassConfig {
	channelTopK: number;
	vecFloor: number;
	k: number;
}

export function hybridSearch(ctx: RetrieveContext, query: RetrieveQuery, opts: RetrieveOptions): Hit[] {
	ctx.graph.ensure(ctx.chunks.values());

	let hits = runPass(ctx, query, opts, {
		channelTopK: Math.max(opts.topK * 3, 100),
		vecFloor: VEC_FLOOR,
		k: RRF_K,
	});
	const primaryCount = countPrimaries(hits);
	if (primaryCount < MIN_RESULTS_BEFORE_WIDEN) {
		const wider = runPass(ctx, query, opts, {
			channelTopK: Math.max(opts.topK * 6, 400),
			vecFloor: VEC_FLOOR_WIDE,
			k: RRF_K_WIDE,
		});
		if (countPrimaries(wider) > primaryCount) hits = wider;
	}
	return hits;
}

function countPrimaries(hits: Hit[]): number {
	let n = 0;
	for (const h of hits) if (!h.signals.neighbor) n++;
	return n;
}

function runPass(ctx: RetrieveContext, query: RetrieveQuery, opts: RetrieveOptions, cfg: PassConfig): Hit[] {
	const { chunks, embeddingsAvailable } = ctx;
	const { queryTokens, queryEmbedding, queryEmbeddingPrev, recentFiles } = query;
	const { topK, fileFilter } = opts;

	const meta = new Map<string, { chunk: IndexedChunk; overlap: number; vec: number }>();
	const lex: { id: string; s: number; o: number }[] = [];
	const vecs: { id: string; v: number }[] = [];
	// Dual-space channel: chunks whose vector is still in the PREVIOUS model's
	// space (mid model-swap backfill). Scored against the prev-space query
	// embedding and fused as their own ranking — cosines from different models
	// are never mixed inside one ranked list.
	const vecsPrev: { id: string; v: number }[] = [];

	for (const c of chunks.values()) {
		if (!c.scored) continue;
		if (fileFilter && !fileFilter.has(c.file)) continue;

		let overlap = 0;
		for (const t of queryTokens) if (c.tokens.has(t)) overlap++;

		let vec = 0;
		let inPrevSpace = false;
		if (queryEmbedding && c.embedding && c.embedding.length === queryEmbedding.length) {
			vec = cosineQueryToInt8(queryEmbedding, c.embedding, c.vecScale ?? 1);
		} else if (queryEmbeddingPrev && c.prevEmbedding && c.prevEmbedding.length === queryEmbeddingPrev.length) {
			vec = cosineQueryToInt8(queryEmbeddingPrev, c.prevEmbedding, c.prevVecScale ?? 1);
			inPrevSpace = true;
		}

		if (overlap === 0 && vec < cfg.vecFloor) continue;

		meta.set(c.id, { chunk: c, overlap, vec });
		if (overlap > 0) lex.push({ id: c.id, s: overlap / queryTokens.length, o: overlap });
		if (vec >= cfg.vecFloor) (inPrevSpace ? vecsPrev : vecs).push({ id: c.id, v: vec });
	}
	if (meta.size === 0) return [];

	lex.sort((a, b) => b.s - a.s || b.o - a.o);
	vecs.sort((a, b) => b.v - a.v);
	vecsPrev.sort((a, b) => b.v - a.v);
	const lexIds = lex.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));
	const vecIds = vecs.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));
	const vecPrevIds = vecsPrev.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));

	// Weighted RRF: each channel's per-doc 1/(k+rank) (via rrfMerge), scaled by weight.
	const fused = new Map<string, number>();
	if (lexIds.length) {
		for (const f of rrfMerge([lexIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + LEX_WEIGHT * f.score);
	}
	if (vecIds.length) {
		for (const f of rrfMerge([vecIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + VEC_WEIGHT * f.score);
	}
	if (vecPrevIds.length) {
		for (const f of rrfMerge([vecPrevIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + VEC_PREV_WEIGHT * f.score);
	}

	// Recency boost: matched chunks from recently-edited files score up to
	// REC_BOOST higher, decaying harmonically with the file's recency rank.
	if (recentFiles && recentFiles.size > 0) {
		for (const [id, score] of fused) {
			const m = meta.get(id);
			const r = m ? recentFiles.get(m.chunk.file) : undefined;
			if (r !== undefined) fused.set(id, score * (1 + REC_BOOST / (1 + r)));
		}
	}

	// Graph propagation: push seed scores one hop through LSP/text dependency edges
	// so convergent evidence (many memory hits → memoryDatabase) outranks lexical flukes.
	const seeds = [...fused.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, GRAPH_SEED_COUNT)
		.map(([id, score]) => ({ id, score }));
	const graphBoosts = ctx.graph.propagateFromSeeds(seeds, chunks, queryTokens, { alpha: GRAPH_ALPHA });
	for (const [id, boost] of graphBoosts) {
		fused.set(id, (fused.get(id) ?? 0) + boost);
	}

	// Collapse child → display parent; parent score = sum of top-3 child fused scores.
	const groups = new Map<string, { scores: number[]; bestOverlap: number; bestVec: number; viaChild: boolean; graphBoost: number }>();
	for (const [id, score] of fused) {
		const m = meta.get(id);
		const gBoost = graphBoosts.get(id) ?? 0;
		if (m) {
			const displayId = m.chunk.parentId ?? id;
			let g = groups.get(displayId);
			if (!g) { g = { scores: [], bestOverlap: 0, bestVec: 0, viaChild: displayId !== id, graphBoost: 0 }; groups.set(displayId, g); }
			g.scores.push(score);
			if (m.overlap > g.bestOverlap) g.bestOverlap = m.overlap;
			if (m.vec > g.bestVec) g.bestVec = m.vec;
			if (displayId !== id) g.viaChild = true;
			if (gBoost > g.graphBoost) g.graphBoost = gBoost;
		} else if (gBoost > 0) {
			const c = chunks.get(id);
			if (!c || !c.scored) continue;
			const displayId = c.parentId ?? id;
			let g = groups.get(displayId);
			if (!g) { g = { scores: [], bestOverlap: 0, bestVec: 0, viaChild: false, graphBoost: 0 }; groups.set(displayId, g); }
			g.scores.push(score);
			if (gBoost > g.graphBoost) g.graphBoost = gBoost;
		}
	}

	const rankedAll = [...groups.entries()]
		.map(([displayId, g]) => {
			const top = g.scores.sort((a, b) => b - a).slice(0, TOP_CHILDREN_PER_PARENT).reduce((s, x, i) => s + x * (CHILD_SCORE_DECAY[i] ?? 0), 0);
			const disp = resolveDisplay(chunks, displayId);
			return { displayId, g, disp, score: top * languageBoost(disp?.chunk.language ?? '') };
		})
		.filter((r): r is { displayId: string; g: { scores: number[]; bestOverlap: number; bestVec: number; viaChild: boolean; graphBoost: number }; disp: { chunk: IndexedChunk; content: string }; score: number } => !!r.disp)
		.sort((a, b) => b.score - a.score);

	const { strong, weak } = splitAtKnee(rankedAll, topK);
	const ranked = [...strong, ...weak];

	const primaryIds = new Set(ranked.map(r => r.displayId));
	const hits: Hit[] = ranked.map((r, idx) => ({
		chunk: toChunkMeta(r.disp.chunk),
		content: r.disp.content,
		score: r.score,
		signals: {
			terms: r.g.bestOverlap,
			...(embeddingsAvailable ? { vec: r.g.bestVec } : {}),
			...(r.g.viaChild ? { child: 1, parent: 1 } : {}),
			...(r.g.graphBoost > 0 ? { graphBoost: r.g.graphBoost } : {}),
			...(idx >= strong.length ? { weak: 1 } : {}),
		},
	}));

	hits.push(...expandNeighbors(ctx, ranked.map(r => r.displayId), primaryIds, fileFilter));
	return hits;
}

/** Adaptive knee cut: demote tail matches below a sharp score drop (Vectara-style). */
function splitAtKnee<T extends { score: number }>(ranked: T[], topK: number): { strong: T[]; weak: T[] } {
	const candidates = ranked.slice(0, topK);
	if (candidates.length <= KNEE_MIN_STRONG) { return { strong: candidates, weak: [] }; }
	const top = candidates[0].score;
	if (top <= 0) { return { strong: candidates, weak: [] }; }

	const minStrong = Math.max(KNEE_MIN_STRONG, Math.ceil(topK * 0.3));
	let kneeIdx = -1;
	let minRatio = Infinity;
	for (let i = 1; i < candidates.length; i++) {
		const prev = candidates[i - 1].score;
		const cur = candidates[i].score;
		if (prev <= 0) { continue; }
		const ratio = cur / prev;
		const relToTop = cur / top;
		if (relToTop < KNEE_REL_TO_TOP && ratio < minRatio) {
			minRatio = ratio;
			kneeIdx = i;
		}
	}
	if (kneeIdx < 0) { return { strong: candidates, weak: [] }; }

	const cutAt = Math.max(kneeIdx, minStrong);
	if (cutAt >= candidates.length) { return { strong: candidates, weak: [] }; }
	return { strong: candidates.slice(0, cutAt), weak: candidates.slice(cutAt) };
}

function expandNeighbors(ctx: RetrieveContext, primaryIds: string[], exclude: Set<string>, fileFilter: Set<string> | null): Hit[] {
	const { chunks, graph } = ctx;
	const out: Hit[] = [];
	const seen = new Set(exclude);
	let budget = NEIGHBOR_MAX;
	for (const pid of primaryIds) {
		if (budget <= 0) break;
		const p = chunks.get(pid);
		if (!p) continue;
		for (const nid of graph.neighborsOf(p, NEIGHBOR_MAX)) {
			if (budget <= 0) break;
			if (seen.has(nid)) continue;
			const disp = resolveDisplay(chunks, nid);
			if (!disp || !disp.content) continue;
			if (fileFilter && !fileFilter.has(disp.chunk.file)) continue;
			seen.add(nid);
			budget--;
			out.push({
				chunk: toChunkMeta(disp.chunk),
				content: disp.content,
				score: 0,
				signals: { neighbor: 1 },
			});
		}
	}
	return out;
}

/**
 * Resolve a chunk id to its displayable chunk + content. A CHILD (sub-statement)
 * always resolves UP to its enclosing PARENT block — that is the whole point of
 * parent–child chunking: embed the precise child, inject the full parent for
 * context. Keyed on `parentId`, never on whether content happens to be present.
 */
function resolveDisplay(chunks: Map<string, IndexedChunk>, id: string): { chunk: IndexedChunk; content: string } | null {
	const c = chunks.get(id);
	if (!c) return null;
	if (c.parentId) {
		const p = chunks.get(c.parentId);
		if (p) return { chunk: p, content: p.content || c.content };
	}
	return { chunk: c, content: c.content };
}

function toChunkMeta(c: IndexedChunk): Chunk {
	return {
		id: c.id, file: c.file, startLine: c.startLine, endLine: c.endLine,
		kind: c.kind, name: c.name, language: c.language, contentHash: c.contentHash,
	};
}

function languageBoost(lang: string): number {
	if (lang === 'typescript' || lang === 'typescriptreact' || lang === 'javascript' || lang === 'javascriptreact') return 1.8;
	if (lang === 'python' || lang === 'rust' || lang === 'go' || lang === 'java' || lang === 'csharp' || lang === 'cpp' || lang === 'c') return 1.6;
	if (lang === 'markdown' || lang === 'plaintext') return 0.5;
	if (lang === 'json' || lang === 'yaml' || lang === 'toml' || lang === 'xml') return 0.7;
	return 1.0;
}
