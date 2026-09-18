/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// allow-any-unicode-comment-file

/**
 * Hybrid retriever: exact text + lexical (token-overlap) + vector (dynamic int8 cosine)
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

import { rrfMerge } from '../../common/semanticIndex/rrf.js';
import { hasTokenId, tokenIdOf } from './tokenDict.js';
import { Chunk, Hit } from '../../common/semanticIndex/semanticIndexTypes.js';
import { IndexedChunk } from './browserIndexTypes.js';
import { cosineQueryToInt8 } from './quantizer.js';
import { DependencyGraph } from './dependencyGraph.js';

const LEX_WEIGHT = 0.4;
const VEC_WEIGHT = 0.6;
/** Exact phrase/name evidence is the highest-precision local channel. It is
 *  computed only for lexical candidates, so it adds no second corpus scan and
 *  needs no sidecar process or additional resident index. */
const EXACT_WEIGHT = 1.2;
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
	/** Original query text for exact phrase/name/path matching. Optional so
	 *  latency-sensitive callers and older tests retain the lexical floor. */
	queryText?: string;
	queryEmbedding: Float32Array | null;
	/** Query embedded in the PREVIOUS model's space (dual-space retrieval during
	 *  a model-swap backfill). Scored against chunks that still carry only a
	 *  `prevEmbedding`; fused as a separate RRF channel. */
	queryEmbeddingPrev?: Float32Array | null;
	/** file → recency rank (0 = most recently edited). Chunks from these files
	 *  that matched a primary channel get a small multiplicative boost. */
	recentFiles?: ReadonlyMap<string, number> | null;
	/** Pre-fetched beast sidecar hits (rank-ordered best-first, 1-based lines),
	 *  fused as a 4th RRF channel when present. The caller owns the fetch and
	 *  its timeout budget — this stays a pure synchronous ranker. */
	beastHits?: readonly { file: string; line: number }[] | null;
}

export interface RetrieveOptions {
	topK: number;
	fileFilter: Set<string> | null;
	/** RRF weight of the beast channel (only used when beastHits are present). */
	beastWeight?: number;
	/** Rescue mode: the beast-FREE ranking's head stays locked; beast-fused
	 *  results may only fill slots below it. Protects confident rankings from
	 *  channel noise while still rescuing queries the other channels miss. */
	beastRescue?: boolean;
}

interface PassConfig {
	channelTopK: number;
	vecFloor: number;
	k: number;
}

/** Rescue mode: how much of the beast-free ranking's head is locked. */
const RESCUE_LOCKED_HEAD = 5;
/** Multiplier when a chunk's NAME (not just its body) carries a query token. */
const NAME_MATCH_BONUS = 1.25;
/** Vector dims at/above which the space counts as STRONG (qwen 1024d); potion
 *  static is 256d. Gates the lexical channel's scoring mode — see runPass. */
const STRONG_SPACE_DIM = 1024;

export function hybridSearch(ctx: RetrieveContext, query: RetrieveQuery, opts: RetrieveOptions): Hit[] {
	if (opts.beastRescue && query.beastHits && query.beastHits.length > 0) {
		return rescueMerge(ctx, query, opts);
	}
	return hybridSearchInner(ctx, query, opts);
}

/**
 * Rescue-only beast fusion: rank WITHOUT beast, lock that head, and let the
 * beast-fused ranking fill only the slots below it. Confident rankings keep
 * their top results untouched; queries the other channels miss still get the
 * sidecar's exact-match candidates into the visible window. Costs a second
 * ranking pass — only taken when beast hits are actually present.
 */
