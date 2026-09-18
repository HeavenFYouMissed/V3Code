/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// allow-any-unicode-comment-file

/**
 * Embedding-model selector for the semantic index. Picks a backend on first init:
 *   - default ('auto')  →  StaticEmbedder on minishlab/potion-code-16M — fast,
 *                          code-specialized, runs great on any machine.
 *   - 'auto' on a 16GB+ machine WITH the model already on disk, or explicit
 *     'qwen3-embed'      →  LlamaEmbedder on Qwen3-Embedding-0.6B (llama.cpp/Metal),
 *                          the higher-quality "quality path". RAM-GATED: on a <16GB
 *                          machine it is skipped, because loading it OOM-crashes
 *                          8GB laptops (see qwen3RamOk).
 *   - Retired or unknown model hints resolve to Potion; failures leave lexical search available.
 *
 * Any quality-path failure falls through to the static path — indexing must never be
 * blocked on it. Model files lazy-download to `~/.v3code/models/` on first use; the
 * download host is configurable via `v3code.semanticIndex.modelDownloadHost`.
 */

import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { StaticEmbedder } from './staticEmbedder.js';
import { LlamaEmbedder, qwen3EmbedModelPresent, EmbedKind } from './llamaEmbedder.js';
import { STATIC_CODE_REPO, staticCodeRepoForIdentity } from './staticEmbedModels.js';

export { POTION_CODE_V1_REPO, POTION_CODE_V2_REPO, STATIC_CODE_REPO } from './staticEmbedModels.js';

export type { EmbedKind } from './llamaEmbedder.js';

export type EmbedModelHint = 'auto' | 'qwen3-embed' | 'potion-code';

/** The Qwen3 quality embedder runs on llama.cpp/Metal and needs real headroom. On a
 *  low-RAM machine (an 8GB laptop, where memory is unified with the GPU) loading it
 *  alongside the editor OOM-crashes the whole app. Gate it to ~16GB+ physical RAM;
 *  anything under stays on the static code path (which runs great everywhere). The
 *  floor is 15GiB so a true 16GB machine — which reports ~16GiB — comfortably passes.
 *  Windows is lower: totalmem() there (GlobalMemoryStatusEx) excludes the BIOS/iGPU
 *  hardware-reserved carve-out, so a marketing-16GB laptop can report ~14-15GB and
 *  the 15GiB floor wrongly pins it on potion. 13GiB still blocks every 12GB machine
 *  while admitting a real 16GB box that reserves up to ~2GB. */
const MIN_RAM_BYTES_FOR_QWEN3 = (process.platform === 'win32' ? 13 : 15) * 1024 * 1024 * 1024;
function qwen3RamOk(): boolean {
	try { return totalmem() >= MIN_RAM_BYTES_FOR_QWEN3; }
	catch { return false; }
}

export interface EmbedderOptions {
	modelHint?: EmbedModelHint;
	cacheDir?: string;
	mirrorHost?: string;
	/** Batch size for `embed([...])`. */
	batchSize?: number;
}

interface ModelDescriptor {
	id: string;
	dim: number;
	quantized: boolean;
}

export class Embedder {
	private descriptor: ModelDescriptor | null = null;
	private initPromise: Promise<void> | null = null;
	/** Static (Model2Vec) backend — the default fast/code path. */
	private staticEmbedder: StaticEmbedder | null = null;
	/** GPU llama.cpp backend (Qwen3-Embedding-0.6B) — the quality path. */
	private llamaEmbedder: LlamaEmbedder | null = null;

	constructor(private readonly opts: EmbedderOptions = {}) {}

	get isReady(): boolean { return !!(this.staticEmbedder?.isReady || this.llamaEmbedder?.isReady) && this.descriptor !== null; }
	get modelId(): string { return this.descriptor?.id ?? ''; }
	get dim(): number { return this.descriptor?.dim ?? 0; }

	async init(): Promise<void> {
		if (this.isReady) return;
		if (!this.initPromise) {
			this.initPromise = this.doInit();
		}
		await this.initPromise;
	}

