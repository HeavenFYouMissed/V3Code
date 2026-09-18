/*--------------------------------------------------------------------------------------

 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.

 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.

 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */



import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Database, HardDrive, Info, Loader2, RefreshCw } from 'lucide-react';

import { IndexStatus } from '../../../../common/semanticIndex/semanticIndexTypes.js';

import { REBUILD_INDEX_ID } from '../../../semanticIndexActions.js';

import { useAccessor, useSemanticIndexState } from '../util/services.js';

import { VoidSwitch } from '../util/inputs.js';

import ErrorBoundary from '../util/ErrorBoundary.js';

import {

	CardDivider,

	SettingRow,

	SettingsCard,

	SettingsSection,

} from './SettingsLayout.js';



function useConfigValue<T>(key: string, defaultValue: T): readonly [T, (value: T) => void] {

	const accessor = useAccessor();

	const configurationService = accessor.get('IConfigurationService');

	const read = useCallback(() => configurationService.getValue<T>(key) ?? defaultValue, [configurationService, key, defaultValue]);

	const [value, setValue] = useState(read);



	useEffect(() => {

		setValue(read());

		const disposable = configurationService.onDidChangeConfiguration(e => {

			if (e.affectsConfiguration(key)) {

				setValue(read());

			}

		});

		return () => disposable.dispose();

	}, [configurationService, key, read]);



	const update = useCallback((next: T) => {

		void configurationService.updateValue(key, next);

	}, [configurationService, key]);



	return [value, update] as const;

}



function indexProgressPercent(s: IndexStatus): number {

	if (s.state === 'ready' || s.state === 'idle') {

		// During a background quality upgrade the bar tracks the upgrade, not
		// availability (which is already 100% — search works via interim vectors).
		if (s.backgroundUpgrade && s.chunksToEmbed) {

			return Math.min(100, Math.floor(((s.embeddedChunks ?? 0) / s.chunksToEmbed) * 100));

		}

		return s.filesTotal > 0 || s.filesIndexed > 0 ? 100 : 0;

	}

	if (s.state === 'embedding' && (s.chunksToEmbed ?? 0) > 0) {

		return Math.min(100, Math.floor(((s.embeddedChunks ?? 0) / s.chunksToEmbed!) * 100));

	}

	if (s.filesTotal <= 0) return 0;

	return Math.min(100, Math.floor((s.filesIndexed / s.filesTotal) * 100));

}



function indexStatusLabel(s: IndexStatus): string {

	switch (s.state) {

		case 'walking':

			return `Scanning… ${s.filesTotal || 0} files found`;

		case 'chunking': {

			const pct = indexProgressPercent(s);

			const rate = s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)

				? ` · ${s.filesPerSecond.toFixed(s.filesPerSecond >= 10 ? 0 : 1)} files/s`

				: '';

			return `Indexing ${s.filesIndexed}/${s.filesTotal || '?'} (${pct}%)${rate}`;

		}

		case 'embedding': {

			// During embedding the rate field carries CHUNKS/s (the file walk is done).

			const ec = s.embeddedChunks ?? 0;

			const tc = s.chunksToEmbed ?? 0;

			const pct = tc > 0 ? Math.min(100, Math.floor((ec / tc) * 100)) : 0;

			const rate = s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)

				? ` · ${s.filesPerSecond.toFixed(s.filesPerSecond >= 10 ? 0 : 1)} chunks/s`

				: '';

			return `Embedding ${ec.toLocaleString()}/${tc.toLocaleString()} (${pct}%)${rate}`;

		}

		case 'error':

			return s.lastError ? `Error: ${s.lastError}` : 'Index error';

		case 'ready':

		case 'idle': {

			if (s.staleSources) {

				return `Search ready — retrying ${s.staleSources} stale source${s.staleSources === 1 ? '' : 's'}`;

			}

			if (s.backgroundUpgrade && s.chunksToEmbed) {

				const ec = s.embeddedChunks ?? 0;

				const upct = Math.floor((ec / s.chunksToEmbed) * 100);

				const rate = s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)

					? ` · ${s.filesPerSecond.toFixed(s.filesPerSecond >= 10 ? 0 : 1)} chunks/s`

					: '';

				const eta = s.etaSeconds !== undefined && isFinite(s.etaSeconds) && s.etaSeconds > 0.5

					? ` · ~${formatEta(s.etaSeconds)} left`

					: '';

				return `Ready — search available · quality upgrade ${upct}%${rate}${eta}`;

			}

			return s.filesIndexed > 0 ? 'Index up to date' : 'No files indexed yet';

		}

		default:

			return 'Initializing…';

	}

}



