/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Registered in app.ts — mirrors sendLLMMessageChannel.ts pattern.
// Runs the @xenova/transformers embedder in the main (Node) process so the
// renderer can request vector embeddings over IPC without importing Node builtins.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Embedder, EmbedderOptions } from '../common/semanticIndex/embedder.js';
import { LlamaReranker, qwen3RerankModelPresent } from '../common/semanticIndex/llamaReranker.js';

export class SemanticEmbedChannel implements IServerChannel {

	private embedder: Embedder | null = null;
	private initPromise: Promise<void> | null = null;
	/** Hint the live embedder was built with — a different hint on 'init' triggers a swap. */
	private currentHint: string | undefined = undefined;

	listen(_: unknown, _event: string): Event<any> {
		throw new Error(`SemanticEmbedChannel has no events. Requested: ${_event}`);
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		try {
			if (command === 'init') {
				return await this._callInit(params);
			} else if (command === 'embed') {
				return await this._callEmbed(params);
			} else if (command === 'embedStatic') {
				return await this._callEmbedStatic(params);
			} else if (command === 'getModelInfo') {
				return this._callGetModelInfo();
			} else if (command === 'rerank') {
				return await this._callRerank(params);
			} else if (command === 'getRerankInfo') {
				return this._callGetRerankInfo();
			} else if (command === 'dispose') {
				return this._callDispose();
			} else {
				throw new Error(`SemanticEmbedChannel: command "${command}" not recognized.`);
			}
		} catch (e) {
			console.error('[SemanticEmbedChannel] call error:', e);
			throw e;
		}
	}

	private async _callInit(params?: { modelHint?: string; cacheDir?: string; mirrorHost?: string }): Promise<void> {
		// Re-init with a DIFFERENT hint = live model swap (the settings dropdown was
		// dead before this: params were silently ignored once an embedder existed).
		const hintChanged = params?.modelHint !== undefined && params.modelHint !== this.currentHint;
		if (this.embedder?.isReady && !hintChanged) return;
		if (this.initPromise && !hintChanged) { await this.initPromise; return; }
		if (hintChanged && this.embedder) {
			if (this.initPromise) { try { await this.initPromise; } catch { /* replacing anyway */ } }
			this.embedder.dispose();
			this.embedder = null;
			this.initPromise = null;
		}

		const opts: EmbedderOptions = {};
		if (params?.modelHint) opts.modelHint = params.modelHint as any;
		if (params?.cacheDir) opts.cacheDir = params.cacheDir;
		if (params?.mirrorHost) opts.mirrorHost = params.mirrorHost;

		this.currentHint = params?.modelHint;
		this.embedder = new Embedder(opts);
		this.initPromise = this.embedder.init();
		await this.initPromise;
	}

	private async _callEmbed(params: { texts: string[]; kind?: 'doc' | 'query' }): Promise<VSBuffer> {
		if (!this.embedder || !this.embedder.isReady) {
			await this._callInit();
		}
		const results = await this.embedder!.embed(params.texts, params.kind ?? 'doc');
		return this._packVectors(results);
	}

	/** Prev-space (potion static) embeds for dual-space retrieval during a model-swap backfill. */
	private async _callEmbedStatic(params: { texts: string[]; modelId?: string }): Promise<VSBuffer> {
		if (!this.embedder || !this.embedder.isReady) {
			await this._callInit();
		}
		const results = await this.embedder!.embedStatic(params.texts, params.modelId);
		return this._packVectors(results);
	}

	/** Ship raw float bytes instead of Array.from(f32). The old path boxed
	 *  count*dim JS numbers per batch (6,144 for 16×384) and structured-cloned
	 *  each one. Layout: [uint32 count][uint32 dim][float32 count*dim]. */
	private _packVectors(results: Float32Array[]): VSBuffer {
		const count = results.length;
		const dim = count > 0 ? results[0].length : (this.embedder?.dim || 0);
		const out = new Uint8Array(8 + count * dim * 4);
		const view = new DataView(out.buffer);
		view.setUint32(0, count, true);
		view.setUint32(4, dim, true);
		const floats = new Float32Array(out.buffer, 8, count * dim);
		for (let i = 0; i < count; i++) floats.set(results[i], i * dim);
		return VSBuffer.wrap(out);
	}

	private _callGetModelInfo(): { modelId: string; dim: number; isReady: boolean } {
		return {
			modelId: this.embedder?.modelId ?? '',
			dim: this.embedder?.dim ?? 0,
			isReady: this.embedder?.isReady ?? false,
		};
	}

	private _callDispose(): void {
		this.embedder?.dispose();
		this.embedder = null;
		this.initPromise = null;
		void this.reranker?.dispose();
		this.reranker = null;
		this.rerankInitPromise = null;
	}

	// -- Local cross-encoder reranker (Qwen3-Reranker-0.6B) --

	private reranker: LlamaReranker | null = null;
	private rerankInitPromise: Promise<void> | null = null;
	private static readonly CACHE_DIR = join(homedir(), '.v3code', 'models');

	/**
	 * Scores docs against the query with the local cross-encoder. Lazily loads the
	 * model; `allowDownload` (from the 'on' setting) permits the one-time ~610MB
	 * fetch, otherwise the model must already be on disk. Throws on failure — the
	 * BROWSER side owns the never-throw fallback so fused order always survives.
	 */
	private async _callRerank(params: { query: string; docs: string[]; allowDownload?: boolean }): Promise<number[]> {
		if (!this.reranker?.isReady) {
			if (!this.rerankInitPromise) {
				const r = new LlamaReranker();
				this.rerankInitPromise = r.init(SemanticEmbedChannel.CACHE_DIR, { allowDownload: params.allowDownload })
					.then(() => { this.reranker = r; })
					.catch(err => { this.rerankInitPromise = null; throw err; });
			}
			await this.rerankInitPromise;
		}
		return this.reranker!.rankAll(params.query, params.docs);
	}

	private _callGetRerankInfo(): { isReady: boolean; modelPresent: boolean } {
		return {
			isReady: this.reranker?.isReady ?? false,
			modelPresent: qwen3RerankModelPresent(SemanticEmbedChannel.CACHE_DIR),
		};
	}
}