	private async doInit(): Promise<void> {
		const requestedHint = this.opts.modelHint;
		const hint = requestedHint === 'auto' || requestedHint === 'qwen3-embed' ? requestedHint : 'potion-code';
		const cacheDir = this.opts.cacheDir ?? join(homedir(), '.v3code', 'models');
		await mkdir(cacheDir, { recursive: true });

		// Quality path: Qwen3-Embedding-0.6B on llama.cpp (Metal). Explicit hint
		// downloads the ~610MB GGUF; 'auto' uses it ONLY when already on disk so
		// the default never triggers a surprise download. Any failure falls
		// through to the static path — indexing must never be blocked on this.
		const qwen3Wanted = hint === 'qwen3-embed' || (hint === 'auto' && qwen3EmbedModelPresent(cacheDir));
		if (qwen3Wanted && !qwen3RamOk()) {
			// Refuse the quality path on low-RAM machines — loading Qwen3 here is what
			// OOM-crashes 8GB laptops. Stay on the static code embedder instead.
			console.log(`[v3code-embedder] Qwen3 quality path needs ~16GB+ RAM (have ~${Math.round(totalmem() / (1024 * 1024 * 1024))}GB) — staying on the static code embedder to avoid an out-of-memory crash.`);
		}
		if (qwen3Wanted && qwen3RamOk()) {
			try {
				const le = new LlamaEmbedder();
				await le.init(cacheDir, { allowDownload: hint === 'qwen3-embed' });
				this.llamaEmbedder = le;
				this.descriptor = { id: le.modelId, dim: le.dim, quantized: false };
				// Startup identity log on EVERY selection path — "which embedder is
				// actually live" must never be a guess (the quality path was once
				// silently dark for months behind a filename mismatch).
				console.log(`[v3code-embedder] using ${le.modelId} (llama.cpp quality path, hint=${hint})`);
				return;
			} catch (err: any) {
				console.warn('[v3code-embedder] qwen3 llama engine failed, falling back to static:', err?.message ?? err);
			}
		}

		// Potion is the only fallback backend. Do not load retired transformer models.
		try {
			const se = new StaticEmbedder(STATIC_CODE_REPO, cacheDir);
			await se.init();
			this.staticEmbedder = se;
			this.descriptor = { id: STATIC_CODE_REPO, dim: se.dim, quantized: false };
			console.log(`[v3code-embedder] using ${STATIC_CODE_REPO} (static default path, hint=${hint})`);
		} catch (err) {
			console.warn('[v3code-embedder] Potion unavailable; continuing with lexical-only search:', err);
			throw new Error('Potion embeddings unavailable; use lexical-only search.');
		}
	}

	/**
	 * Compute embeddings for a batch of texts. Returns one Float32Array per input.
	 * Uses mean pooling + L2 normalization so dot-product == cosine similarity.
	 */
	async embed(texts: string[], kind: EmbedKind = 'doc'): Promise<Float32Array[]> {
		await this.init();
		// Quality path: llama.cpp transformer. `kind` selects Qwen3's query
		// instruct-prefix; the static/transformer paths embed symmetrically and
		// ignore it.
		if (this.llamaEmbedder?.isReady) {
			return this.llamaEmbedder.embed(texts, kind);
		}
		// Static path: weighted-mean of precomputed token vectors (no inference).
		if (this.staticEmbedder?.isReady) {
			return this.staticEmbedder.embed(texts);
		}
		throw new Error('Embedding backend unavailable; use lexical-only search.');
	}

	// -- Previous-space (potion static) query embedding for dual-space retrieval --

	/** Lazily-loaded potion instance used ONLY for prev-space query embeds while a
	 *  model-swap backfill is in flight. Cheap: static token-vector lookup, no GPU. */
	private readonly prevSpaceEmbedders = new Map<string, StaticEmbedder>();
	private readonly prevSpaceInits = new Map<string, Promise<StaticEmbedder>>();

	/**
	 * Embed `texts` in the requested Potion static space regardless of the active
	 * backend. The model identity is explicit because v1 and v2 are both 256d but
	 * are different vector spaces; silently using the current model for retired
	 * vectors would produce plausible-looking, invalid similarity scores.
	 * Used by dual-space retrieval: while the Qwen3 backfill runs, chunks that
	 * still carry potion vectors need the QUERY embedded in potion space too.
	 * Throws when potion can't load — the caller treats that as "no prev channel".
	 */
	async embedStatic(texts: string[], modelId: string = STATIC_CODE_REPO): Promise<Float32Array[]> {
		await this.init();
		const repo = staticCodeRepoForIdentity(modelId);
		if (!repo) throw new Error(`Unsupported previous static embedding space: ${modelId}`);
		// Active backend already IS the requested Potion version — reuse it.
		if (this.staticEmbedder?.isReady && this.staticEmbedder.modelId === repo) {
			return this.staticEmbedder.embed(texts);
		}
		let init = this.prevSpaceInits.get(repo);
		if (!init) {
			const cacheDir = this.opts.cacheDir ?? join(homedir(), '.v3code', 'models');
			init = (async () => {
				const se = new StaticEmbedder(repo, cacheDir);
				await se.init();
				this.prevSpaceEmbedders.set(repo, se);
				return se;
			})().catch(err => { this.prevSpaceInits.delete(repo); throw err; });
			this.prevSpaceInits.set(repo, init);
		}
		const se = await init;
		return se.embed(texts);
	}

	/** Free the loaded pipeline. Safe to call multiple times. */
	dispose(): void {
		this.staticEmbedder?.dispose();
		this.staticEmbedder = null;
		for (const embedder of this.prevSpaceEmbedders.values()) embedder.dispose();
		this.prevSpaceEmbedders.clear();
		this.prevSpaceInits.clear();
		this.llamaEmbedder?.dispose(); // async native free — fire and forget
		this.llamaEmbedder = null;
		this.descriptor = null;
		this.initPromise = null;
	}
}
