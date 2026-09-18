/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * LSP edge enricher — upgrades the text-derived dependency graph with REAL
 * edges resolved by the language service.
 *
 * The tree-sitter graph (dependencyGraph.ts) guesses edges from node text and
 * openly documents a ~60-70% recall ceiling. This module walks the actual LSP:
 * for a file's top-level symbols it asks the ILspBridgeAdapter for document
 * symbols, then resolves references (and cross-file definitions) at each
 * symbol's position, and writes the results into per-chunk `lspDefines` /
 * `lspRefs` arrays. Those arrays carry the SAME plain-symbol-name semantics as
 * the text-derived `defines`/`refs`, so DependencyGraph._rebuild can union
 * them and `neighborsOf` can prefer them — no consumer changes needed.
 *
 * STRICT BUDGETS (the adapter itself has none — every call can resolve a text
 * model and wake a language server, so bulk walks must self-throttle):
 *   • only files surfaced by open-model / edit / retrieve() events are ever
 *     considered (callers enqueue candidates; nothing walks the workspace),
 *   • at most MAX_SYMBOLS_PER_FILE symbols per file per pass,
 *   • at most MAX_FILES_PER_CYCLE files per idle cycle,
 *   • one pass in flight at a time (single-flight),
 *   • a FILE_YIELD_MS timer between files,
 *   • total kill-switch: 'v3code.semanticIndex.lspGraphEdges'.
 *
 * Cold-server handling: a cold TS server returns an empty outline. Such files
 * become re-eligible after RETRY_COOLDOWN_MS; files that enriched successfully
 * are never re-attempted while their contentHash is unchanged.
 *
 * Hydration seeding: chunks restored from the CAS (branch-switch fast path) or
 * from persisted pages arrive WITH their lspDefines/lspRefs, but this state map
 * is session-local and would not know — so enqueue/pass consult the host's
 * hasOwnLspEdges() and seed `succeeded` for such files instead of redundantly
 * re-resolving edges the index already has.
 *
 * The pure planning/eligibility/mapping functions are exported for unit tests
 * (test/browser/lspGraphEdges.test.ts) — this module deliberately imports no
 * VS Code services.
 */

import { IndexedChunk } from './browserIndexTypes.js';

// -- Budgets --

/** Max top-level symbols resolved per file per pass. */
export const MAX_SYMBOLS_PER_FILE = 5;
/** Max files enriched per idle cycle. */
export const MAX_FILES_PER_CYCLE = 20;
/** Pause between files inside one pass, so the language service breathes. */
export const FILE_YIELD_MS = 250;
/** A file whose enrichment came back empty (cold server) may retry after this. */
export const RETRY_COOLDOWN_MS = 5 * 60_000;
/** Cap on lsp-derived refs per chunk — mirrors the chunker's maxRefsPerParent. */
export const MAX_LSP_REFS_PER_CHUNK = 24;
/** Cap on lsp-derived defines per chunk. */
export const MAX_LSP_DEFINES_PER_CHUNK = 16;
/** Reference locations examined per symbol — bounds hot symbols. */
export const MAX_REF_LOCATIONS_PER_SYMBOL = 100;
/** Candidate queue bound (most-recent kept). */
export const QUEUE_MAX = 200;
/** Idle delay before a scheduled pass starts. */
export const PASS_DELAY_MS = 1_000;

// -- Shapes (structural mirrors of the adapter's types; kept local so the pure
//    parts have zero service imports) --

export interface EnricherSymbol {
	name: string;
	/** 0-indexed (LSP convention — the adapter translates at its boundary). */
	line: number;
	/** 0-indexed. */
	character: number;
	containerName?: string;
}

export interface EnricherRefLocation {
	/** Workspace-relative POSIX path. */
	filePath: string;
	/** 0-indexed. */
	line: number;
}

export interface EnricherDefinition {
	name: string;
	filePath: string;
}

/** Everything resolved for one symbol — input to the pure edge application. */
export interface SymbolResolution {
	symbol: EnricherSymbol;
	refLocations: readonly EnricherRefLocation[];
	definition: EnricherDefinition | null;
}