function rescueMerge(ctx: RetrieveContext, query: RetrieveQuery, opts: RetrieveOptions): Hit[] {
	const base = hybridSearchInner(ctx, { ...query, beastHits: null }, opts);
	const fused = hybridSearchInner(ctx, query, opts);
	const key = (h: Hit) => `${h.chunk.file}:${h.chunk.startLine}`;
	const basePrimaries = base.filter(h => !h.signals.neighbor);
	const out = basePrimaries.slice(0, RESCUE_LOCKED_HEAD);
	const seen = new Set(out.map(key));
	// Below the locked head, the beast-fused order takes over; base-only
	// primaries that the fused pass dropped entirely still trail behind.
	for (const h of fused.filter(x => !x.signals.neighbor)) {
		if (out.length >= opts.topK) break;
		if (seen.has(key(h))) continue;
		seen.add(key(h));
		out.push(h);
	}
	for (const h of basePrimaries) {
		if (out.length >= opts.topK) break;
		if (seen.has(key(h))) continue;
		seen.add(key(h));
		out.push(h);
	}
	out.push(...base.filter(h => h.signals.neighbor === 1));
	return out;
}

function hybridSearchInner(ctx: RetrieveContext, query: RetrieveQuery, opts: RetrieveOptions): Hit[] {
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
	const { queryTokens, queryText, queryEmbedding, queryEmbeddingPrev, recentFiles, beastHits } = query;
	const { topK, fileFilter } = opts;

	// Beast channel resolution: map each sidecar hit (file + 1-based line) to
	// the SMALLEST scored chunk containing that line — the most precise unit;
	// resolving to both parent and child would double-count in parent collapse.
	// Hits in files the index never chunked are dropped (they carry no content).
	let beastRankByChunk: Map<string, number> | null = null; // chunk id → best 1-based beast rank
	if (beastHits && beastHits.length > 0) {
		const byFile = new Map<string, { line0: number; rank: number }[]>();
		for (let i = 0; i < beastHits.length; i++) {
			const h = beastHits[i];
			let arr = byFile.get(h.file);
			if (!arr) { arr = []; byFile.set(h.file, arr); }
			arr.push({ line0: h.line - 1, rank: i + 1 });
		}
		const bestPerHit = new Map<number, { id: string; span: number }>();
		for (const c of chunks.values()) {
			if (!c.scored) continue;
			if (fileFilter && !fileFilter.has(c.file)) continue;
			const fh = byFile.get(c.file);
			if (!fh) continue;
			const span = c.endLine - c.startLine;
			for (const { line0, rank } of fh) {
				if (line0 < c.startLine || line0 > c.endLine) continue;
				const prev = bestPerHit.get(rank);
				if (!prev || span < prev.span) bestPerHit.set(rank, { id: c.id, span });
			}
		}
		beastRankByChunk = new Map();
		for (const [rank, { id }] of bestPerHit) {
			const prev = beastRankByChunk.get(id);
			if (prev === undefined || rank < prev) beastRankByChunk.set(id, rank);
		}
	}

	const meta = new Map<string, { chunk: IndexedChunk; overlap: number; vec: number; beast: number; exact: number }>();
	// Lexical candidates carry WHICH query tokens matched so they can be
	// IDF-scored after the scan (df is only known once the corpus is walked).
	const lexMatches: { id: string; matched: number[]; o: number; setSize: number; name: string }[] = [];
	const df = new Array<number>(queryTokens.length).fill(0);
	let corpusSize = 0;
	const vecs: { id: string; v: number }[] = [];
	// Dual-space channel: chunks whose vector is still in the PREVIOUS model's
	// space (mid model-swap backfill). Scored against the prev-space query
	// embedding and fused as their own ranking — cosines from different models
	// are never mixed inside one ranked list.
	const vecsPrev: { id: string; v: number }[] = [];

	// Query tokens -> interned ids ONCE; the per-chunk probe is then an integer
	// binary search over the chunk's sorted id array instead of a string-hash
	// Set lookup (audit #5/#6 — same matches, same order, cheaper everywhere).
	const queryTokenIds = queryTokens.map(t => tokenIdOf(t));
	for (const c of chunks.values()) {
		if (!c.scored) continue;
		if (fileFilter && !fileFilter.has(c.file)) continue;
		corpusSize++;

		let overlap = 0;
		const matched: number[] = [];
		for (let ti = 0; ti < queryTokens.length; ti++) {
			if (hasTokenId(c.tokens, queryTokenIds[ti])) { overlap++; matched.push(ti); df[ti]++; }
		}

		let vec = 0;
		let inPrevSpace = false;
		if (queryEmbedding && c.embedding && c.embedding.length === queryEmbedding.length) {
			vec = cosineQueryToInt8(queryEmbedding, c.embedding, c.vecScale ?? 1);
		} else if (queryEmbeddingPrev && c.prevEmbedding && c.prevEmbedding.length === queryEmbeddingPrev.length) {
			vec = cosineQueryToInt8(queryEmbeddingPrev, c.prevEmbedding, c.prevVecScale ?? 1);
			inPrevSpace = true;
		}

		const beastRank = beastRankByChunk?.get(c.id) ?? 0;
		if (overlap === 0 && vec < cfg.vecFloor && beastRank === 0) continue;

		meta.set(c.id, { chunk: c, overlap, vec, beast: beastRank, exact: 0 });
		if (overlap > 0) lexMatches.push({ id: c.id, matched, o: overlap, setSize: c.tokens.length, name: c.name ?? '' });
		if (vec >= cfg.vecFloor) (inPrevSpace ? vecsPrev : vecs).push({ id: c.id, v: vec });
	}
	if (meta.size === 0) return [];

	// SPACE-AWARE lexical scoring (audit #3 + #4). Which ordering the lexical
	// channel uses depends on how strong the vector signal ACTUALLY IS for this
	// query — judged by channel composition, not the query vector alone (during
	// a potion→qwen backfill the query embeds at 1024d immediately while the
	// corpus still scores in the 256d prev space; that window must stay in
	// weak-space mode):
	//  - WEAK/ABSENT vector signal: lexical carries the ranking — IDF over
	//    matched tokens, smaller-set tie-break, name-match bonus. +21% MRR
	//    measured under potion.
	//  - STRONG signal (1024d transformer carrying the vector channel): lexical
	//    is a CORROBORATION signal — coverage-first ordering tracks the vector
	//    channel best (IDF-first measurably hurt: qwen gate 3/7). IDF still
	//    breaks coverage ties so thousand-way tie groups are never sliced in
	//    file-scan order (the original audit-#4 lottery).
	const strongSpace = !!queryEmbedding && queryEmbedding.length >= STRONG_SPACE_DIM && vecs.length >= vecsPrev.length;
	const idf = df.map(d => Math.log(1 + (Math.max(1, corpusSize) - d + 0.5) / (d + 0.5)));
	const lex: { id: string; s: number; o: number; setSize: number; idfSum: number }[] = [];
	for (const m of lexMatches) {
		let idfSum = 0;
		for (const ti of m.matched) idfSum += idf[ti];
		const nameLower = m.name.toLowerCase();
		if (nameLower && m.matched.some(ti => nameLower.includes(queryTokens[ti]))) idfSum *= NAME_MATCH_BONUS;
		lex.push({ id: m.id, s: strongSpace ? m.o / queryTokens.length : idfSum, o: m.o, setSize: m.setSize, idfSum });
	}
	if (strongSpace) {
		lex.sort((a, b) => b.o - a.o || b.idfSum - a.idfSum || a.setSize - b.setSize);
	} else {
		lex.sort((a, b) => b.s - a.s || a.setSize - b.setSize || b.o - a.o);
	}
	vecs.sort((a, b) => b.v - a.v);
	vecsPrev.sort((a, b) => b.v - a.v);
	const lexIds = lex.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));
	const vecIds = vecs.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));
	const vecPrevIds = vecsPrev.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));

	// Exact-text lane. Token overlap is the cheap prefilter; only that filtered
	// candidate set pays for lower-casing source text. Name equality wins over a
	// name substring, which wins over a body phrase, which wins over a path hit.
	// This restores word order and punctuation that bag-of-tokens necessarily
	// loses (for example, a copied log line or an exact camelCase symbol).
	const exactNeedle = queryText?.trim().toLowerCase();
	const exact: { id: string; strength: number; span: number }[] = [];
	if (exactNeedle && exactNeedle.length >= 3 && exactNeedle.length <= 512) {
		const identifierQuery = /^[a-z_$][a-z0-9_$]*$/i.test(queryText!.trim());
		for (const m of lexMatches) {
			if (m.o < queryTokens.length) continue;
			const entry = meta.get(m.id);
			if (!entry) continue;
			const c = entry.chunk;
			const name = (c.name ?? '').toLowerCase();
			let strength = name === exactNeedle ? 4 : (!identifierQuery && name.includes(exactNeedle)) ? 3 : 0;
			// A bare identifier means "the symbol", not every reference containing
			// its spelling. Body/path phrase matches remain valuable for copied log
			// lines, diagnostics, filenames, and other non-identifier lookups.
			if (!identifierQuery && strength === 0 && c.content.toLowerCase().includes(exactNeedle)) strength = 2;
			if (!identifierQuery && strength === 0 && c.file.toLowerCase().includes(exactNeedle)) strength = 1;
			if (strength === 0) continue;
			entry.exact = strength;
			exact.push({ id: m.id, strength, span: c.endLine - c.startLine });
		}
	}
	exact.sort((a, b) => b.strength - a.strength || a.span - b.span);
	const exactIds = exact.slice(0, cfg.channelTopK).map(x => ({ id: x.id }));

	// Weighted RRF: each channel's per-doc 1/(k+rank) (via rrfMerge), scaled by weight.
	const fused = new Map<string, number>();
	if (exactIds.length) {
		for (const f of rrfMerge([exactIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + EXACT_WEIGHT * f.score);
	}
	if (lexIds.length) {
		for (const f of rrfMerge([lexIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + LEX_WEIGHT * f.score);
	}
	if (vecIds.length) {
		for (const f of rrfMerge([vecIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + VEC_WEIGHT * f.score);
	}
	if (vecPrevIds.length) {
		for (const f of rrfMerge([vecPrevIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + VEC_PREV_WEIGHT * f.score);
	}
	// Beast channel (eval-gated Phase B): the sidecar's rank order re-scored
	// with the same 1/(k+rank) shape as the other channels, scaled by beastWeight.
	if (beastRankByChunk && beastRankByChunk.size > 0) {
		const beastWeight = opts.beastWeight ?? 0.4;
		const beastIds = [...beastRankByChunk.entries()].sort((a, b) => a[1] - b[1]).slice(0, cfg.channelTopK).map(([id]) => ({ id }));
		for (const f of rrfMerge([beastIds], cfg.k)) fused.set(f.item.id, (fused.get(f.item.id) ?? 0) + beastWeight * f.score);
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

	// Collapse child → display parent; parent score = decayed sum of top-3 child
	// fused scores, but children beyond the BEST one only contribute when they
	// carry cross-channel CORROBORATION (lexical overlap or a beast hit). A big
	// parent holding several mediocre vec-only children must not out-mass one
	// precise answer (the audit-#3 lottery-ticket failure; the earlier live
	// repro — three vec-only children summing past a vec+terms exact match —
	// is exactly what the corroboration gate blocks).
	type GroupEntry = { s: number; corr: boolean };
	const groups = new Map<string, { entries: GroupEntry[]; bestOverlap: number; bestVec: number; viaChild: boolean; graphBoost: number; bestBeast: number; bestExact: number }>();
	for (const [id, score] of fused) {
		const m = meta.get(id);
		const gBoost = graphBoosts.get(id) ?? 0;
		if (m) {
			const displayId = m.chunk.parentId ?? id;
			let g = groups.get(displayId);
			if (!g) { g = { entries: [], bestOverlap: 0, bestVec: 0, viaChild: displayId !== id, graphBoost: 0, bestBeast: 0, bestExact: 0 }; groups.set(displayId, g); }
			g.entries.push({ s: score, corr: m.overlap > 0 || m.beast > 0 });
			if (m.overlap > g.bestOverlap) g.bestOverlap = m.overlap;
			if (m.vec > g.bestVec) g.bestVec = m.vec;
			if (m.beast > 0 && (g.bestBeast === 0 || m.beast < g.bestBeast)) g.bestBeast = m.beast;
			if (m.exact > g.bestExact) g.bestExact = m.exact;
			if (displayId !== id) g.viaChild = true;
			if (gBoost > g.graphBoost) g.graphBoost = gBoost;
		} else if (gBoost > 0) {
			const c = chunks.get(id);
			if (!c || !c.scored) continue;
			const displayId = c.parentId ?? id;
			let g = groups.get(displayId);
			if (!g) { g = { entries: [], bestOverlap: 0, bestVec: 0, viaChild: false, graphBoost: 0, bestBeast: 0, bestExact: 0 }; groups.set(displayId, g); }
			g.entries.push({ s: score, corr: false });
			if (gBoost > g.graphBoost) g.graphBoost = gBoost;
		}
	}

	const rankedAll = [...groups.entries()]
		.map(([displayId, g]) => {
			const sorted = g.entries.sort((a, b) => b.s - a.s).slice(0, TOP_CHILDREN_PER_PARENT);
			// Corroboration-gating non-best children (i === 0 || e.corr) was MEASURED
			// and rejected (qwen matrix 2026-07-06: 3 queries regressed, isolation
			// run without it: 1 improved / 0 regressed). The plain decayed sum
			// stands; entries keep `corr` for future experiments.
			const top = sorted.reduce((s, e, i) => s + e.s * (CHILD_SCORE_DECAY[i] ?? 0), 0);
			const disp = resolveDisplay(chunks, displayId);
			return { displayId, g, disp, score: top * languageBoost(disp?.chunk.language ?? '') * pathClassWeight(disp?.chunk.file ?? '') };
		})
		.filter((r): r is { displayId: string; g: { entries: GroupEntry[]; bestOverlap: number; bestVec: number; viaChild: boolean; graphBoost: number; bestBeast: number; bestExact: number }; disp: { chunk: IndexedChunk; content: string }; score: number } => !!r.disp)
		.sort((a, b) => b.score - a.score);

	const { strong, weak } = splitAtKnee(rankedAll, topK);
	const ranked = [...strong, ...weak];

	const primaryIds = new Set(ranked.map(r => r.displayId));
	const hits: Hit[] = ranked.map((r, idx) => ({
		chunk: toChunkMeta(r.disp.chunk),
		content: r.disp.content,
		score: r.score,
		signals: {
			...(r.g.bestExact > 0 ? { exact: r.g.bestExact } : {}),
			terms: r.g.bestOverlap,
			...(embeddingsAvailable ? { vec: r.g.bestVec } : {}),
			...(r.g.viaChild ? { child: 1, parent: 1 } : {}),
			...(r.g.graphBoost > 0 ? { graphBoost: r.g.graphBoost } : {}),
			...(r.g.bestBeast > 0 ? { beast: r.g.bestBeast } : {}),
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

/**
 * Path-class ownership weighting. DEMOTE (never hard-filter) vendored / generated /
 * test code so a user's OWN source floats to the top — the fix for "my code buried
 * under vendored/upstream" on monorepos + big repos. Mirrors cloudFusion.ts's
 * PATH_CLASS_WEIGHT for local↔cloud parity. Down-weight, not exclude: vendored code
 * still surfaces when it's the only match. (A fork whose upstream lives OUTSIDE a
 * vendor/ dir — e.g. VSElite's src/vs/ — needs an additional per-workspace own-root
 * config; this handles the common node_modules/dist/test case.)
 */
function pathClassWeight(file: string): number {
	const f = file.toLowerCase();
	if (/(^|\/)(vendor|node_modules|third_party|bower_components|\.yarn)\//.test(f) || /\.min\.(js|css)$/.test(f) || /_pb\.(go|py|js|ts)$/.test(f)) return 0.3; // vendored
	if (/(^|\/)(dist|build|out|\.next|coverage|generated|__generated__)\//.test(f) || /\.(generated|g)\.(ts|js|dart|py)$/.test(f) || /\.d\.ts$/.test(f)) return 0.4; // generated
	if (/(^|\/)(tests?|__tests__|spec|e2e|__mocks__)\//.test(f) || /\.(test|spec)\.[a-z0-9]+$/.test(f)) return 0.6; // test
	return 1.0; // own code
}
