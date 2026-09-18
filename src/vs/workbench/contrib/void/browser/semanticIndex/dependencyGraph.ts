/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// allow-any-unicode-comment-file

/**
 * Lightweight code dependency graph built from tree-sitter `defines`/`refs`.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ RECALL CEILING — READ THIS BEFORE TRUSTING THE GRAPH AS GROUND TRUTH.     │
 * │                                                                           │
 * │ This graph is derived purely from tree-sitter node TEXT (callee names,    │
 * │ type identifiers, definition names). It has NO semantic resolution, so    │
 * │ it is roughly 60–70% complete. Known misses:                              │
 * │   • Imported symbols used as values (e.g. `arr.map(foo)` where `foo` is   │
 * │     imported) — captured only if `foo` is also a recognised def somewhere.│
 * │   • Inherited methods (`this.baseMethod()` defined in a parent class      │
 * │     elsewhere) — no inheritance resolution.                               │
 * │   • Dynamic dispatch (`obj[name]()`, `Reflect.get(...)`).                 │
 * │   • Re-exports (`export { foo } from './bar'`) — the local "definition"   │
 * │     is a re-export, not the real one.                                     │
 * │   • Name collisions — a global symbol name maps to every chunk that       │
 * │     defines it; we cap fan-out (below) and drop over-ambiguous symbols.   │
 * │                                                                           │
 * │ Use it for AUGMENTATION (pull likely-relevant neighbors into context),   │
 * │ never as authoritative go-to-definition. That needs an LSP.               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * LSP LAYER: chunks may additionally carry `lspDefines`/`lspRefs` — REAL edges
 * resolved by the language service (lspEdgeEnricher.ts). They use the same
 * plain-symbol-name semantics and are unioned into the graph here. Because
 * they are verified (not guessed), they bypass the GENERIC_SYMBOLS blocklist
 * and the MIN_SYMBOL_LEN floor, but still respect MAX_FANOUT; `neighborsOf`
 * fills from LSP-derived edges FIRST, then tops up with text-derived ones.
 * Chunks without the lsp fields behave exactly as before.
 *
 * MAINTENANCE MODEL — incremental first, full rebuild as fallback.
 * The old design rebuilt every map from all chunks on the next `ensure()`
 * after any `markDirty()`. With ~300k chunks and the LSP enricher marking
 * dirty once per enriched file, retrieval (the autocomplete hot path!) kept
 * paying multi-hundred-ms full rebuilds. Now:
 *   • `updateChunks()`/`removeChunks()` apply per-chunk deltas in O(symbols
 *     touched). A reverse index (`_byChunk`) records exactly what each chunk
 *     contributed, so removal stays exact even though the enricher mutates
 *     chunks in place (the chunk object can't tell us what it USED to say).
 *   • MAX_FANOUT is enforced at QUERY time via incrementally-maintained
 *     union counters (`_defUnion`/`_refUnion`), not by deleting symbols at
 *     build time — deletion can't be undone incrementally, counters can.
 *   • `markDirty()` + `ensure()` remain for bulk invalidation (full rebuild,
 *     cache load): the next `ensure()` does the old O(chunks) rebuild, and
 *     incremental calls are no-ops while dirty (the rebuild subsumes them).
 *   • `warmUp()` is the cooperative-yield variant of that rebuild for the
 *     background path, so the one big rebuild happens OFF the retrieve path.
 */

import { IndexedChunk } from './browserIndexTypes.js';

/** Symbols too generic to yield useful neighbors — pulling everything that
 *  calls `get`/`map`/`log` is noise, not context. */
const GENERIC_SYMBOLS = new Set([
	'get', 'set', 'map', 'filter', 'reduce', 'forEach', 'push', 'pop', 'shift',
	'slice', 'splice', 'join', 'split', 'log', 'error', 'warn', 'info', 'debug',
	'then', 'catch', 'finally', 'resolve', 'reject', 'toString', 'valueOf',
	'length', 'name', 'value', 'data', 'result', 'key', 'id', 'item', 'self',
	'this', 'super', 'constructor', 'call', 'apply', 'bind', 'has', 'add',
	'delete', 'keys', 'values', 'entries', 'size', 'test', 'exec', 'replace',
	'concat', 'indexOf', 'includes', 'find', 'some', 'every', 'sort', 'print',
]);

