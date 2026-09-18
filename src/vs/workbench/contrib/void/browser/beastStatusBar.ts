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
import { IBeastService, BeastState } from './beastService.js';
import { BEAST_SEARCH_TEST_ID } from './semanticIndexActions.js';

/**
 * Status bar meter for the beast sidecar (the native trigram/symbol index).
 *
 * Idle:      `$(server-process) Beast · 12.8k files`
 * Indexing:  `$(sync~spin) Beast indexing…`
 * Dark:      `$(warning) Beast off`  (kill switch tripped this session)
 * Hidden when the binary is not installed or the sidecar is disabled.
 */
export class BeastStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.beast.statusBar';

	private entry: IStatusbarEntryAccessor | null = null;

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IBeastService private readonly beastService: IBeastService,
	) {
		super();
		this.render();
		this._register(this.beastService.onDidChangeState(() => this.render()));
		// Kick the availability probe so the entry appears without waiting for
		// the first index/search (probe result is cached by the service).
		void this.beastService.isAvailable();
	}

	private render(): void {
		const s = this.beastService.getState();
		// unknown = probe not resolved yet; unavailable = no binary. Both hidden —
		// the sidecar is optional and absence is not an error state worth pixels.
		if (s.phase === 'unknown' || s.phase === 'unavailable') {
			this.entry?.dispose();
			this.entry = null;
			return;
		}

		const entry: IStatusbarEntry = {
			name: localize('v3code.beast.entry.name', 'V3Code Beast Sidecar'),
			text: this.formatText(s),
			ariaLabel: localize('v3code.beast.entry.aria', 'V3Code beast sidecar status'),
			tooltip: this.formatTooltip(s),
			command: s.phase === 'idle' ? BEAST_SEARCH_TEST_ID : undefined,
		};

		if (!this.entry) {
			// Priority 48: immediately left of the cloud index entry (49) so the
			// three index meters (local / cloud / beast) read as one group.
			this.entry = this._register(this.statusbar.addEntry(entry, 'v3code.beast', StatusbarAlignment.RIGHT, 48));
		} else {
			this.entry.update(entry);
		}
	}

	private formatText(s: BeastState): string {
		switch (s.phase) {
			case 'indexing':
				return `$(sync~spin) ${localize('v3code.beast.indexing', 'Beast indexing…')}`;
			case 'dark':
				return `$(warning) ${localize('v3code.beast.dark', 'Beast off')}`;
			case 'idle':
			default: {
				const files = s.lastIndex?.ok ? filesFromSummary(s.lastIndex.summary) : null;
				return files
					? `$(server-process) ${localize('v3code.beast.idleFiles', 'Beast · {0} files', files)}`
					: `$(server-process) ${localize('v3code.beast.idle', 'Beast ready')}`;
			}
		}
	}

	private formatTooltip(s: BeastState): string {
		const parts = [
			localize('v3code.beast.tt.title', 'Beast sidecar (native trigram + symbol index)'),
			localize('v3code.beast.tt.version', 'Version: {0}', s.version ?? 'unknown'),
			localize('v3code.beast.tt.phase', 'Phase: {0}', s.phase),
		];
		if (s.lastIndex) {
			const ago = formatAgo(Date.now() - s.lastIndex.at);
			parts.push(s.lastIndex.ok
				? localize('v3code.beast.tt.last', 'Last index: {0} ago ({1}s)', ago, (s.lastIndex.tookMs / 1000).toFixed(1))
				: localize('v3code.beast.tt.lastFail', 'Last index FAILED {0} ago', ago));
			// The binary's own summary tail (files scanned/indexed, symbol counts).
			for (const line of s.lastIndex.summary.split('\n').slice(0, 5)) {
				const t = line.trim();
				if (t) { parts.push(t); }
			}
		}
		if (s.phase === 'dark') {
			parts.push(localize('v3code.beast.tt.dark', 'Disabled for this session after a failure — see the window log ([v3code-beast]). Reload the window to retry.'));
		}
		if (s.phase === 'idle') {
			parts.push(localize('v3code.beast.tt.click', 'Click to run a sidecar test search'));
		}
		return parts.join('\n');
	}
}

/** Pull "files indexed : 12793" out of the beast index summary, formatted. */
function filesFromSummary(summary: string): string | null {
	const m = /files indexed\s*:\s*(\d+)/.exec(summary);
	if (!m) { return null; }
	const n = Number(m[1]);
	if (n >= 10_000) { return `${Math.round(n / 1000)}k`; }
	if (n >= 1_000) { return `${(n / 1000).toFixed(1)}k`; }
	return String(n);
}

function formatAgo(ms: number): string {
	const min = Math.floor(ms / 60_000);
	if (min < 1) { return localize('v3code.beast.ago.now', 'moments'); }
	if (min < 60) { return `${min}m`; }
	const h = Math.floor(min / 60);
	return `${h}h ${min % 60}m`;
}

registerWorkbenchContribution2(BeastStatusBarContribution.ID, BeastStatusBarContribution, WorkbenchPhase.AfterRestored);
