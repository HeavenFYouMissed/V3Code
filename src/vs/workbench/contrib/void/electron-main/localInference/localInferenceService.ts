/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Built-in LOCAL inference engine (autocomplete packet — zero-config baseline). Wraps
 * node-llama-cpp in the main process: loads a GGUF once and keeps it WARM, then serves
 * fill-in-the-middle (FIM) and plain completions. Proven on real hardware in the Phase 0
 * spike (Qwen2.5-Coder 1.5B on an RTX 4050 via Vulkan, with CPU fallback).
 *
 * TWO separate context sequences (each its own KV cache, never shared): one for interactive
 * FIM autocomplete, one for SPECULATIVE work (next-edit prediction / local chat). This is the
 * key latency win: node-llama-cpp reuses the longest common prefix already in a sequence's KV
 * cache, so re-completing in the same file only re-evaluates what changed. If FIM and the
 * next-edit predictor shared one sequence, every background prediction would evict FIM's warm
 * repo-level prefix and the next keystroke would re-prefill it all cold (~seconds). Separate
 * sequences keep FIM warm. Generations are still serialized (one at a time) to avoid GPU
 * contention, and FIM preempts a running speculative gen so it never waits behind one.
 *
 * Owned/instantiated by the llama IPC channel; the renderer never touches this directly.
 */

import { loadNodeLlama } from './llamaLoader.js';
import { FIMRepoContext } from '../../common/helpers/fimRepoContext.js';

// Bounds the KV cache so two sequences stay cheap on VRAM. Auto-sized to fit available VRAM,
// capped here. Autocomplete prompts are small: trimmed prefix/suffix (~25 lines each) + a
// ~2k-char repo context + <=200 generated tokens, comfortably under this.
const CONTEXT_SIZE = { min: 2048, max: 4096 };

export interface LocalGenOptions {
	maxTokens?: number;
	stopTriggers?: string[];
	/** Repo-level neighbor files to show the model before the current file (FIM only). Rendered
	 *  with Qwen2.5-Coder's native `<|repo_name|>` / `<|file_sep|>` special tokens. */
	repoContext?: FIMRepoContext;
}

export interface LocalEngineInfo {
	loaded: boolean;
	modelPath: string | null;
	gpu: string | false;        // 'cuda' | 'vulkan' | 'metal' | false (=CPU)
	gpuDevices: string[];
}

export class LocalInferenceService {

	private _llama: any = null;
	private _mod: any = null;
	private _model: any = null;
	private _context: any = null;
	private _fimSeq: any = null;
	private _specSeq: any = null;
	private _fimCompletion: any = null;     // interactive autocomplete — keeps its KV cache warm
	private _specCompletion: any = null;    // speculative (next-edit / chat) — separate KV cache
	private _modelPath: string | null = null;
	private _loadPromise: Promise<void> | null = null;
	private _busy: Promise<unknown> = Promise.resolve(); // serialize generations (avoid GPU contention)

	isReady(modelPath: string): boolean { return this._modelPath === modelPath && !!this._fimCompletion; }

	/** Hardware + load state, for the settings UI / diagnostics. Initializes the engine
	 *  (cheap) so GPU detection is available even before a model is loaded. */
	async getInfo(): Promise<LocalEngineInfo> {
		let gpu: string | false = false;
		let gpuDevices: string[] = [];
		try {
			const mod = await loadNodeLlama();
			this._llama = this._llama ?? await mod.getLlama();
			gpu = this._llama.gpu ?? false;
			try { gpuDevices = await this._llama.getGpuDeviceNames(); } catch { /* cpu */ }
		} catch { /* engine unavailable */ }
		return { loaded: !!this._fimCompletion, modelPath: this._modelPath, gpu, gpuDevices };
	}

	/** Load (or switch to) a model and keep it warm. Collapses concurrent load calls. */
	async ensureLoaded(modelPath: string): Promise<void> {
		if (this.isReady(modelPath)) { return; }
		if (this._loadPromise) {
			await this._loadPromise.catch(() => { /* ignore, re-check below */ });
			if (this.isReady(modelPath)) { return; }
		}
		this._loadPromise = this._doLoad(modelPath).finally(() => { this._loadPromise = null; });
		await this._loadPromise;
	}

	private async _doLoad(modelPath: string): Promise<void> {
		await this._unload();
		const mod = await loadNodeLlama();
		this._mod = mod;
		this._llama = this._llama ?? await mod.getLlama();
		this._model = await this._llama.loadModel({ modelPath });
		// Two sequences -> two independent KV caches (FIM vs speculative). `sequences: 2` is what
		// makes that possible; node-llama-cpp evaluates them separately and never shares their data.
		// On a tight GPU this can fail to fit, so degrade to a single shared sequence rather than
		// fail to load (autocomplete still works; it just loses the warm-cache isolation).
		try {
			this._context = await this._model.createContext({ sequences: 2, contextSize: CONTEXT_SIZE });
			this._fimSeq = this._context.getSequence();
			this._specSeq = this._context.getSequence();
			this._specCompletion = new mod.LlamaCompletion({ contextSequence: this._specSeq });
		} catch {
			try { await this._context?.dispose?.(); } catch { /* noop */ }
			this._context = await this._model.createContext({ contextSize: CONTEXT_SIZE });
			this._fimSeq = this._context.getSequence();
			this._specSeq = this._fimSeq;          // shared
			this._specCompletion = null;            // resolved lazily to _fimCompletion below
		}
		this._fimCompletion = new mod.LlamaCompletion({ contextSequence: this._fimSeq });
		this._specCompletion = this._specCompletion ?? this._fimCompletion;
		this._modelPath = modelPath;
	}

