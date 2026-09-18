/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * GPU-accelerated embedding backend: Qwen3-Embedding-0.6B (GGUF, Q8_0) through
 * node-llama-cpp — the same engine that powers local FIM autocomplete. A real
 * transformer with last-token pooling (baked into the GGUF, no flags needed),
 * ~610MB on disk, fully Metal-offloaded on Apple Silicon.
 *
 * MAIN PROCESS ONLY (like the rest of this file's siblings that touch Node).
 * Self-contained on purpose: does its own cached dynamic import of
 * node-llama-cpp and its own idempotent download via createModelDownloader,
 * so `common/` never imports from `electron-main/`.
 *
 * Contract notes (verified against node-llama-cpp 3.18.1 + the GGUF header):
 *  - vectors come back UNNORMALIZED → we L2-normalize; quantizer.ts and all
 *    cosine math require unit length.
 *  - EOS is auto-appended by getEmbeddingFor (add_eos_token=true in the GGUF),
 *    which is exactly what Qwen3's last-token pooling needs.
 *  - queries (not documents) should carry the Qwen3 instruct prefix.
 *  - inputs longer than contextSize THROW → defensive char truncation.
 *
 * Throughput notes:
 *  - the native addon reads embeddings from sequence 0 only
 *    (llama_get_embeddings_seq(ctx, 0) in AddonContext.cpp), so multi-sequence
 *    batching inside ONE context is impossible without forking node-llama-cpp.
 *    Instead we run a POOL of contexts off the shared model weights and fan
 *    doc batches out across them.
 *  - batchSize defaults to min(contextSize, 512) tokens per GPU dispatch; we
 *    pass batchSize=contextSize so a whole chunk is a single dispatch.
 *  - queries get a small dedicated context so search stays responsive while a
 *    backfill batch is in flight on the doc pool.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const QWEN3_EMBED_MODEL = {
	/** Identity used for vector keying (CAS + manifest). Changing it invalidates vectors. */
	id: 'Qwen/Qwen3-Embedding-0.6B-GGUF@Q8_0',
	uri: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0',
	filename: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
	/** What node-llama-cpp's downloader actually writes for `uri` (hf_<org>_<file>.<quant>). */
	downloadedFilename: 'hf_Qwen_Qwen3-Embedding-0.6B.Q8_0.gguf',
	dim: 1024,
	approxBytes: 639_150_592,
} as const;

/** KV budget: upstream caps embed inputs at 8000 chars (~2000-2700 code tokens).
 * 3072 covers the admitted input while avoiding a 4096-token KV allocation. */
const CONTEXT_SIZE = 3072;
/** Queries are short (instruct prefix + search text) — a small dedicated context is plenty. */
const QUERY_CONTEXT_SIZE = 1536;
/** Hard char guard so a rogue caller can never exceed contextSize (throws in llama.cpp). */
const MAX_INPUT_CHARS = 11_000;

/** One doc context is intentional. A second 3072-token context buys background
 * throughput, not retrieval quality, while costing roughly another context's
 * worth of unified memory. Potion makes search available immediately and this
 * one lane upgrades it to Qwen in the background; query work has its own small
 * context below, so search never queues behind the backfill. */
const DOC_CONTEXT_COUNT = 1;

export type EmbedKind = 'doc' | 'query';

/** Query context is smaller (1536 tokens), so the query char guard is tighter. */
const MAX_QUERY_CHARS = 4_000;

/** Qwen3-Embedding docs: instruct-prefix the QUERY side only; documents embed raw. */
export function formatForQwen3Embedding(text: string, kind: EmbedKind): string {
	if (kind === 'query') {
		const t = text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
		return `Instruct: Given a code search query, retrieve the most relevant code passages\nQuery: ${t}`;
	}
	return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

/** In-place L2 normalization; zero vectors stay zero (cosine 0 — a neutral no-match). */
export function l2Normalize(vec: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < vec.length; i++) { sum += vec[i] * vec[i]; }
	if (sum <= 0) { return vec; }
	const inv = 1 / Math.sqrt(sum);
	for (let i = 0; i < vec.length; i++) { vec[i] *= inv; }
	return vec;
}

/**
 * Resolve the GGUF's on-disk path: the declared canonical filename OR the name
 * node-llama-cpp's downloader actually writes. Checking only the canonical name
 * silently disabled the quality path forever on any machine whose model came in
 * via the downloader — 'auto' fell back to the static embedder with the 610MB
 * model sitting right there on disk.
 */
export function resolveQwen3EmbedModelPath(cacheDir: string): string | null {
	for (const name of [QWEN3_EMBED_MODEL.filename, QWEN3_EMBED_MODEL.downloadedFilename]) {
		const p = join(cacheDir, name);
		if (existsSync(p)) { return p; }
	}
	return null;
}

/** Is the GGUF already on disk (under either name)? Gates the zero-surprise 'auto' path. */
export function qwen3EmbedModelPresent(cacheDir: string): boolean {
	return resolveQwen3EmbedModelPath(cacheDir) !== null;
}

// Cached like electron-main/localInference/llamaLoader.ts — one llama env per process.
let _llamaLib: Promise<any> | null = null;
function loadNodeLlama(): Promise<any> {
	if (!_llamaLib) {
		_llamaLib = import('node-llama-cpp' as any).catch(err => { _llamaLib = null; throw err; });
	}
	return _llamaLib;
}

export class LlamaEmbedder {
	/** Doc-embedding context pool — weights shared via the one model; each context only adds KV. */
	private _docCtxs: any[] = [];
	/** Dedicated small context for queries so search never waits behind a doc backfill batch. */
	private _queryCtx: any = null;
	private _model: any = null;
	private _ready = false;
	/** Serializes doc batches so two concurrent embed('doc') calls don't interleave on the pool. */
	private _docLane: Promise<unknown> = Promise.resolve();
	/** Serializes queries among themselves (they're rare and short). */
	private _queryLane: Promise<unknown> = Promise.resolve();

	get isReady(): boolean { return this._ready; }
	get dim(): number { return QWEN3_EMBED_MODEL.dim; }
	get modelId(): string { return QWEN3_EMBED_MODEL.id; }

	/**
	 * Loads (and if `allowDownload`, first downloads) the GGUF. Download is
	 * idempotent + resumable (node-llama-cpp's own downloader). Throws on failure —
	 * the caller (Embedder.doInit) treats that as "fall back to potion".
	 */
	async init(cacheDir: string, opts?: { allowDownload?: boolean; onProgress?: (downloaded: number, total: number) => void }): Promise<void> {
		if (this._ready) { return; }
		const nlc = await loadNodeLlama();

		let modelPath = resolveQwen3EmbedModelPath(cacheDir);
		if (!modelPath) {
			if (!opts?.allowDownload) {
				throw new Error(`Qwen3 embedding model not downloaded (${QWEN3_EMBED_MODEL.filename})`);
			}
			const downloader = await nlc.createModelDownloader({
				modelUri: QWEN3_EMBED_MODEL.uri,
				dirPath: cacheDir,
				onProgress: opts.onProgress
					? ({ downloadedSize, totalSize }: { downloadedSize: number; totalSize: number }) => opts.onProgress!(downloadedSize, totalSize)
					: undefined,
			});
			modelPath = await downloader.download();
		}

		const llama = await nlc.getLlama(); // gpu: 'auto' → Metal on Apple Silicon
		this._model = await llama.loadModel({ modelPath, gpuLayers: 'auto' });
		// contextSize MUST be explicit: 'auto' sizes toward the 32k train context (~3.5GB KV).
		// batchSize MUST be explicit too: the default is min(contextSize, 512) tokens per
		// GPU dispatch, which costs a long chunk up to 6-8 sequential decode calls.
		// batchSize=contextSize makes any chunk a single dispatch.
		const docCtxPromises: Promise<any>[] = [];
		for (let i = 0; i < DOC_CONTEXT_COUNT; i++) {
			docCtxPromises.push(this._model.createEmbeddingContext({ contextSize: CONTEXT_SIZE, batchSize: CONTEXT_SIZE }));
		}
		this._docCtxs = await Promise.all(docCtxPromises);
		try {
			this._queryCtx = await this._model.createEmbeddingContext({ contextSize: QUERY_CONTEXT_SIZE, batchSize: QUERY_CONTEXT_SIZE });
		} catch (err: any) {
			// Query context is an optimization, not a requirement — fall back to the doc pool.
			console.warn('[v3code-embedder] query context creation failed, queries will share the doc pool:', err?.message ?? err);
			this._queryCtx = null;
		}
		this._ready = true;
	}

	private async _embedOne(ctx: any, formatted: string): Promise<Float32Array> {
		try {
			const e = await ctx.getEmbeddingFor(formatted);
			return l2Normalize(Float32Array.from(e.vector));
		} catch (err: any) {
			// One bad text must not sink a 512-chunk batch: a zero vector scores
			// cosine 0 everywhere (never retrieved), and lexical still covers it.
			console.warn('[v3code-embedder] qwen3 embed failed for one text:', err?.message ?? err);
			return new Float32Array(QWEN3_EMBED_MODEL.dim);
		}
	}

	async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
		if (!this._ready || this._docCtxs.length === 0) { throw new Error('LlamaEmbedder not initialized'); }

		// Queries take the dedicated fast lane — they never queue behind a doc batch.
		if (kind === 'query' && this._queryCtx) {
			const qctx = this._queryCtx;
			const run = this._queryLane.then(async () => {
				const out: Float32Array[] = [];
				for (const text of texts) {
					out.push(await this._embedOne(qctx, formatForQwen3Embedding(text, kind)));
				}
				return out;
			});
			this._queryLane = run.catch(() => { });
			return run;
		}

		// Docs fan out across the context pool: a shared cursor + one worker per
		// context. Order is preserved by writing results at their input index.
		const ctxs = this._docCtxs;
		const run = this._docLane.then(async () => {
			const out: Float32Array[] = new Array(texts.length);
			let cursor = 0;
			const worker = async (ctx: any) => {
				while (true) {
					const i = cursor++;
					if (i >= texts.length) { return; }
					out[i] = await this._embedOne(ctx, formatForQwen3Embedding(texts[i], kind));
				}
			};
			await Promise.all(ctxs.map(ctx => worker(ctx)));
			return out;
		});
		this._docLane = run.catch(() => { });
		return run;
	}

	async dispose(): Promise<void> {
		this._ready = false;
		for (const ctx of this._docCtxs) {
			try { await ctx?.dispose?.(); } catch { /* already gone */ }
		}
		this._docCtxs = [];
		try { await this._queryCtx?.dispose?.(); } catch { /* already gone */ }
		this._queryCtx = null;
		try { await this._model?.dispose?.(); } catch { /* already gone */ }
		this._model = null;
	}
}