const MIN_SYMBOL_LEN = 3;
/** A symbol defined or referenced in more than this many chunks is treated as
 *  ambiguous/generic and excluded from neighbor expansion. */
const MAX_FANOUT = 40;

/** Chunks fed to `warmUp` between cooperative yields. */
const WARMUP_YIELD_EVERY = 2_000;

/** Exactly the symbol contributions one chunk added to the maps. */
interface ChunkContribution {
	defs?: string[];
	refs?: string[];
	lspDefs?: string[];
	lspRefs?: string[];
}

export class DependencyGraph {
	/** symbol → chunk ids that DEFINE it (text-derived, noise-filtered). */
	private _defs = new Map<string, Set<string>>();
	/** symbol → chunk ids that REFERENCE it (text-derived, noise-filtered). */
	private _refs = new Map<string, Set<string>>();
	/** symbol → chunk ids that DEFINE it per the LSP (no blocklist — verified). */
	private _lspDefs = new Map<string, Set<string>>();
	/** symbol → chunk ids that REFERENCE it per the LSP. */
	private _lspRefs = new Map<string, Set<string>>();
	/** chunk id → its recorded contributions (reverse index for exact removal). */
	private _byChunk = new Map<string, ChunkContribution>();
	/** symbol -> |defs union lspDefs|, maintained on every add/remove so the
	 *  MAX_FANOUT gate is an O(1) lookup at query time. */
	private _defUnion = new Map<string, number>();
	/** symbol -> |refs union lspRefs|. */
	private _refUnion = new Map<string, number>();
	private _dirty = true;

	markDirty(): void {
		this._dirty = true;
	}

	/** Rebuild the maps if anything changed since the last build. */
	ensure(chunks: Iterable<IndexedChunk>): void {
		if (!this._dirty) return;
		this._reset();
		this._dirty = false;
		for (const c of chunks) this._addChunk(c);
	}

	/**
	 * Cooperative-yield variant of the full rebuild, for the background path
	 * (cache load / rebuild completion). While it runs, `ensure()` sees a clean
	 * graph and serves PARTIAL results — acceptable for an augmentation-only
	 * signal, and strictly cheaper than stalling a retrieve on the sync rebuild.
	 * Aborts (leaving `_dirty` set) if invalidated mid-flight.
	 */
	async warmUp(chunks: Iterable<IndexedChunk>, yieldFn: () => Promise<void>): Promise<void> {
		if (!this._dirty) return;
		this._reset();
		this._dirty = false;
		let n = 0;
		for (const c of chunks) {
			this._addChunk(c);
			if (++n % WARMUP_YIELD_EVERY === 0) {
				await yieldFn();
				if (this._dirty) return; // invalidated mid-warm-up — rebuild pending
			}
		}
	}

	/**
	 * Incrementally (re)index the given chunks: prior contributions of the same
	 * chunk ids are removed first, so this is also the "chunk mutated in place"
	 * path (LSP enrichment). No-op while a full rebuild is pending — it will
	 * pick these chunks up anyway.
	 */
	updateChunks(chunks: Iterable<IndexedChunk>): void {
		if (this._dirty) return;
		for (const c of chunks) this._addChunk(c);
	}

	/** Incrementally remove chunks by id. No-op while a full rebuild is pending. */
	removeChunks(ids: Iterable<string>): void {
		if (this._dirty) return;
		for (const id of ids) this._removeChunk(id);
	}

	private _reset(): void {
		this._defs = new Map();
		this._refs = new Map();
		this._lspDefs = new Map();
		this._lspRefs = new Map();
		this._byChunk = new Map();
		this._defUnion = new Map();
		this._refUnion = new Map();
	}

