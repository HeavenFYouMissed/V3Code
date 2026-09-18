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
import { ICloudIndexSyncService } from './cloudIndexSyncService.js';
import { CLOUD_INDEX_CONFIGURE_ID, CLOUD_INDEX_SYNC_NOW_ID } from './cloudIndexActions.js';

/**
 * Status bar meter for V3Index cloud sync.
 *
 * Syncing:  `$(cloud-upload) Cloud 42% · 18k chunks · 320/s`
 * Idle:     `$(cloud) Cloud synced · 312k chunks`
 * Error:    `$(warning) Cloud sync error`
 * Hidden when cloud index is disabled.
 */
export class CloudIndexStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.cloudIndex.statusBar';

	private entry: IStatusbarEntryAccessor | null = null;

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@ICloudIndexSyncService private readonly cloudIndexSync: ICloudIndexSyncService,
	) {
		super();
		this.render();
		this._register(this.cloudIndexSync.onDidChangeState(() => this.render()));
	}

	private render(): void {
		const s = this.cloudIndexSync.getState();

		const entry: IStatusbarEntry = {
			name: localize('v3code.cloudIndex.entry.name', 'V3Code Cloud Index'),
			text: this.formatText(s),
			ariaLabel: localize('v3code.cloudIndex.entry.aria', 'V3Code Cloud Index sync status'),
			tooltip: this.formatTooltip(s),
			command: !s.enabled
				? CLOUD_INDEX_CONFIGURE_ID
				: (s.phase === 'syncing' ? undefined : CLOUD_INDEX_SYNC_NOW_ID),
		};

		if (!this.entry) {
			this.entry = this._register(this.statusbar.addEntry(entry, 'v3code.cloudIndex', StatusbarAlignment.RIGHT, 49));
		} else {
			this.entry.update(entry);
		}
	}

	private formatText(s: ReturnType<ICloudIndexSyncService['getState']>): string {
		if (!s.enabled) {
			return `$(cloud) ${localize('v3code.cloudIndex.off', 'Cloud off')}`;
		}
		switch (s.phase) {
			case 'syncing': {
				const pct = s.changedFilesTotal > 0
					? Math.min(100, Math.floor((s.filesProcessed / s.changedFilesTotal) * 100))
					: 0;
				const rate = s.chunksPerSecond >= 1
					? ` · ${formatRate(s.chunksPerSecond)}/s`
					: '';
				return `$(sync~spin) ${localize('v3code.cloudIndex.syncing', 'Cloud {0}% · {1} chunks{2}', pct, formatCount(s.chunksUploaded), rate)}`;
			}
			case 'error':
				return `$(warning) ${localize('v3code.cloudIndex.error', 'Cloud sync error')}`;
			case 'paused':
				return `$(debug-pause) ${localize('v3code.cloudIndex.paused', 'Cloud contribution paused')}`;
			case 'idle':
			default: {
				if (s.readOnly) {
					return `$(cloud) ${localize('v3code.cloudIndex.sharedBase', 'Cloud team base')}`;
				}
				const last = s.lastResult;
				if (last?.ok && last.uploadedChunks > 0) {
					return `$(cloud) ${localize('v3code.cloudIndex.idle', 'Cloud synced · {0} chunks', formatCount(last.uploadedChunks))}`;
				}
				if (last?.ok) {
					return `$(cloud) ${localize('v3code.cloudIndex.upToDate', 'Cloud up to date')}`;
				}
				return `$(cloud) ${localize('v3code.cloudIndex.ready', 'Cloud index')}`;
			}
		}
	}

	private formatTooltip(s: ReturnType<ICloudIndexSyncService['getState']>): string {
		if (!s.enabled) {
			return [
				localize('v3code.cloudIndex.tt.off', 'Cloud index sync is off.'),
				localize('v3code.cloudIndex.tt.offHint', 'Cloud Index connects automatically on paid plans. Privacy Mode keeps it off; manual settings are an advanced override.'),
				localize('v3code.cloudIndex.tt.clickConfigure', 'Click to open Cloud Index settings'),
			].join('\n');
		}
		const parts = [
			localize('v3code.cloudIndex.tt.workspace', 'Workspace: {0}', s.workspaceId || 'n/a'),
			localize('v3code.cloudIndex.tt.phase', 'Phase: {0}', s.phase),
		];
		if (s.readOnly) {
			parts.push(localize('v3code.cloudIndex.tt.readOnly', 'Shared base: read-only; local working tree is the live overlay.'));
		}
		if (s.phase === 'syncing') {
			const pct = s.changedFilesTotal > 0
				? Math.min(100, Math.floor((s.filesProcessed / s.changedFilesTotal) * 100))
				: 0;
			parts.push(localize('v3code.cloudIndex.tt.files', 'Files: {0}/{1} ({2}%)', s.filesProcessed, s.changedFilesTotal, pct));
			parts.push(localize('v3code.cloudIndex.tt.chunks', 'Chunks uploaded: {0}', s.chunksUploaded.toLocaleString()));
			if (s.chunksPerSecond >= 0.5) {
				parts.push(localize('v3code.cloudIndex.tt.speed', 'Speed: {0} chunks/s', s.chunksPerSecond.toFixed(1)));
			}
			if (s.startedAt && s.filesProcessed > 0 && s.changedFilesTotal > s.filesProcessed) {
				const elapsed = (Date.now() - s.startedAt) / 1000;
				const filesPerSec = s.filesProcessed / Math.max(elapsed, 0.5);
				const etaSec = (s.changedFilesTotal - s.filesProcessed) / filesPerSec;
				if (isFinite(etaSec) && etaSec > 1) {
					parts.push(localize('v3code.cloudIndex.tt.eta', 'ETA: {0}', formatEta(etaSec)));
				}
			}
		}
		const last = s.lastResult;
		if (last && s.phase !== 'syncing') {
			if (last.ok) {
				parts.push(localize('v3code.cloudIndex.tt.lastOk', 'Last sync: {0} files, {1} chunks in {2}ms',
					last.changedFiles, last.uploadedChunks.toLocaleString(), last.tookMs));
			} else if (last.error) {
				parts.push(localize('v3code.cloudIndex.tt.lastErr', 'Last error: {0}', last.error));
			}
		}
		parts.push(localize('v3code.cloudIndex.tt.click', 'Click to sync now'));
		parts.push(localize('v3code.cloudIndex.tt.settings', 'Configure: {0}', CLOUD_INDEX_CONFIGURE_ID));
		return parts.join('\n');
	}
}

function formatCount(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 10_000) { return `${Math.round(n / 1000)}k`; }
	return n.toLocaleString();
}

function formatRate(n: number): string {
	if (n >= 10_000) { return `${Math.round(n / 1000)}k`; }
	if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
	return n.toFixed(0);
}

function formatEta(sec: number): string {
	if (sec < 60) { return `${Math.ceil(sec)}s`; }
	const totalMin = Math.ceil(sec / 60);
	if (totalMin < 60) { return `${totalMin}m`; }
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

registerWorkbenchContribution2(CloudIndexStatusBarContribution.ID, CloudIndexStatusBarContribution, WorkbenchPhase.AfterRestored);
