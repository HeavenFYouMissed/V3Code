/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Cloud fusion — stage-for-stage adaptation of core/hybridRetriever.ts for the
 *  storage split (FTS5 lexical in DO-SQLite, vectors in Vectorize).
 *
 *  hybridRetriever scores every in-memory chunk itself (token overlap + int8
 *  cosine). Here the channels arrive pre-scored: lexical ranks from FTS5 bm25,
 *  vector ranks from Vectorize topK. Everything downstream — RRF fusion,
 *  recency boost, graph propagation, child→parent collapse, language boost,
 *  adaptive knee — mirrors the editor pipeline and its measured constants.
 *  Keep constants in lockstep with core/hybridRetriever.ts (parity-audited by
 *  the eval harness). Divergences are commented inline.
 *--------------------------------------------------------------------------------------*/

import { rrfMerge } from '../core/rrf.js';
import type { IndexedChunk } from '../core/browserIndexTypes.js';

// Cloud graph edges now come from SQL (SqlGraph over the DO's symbol_edges
// table) — the editor keeps its in-memory DependencyGraph. cloudFuse depends
// only on this narrow surface; both implementations satisfy it, and the SQL one
// reproduces the in-memory scoring byte-for-byte (see retrieve/sqlGraph.ts).
export interface FusionGraph {
	propagateFromSeeds(
		seeds: ReadonlyArray<{ id: string; score: number }>,
		chunkById: ReadonlyMap<string, IndexedChunk>,
		queryTokens: readonly string[],
		opts?: { alpha?: number; maxPerSeed?: number },
	): Map<string, number>;
	neighborsOf(chunk: IndexedChunk, max: number): string[];
}

// Constants mirrored from core/hybridRetriever.ts — do not tune here without
// re-measuring in the eval harness.
const LEX_WEIGHT = 0.4;
const VEC_WEIGHT = 0.6;
const REC_BOOST = 0.25;
const RRF_K = 30;
const NEIGHBOR_MAX = 10;
const TOP_CHILDREN_PER_PARENT = 3;
const CHILD_SCORE_DECAY = [1, 0.5, 0.25];
const GRAPH_SEED_COUNT = 20;
const GRAPH_ALPHA = 0.3;
const KNEE_REL_TO_TOP = 0.35;
const KNEE_MIN_STRONG = 5;

const LANGUAGE_BOOST: Record<string, number> = {
	typescript: 1.8, typescriptreact: 1.8, javascript: 1.8, javascriptreact: 1.8,
	python: 1.6, rust: 1.6, go: 1.6, java: 1.6, csharp: 1.6, cpp: 1.6, c: 1.6,
	markdown: 0.5, plaintext: 0.5,
	json: 0.7, yaml: 0.7, toml: 0.7, xml: 0.7,
};