	/** Add `id` under `sym` in `map`; bump the union counter unless the other
	 *  layer of the same side already counted this id. Returns false on dup. */
	private _add(map: Map<string, Set<string>>, other: Map<string, Set<string>>, union: Map<string, number>, sym: string, id: string): boolean {
		let set = map.get(sym);
		if (!set) { set = new Set(); map.set(sym, set); }
		if (set.has(id)) return false;
		set.add(id);
		if (!other.get(sym)?.has(id)) union.set(sym, (union.get(sym) ?? 0) + 1);
		return true;
	}

	private _removeOne(map: Map<string, Set<string>>, other: Map<string, Set<string>>, union: Map<string, number>, sym: string, id: string): void {
		const set = map.get(sym);
		if (!set || !set.delete(id)) return;
		if (set.size === 0) map.delete(sym);
		if (!other.get(sym)?.has(id)) {
			const n = (union.get(sym) ?? 1) - 1;
			if (n <= 0) union.delete(sym); else union.set(sym, n);
		}
	}

	private _addChunk(c: IndexedChunk): void {
		// Self-cleaning: drop any prior contribution of this id first, so re-adds
		// (chunk mutated in place; a warm-up iterator revisiting a chunk that an
		// interleaved updateChunks already applied) never corrupt the reverse
		// index. A no-op map miss when the id is new.
		this._removeChunk(c.id);
		const contrib: ChunkContribution = {};
		if (c.defines) {
			for (const d of c.defines) {
				if (d.length < MIN_SYMBOL_LEN || GENERIC_SYMBOLS.has(d)) continue;
				if (this._add(this._defs, this._lspDefs, this._defUnion, d, c.id)) (contrib.defs ??= []).push(d);
			}
		}
		if (c.refs) {
			for (const r of c.refs) {
				if (r.length < MIN_SYMBOL_LEN || GENERIC_SYMBOLS.has(r)) continue;
				if (this._add(this._refs, this._lspRefs, this._refUnion, r, c.id)) (contrib.refs ??= []).push(r);
			}
		}
		// LSP-verified edges bypass the noise filters — a real reference to a
		// short/generic name (`run`, `get`) is still a real edge.
		if (c.lspDefines) {
			for (const d of c.lspDefines) {
				if (d && this._add(this._lspDefs, this._defs, this._defUnion, d, c.id)) (contrib.lspDefs ??= []).push(d);
			}
		}
		if (c.lspRefs) {
			for (const r of c.lspRefs) {
				if (r && this._add(this._lspRefs, this._refs, this._refUnion, r, c.id)) (contrib.lspRefs ??= []).push(r);
			}
		}
		this._byChunk.set(c.id, contrib);
	}

	private _removeChunk(id: string): void {
		const contrib = this._byChunk.get(id);
		if (!contrib) return;
		this._byChunk.delete(id);
		if (contrib.defs) for (const d of contrib.defs) this._removeOne(this._defs, this._lspDefs, this._defUnion, d, id);
		if (contrib.lspDefs) for (const d of contrib.lspDefs) this._removeOne(this._lspDefs, this._defs, this._defUnion, d, id);
		if (contrib.refs) for (const r of contrib.refs) this._removeOne(this._refs, this._lspRefs, this._refUnion, r, id);
		if (contrib.lspRefs) for (const r of contrib.lspRefs) this._removeOne(this._lspRefs, this._refs, this._refUnion, r, id);
	}

	// -- Fan-out gate (query time) --
	// Over-ambiguous symbols create noisy, low-precision edges. Fan-out counts
	// the UNION of text + lsp contributors per side, and a symbol over budget is
	// invisible to both layers (LSP edges respect MAX_FANOUT even though they
	// skip the blocklist). Gating at read time instead of deleting at build time
	// is what makes incremental removal possible.

	private _defSet(sym: string): Set<string> | undefined {
		return (this._defUnion.get(sym) ?? 0) > MAX_FANOUT ? undefined : this._defs.get(sym);
	}
	private _refSet(sym: string): Set<string> | undefined {
		return (this._refUnion.get(sym) ?? 0) > MAX_FANOUT ? undefined : this._refs.get(sym);
	}
	private _lspDefSet(sym: string): Set<string> | undefined {
		return (this._defUnion.get(sym) ?? 0) > MAX_FANOUT ? undefined : this._lspDefs.get(sym);
	}
	private _lspRefSet(sym: string): Set<string> | undefined {
		return (this._refUnion.get(sym) ?? 0) > MAX_FANOUT ? undefined : this._lspRefs.get(sym);
	}