function isIndexBusy(s: IndexStatus): boolean {

	return s.state === 'walking' || s.state === 'chunking' || s.state === 'embedding';

}



function formatEta(sec: number): string {

	if (sec < 60) return `${Math.ceil(sec)}s`;

	const totalMin = Math.ceil(sec / 60);

	if (totalMin < 60) return `${totalMin}m`;

	const h = Math.floor(totalMin / 60);

	const m = totalMin % 60;

	return m > 0 ? `${h}h ${m}m` : `${h}h`;

}



export const IndexingDocsTab = () => {

	const accessor = useAccessor();

	const commandService = accessor.get('ICommandService');

	const status = useSemanticIndexState();

	const [syncing, setSyncing] = useState(false);



	const [enabled, setEnabled] = useConfigValue('v3code.semanticIndex.enabled', true);

	const [autoRebuild, setAutoRebuild] = useConfigValue('v3code.semanticIndex.autoRebuildOnStartup', true);

	const [embedModel, setEmbedModel] = useConfigValue('v3code.semanticIndex.embedModel', 'potion-code');

	const [exclude, setExclude] = useConfigValue<string[]>('v3code.semanticIndex.exclude', []);

	const [maxFileSizeKB, setMaxFileSizeKB] = useConfigValue('v3code.semanticIndex.maxFileSizeKB', 1024);

	const [concurrency, setConcurrency] = useConfigValue('v3code.semanticIndex.concurrency', 4);



	const excludeText = useMemo(() => exclude.join('\n'), [exclude]);



	const pct = useMemo(() => indexProgressPercent(status), [status]);

	const busy = isIndexBusy(status) || syncing;



	const onSync = useCallback(async () => {

		if (busy) return;

		setSyncing(true);

		try {

			await commandService.executeCommand(REBUILD_INDEX_ID);

		} finally {

			setSyncing(false);

		}

	}, [busy, commandService]);



	const onExcludeChange = useCallback((text: string) => {

		const patterns = text.split('\n').map(l => l.trim()).filter(Boolean);

		setExclude(patterns);

	}, [setExclude]);



	return (

		<div>

			<SettingsSection label="Codebase">

				<SettingsCard>

					<div className="@@v3code-settings-card-padded">

						<div className="flex items-start justify-between gap-4">

							<div>

								<div className="flex items-center gap-2 mb-1">

									<h3 className="text-sm font-medium m-0" style={{ color: 'var(--fg)' }}>Codebase Indexing</h3>

									<Info size={14} style={{ color: 'var(--fg-dim)' }} />

								</div>

								<p className="@@v3code-settings-row-desc m-0">

									Embed your codebase for improved contextual understanding. All embeddings and metadata are stored locally on your machine — your code never leaves this device.

								</p>

								<span className="@@v3code-settings-local-badge">

									<HardDrive size={12} />

									Local only

								</span>

							</div>

							<button

								type="button"

								className="@@v3code-settings-btn-secondary"

								disabled={busy || !enabled}

								onClick={() => void onSync()}

							>

								{busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}

								Sync

							</button>

						</div>



						<div className="@@v3code-settings-progress-track">

							<div className="@@v3code-settings-progress-fill" style={{ width: `${pct}%` }} />

						</div>



						<div className="flex items-center justify-between gap-4 text-xs" style={{ color: 'var(--fg-muted)' }}>

							<span>{indexStatusLabel(status)}</span>

							<span>{pct}%</span>

						</div>



						<div className="flex flex-wrap gap-4 mt-3 text-xs" style={{ color: 'var(--fg-dim)' }}>

							<span className="inline-flex items-center gap-1">

								<Database size={12} />

								{status.filesIndexed.toLocaleString()} files

							</span>

							<span>{status.chunksTotal.toLocaleString()} chunks</span>

							{status.modelId ? <span>Model: {status.modelId}</span> : null}

							{status.etaSeconds !== undefined && isFinite(status.etaSeconds) && status.etaSeconds > 0.5 && busy ? (

								<span>ETA: {formatEta(status.etaSeconds)}</span>

							) : null}

						</div>



						{status.currentFile && busy ? (

							<p className="text-xs mt-2 truncate m-0" style={{ color: 'var(--fg-dim)' }} title={status.currentFile}>

								{status.currentFile}

							</p>

						) : null}

					</div>



					<CardDivider />



					<ErrorBoundary>

						<SettingRow

							title="Enable codebase indexing"

							description="Turn semantic search on or off for this workspace."

							control={<VoidSwitch size="xs" value={enabled} onChange={setEnabled} />}

						/>

					</ErrorBoundary>



					<SettingRow

						title="Auto-sync on workspace open"

						description="Rebuild the semantic index when you open this workspace."

						control={<VoidSwitch size="xs" value={autoRebuild} onChange={setAutoRebuild} />}

					/>



					<SettingRow

						title="Embedding model"

						description="Local model used for semantic search. Changing this triggers a full re-sync."

						control={

							<select

								className="@@v3code-settings-select"

								value={['auto', 'qwen3-embed', 'potion-code'].includes(embedModel) ? embedModel : 'potion-code'}

								onChange={(e) => setEmbedModel(e.target.value)}

							>

								<option value="auto">Auto</option>

								<option value="qwen3-embed">Qwen3 0.6B (GPU, best quality, ~610MB)</option>

								<option value="potion-code">Potion Code (fastest)</option>

							</select>

						}

					/>



					<SettingRow

						title="Max file size (KB)"

						description="Files larger than this are skipped during indexing."

						control={

							<input

								type="number"

								min={1}

								max={4096}

								className="@@v3code-settings-select"

								style={{ width: 72 }}

								value={maxFileSizeKB}

								onChange={(e) => setMaxFileSizeKB(Number(e.target.value) || 1024)}

							/>

						}

					/>



					<SettingRow

						title="Indexing concurrency"

						description="Parallel workers during a sync. Higher is faster but uses more CPU."

						control={

							<input

								type="number"

								min={1}

								max={8}

								className="@@v3code-settings-select"

								style={{ width: 56 }}

								value={concurrency}

								onChange={(e) => setConcurrency(Math.min(8, Math.max(1, Number(e.target.value) || 4)))}

							/>

						}

					/>



					<CardDivider />



					<div className="@@v3code-settings-row">

						<div className="@@v3code-settings-row-body">

							<p className="@@v3code-settings-row-title">Excluded paths</p>

							<p className="@@v3code-settings-row-desc">

								Directory names to skip during indexing (one per line). Respects your workspace .gitignore as well.

							</p>

							<textarea

								className="@@v3code-settings-exclude-input mt-3"

								value={excludeText}

								onChange={(e) => onExcludeChange(e.target.value)}

								placeholder={'node_modules\n.git\nout\ndist'}

								spellCheck={false}

							/>

						</div>

					</div>

				</SettingsCard>

			</SettingsSection>



			<SettingsSection label="Docs">

				<SettingsCard>

					<div className="@@v3code-settings-card-padded">

						<div className="flex items-start justify-between gap-4">

							<div>

								<h4 className="text-sm font-medium m-0 mb-1" style={{ color: 'var(--fg)' }}>Workspace documentation</h4>

								<p className="@@v3code-settings-row-desc m-0">

									Markdown, MDX, reStructuredText, AsciiDoc, and plain-text files in this workspace use the same exact, lexical, semantic, and freshness pipeline as code.

								</p>

								<span className="@@v3code-settings-local-badge">

									<HardDrive size={12} />

									Local source

								</span>

							</div>

							<div className="text-right">

								<div className="text-lg font-medium" style={{ color: 'var(--fg)' }}>{(status.documentationFiles ?? 0).toLocaleString()}</div>

								<div className="text-xs" style={{ color: 'var(--fg-dim)' }}>documents indexed</div>

							</div>

						</div>

						<p className="text-xs mt-3 mb-0" style={{ color: 'var(--fg-dim)' }}>

							External sites and wikis will use a governed source registry with provenance, freshness, deletion, and private-cloud policy—not an untracked crawler.

						</p>

					</div>

				</SettingsCard>

			</SettingsSection>

		</div>

	);

};