// Path-class ownership weighting (harvested from bloop/Cody/meilisearch). DEMOTE
// (never hard-filter) vendored / generated / test code so a user's OWN source floats
// to the top — the direct fix for the measured "my code buried under upstream/vendored"
// weakness on forks + monorepos (e.g. VSElite: 95% upstream VS Code + Copilot code
// drowning the void/ additions). Vendored still appears when it's the only match.
const PATH_CLASS_WEIGHT: Record<string, number> = { own: 1.0, test: 0.6, generated: 0.4, vendored: 0.3 };
function classifyPath(file: string): keyof typeof PATH_CLASS_WEIGHT {
	const f = file.toLowerCase();
	if (/(^|\/)(vendor|node_modules|third_party|bower_components|\.yarn|packages\/[^/]+\/node_modules)\//.test(f) || /\.min\.(js|css)$/.test(f) || /_pb\.(go|py|js|ts)$/.test(f)) return 'vendored';
	if (/(^|\/)(dist|build|out|\.next|coverage|generated|__generated__)\//.test(f) || /\.(generated|g)\.(ts|js|dart|py)$/.test(f) || /\.d\.ts$/.test(f)) return 'generated';
	if (/(^|\/)(tests?|__tests__|spec|e2e|__mocks__)\//.test(f) || /\.(test|spec)\.[a-z0-9]+$/.test(f)) return 'test';
	return 'own';
}

/** Candidate record fetched from the workspace DO — the graph/collapse fields
 *  of IndexedChunk without content or vectors. */
export interface FusionCandidate {
	id: string;
	casKey: string;
	file: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	language: string;
	parentId?: string;
	scored: boolean;
	defines?: string[];
	refs?: string[];
	lspDefines?: string[];
	lspRefs?: string[];
}

export interface ChannelInputs {
	/** FTS5 hits, best-first (bm25 ascending already ordered by the DO). */
	lexicalRanked: string[];
	/** Vectorize hits, best-first. */
	vectorRanked: string[];
	/** file → recency rank (0 = most recent), from client-pushed edit signals. */
	recentFiles: ReadonlyMap<string, number> | null;
	queryTokens: readonly string[];
}

export interface FusedHit {
	chunk: FusionCandidate;
	score: number;
	signals: { fts?: number; vec?: number; graphBoost?: number; neighbor?: number; parent?: number; child?: number; weak?: number };
}

export function cloudFuse(
	candidates: Map<string, FusionCandidate>,
	graph: FusionGraph,
	inputs: ChannelInputs,
	topK: number,
): FusedHit[] {
	// 1. RRF over the two ranked channels (hybridRetriever.ts fusion step).
	//    rrfMerge is unweighted; channel weights are applied from the per-channel
	//    ranks it returns — score = Σ weight_c / (k + rank_c), editor parity.
	const fused = rrfMerge(
		[inputs.lexicalRanked.map(id => ({ id })), inputs.vectorRanked.map(id => ({ id }))],
		RRF_K,
	);

	interface Working { id: string; score: number; signals: FusedHit['signals'] }
	const working: Working[] = [];
	for (const f of fused) {
		const c = candidates.get(f.item.id);
		if (!c) continue;
		const signals: FusedHit['signals'] = {};
		const [lexRank, vecRank] = [f.ranks[0] ?? 0, f.ranks[1] ?? 0];
		if (lexRank > 0) signals.fts = 1 / lexRank;
		if (vecRank > 0) signals.vec = 1 / vecRank;
		let score = 0;
		if (lexRank > 0) score += LEX_WEIGHT / (RRF_K + lexRank);
		if (vecRank > 0) score += VEC_WEIGHT / (RRF_K + vecRank);
		// 2. Recency boost (editor: score *= 1 + REC_BOOST/(1+rank)).
		const rec = inputs.recentFiles?.get(c.file);
		if (rec !== undefined) score *= 1 + REC_BOOST / (1 + rec);
		// Language boost (editor applies before collapse).
		score *= LANGUAGE_BOOST[c.language] ?? 1.0;
		// Path-class ownership weight — own code floats above vendored/generated/test.
		score *= PATH_CLASS_WEIGHT[classifyPath(c.file)];
		working.push({ id: f.item.id, score, signals });
	}
	working.sort((a, b) => b.score - a.score);

	// 3. Graph propagation from top seeds (one hop, query-term-weighted edges).
	const seeds = working.slice(0, GRAPH_SEED_COUNT).map(w => ({ id: w.id, score: w.score }));
	const anyCandidates = candidates as unknown as ReadonlyMap<string, IndexedChunk>;
	const boosts = graph.propagateFromSeeds(seeds, anyCandidates, inputs.queryTokens, { alpha: GRAPH_ALPHA });
	for (const w of working) {
		const b = boosts.get(w.id);
		if (b) { w.score += b; w.signals.graphBoost = b; }
	}
	working.sort((a, b) => b.score - a.score);

	// 4. Child → parent collapse: parent score = decayed sum of its top children.
	const byParent = new Map<string, Working[]>();
	const standalone: Working[] = [];
	for (const w of working) {
		const c = candidates.get(w.id)!;
		if (c.parentId && candidates.has(c.parentId)) {
			const arr = byParent.get(c.parentId) ?? [];
			arr.push(w);
			byParent.set(c.parentId, arr);
		} else {
			standalone.push(w);
		}
	}
	const collapsed: Working[] = [...standalone];
	for (const [parentId, children] of byParent) {
		children.sort((a, b) => b.score - a.score);
		let sum = 0;
		for (let i = 0; i < Math.min(children.length, TOP_CHILDREN_PER_PARENT); i++) {
			sum += children[i].score * (CHILD_SCORE_DECAY[i] ?? 0);
		}
		const existing = collapsed.find(w => w.id === parentId);
		if (existing) {
			existing.score = Math.max(existing.score, sum);
			existing.signals.parent = 1;
		} else {
			collapsed.push({ id: parentId, score: sum, signals: { parent: 1, child: 1 } });
		}
	}
	collapsed.sort((a, b) => b.score - a.score);

	// 5. Adaptive knee: hits below 35% of the top are demoted to the weak tail.
	const top = collapsed[0]?.score ?? 0;
	const strong: Working[] = [];
	const weak: Working[] = [];
	for (const w of collapsed) {
		if (strong.length < KNEE_MIN_STRONG || w.score >= top * KNEE_REL_TO_TOP) strong.push(w);
		else { w.signals.weak = 1; weak.push(w); }
	}

	// 6. Neighbor expansion from primaries (context layer, editor parity).
	const primaries = strong.slice(0, topK);
	const inResults = new Set(primaries.map(w => w.id));
	const neighbors: Working[] = [];
	for (const w of primaries) {
		const c = candidates.get(w.id);
		if (!c) continue;
		const ns = graph.neighborsOf(c as never, NEIGHBOR_MAX);
		for (const nid of ns) {
			if (inResults.has(nid) || !candidates.has(nid)) continue;
			inResults.add(nid);
			neighbors.push({ id: nid, score: w.score * 0.1, signals: { neighbor: 1 } });
			if (neighbors.length >= NEIGHBOR_MAX) break;
		}
		if (neighbors.length >= NEIGHBOR_MAX) break;
	}

	const out: FusedHit[] = [];
	for (const w of [...primaries, ...neighbors, ...weak]) {
		const chunk = candidates.get(w.id);
		if (!chunk) continue;
		out.push({ chunk, score: w.score, signals: w.signals });
		if (out.length >= topK + neighbors.length + weak.length) break;
	}
	return out.slice(0, Math.max(topK, out.length > topK ? topK + NEIGHBOR_MAX : topK));
}