	/**
	 * How many chunks REFERENCE `symbol` (text-derived + LSP-verified layers).
	 * Cheap centrality signal: a file whose definitions are referenced all over
	 * the codebase should get quality vectors early in a backfill. Bounded by
	 * MAX_FANOUT per symbol (over-ambiguous symbols are gated out).
	 * Callers must run `ensure()` first.
	 */
	refCountOf(symbol: string): number {
		if ((this._refUnion.get(symbol) ?? 0) > MAX_FANOUT) return 0;
		return (this._refs.get(symbol)?.size ?? 0) + (this._lspRefs.get(symbol)?.size ?? 0);
	}

	private _defCountOf(symbol: string): number {
		const n = this._defUnion.get(symbol) ?? 0;
		return n > MAX_FANOUT ? 0 : n;
	}

	private _edgeWeight(symbol: string, isLsp: boolean, queryTokens: ReadonlySet<string>): number {
		let w = isLsp ? 1.0 : 0.5;
		if (queryTokens.has(symbol.toLowerCase())) { w *= 4; }
		if (this._defCountOf(symbol) >= 5) { w *= 0.1; }
		w /= Math.sqrt(Math.max(1, this.refCountOf(symbol)));
		return w;
	}

	/**
	 * One-hop score propagation from high-scoring seed chunks (Aider repo-map style).
	 * Neighbors reachable via LSP-verified edges score higher than text-guessed ones;
	 * edges through query-matching symbol names are boosted; ambiguous mega-symbols
	 * are damped.
	 */
	propagateFromSeeds(
		seeds: ReadonlyArray<{ id: string; score: number }>,
		chunkById: ReadonlyMap<string, IndexedChunk>,
		queryTokens: readonly string[],
		opts?: { alpha?: number; maxPerSeed?: number },
	): Map<string, number> {
		const alpha = opts?.alpha ?? 0.3;
		const maxPerSeed = opts?.maxPerSeed ?? 12;
		const qSet = new Set(queryTokens.map(t => t.toLowerCase()));
		const out = new Map<string, number>();
		const bump = (targetId: string, seedScore: number, edgeW: number) => {
			if (edgeW <= 0) { return; }
			const add = alpha * seedScore * edgeW;
			out.set(targetId, (out.get(targetId) ?? 0) + add);
		};
		const pushTargets = (
			symbol: string,
			isLsp: boolean,
			targets: ReadonlySet<string> | undefined,
			seedId: string,
			seedScore: number,
			seen: Set<string>,
		) => {
			if (!targets) { return; }
			const w = this._edgeWeight(symbol, isLsp, qSet);
			for (const tid of targets) {
				if (tid === seedId || seen.has(tid)) { continue; }
				seen.add(tid);
				bump(tid, seedScore, w);
				if (seen.size >= maxPerSeed) { return; }
			}
		};
		for (const seed of seeds) {
			const chunk = chunkById.get(seed.id);
			if (!chunk || seed.score <= 0) { continue; }
			const seen = new Set<string>();
			const allRefs = chunk.lspRefs ? (chunk.refs ? [...chunk.lspRefs, ...chunk.refs] : chunk.lspRefs) : chunk.refs;
			const allDefs = chunk.lspDefines ? (chunk.defines ? [...chunk.lspDefines, ...chunk.defines] : chunk.lspDefines) : chunk.defines;
			if (chunk.lspRefs) {
				for (const r of chunk.lspRefs) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(r, true, this._lspDefSet(r), seed.id, seed.score, seen);
				}
			}
			if (chunk.lspDefines && seen.size < maxPerSeed) {
				for (const d of chunk.lspDefines) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(d, true, this._lspRefSet(d), seed.id, seed.score, seen);
				}
			}
			if (allRefs && seen.size < maxPerSeed) {
				for (const r of allRefs) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(r, false, this._defSet(r), seed.id, seed.score, seen);
				}
			}
			if (allDefs && seen.size < maxPerSeed) {
				for (const d of allDefs) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(d, false, this._refSet(d), seed.id, seed.score, seen);
				}
			}
		}
		return out;
	}

	/**
	 * Neighbors of a chunk: the definitions of symbols it CALLS/USES (outbound —
	 * "underlying functions / interface types") plus chunks that CALL the symbols
	 * it defines (inbound — "callers"). Returns up to `max` unique chunk ids,
	 * excluding the chunk itself.
	 *
	 * Two-pass fill: pass 1 takes targets reachable via LSP-verified edges
	 * (real callers / real definitions), pass 2 tops up the remaining budget
	 * with text-derived edges. With no lsp data anywhere, pass 1 is a no-op and
	 * this behaves exactly as before.
	 */
	neighborsOf(chunk: IndexedChunk, max: number): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const collect = (ids: ReadonlySet<string> | undefined) => {
			if (!ids) return;
			for (const id of ids) {
				if (id === chunk.id || seen.has(id)) continue;
				seen.add(id);
				out.push(id);
				if (out.length >= max) return;
			}
		};
		const allRefs = chunk.lspRefs ? (chunk.refs ? [...chunk.lspRefs, ...chunk.refs] : chunk.lspRefs) : chunk.refs;
		const allDefs = chunk.lspDefines ? (chunk.defines ? [...chunk.lspDefines, ...chunk.defines] : chunk.lspDefines) : chunk.defines;

		// Pass 1 (LSP-preferred) — outbound: LSP-verified definitions of what
		// this chunk references; inbound: LSP-verified referencers of what it
		// defines.
		if (allRefs) {
			for (const r of allRefs) {
				if (out.length >= max) break;
				collect(this._lspDefSet(r));
			}
		}
		if (allDefs && out.length < max) {
			for (const d of allDefs) {
				if (out.length >= max) break;
				collect(this._lspRefSet(d));
			}
		}

		// Pass 2 (text) — the original fill, over the unioned symbol lists.
		if (allRefs && out.length < max) {
			for (const r of allRefs) {
				if (out.length >= max) break;
				collect(this._defSet(r));
			}
		}
		if (allDefs && out.length < max) {
			for (const d of allDefs) {
				if (out.length >= max) break;
				collect(this._refSet(d));
			}
		}
		return out;
	}

	/**
	 * Files connected to `fileChunks`' file via the graph, ranked by edge count.
	 * Powers proactive prefetch ("you edited A, warm B which A depends on").
	 *
	 * @param fileChunks  every chunk belonging to the source file
	 * @param idToFile    resolve a chunk id → its file path
	 * @param max         max related files to return
	 */
	relatedFiles(fileChunks: readonly IndexedChunk[], idToFile: (id: string) => string | undefined, max: number): string[] {
		if (fileChunks.length === 0) return [];
		const self = fileChunks[0].file;
		const score = new Map<string, number>();
		const bump = (ids: ReadonlySet<string> | undefined) => {
			if (!ids) return;
			for (const id of ids) {
				const f = idToFile(id);
				if (f && f !== self) score.set(f, (score.get(f) ?? 0) + 1);
			}
		};
		for (const c of fileChunks) {
			if (c.refs) for (const r of c.refs) bump(this._defSet(r));
			if (c.defines) for (const d of c.defines) bump(this._refSet(d));
			// LSP-verified edges count toward the ranking too (a file may double
			// its score for an edge confirmed by both layers — that is fine, the
			// edge is simply stronger evidence of relatedness).
			if (c.lspRefs) for (const r of c.lspRefs) { bump(this._defSet(r)); bump(this._lspDefSet(r)); }
			if (c.lspDefines) for (const d of c.lspDefines) { bump(this._refSet(d)); bump(this._lspRefSet(d)); }
		}
		return [...score.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, max)
			.map(e => e[0]);
	}
}