export interface FileEnrichState {
	/** contentHash of the file at the last attempt. */
	contentHash: string;
	/** ms timestamp of the last attempt. */
	lastAttempt: number;
	/** True when the pass found symbols (⇒ never re-run while hash unchanged). */
	succeeded: boolean;
}

/** Host seam — the orchestrator adapts ILspBridgeAdapter + its chunk maps. */
export interface LspEdgeHost {
	/** Kill-switch: 'v3code.semanticIndex.lspGraphEdges' AND index enabled. */
	isEnabled(): boolean;
	getDocumentSymbols(file: string): Promise<EnricherSymbol[]>;
	getReferences(file: string, line: number, character: number): Promise<EnricherRefLocation[]>;
	getDefinition(file: string, line: number, character: number): Promise<EnricherDefinition | null>;
	/** LIVE chunk objects of an indexed file ([] when not indexed) — mutated in place. */
	chunksOf(file: string): IndexedChunk[];
	/** Current contentHash of the file (undefined ⇒ not indexed any more). */
	contentHashOf(file: string): string | undefined;
	/**
	 * Whether the file's CURRENT chunks already carry edges produced by its own
	 * enrichment pass (i.e. some chunk has lspDefines — lspRefs alone can be
	 * inbound writes from ANOTHER file's pass and do not count). True for files
	 * hydrated from the CAS / persisted pages that were enriched before.
	 */
	hasOwnLspEdges(file: string): boolean;
	/** Called once per pass with every file whose chunks gained lsp edges. */
	onEnriched(touchedFiles: ReadonlySet<string>): void;
	log?(message: string): void;
}

// -- Pure eligibility / budget logic (unit-tested standalone) --

/**
 * Whether a file may be enriched now.
 *   • never attempted → yes
 *   • content changed since last attempt → yes
 *   • unchanged + succeeded → never again
 *   • unchanged + failed/empty (cold server) → after RETRY_COOLDOWN_MS
 */
export function isFileEligible(state: FileEnrichState | undefined, currentHash: string | undefined, now: number): boolean {
	if (!currentHash) return false; // not indexed
	if (!state) return true;
	if (state.contentHash !== currentHash) return true;
	if (state.succeeded) return false;
	return now - state.lastAttempt >= RETRY_COOLDOWN_MS;
}

/**
 * Pick up to `maxFiles` eligible files from the queue, preserving queue order
 * (most recently touched candidates were pushed last; the queue owner decides
 * ordering — this just filters + caps).
 */
export function selectBatch(
	queue: readonly string[],
	stateOf: (file: string) => FileEnrichState | undefined,
	hashOf: (file: string) => string | undefined,
	now: number,
	maxFiles: number = MAX_FILES_PER_CYCLE,
): string[] {
	const out: string[] = [];
	for (const file of queue) {
		if (out.length >= maxFiles) break;
		if (isFileEligible(stateOf(file), hashOf(file), now)) out.push(file);
	}
	return out;
}

/** Top-level symbols only (no containerName), deduped by name, capped. */
export function pickTopLevelSymbols(symbols: readonly EnricherSymbol[], max: number = MAX_SYMBOLS_PER_FILE): EnricherSymbol[] {
	const seen = new Set<string>();
	const out: EnricherSymbol[] = [];
	for (const s of symbols) {
		if (out.length >= max) break;
		if (s.containerName) continue;
		if (!s.name || s.name === '<anonymous>' || seen.has(s.name)) continue;
		seen.add(s.name);
		out.push(s);
	}
	return out;
}

/**
 * Chunk containing a 0-indexed LSP line. Chunk lines are 1-indexed inclusive
 * (semanticIndexTypes.Chunk); prefers the SMALLEST containing span so a
 * reference inside a method maps to the method chunk, not the whole class.
 */
export function chunkAtLine(chunks: readonly IndexedChunk[], zeroBasedLine: number): IndexedChunk | undefined {
	const line = zeroBasedLine + 1;
	let best: IndexedChunk | undefined;
	for (const c of chunks) {
		if (c.startLine > line || c.endLine < line) continue;
		if (!best || (c.endLine - c.startLine) < (best.endLine - best.startLine)) best = c;
	}
	return best;
}

