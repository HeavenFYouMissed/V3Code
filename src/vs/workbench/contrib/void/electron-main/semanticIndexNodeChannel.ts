/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Main-process IPC channel hosting the ENGINE of the (dormant) Node semantic
 * index: SQLite FTS5 + sqlite-vec storage (common/semanticIndex/database.ts),
 * query expansion (queryExpander.ts) and 4-channel RRF retrieval (retriever.ts).
 *
 * Registered in app.ts as `void-channel-semanticIndexNode`; the renderer talks
 * to it via browser/semanticIndexNodeProxy.ts, gated behind the
 * `v3code.semanticIndex.nodeBackend` feature flag. Mirrors MemoryChannel:
 * command-string dispatch, lazy Map<dbPath, Promise<Engine>> cache with
 * retry-on-open-failure, dbPath carried in every call, a 'dispose' command,
 * and listen() throws (no events — the renderer polls 'status').
 *
 * ORCHESTRATION (workspace walk, file watching, chunking, status UI) stays in
 * the renderer (semanticIndexBrowserImpl.ts); this channel only owns the
 * engine. Chunks arrive pre-chunked over 'upsertChunks' and are embedded here
 * by an Embedder OWNED BY THIS CHANNEL (same hint resolution as
 * SemanticEmbedChannel — the `modelHint` arrives in 'open').
 *
 * Degradation ladder (never blocks indexing):
 *   sqlite-vec missing → FTS5-only storage + retrieval (database.ts soft-probe)
 *   embedder init fails → chunks still indexed for FTS; vector channels skipped
 *   expander fails      → heuristic identifier extraction
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { SemanticIndexDatabase } from '../common/semanticIndex/database.js';
import { Embedder, EmbedderOptions, EmbedModelHint } from '../common/semanticIndex/embedder.js';
import { Retriever } from '../common/semanticIndex/retriever.js';
import { createQueryExpander, expansionCacheKey, QueryExpanderApi } from '../common/semanticIndex/queryExpander.js';
import { languageFromExtension } from '../common/semanticIndex/chunkerLanguages.js';
import { Chunk, Hit, QueryExpansion } from '../common/semanticIndex/semanticIndexTypes.js';
import { contentHash } from '../common/semanticIndex/hashing.js';
import { effectiveEmbedIdentity } from '../common/semanticIndex/embedIdentity.js';
import {
	NodeIndexOpenParams, NodeIndexOpenResult, NodeIndexUpsertParams, NodeIndexRemoveFileParams,
	NodeIndexRetrieveParams, NodeIndexStatusParams, NodeIndexStatusResult, NodeIndexDisposeParams,
	isValidNodeChunkInput, capEmbedText,
} from '../common/semanticIndex/semanticIndexNodeIpc.js';

const EXPANSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on a single retrieve(), INCLUDING query expansion — a locked
 *  DB, or a 'local-llama' expander cold-loading its GGUF model / grinding
 *  through CPU inference, must produce a clean error, not a hung agent turn.
 *  (The legacy service ran expansion outside its timeout; that was a bug.) */
const RETRIEVE_TIMEOUT_MS = 15_000;

interface Engine {
	db: SemanticIndexDatabase;
}

export class SemanticIndexNodeChannel implements IServerChannel {

	private readonly engines = new Map<string, Promise<Engine>>();

	// -- channel-owned embedder (same swap-on-hint-change logic as SemanticEmbedChannel) --
	private embedder: Embedder | null = null;
	private embedderInit: Promise<void> | null = null;
	private currentHint: string | undefined = undefined;

