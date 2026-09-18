/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * First-run model download (autocomplete packet — Phase 2). Pulls the built-in GGUF into the
 * per-user models dir so autocomplete works zero-config on a fresh install. Uses node-llama-cpp's
 * own downloader (HF URL resolution + resume + progress). Tracks per-model status in memory so
 * the renderer can poll a progress bar without an event channel.
 *
 * MAIN PROCESS ONLY.
 */

import { promises as fs } from 'node:fs';
import { loadNodeLlama } from './llamaLoader.js';
import { localModelsDir, resolveLocalModelPath } from './localModelStore.js';

// Logical model name -> download URL. Instruct GGUF for now (FIM proven in the spike); the
// BASE Qwen2.5-Coder is a follow-up for cleaner FIM. Phase 2b adds hardware-adaptive tiers.
const URL_OF_MODEL: Record<string, string> = {
	'qwen2.5-coder-1.5b': 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
	'qwen2.5-coder-0.5b': 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
};

/** Detect this machine's acceleration so the right model size can be picked (GPU -> 1.5B,
 *  CPU-only -> 0.5B). Cheap: just initializes the engine + reads its backend. */
export async function getEngineInfo(): Promise<{ gpu: string | false; gpuDevices: string[] }> {
	try {
		const mod = await loadNodeLlama();
		const llama = await mod.getLlama();
		let gpuDevices: string[] = [];
		try { gpuDevices = await llama.getGpuDeviceNames(); } catch { /* cpu */ }
		return { gpu: llama.gpu ?? false, gpuDevices };
	} catch { return { gpu: false, gpuDevices: [] }; }
}

export interface ModelDownloadStatus {
	state: 'absent' | 'downloading' | 'ready' | 'error';
	downloadedBytes: number;
	totalBytes: number;
	error?: string;
}

const _status = new Map<string, ModelDownloadStatus>();

export async function isModelDownloaded(modelName: string): Promise<boolean> {
	try { await fs.access(resolveLocalModelPath(modelName)); return true; } catch { return false; }
}

export function getDownloadStatus(modelName: string): ModelDownloadStatus {
	return _status.get(modelName) ?? { state: 'absent', downloadedBytes: 0, totalBytes: 0 };
}

/** Idempotent: returns immediately if the file already exists or a download is in flight.
 *  Kicks off the download and updates `getDownloadStatus` as it progresses. */
export async function ensureModelDownloaded(modelName: string): Promise<void> {
	if (await isModelDownloaded(modelName)) { _status.set(modelName, { state: 'ready', downloadedBytes: 0, totalBytes: 0 }); return; }
	const cur = _status.get(modelName);
	if (cur?.state === 'downloading') { return; }

	const url = URL_OF_MODEL[modelName];
	if (!url) { _status.set(modelName, { state: 'error', downloadedBytes: 0, totalBytes: 0, error: `No download URL for "${modelName}"` }); return; }

	_status.set(modelName, { state: 'downloading', downloadedBytes: 0, totalBytes: 0 });
	try {
		const mod = await loadNodeLlama();
		await fs.mkdir(localModelsDir(), { recursive: true });
		const downloader = await mod.createModelDownloader({
			modelUri: url,
			dirPath: localModelsDir(),
			onProgress: (p: any) => {
				_status.set(modelName, {
					state: 'downloading',
					downloadedBytes: p?.downloadedSize ?? 0,
					totalBytes: p?.totalSize ?? 0,
				});
			},
		});
		await downloader.download();
		_status.set(modelName, { state: 'ready', downloadedBytes: 0, totalBytes: 0 });
	} catch (e) {
		_status.set(modelName, { state: 'error', downloadedBytes: 0, totalBytes: 0, error: e instanceof Error ? e.message : String(e) });
	}
}