function addCapped(arr: string[] | undefined, sym: string, cap: number): string[] | undefined {
	if (!sym) return arr;
	if (!arr) return [sym];
	if (arr.length >= cap || arr.includes(sym)) return arr;
	arr.push(sym);
	return arr;
}

/**
 * Apply resolved symbol data as `lspDefines`/`lspRefs` mutations:
 *   • the defining chunk of `file` gains lspDefines: [symbol.name],
 *   • every chunk containing a reference location gains lspRefs: [symbol.name]
 *     (this is the INBOUND side — dependencyGraph maps refs → referencing
 *     chunk ids, so neighborsOf(defChunk) finds real callers),
 *   • a cross-file definition adds its name to the defining chunk's lspRefs
 *     (OUTBOUND — covers re-exports/aliases whose real definition lives
 *     elsewhere).
 * Mutates live chunks; returns the set of files whose chunks changed.
 */
export function applySymbolResolutions(
	file: string,
	chunksOf: (f: string) => readonly IndexedChunk[],
	resolutions: readonly SymbolResolution[],
): Set<string> {
	const touched = new Set<string>();
	const ownChunks = chunksOf(file);
	for (const res of resolutions) {
		const sym = res.symbol;
		const defChunk = chunkAtLine(ownChunks, sym.line);
		if (defChunk) {
			const before = defChunk.lspDefines?.length ?? 0;
			defChunk.lspDefines = addCapped(defChunk.lspDefines, sym.name, MAX_LSP_DEFINES_PER_CHUNK);
			if ((defChunk.lspDefines?.length ?? 0) !== before) touched.add(file);
		}
		// Outbound: the local symbol resolves to a definition in ANOTHER file
		// (re-export / alias) — edge from this chunk to the real definition.
		const def = res.definition;
		if (defChunk && def && def.filePath && def.filePath !== file) {
			const name = (def.name && def.name !== '<anonymous>') ? def.name : sym.name;
			const before = defChunk.lspRefs?.length ?? 0;
			defChunk.lspRefs = addCapped(defChunk.lspRefs, name, MAX_LSP_REFS_PER_CHUNK);
			if ((defChunk.lspRefs?.length ?? 0) !== before) touched.add(file);
		}
		// Inbound: chunks that REALLY reference this symbol.
		let taken = 0;
		for (const loc of res.refLocations) {
			if (taken >= MAX_REF_LOCATIONS_PER_SYMBOL) break;
			taken++;
			// Skip the definition site itself.
			if (defChunk && loc.filePath === file && loc.line + 1 >= defChunk.startLine && loc.line + 1 <= defChunk.endLine) continue;
			const refChunk = chunkAtLine(chunksOf(loc.filePath), loc.line);
			if (!refChunk || refChunk === defChunk) continue;
			const before = refChunk.lspRefs?.length ?? 0;
			refChunk.lspRefs = addCapped(refChunk.lspRefs, sym.name, MAX_LSP_REFS_PER_CHUNK);
			if ((refChunk.lspRefs?.length ?? 0) !== before) touched.add(loc.filePath);
		}
	}
	return touched;
}

// -- The background enrichment pass --

export class LspEdgeEnricher {
	private readonly _state = new Map<string, FileEnrichState>();
	/** Candidate files, oldest first; enqueue moves a file to the back. */
	private _queue: string[] = [];
	private _running = false;
	private _timer: ReturnType<typeof setTimeout> | null = null;
	private _disposed = false;

	constructor(
		private readonly host: LspEdgeHost,
		/** Injectable clock/sleep for tests. */
		private readonly now: () => number = () => Date.now(),
		private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
	) { }

	/** Visible for tests/diagnostics. */
	get pendingCount(): number { return this._queue.length; }

	/** Add candidate files (open models / recent edits / retrieve() hits). */
	enqueue(files: readonly string[]): void {
		if (this._disposed || files.length === 0 || !this.host.isEnabled()) return;
		for (const f of files) {
			const i = this._queue.indexOf(f);
			if (i >= 0) this._queue.splice(i, 1);
			if (this._alreadyEnriched(f)) continue;
			this._queue.push(f);
		}
		if (this._queue.length > QUEUE_MAX) this._queue.splice(0, this._queue.length - QUEUE_MAX);
		if (this._queue.length > 0) this._schedule();
	}