	/** Fill-in-the-middle completion (what autocomplete uses). INTERACTIVE: it preempts any
	 *  in-flight generation (e.g. a speculative next-edit prediction) so the model lane frees
	 *  immediately and the user's completion never waits behind a background prediction. Falls
	 *  back to a plain completion if the loaded model has no infill support. */
	generateFim(modelPath: string, prefix: string, suffix: string, opts?: LocalGenOptions): Promise<string> {
		// Preempt ONLY a running SPECULATIVE (next-edit) generation — NEVER another FIM. (Aborting
		// FIM-on-FIM made every completion abort the previous one so none ever finished.)
		if (this._running?.speculative) { this._running.abort.abort(); }
		return this._run(modelPath, false, async (signal) => {
			const max = opts?.maxTokens ?? 64;
			const stop = this._fimStopTriggers(opts?.stopTriggers);
			if (this._fimCompletion.infillSupported === false) {
				return await this._fimCompletion.generateCompletion(prefix, { maxTokens: max, customStopTriggers: stop, signal });
			}
			// Repo-level FIM: prepend neighbor files (with real `<|file_sep|>` special tokens) so the
			// model understands code beyond the current file. Falls back to a plain prefix when there
			// are no neighbors — the common case stays on the proven infill path, untouched.
			const prefixInput = await this._buildRepoLevelPrefix(prefix, opts?.repoContext);
			return await this._fimCompletion.generateInfillCompletion(prefixInput, suffix, { maxTokens: max, customStopTriggers: stop, signal });
		});
	}

	/** Stop triggers for FIM. Adds the repo-level boundary tokens (`<|file_sep|>`, `<|repo_name|>`,
	 *  `<|fim_pad|>`, `<|endoftext|>`) so the model can't run on into "the next file", plus a
	 *  markdown fence so an instruct model can't drift into ```lang blocks. Without these, repo-level
	 *  FIM tends to emit long multi-file / markdown blobs after the real completion. */
	private _fimStopTriggers(callerStops?: string[]): any[] {
		const stops: any[] = [...(callerStops ?? []), '```'];
		try {
			const { LlamaText, SpecialTokensText } = this._mod ?? {};
			if (LlamaText && SpecialTokensText) {
				for (const tok of ['<|file_sep|>', '<|repo_name|>', '<|fim_pad|>', '<|endoftext|>']) {
					stops.push(new LlamaText(new SpecialTokensText(tok)));
				}
			}
		} catch { /* string stops still apply */ }
		return stops;
	}

	/** Build the infill prefix as a `LlamaText` with Qwen's repo-level special tokens when neighbor
	 *  files are present; otherwise return the raw prefix string unchanged. Best-effort: any failure
	 *  degrades to the plain prefix so a completion is never lost to context-building. */
	private async _buildRepoLevelPrefix(prefix: string, repo?: FIMRepoContext): Promise<any> {
		if (!repo || repo.files.length === 0) { return prefix; }
		try {
			const mod = this._mod ?? await loadNodeLlama();
			const { LlamaText, SpecialTokensText } = mod;
			const fileSep = (label: string) => [new SpecialTokensText('<|file_sep|>'), `${label}\n`];
			const parts: any[] = [];
			if (repo.repoName) { parts.push(new SpecialTokensText('<|repo_name|>'), `${repo.repoName}\n`); }
			for (const f of repo.files) { parts.push(...fileSep(f.path), `${f.content}\n`); }
			parts.push(...fileSep(repo.currentPath ?? 'current_file'), prefix);
			return new LlamaText(parts);
		} catch { return prefix; }
	}

	/** Plain text completion (used by the next-edit predictor + local chat). SPECULATIVE/low
	 *  priority — does not preempt; an incoming FIM completion aborts it. */
	generateCompletion(modelPath: string, prompt: string, opts?: LocalGenOptions): Promise<string> {
		return this._run(modelPath, true, async (signal) => {
			return await this._specCompletion.generateCompletion(prompt, { maxTokens: opts?.maxTokens ?? 64, customStopTriggers: opts?.stopTriggers, signal });
		});
	}

	private _running: { abort: AbortController; speculative: boolean } | null = null;

	// One generation at a time (single context sequence). FIM preempts a running SPECULATIVE
	// generation (next-edit) so an interactive completion never blocks behind it — but FIM never
	// aborts another FIM (they serialize normally).
	private _run(modelPath: string, speculative: boolean, fn: (signal: AbortSignal) => Promise<string>): Promise<string> {
		const abort = new AbortController();
		const next = this._busy.catch(() => { /* prior failure shouldn't block */ }).then(async () => {
			await this.ensureLoaded(modelPath);
			this._running = { abort, speculative };
			try { return await fn(abort.signal); }
			finally { if (this._running?.abort === abort) { this._running = null; } }
		});
		this._busy = next.catch(() => { /* swallow so the chain continues */ });
		return next;
	}

	async dispose(): Promise<void> { await this._unload(); }

	private async _unload(): Promise<void> {
		const specIsShared = this._specCompletion === this._fimCompletion; // fallback: one sequence for both
		try { this._fimCompletion?.dispose?.(); } catch { /* noop */ }
		try { if (!specIsShared) { this._specCompletion?.dispose?.(); } } catch { /* noop */ }
		try { this._fimSeq?.dispose?.(); } catch { /* noop */ }
		try { if (this._specSeq && this._specSeq !== this._fimSeq) { this._specSeq.dispose?.(); } } catch { /* noop */ }
		try { await this._context?.dispose?.(); } catch { /* noop */ }
		try { await this._model?.dispose?.(); } catch { /* noop */ }
		this._fimCompletion = null; this._specCompletion = null; this._fimSeq = null; this._specSeq = null;
		this._context = null; this._model = null; this._modelPath = null;
	}
}
