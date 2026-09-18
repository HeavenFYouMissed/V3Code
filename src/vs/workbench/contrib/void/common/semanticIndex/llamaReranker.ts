/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Local cross-encoder rerank stage: Qwen3-Reranker-0.6B (GGUF, Q8_0) through
 * node-llama-cpp's ranking context. MAIN PROCESS ONLY — browser code must import
 * llamaRerankerPure.ts instead (pure helpers have no Node deps).
 */

import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import {
	QWEN3_RERANK_MODEL,
} from './llamaRerankerPure.js';

export {
	QWEN3_RERANK_MODEL,
	RERANK_DOC_CHARS,
	RERANK_MAX_CANDIDATES,
	buildRerankDoc,
	applyRerankOrder,
} from './llamaRerankerPure.js';

const CONTEXT_SIZE = 4096;

/** Same RAM floor as the Qwen3 embedder gate (see embedder.ts qwen3RamOk): this
 *  llama.cpp/Metal rerank model OOM-crashes low-RAM machines, so require ~16GB+
 *  (15GiB floor so a true 16GB machine passes). Under that, rerank stays heuristic.
 *  Windows is lower for the same reason as the embedder gate: totalmem() excludes
 *  the BIOS/iGPU hardware-reserved carve-out there, so marketing-16GB laptops
 *  report ~14-15GB and the 15GiB floor would wrongly refuse them. */
const MIN_RAM_BYTES_FOR_RERANK = (process.platform === 'win32' ? 13 : 15) * 1024 * 1024 * 1024;
function rerankRamOk(): boolean {
	try { return totalmem() >= MIN_RAM_BYTES_FOR_RERANK; }
	catch { return false; }
}

/**
 * Resolve the GGUF's on-disk path: the declared canonical filename OR the name
 * node-llama-cpp's downloader actually writes (same fix as
 * resolveQwen3EmbedModelPath — a single-name check kept the reranker dark).
 */
export function resolveQwen3RerankModelPath(cacheDir: string): string | null {
	for (const name of [QWEN3_RERANK_MODEL.filename, QWEN3_RERANK_MODEL.downloadedFilename]) {
		const p = join(cacheDir, name);
		if (existsSync(p)) { return p; }
	}
	return null;
}

export function qwen3RerankModelPresent(cacheDir: string): boolean {
	return resolveQwen3RerankModelPath(cacheDir) !== null;
}

let _llamaLib: Promise<any> | null = null;
function loadNodeLlama(): Promise<any> {
	if (!_llamaLib) {
		_llamaLib = import('node-llama-cpp' as any).catch(err => { _llamaLib = null; throw err; });
	}
	return _llamaLib;
}

export class LlamaReranker {
	private _ctx: any = null;
	private _model: any = null;
	private _ready = false;
	private _lane: Promise<unknown> = Promise.resolve();

	get isReady(): boolean { return this._ready; }
	get modelId(): string { return QWEN3_RERANK_MODEL.id; }

	async init(cacheDir: string, opts?: { allowDownload?: boolean }): Promise<void> {
		if (this._ready) { return; }
		if (!rerankRamOk()) {
			// Refuse the local rerank model on low-RAM machines — same OOM risk as the
			// Qwen3 embedder. The caller catches this and falls back to heuristic rerank.
			throw new Error(`Qwen3 reranker needs ~16GB+ RAM (have ~${Math.round(totalmem() / (1024 * 1024 * 1024))}GB) — skipping the local rerank model to avoid an out-of-memory crash (rerank falls back to the heuristic path).`);
		}
		const nlc = await loadNodeLlama();

		let modelPath = resolveQwen3RerankModelPath(cacheDir);
		if (!modelPath) {
			if (!opts?.allowDownload) {
				throw new Error(`Qwen3 reranker model not downloaded (${QWEN3_RERANK_MODEL.filename})`);
			}
			const downloader = await nlc.createModelDownloader({
				modelUri: QWEN3_RERANK_MODEL.uri,
				dirPath: cacheDir,
			});
			modelPath = await downloader.download();
		}

		const llama = await nlc.getLlama();
		this._model = await llama.loadModel({ modelPath, gpuLayers: 'auto' });
		this._ctx = await this._model.createRankingContext({ contextSize: CONTEXT_SIZE });
		this._ready = true;
	}

	async rankAll(query: string, docs: string[]): Promise<number[]> {
		if (!this._ready || !this._ctx) { throw new Error('LlamaReranker not initialized'); }
		const run = this._lane.then(() => this._ctx.rankAll(query, docs) as Promise<number[]>);
		this._lane = run.catch(() => { });
		return run;
	}

	async dispose(): Promise<void> {
		this._ready = false;
		try { await this._ctx?.dispose?.(); } catch { /* already gone */ }
		try { await this._model?.dispose?.(); } catch { /* already gone */ }
		this._ctx = null;
		this._model = null;
	}
}