	// -- query expanders, cached per mode (local-llama holds native memory) --
	private readonly expanders = new Map<string, QueryExpanderApi>();

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`SemanticIndexNodeChannel has no events. Requested: ${event}`);
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		try {
			return await this._dispatch(command, params);
		} catch (e) {
			console.error(`[SemanticIndexNodeChannel] "${command}" error:`, e);
			throw e;
		}
	}

	private async _dispatch(command: string, params: any): Promise<any> {
		// Commands that don't need an open engine.
		if (command === 'dispose') return this._dispose(params as NodeIndexDisposeParams | undefined);
		if (command === 'open') return this._open(params as NodeIndexOpenParams);

		const { dbPath } = (params ?? {}) as { dbPath?: string };
		if (!dbPath) throw new Error(`SemanticIndexNodeChannel: "${command}" requires dbPath`);
		const engine = await this._getEngine(dbPath);

		switch (command) {
			case 'upsertChunks':
				return this._upsertChunks(engine, params as NodeIndexUpsertParams);
			case 'removeFile':
				return engine.db.deleteByFile((params as NodeIndexRemoveFileParams).file);
			case 'retrieve':
				return this._retrieve(engine, params as NodeIndexRetrieveParams);
			case 'status':
				return this._status(engine, params as NodeIndexStatusParams);
			default:
				throw new Error(`SemanticIndexNodeChannel: command "${command}" not recognized.`);
		}
	}

	// ---- engine lifecycle ----

	private _getEngine(dbPath: string): Promise<Engine> {
		const p = this.engines.get(dbPath);
		if (!p) {
			// Unlike MemoryChannel, an engine open needs model identity/dim, so a
			// fully lazy open can't guess — the renderer must call 'open' first.
			throw new Error(`SemanticIndexNodeChannel: "${dbPath}" is not open — call 'open' first.`);
		}
		return p;
	}

	private async _open(params: NodeIndexOpenParams): Promise<NodeIndexOpenResult> {
		const { dbPath } = params ?? {};
		if (!dbPath) throw new Error(`SemanticIndexNodeChannel: "open" requires dbPath`);

		// (Re)configure the channel embedder from the hint, then await it so the
		// DB is keyed to the AUTHORITATIVE model identity. If the embedder fails
		// we fall back to the renderer-supplied identity (or lexical-only) — the
		// DB still serves FTS5.
		this._ensureEmbedder(params.modelHint, params.mirrorHost);
		const embedderReady = await this._embedderReady();
		// Key the DB to the EFFECTIVE identity (model + embed-text scheme,
		// embedIdentity.ts) — database.ts wipes vec+fts+chunks on mismatch, which
		// re-embeds pre-header rows on the next mirror. The renderer already sends
		// a salted id in params; effectiveEmbedIdentity is idempotent either way.
		const modelId = embedderReady ? effectiveEmbedIdentity(this.embedder!.modelId) : (params.modelId || 'lexical-only');
		const dim = embedderReady ? this.embedder!.dim : (params.dim > 0 ? params.dim : 0);

		let p = this.engines.get(dbPath);
		if (p) {
			// Re-open with a different model identity → recreate so database.ts's
			// model-mismatch wipe (applyVecTable) runs against fresh state.
			let existing: Engine | null = null;
			try { existing = await p; } catch { existing = null; }
			if (existing && (existing.db.model !== modelId || existing.db.dim !== dim)) {
				this.engines.delete(dbPath);
				try { await existing.db.close(); } catch { /* noop */ }
				p = undefined;
			} else if (!existing) {
				this.engines.delete(dbPath);
				p = undefined;
			}
		}
		if (!p) {
			p = (async (): Promise<Engine> => {
				await fs.mkdir(dirname(dbPath), { recursive: true });
				const db = new SemanticIndexDatabase();
				await db.open({ dbPath, embeddingDim: dim, modelId });
				try { await db.pruneExpiredExpansions(EXPANSION_CACHE_TTL_MS); } catch { /* noop */ }
				return { db };
			})();
			this.engines.set(dbPath, p);
			// On open failure, drop the cached promise so a later call can retry.
			p.catch(() => this.engines.delete(dbPath));
		}
		const engine = await p;
		return {
			hasVec: engine.db.hasVec,
			embedderReady,
			modelId,
			dim,
			files: await engine.db.countFiles(),
			chunks: await engine.db.countChunks(),
		};
	}

	private async _dispose(params?: NodeIndexDisposeParams): Promise<void> {
		if (params?.dbPath) {
			const p = this.engines.get(params.dbPath);
			if (p) {
				this.engines.delete(params.dbPath);
				try { (await p).db.close(); } catch { /* noop */ }
			}
			return;
		}
		const all = [...this.engines.values()];
		this.engines.clear();
		await Promise.all(all.map(async p => {
			try { (await p).db.close(); } catch { /* noop */ }
		}));
		for (const ex of this.expanders.values()) {
			try { ex.dispose?.(); } catch { /* noop */ }
		}
		this.expanders.clear();
		this.embedder?.dispose();
		this.embedder = null;
		this.embedderInit = null;
		this.currentHint = undefined;
	}

	// ---- embedder (owned here; mirrors SemanticEmbedChannel._callInit) ----

	private _ensureEmbedder(modelHint?: string, mirrorHost?: string): void {
		const hintChanged = modelHint !== undefined && modelHint !== this.currentHint;
		if (this.embedder && !hintChanged) return;
		if (this.embedder && hintChanged) {
			this.embedder.dispose();
			this.embedder = null;
			this.embedderInit = null;
		}
		const opts: EmbedderOptions = {};
		if (modelHint) opts.modelHint = modelHint as EmbedModelHint;
		if (mirrorHost) opts.mirrorHost = mirrorHost;
		// Default cacheDir inside Embedder is ~/.v3code/models — same store the
		// SemanticEmbedChannel embedder uses, so model files are shared on disk.
		this.currentHint = modelHint;
		this.embedder = new Embedder(opts);
		this.embedderInit = this.embedder.init();
		this.embedderInit.catch(() => { /* surfaced via _embedderReady */ });
	}

	private async _embedderReady(): Promise<boolean> {
		if (!this.embedder || !this.embedderInit) return false;
		try { await this.embedderInit; } catch { return false; }
		return this.embedder.isReady;
	}

	// ---- upsert ----

	private async _upsertChunks(engine: Engine, params: NodeIndexUpsertParams): Promise<{ upserted: number; skipped: number }> {
		const inputs = (params.chunks ?? []).filter(isValidNodeChunkInput);
		if (inputs.length === 0) return { upserted: 0, skipped: 0 };

		// Embed here, main-side, with the channel-owned embedder. Vectors are only
		// written when sqlite-vec loaded AND the embedder's dim matches the table —
		// otherwise the batch still lands in FTS5 (graceful FTS-only degradation).
		let vecs: (Float32Array | null)[] | null = null;
		if (engine.db.hasVec && await this._embedderReady() && this.embedder!.dim === engine.db.dim) {
			try {
				// `embedText` (contextual header + content) feeds the VECTOR only;
				// FTS + stored chunk_text below keep the raw `text`.
				vecs = await this.embedder!.embed(inputs.map(c => capEmbedText(c.embedText || c.text || c.name)));
			} catch (e) {
				console.warn('[SemanticIndexNodeChannel] embed failed, indexing batch FTS-only:', (e as Error)?.message ?? e);
				vecs = null;
			}
		}

		let upserted = 0;
		let skipped = 0;
		for (let i = 0; i < inputs.length; i++) {
			const c = inputs[i];
			const chunk: Chunk = {
				id: c.id,
				file: c.file,
				startLine: c.startLine,
				endLine: c.endLine,
				kind: 'block',
				name: c.name,
				language: languageFromExtension(c.file) ?? '',
				contentHash: contentHash(c.text),
			};
			const res = await engine.db.upsertChunk(chunk, c.text, vecs?.[i] ?? null);
			if (res.skipped) skipped++; else upserted++;
		}
		return { upserted, skipped };
	}

	// ---- retrieval ----

	private async _retrieve(engine: Engine, params: NodeIndexRetrieveParams): Promise<Hit[]> {
		const prompt = (params.prompt ?? '').trim();
		if (!prompt) return [];
		const topK = params.topK ?? 30;

		const run = async (): Promise<Hit[]> => {
			// Expansion runs INSIDE the timeout race: 'local-llama' can cold-load
			// a GGUF model and do up-to-256-token CPU inference per uncached
			// prompt, which must count against the retrieve budget. If the race
			// times out mid-expand, the orphaned expand still settles and warms
			// the 24h cache for the next call.
			const expansion = await this._expand(engine, prompt, params.expanderMode ?? 'heuristic');
			if (engine.db.hasVec && await this._embedderReady() && this.embedder!.dim === engine.db.dim) {
				try {
					return await new Retriever(engine.db, this.embedder!).retrieve(expansion, { topK });
				} catch (e) {
					console.warn('[SemanticIndexNodeChannel] vector retrieve failed, falling back to FTS-only:', (e as Error)?.message ?? e);
				}
			}
			return this._ftsOnlyRetrieve(engine.db, expansion, topK);
		};

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<Hit[]>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error(`[semantic-index-node] retrieve timed out after ${RETRIEVE_TIMEOUT_MS}ms`)),
				RETRIEVE_TIMEOUT_MS,
			);
		});
		try {
			return await Promise.race([run(), timeout]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	/** FTS5/BM25-only ranking used when vectors are unavailable — mirrors the
	 *  retriever's hydration so hit shape stays identical. */
	private async _ftsOnlyRetrieve(db: SemanticIndexDatabase, expansion: QueryExpansion, topK: number): Promise<Hit[]> {
		const query = [expansion.original, ...expansion.alternatives].filter(Boolean).join(' ');
		const rows = await db.queryByFts(query || expansion.original, Math.max(topK * 2, 60));
		const top = rows.slice(0, topK);
		if (top.length === 0) return [];
		const ids = top.map(r => r.id);
		const [chunkMap, contentMap] = await Promise.all([db.getChunks(ids), db.getContents(ids)]);
		const hits: Hit[] = [];
		for (let i = 0; i < top.length; i++) {
			const chunk = chunkMap.get(top[i].id);
			const content = contentMap.get(top[i].id);
			if (!chunk || content === undefined) continue;
			// RRF-style score so downstream sorting semantics (higher = better) hold.
			hits.push({ chunk, content, score: 1 / (60 + i + 1), signals: { fts: i + 1 } });
		}
		return hits;
	}

	private async _expand(engine: Engine, prompt: string, mode: 'heuristic' | 'local-llama' | 'chat-model'): Promise<QueryExpansion> {
		const cacheKey = expansionCacheKey(prompt);
		try {
			const cached = await engine.db.getCachedExpansion(cacheKey, EXPANSION_CACHE_TTL_MS);
			if (cached) return JSON.parse(cached) as QueryExpansion;
		} catch { /* cache is best-effort */ }

		// 'chat-model' needs a renderer-side ISendLLMMessage closure that doesn't
		// exist in main — createQueryExpander already falls through to heuristic
		// when the callback is absent, so the mode degrades safely.
		const expander = this._getExpander(mode);
		let expansion: QueryExpansion;
		try {
			expansion = await expander.expand(prompt);
		} catch {
			// local-llama model missing / native load failure → heuristic.
			expansion = await this._getExpander('heuristic').expand(prompt);
		}
		try { await engine.db.putCachedExpansion(cacheKey, JSON.stringify(expansion)); } catch { /* noop */ }
		return expansion;
	}

	private _getExpander(mode: string): QueryExpanderApi {
		let ex = this.expanders.get(mode);
		if (!ex) {
			ex = createQueryExpander({
				mode: mode === 'local-llama' ? 'local-llama' : mode === 'chat-model' ? 'chat-model' : 'heuristic',
				llama: mode === 'local-llama'
					? { modelPath: join(homedir(), '.v3code', 'models', 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf') }
					: undefined,
			});
			this.expanders.set(mode, ex);
		}
		return ex;
	}

	// ---- status ----

	private async _status(engine: Engine, _params: NodeIndexStatusParams): Promise<NodeIndexStatusResult> {
		return {
			files: await engine.db.countFiles(),
			chunks: await engine.db.countChunks(),
			hasVec: engine.db.hasVec,
			embedderReady: this.embedder?.isReady ?? false,
			modelId: engine.db.model,
			dim: engine.db.dim,
		};
	}
}
