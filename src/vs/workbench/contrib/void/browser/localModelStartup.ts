/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * First-run download of the built-in autocomplete model (Phase 2). On workbench start, if
 * autocomplete is on AND the selected Autocomplete model is the built-in local one AND it isn't
 * on disk yet, download it ONCE with a progress notification. Best-effort: a failure just leaves
 * autocomplete in its "model missing" state (it retries next launch). This is what makes local
 * autocomplete work on a fresh install without the user sourcing a model.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout } from '../../../../base/common/async.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ILocalInferenceService } from './localInferenceProxy.js';

class LocalModelStartupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.localModelStartup';
	private autocompleteWasEnabled: boolean;

	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILocalInferenceService private readonly localInferenceService: ILocalInferenceService,
		@IProgressService private readonly progressService: IProgressService,
	) {
		super();
		this.autocompleteWasEnabled = this.voidSettingsService.state.globalSettings.enableAutocomplete;
		void this._maybeDownload();
		// Autocomplete now ships off. A user who opts in from Settings should not have to restart
		// before the first-run downloader wakes up. Only react to the off -> on edge; model-picker
		// downloads have their own explicit action and unrelated settings changes stay cheap.
		this._register(this.voidSettingsService.onDidChangeState(() => {
			const enabled = this.voidSettingsService.state.globalSettings.enableAutocomplete;
			if (enabled && !this.autocompleteWasEnabled) {
				void this._maybeDownload();
			}
			this.autocompleteWasEnabled = enabled;
		}));
	}

	private async _maybeDownload(): Promise<void> {
		try {
			const s = this.voidSettingsService.state;
			if (!s.globalSettings.enableAutocomplete) { return; }
			const sel = s.modelSelectionOfFeature.Autocomplete;
			if (!sel || sel.providerName !== 'v3code-local') { return; } // user picked a different engine
			let modelName = sel.modelName;

			// Already have whatever's selected? Nothing to do (don't disturb a working setup).
			if (await this.localInferenceService.isModelDownloaded(modelName)) { return; }

			// First-run, nothing downloaded yet: right-size the model to the machine so it runs
			// well on everyone's PC. A real GPU gets the 1.5B (sharper). CPU-only gets the 0.5B
			// (lighter, still good). Only auto-pick the two built-in tiers — if the user manually
			// chose some other local model, respect it.
			const isBuiltinTier = modelName === 'qwen2.5-coder-1.5b' || modelName === 'qwen2.5-coder-0.5b';
			if (isBuiltinTier) {
				let hasGpu = true; // assume GPU on failure — the bigger model still runs on CPU, just slower
				try { const info = await this.localInferenceService.getEngineInfo(); hasGpu = !!info.gpu; } catch { /* keep default */ }
				const want = hasGpu ? 'qwen2.5-coder-1.5b' : 'qwen2.5-coder-0.5b';
				if (want !== modelName) {
					await this.voidSettingsService.setModelSelectionOfFeature('Autocomplete', { providerName: 'v3code-local', modelName: want });
					modelName = want;
					// The smaller tier might already be present from a prior run.
					if (await this.localInferenceService.isModelDownloaded(modelName)) { return; }
				}
			}

			await this.progressService.withProgress(
				{ location: ProgressLocation.Notification, title: 'V3Code: downloading the built-in autocomplete model (one time)…', cancellable: false },
				async (progress) => {
					void this.localInferenceService.ensureModelDownloaded(modelName);
					let lastPct = 0;
					for (let i = 0; i < 60 * 30; i++) { // safety cap (~30 min at 1s polls)
						await timeout(1000);
						const st = await this.localInferenceService.getDownloadStatus(modelName);
						if (st.state === 'ready') { progress.report({ message: 'ready — autocomplete is on', increment: 100 - lastPct }); return; }
						if (st.state === 'error') { progress.report({ message: `failed: ${st.error ?? 'unknown error'}` }); await timeout(4000); return; }
						if (st.totalBytes > 0) {
							const pct = Math.min(99, Math.floor((st.downloadedBytes / st.totalBytes) * 100));
							const mb = (n: number) => Math.round(n / 1_000_000);
							progress.report({ message: `${pct}%  (${mb(st.downloadedBytes)} / ${mb(st.totalBytes)} MB)`, increment: pct - lastPct });
							lastPct = pct;
						}
					}
				}
			);
		} catch { /* best-effort; retries next launch */ }
	}
}

registerWorkbenchContribution2(LocalModelStartupContribution.ID, LocalModelStartupContribution, WorkbenchPhase.AfterRestored);
