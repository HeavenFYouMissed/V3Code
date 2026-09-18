/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntry, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js';
import { REBUILD_INDEX_ID } from './semanticIndexActions.js';

/**
 * Status bar item for the semantic index.
 *
 * Idle:      `$(database) V3Code Index: N files`
 * Working:   `$(sync~spin) Indexing M/N`
 * Error:     `$(warning) V3Code Index error`
 *
 * Click triggers the Rebuild action — same as the command palette entry. Click
 * lives on the status bar rather than the agent panel because the index is a
 * workspace-wide concern, not a per-thread one.
 */
export class SemanticIndexStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.semanticIndex.statusBar';

	private entry: IStatusbarEntryAccessor | null = null;

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@ISemanticIndexService private readonly indexService: ISemanticIndexService,
	) {
		super();
		this.render();
		this._register(this.indexService.onDidChangeStatus(() => this.render()));
	}

	private render(): void {
		const s = this.indexService.getStatus();
		const entry: IStatusbarEntry = {
			name: localize('v3code.semanticIndex.entry.name', 'V3Code Semantic Index'),
			text: this.formatText(s),
			ariaLabel: localize('v3code.semanticIndex.entry.aria', 'V3Code Semantic Index status'),
			tooltip: this.formatTooltip(s),
			command: REBUILD_INDEX_ID,
		};
		if (!this.entry) {
			this.entry = this._register(this.statusbar.addEntry(entry, 'v3code.semanticIndex', StatusbarAlignment.RIGHT, 50));
		} else {
			this.entry.update(entry);
		}
	}

	private formatText(s: ReturnType<ISemanticIndexService['getStatus']>): string {
		// A rebuild the user did not ask for says why, right in the status bar —
		// a self-healing index that looks identical to a routine scan is how the
		// degraded-chunking bug stayed invisible for as long as it did.
		const reason = s.rebuildReason ? ` · ${s.rebuildReason}` : '';
		switch (s.state) {
			case 'walking':
				return `$(sync~spin) ${localize('v3code.semanticIndex.scanning', 'Scanning… {0} files', s.filesTotal || 0)}${reason}`;
			case 'chunking': {
				const pct = s.filesTotal > 0 ? Math.floor((s.filesIndexed / s.filesTotal) * 100) : 0;
				const rate = s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)
					? ` · ${s.filesPerSecond.toFixed(s.filesPerSecond >= 10 ? 0 : 1)}/s`
					: '';
				return `$(sync~spin) ${localize('v3code.semanticIndex.indexing', 'Indexing {0}/{1}', s.filesIndexed, s.filesTotal || '?')} (${pct}%)${rate}${reason}`;
			}
			case 'embedding': {
				const ec = s.embeddedChunks ?? 0;
				const tc = s.chunksToEmbed ?? 0;
				const pct = tc > 0 ? Math.floor((ec / tc) * 100) : 0;
				const rate = s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)
					? ` · ${s.filesPerSecond.toFixed(s.filesPerSecond >= 10 ? 0 : 1)}/s`
					: '';
				return `$(sync~spin) ${localize('v3code.semanticIndex.embedding', 'Embedding {0}/{1}', ec, tc)} (${pct}%)${rate}`;
			}
			case 'error':
				return `$(warning) ${localize('v3code.semanticIndex.error', 'V3Code Index error')}`;
			case 'ready':
			case 'idle': {
				// Slow-model backfill running behind a fully searchable index — annotate
				// quietly instead of looking "busy" for hours.
				if (s.backgroundUpgrade && s.chunksToEmbed) {
					const pct = Math.floor(((s.embeddedChunks ?? 0) / s.chunksToEmbed) * 100);
					return `$(database) ${localize('v3code.semanticIndex.upgrading', 'V3Code Index: ready · upgrading {0}%', pct)}`;
				}
				return `$(database) ${localize('v3code.semanticIndex.idle', 'V3Code Index: {0} files', s.filesIndexed)}`;
			}
			default:
				return `$(database) ${localize('v3code.semanticIndex.notReady', 'V3Code Index')}`;
		}
	}

	private formatTooltip(s: ReturnType<ISemanticIndexService['getStatus']>): string {
		const parts = [
			localize('v3code.semanticIndex.tt.state', 'State: {0}', s.state),
			localize('v3code.semanticIndex.tt.files', 'Files: {0}/{1}', s.filesIndexed, s.filesTotal || 0),
			localize('v3code.semanticIndex.tt.chunks', 'Chunks: {0}', s.chunksTotal),
			localize('v3code.semanticIndex.tt.model', 'Model: {0}', s.modelId ?? 'n/a'),
		];
		if (s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)) {
			// During 'embedding' (or a background upgrade) the rate field carries
			// chunks/s (the file walk is done).
			parts.push((s.state === 'embedding' || s.backgroundUpgrade)
				? localize('v3code.semanticIndex.tt.speedChunks', 'Speed: {0} chunks/s', s.filesPerSecond.toFixed(1))
				: localize('v3code.semanticIndex.tt.speed', 'Speed: {0} files/s', s.filesPerSecond.toFixed(1)));
		}
		if (s.etaSeconds !== undefined && isFinite(s.etaSeconds) && s.etaSeconds > 0.5) {
			parts.push(localize('v3code.semanticIndex.tt.eta', 'ETA: {0}', formatEtaDuration(s.etaSeconds)));
		}
		if (s.chunksToEmbed) {
			parts.push(s.backgroundUpgrade
				? localize('v3code.semanticIndex.tt.upgrading', 'Quality upgrade: {0}/{1} chunks (search fully available)', s.embeddedChunks ?? 0, s.chunksToEmbed)
				: localize('v3code.semanticIndex.tt.embedding', 'Embedding: {0}/{1} chunks', s.embeddedChunks ?? 0, s.chunksToEmbed));
		}
		if (s.rebuildReason) parts.push(localize('v3code.semanticIndex.tt.rebuildReason', 'Rebuilding because: {0}', s.rebuildReason));
		if (s.currentFile) parts.push(localize('v3code.semanticIndex.tt.current', 'Current: {0}', s.currentFile));
		if (s.lastError) parts.push(localize('v3code.semanticIndex.tt.err', 'Last error: {0}', s.lastError));
		parts.push(localize('v3code.semanticIndex.tt.click', 'Click to rebuild'));
		return parts.join('\n');
	}
}

function formatEtaDuration(sec: number): string {
	if (sec < 60) { return `${Math.ceil(sec)}s`; }
	const totalMin = Math.ceil(sec / 60);
	if (totalMin < 60) { return `${totalMin}m`; }
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

registerWorkbenchContribution2(SemanticIndexStatusBarContribution.ID, SemanticIndexStatusBarContribution, WorkbenchPhase.AfterRestored);
