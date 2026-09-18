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
 * Maps are rebuilt lazily: callers `markDirty()` on any chunk mutation and the
 * next `ensure()` (typically inside a retrieve) does an O(chunks) rebuild.
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

export class DependencyGraph {
	/** symbol → chunk ids that DEFINE it (text-derived, noise-filtered). */
	private _defs = new Map<string, Set<string>>();
	/** symbol → chunk ids that REFERENCE it (text-derived, noise-filtered). */
	private _refs = new Map<string, Set<string>>();
	/** symbol → chunk ids that DEFINE it per the LSP (no blocklist — verified). */
	private _lspDefs = new Map<string, Set<string>>();
	/** symbol → chunk ids that REFERENCE it per the LSP. */
	private _lspRefs = new Map<string, Set<string>>();
	private _dirty = true;

	markDirty(): void {
		this._dirty = true;
	}

	/** Rebuild the maps if anything changed since the last build. */
	ensure(chunks: Iterable<IndexedChunk>): void {
		if (!this._dirty) return;
		this._rebuild(chunks);
	}

	private _rebuild(chunks: Iterable<IndexedChunk>): void {
		const defs = new Map<string, Set<string>>();
		const refs = new Map<string, Set<string>>();
		const lspDefs = new Map<string, Set<string>>();
		const lspRefs = new Map<string, Set<string>>();
		const addRaw = (map: Map<string, Set<string>>, sym: string, id: string) => {
			let set = map.get(sym);
			if (!set) { set = new Set(); map.set(sym, set); }
			set.add(id);
		};
		const add = (map: Map<string, Set<string>>, sym: string, id: string) => {
			if (sym.length < MIN_SYMBOL_LEN || GENERIC_SYMBOLS.has(sym)) return;
			addRaw(map, sym, id);
		};
		for (const c of chunks) {
			if (c.defines) for (const d of c.defines) add(defs, d, c.id);
			if (c.refs) for (const r of c.refs) add(refs, r, c.id);
			// LSP-verified edges bypass the noise filters — a real reference to a
			// short/generic name (`run`, `get`) is still a real edge.
			if (c.lspDefines) for (const d of c.lspDefines) if (d) addRaw(lspDefs, d, c.id);
			if (c.lspRefs) for (const r of c.lspRefs) if (r) addRaw(lspRefs, r, c.id);
		}
		// Drop over-ambiguous symbols — they create noisy, low-precision edges.
		// Fan-out counts the UNION of text + lsp contributors per side, and a
		// symbol over budget is dropped from both layers (LSP edges respect
		// MAX_FANOUT even though they skip the blocklist).
		const unionSize = (a: Set<string> | undefined, b: Set<string> | undefined): number => {
			if (!a) return b?.size ?? 0;
			if (!b) return a.size;
			let n = a.size;
			for (const id of b) if (!a.has(id)) n++;
			return n;
		};
		for (const sym of new Set([...defs.keys(), ...lspDefs.keys()])) {
			if (unionSize(defs.get(sym), lspDefs.get(sym)) > MAX_FANOUT) { defs.delete(sym); lspDefs.delete(sym); }
		}
		for (const sym of new Set([...refs.keys(), ...lspRefs.keys()])) {
			if (unionSize(refs.get(sym), lspRefs.get(sym)) > MAX_FANOUT) { refs.delete(sym); lspRefs.delete(sym); }
		}
		this._defs = defs;
		this._refs = refs;
		this._lspDefs = lspDefs;
		this._lspRefs = lspRefs;
		this._dirty = false;
	}

	/**
	 * How many chunks REFERENCE `symbol` (text-derived + LSP-verified layers).
	 * Cheap centrality signal: a file whose definitions are referenced all over
	 * the codebase should get quality vectors early in a backfill. Bounded by
	 * MAX_FANOUT per symbol (over-ambiguous symbols were dropped at build time).
	 * Callers must run `ensure()` first.
	 */
	refCountOf(symbol: string): number {
		return (this._refs.get(symbol)?.size ?? 0) + (this._lspRefs.get(symbol)?.size ?? 0);
	}

	private _defCountOf(symbol: string): number {
		const a = this._defs.get(symbol);
		const b = this._lspDefs.get(symbol);
		if (!a) { return b?.size ?? 0; }
		if (!b) { return a.size; }
		let n = a.size;
		for (const id of b) if (!a.has(id)) { n++; }
		return n;
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
			targetMap: Map<string, Set<string>> | undefined,
			seedId: string,
			seedScore: number,
			seen: Set<string>,
		) => {
			if (!targetMap) { return; }
			const w = this._edgeWeight(symbol, isLsp, qSet);
			for (const tid of targetMap.get(symbol) ?? []) {
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
					pushTargets(r, true, this._lspDefs, seed.id, seed.score, seen);
				}
			}
			if (chunk.lspDefines && seen.size < maxPerSeed) {
				for (const d of chunk.lspDefines) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(d, true, this._lspRefs, seed.id, seed.score, seen);
				}
			}
			if (allRefs && seen.size < maxPerSeed) {
				for (const r of allRefs) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(r, false, this._defs, seed.id, seed.score, seen);
				}
			}
			if (allDefs && seen.size < maxPerSeed) {
				for (const d of allDefs) {
					if (seen.size >= maxPerSeed) { break; }
					pushTargets(d, false, this._refs, seed.id, seed.score, seen);
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
		const collect = (ids: Set<string> | undefined) => {
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
				collect(this._lspDefs.get(r));
			}
		}
		if (allDefs && out.length < max) {
			for (const d of allDefs) {
				if (out.length >= max) break;
				collect(this._lspRefs.get(d));
			}
		}

		// Pass 2 (text) — the original fill, over the unioned symbol lists.
		if (allRefs && out.length < max) {
			for (const r of allRefs) {
				if (out.length >= max) break;
				collect(this._defs.get(r));
			}
		}
		if (allDefs && out.length < max) {
			for (const d of allDefs) {
				if (out.length >= max) break;
				collect(this._refs.get(d));
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
		const bump = (ids: Set<string> | undefined) => {
			if (!ids) return;
			for (const id of ids) {
				const f = idToFile(id);
				if (f && f !== self) score.set(f, (score.get(f) ?? 0) + 1);
			}
		};
		for (const c of fileChunks) {
			if (c.refs) for (const r of c.refs) bump(this._defs.get(r));
			if (c.defines) for (const d of c.defines) bump(this._refs.get(d));
			// LSP-verified edges count toward the ranking too (a file may double
			// its score for an edge confirmed by both layers — that is fine, the
			// edge is simply stronger evidence of relatedness).
			if (c.lspRefs) for (const r of c.lspRefs) { bump(this._defs.get(r)); bump(this._lspDefs.get(r)); }
			if (c.lspDefines) for (const d of c.lspDefines) { bump(this._refs.get(d)); bump(this._lspRefs.get(d)); }
		}
		return [...score.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, max)
			.map(e => e[0]);
	}
}