	/**
	 * True when no LSP work is needed for the file's current content: it is no
	 * longer indexed, this session already enriched it, or its chunks were
	 * hydrated (CAS branch-switch fast path / persisted pages) WITH their own
	 * lsp edges — in which case the session-local state map is seeded so the
	 * cross-branch fast path is never negated by redundant re-resolution.
	 */
	private _alreadyEnriched(file: string): boolean {
		const hash = this.host.contentHashOf(file);
		if (!hash) return true; // not indexed → nothing to enrich
		const st = this._state.get(file);
		// Unchanged content: succeeded ⇒ done; failed/empty ⇒ keep for the
		// cooldown retry (isFileEligible gates when it may actually run).
		if (st && st.contentHash === hash) return st.succeeded;
		if (this.host.hasOwnLspEdges(file)) {
			this._state.set(file, { contentHash: hash, lastAttempt: this.now(), succeeded: true });
			return true;
		}
		return false;
	}

	dispose(): void {
		this._disposed = true;
		if (this._timer) { clearTimeout(this._timer); this._timer = null; }
		this._queue = [];
	}

	private _schedule(): void {
		if (this._disposed || this._running || this._timer) return;
		this._timer = setTimeout(() => {
			this._timer = null;
			void this._runPass();
		}, PASS_DELAY_MS);
	}

	/** One budgeted pass. Single-flight; reschedules itself while work remains. */
	private async _runPass(): Promise<void> {
		if (this._disposed || this._running) return;
		this._running = true;
		try {
			if (!this.host.isEnabled()) { this._queue = []; return; }
			const startedAt = this.now();
			const batch = selectBatch(
				this._queue,
				f => this._state.get(f),
				f => this.host.contentHashOf(f),
				startedAt,
			);
			const batchSet = new Set(batch);
			// Drop processed candidates AND permanently-ineligible ones (already
			// succeeded on this content / no longer indexed) so the queue drains.
			this._queue = this._queue.filter(f => {
				if (batchSet.has(f)) return false;
				const hash = this.host.contentHashOf(f);
				if (!hash) return false;
				const st = this._state.get(f);
				return !(st && st.contentHash === hash && st.succeeded);
			});

			const touchedAll = new Set<string>();
			let enriched = 0;
			for (const file of batch) {
				if (this._disposed || !this.host.isEnabled()) break;
				const hash = this.host.contentHashOf(file);
				if (!hash) continue; // un-indexed since selection
				// A hydration may have restored this file's lsp edges AFTER it was
				// queued (branch switch hitting the CAS fast path) — seed + skip.
				if (this._alreadyEnriched(file)) continue;
				let succeeded = false;
				try {
					const symbols = await this.host.getDocumentSymbols(file);
					const top = pickTopLevelSymbols(symbols);
					succeeded = top.length > 0;
					if (succeeded) {
						const resolutions: SymbolResolution[] = [];
						for (const sym of top) {
							const [refLocations, definition] = await Promise.all([
								this.host.getReferences(file, sym.line, sym.character).catch(() => [] as EnricherRefLocation[]),
								this.host.getDefinition(file, sym.line, sym.character).catch(() => null),
							]);
							resolutions.push({ symbol: sym, refLocations, definition });
						}
						const touched = applySymbolResolutions(file, f => this.host.chunksOf(f), resolutions);
						for (const t of touched) touchedAll.add(t);
						if (touched.size > 0) enriched++;
					}
				} catch (err: any) {
					this.host.log?.(`[v3code-index] lsp-edge enrich failed for ${file}: ${err?.message ?? err}`);
				}
				this._state.set(file, { contentHash: hash, lastAttempt: this.now(), succeeded });
				await this.sleep(FILE_YIELD_MS);
			}
			if (touchedAll.size > 0) {
				this.host.log?.(`[v3code-index] lsp edges: enriched ${enriched} files (${touchedAll.size} files touched) in ${this.now() - startedAt}ms`);
				this.host.onEnriched(touchedAll);
			}
		} finally {
			this._running = false;
			if (!this._disposed && this._queue.length > 0) this._schedule();
		}
	}
}
