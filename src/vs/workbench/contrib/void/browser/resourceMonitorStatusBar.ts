/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Status-bar resource glance for V3Code (Resources Explorer, phase 1):
 * `$(pulse) CPU 47% · RAM 72% · V3 1.2GB`, updating on the monitor service's poll.
 * Hover shows the per-role breakdown (IDE core / extensions / terminals / indexer & AI);
 * click opens the full Resource Monitor panel. Amber text when something is hot
 * (system CPU > 80% or V3 RSS > 4 GB) — V3 palette, no emoji, red reserved for errors.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import * as dom from '../../../../base/browser/dom.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntry, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IResourceMonitorService } from './resourceMonitorService.js';
import { formatBytes, HOT_SYSTEM_CPU_PCT, HOT_V3_RSS_BYTES, memoryPressurePct, RESOURCE_BUCKET_LABELS, ResourceBucketId, ResourceSnapshot, RM_SETTING_ENABLED, RM_SETTING_SHOW_IN_STATUS_BAR } from '../common/resourceMonitorTypes.js';
import { OPEN_RESOURCE_MONITOR_ACTION_ID } from './resourceMonitorPane.js';

const AMBER = '#e8b04b'; // V3 working-state amber (matches the composer's working accent family)
const fgMix = (pct: number) => `color-mix(in srgb, var(--vscode-foreground) ${pct}%, transparent)`;

export class ResourceMonitorStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.resourceMonitor.statusBar';

	private entry: IStatusbarEntryAccessor | null = null;

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IResourceMonitorService private readonly resourceMonitor: IResourceMonitorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService _commandService: ICommandService,
	) {
		super();
		this.render();
		this._register(this.resourceMonitor.onDidChangeSnapshot(() => this.render()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(RM_SETTING_ENABLED) || e.affectsConfiguration(RM_SETTING_SHOW_IN_STATUS_BAR)) {
				this.render();
			}
		}));
	}

	private get visible(): boolean {
		return this.configurationService.getValue<boolean>(RM_SETTING_ENABLED) !== false
			&& this.configurationService.getValue<boolean>(RM_SETTING_SHOW_IN_STATUS_BAR) !== false;
	}

	private render(): void {
		if (!this.visible) {
			this.entry?.dispose();
			this.entry = null;
			return;
		}
		const snap = this.resourceMonitor.snapshot;
		const ramPct = snap ? memoryPressurePct(snap) : 0;
		const memAvailable = snap?.systemMemAvailableBytes;
		const hot = !!snap && (snap.systemCpuPct > HOT_SYSTEM_CPU_PCT || snap.v3RssBytes > HOT_V3_RSS_BYTES);
		const text = snap
			? memAvailable !== undefined
				? `$(pulse) CPU ${snap.systemCpuPct.toFixed(0)}% · RAM ${formatBytes(memAvailable)} free · V3 ${formatBytes(snap.v3RssBytes)}`
				: `$(pulse) CPU ${snap.systemCpuPct.toFixed(0)}% · RAM ${ramPct.toFixed(0)}% · V3 ${formatBytes(snap.v3RssBytes)}`
			: `$(pulse) ${localize('v3code.resourceMonitor.warming', 'Resources')}`;

		const entry: IStatusbarEntry = {
			name: localize('v3code.resourceMonitor.name', 'V3Code Resource Monitor'),
			text,
			ariaLabel: localize('v3code.resourceMonitor.aria', 'System and V3Code resource usage'),
			tooltip: snap ? this.buildCard(snap, hot) : localize('v3code.resourceMonitor.tooltipWarming', 'Collecting the first resource sample…'),
			command: OPEN_RESOURCE_MONITOR_ACTION_ID,
			color: hot ? AMBER : undefined,
		};
		if (!this.entry) {
			this.entry = this._register(this.statusbar.addEntry(entry, 'v3code.resourceMonitor', StatusbarAlignment.RIGHT, 54));
		} else {
			this.entry.update(entry);
		}
	}

	/** Hover card: system line + per-role V3 breakdown, same visual family as the usage card. */
	private buildCard(snap: ResourceSnapshot, hot: boolean): HTMLElement {
		const card = dom.$('div.v3-resource-card');
		card.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:240px;max-width:320px;padding:12px 14px;font-size:12px;line-height:1.45;color:var(--vscode-foreground);';

		const title = dom.$('span');
		title.textContent = localize('v3code.resourceMonitor.card.title', 'Resources');
		title.style.cssText = 'font-weight:600;font-size:13px;';

		const sys = dom.$('div');
		sys.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 14px;';
		const stat = (label: string, val: string, color?: string) => {
			const s = dom.$('span');
			const l = dom.$('span'); l.textContent = label + ' '; l.style.opacity = '.55';
			const v = dom.$('span'); v.textContent = val; v.style.cssText = `font-variant-numeric:tabular-nums;${color ? `color:${color};` : ''}`;
			s.append(l, v);
			return s;
		};
		const ramPct = memoryPressurePct(snap);
		const memLine = snap.systemMemAvailableBytes !== undefined
			? `${formatBytes(snap.systemMemAvailableBytes)} avail · ${formatBytes(snap.systemMemTotalBytes - snap.systemMemAvailableBytes)} in use`
			: `${formatBytes(snap.systemMemUsedBytes)} / ${formatBytes(snap.systemMemTotalBytes)} (${ramPct.toFixed(0)}%)`;
		sys.append(
			stat(localize('v3code.resourceMonitor.card.cpu', 'CPU'), `${snap.systemCpuPct.toFixed(0)}%`, snap.systemCpuPct > HOT_SYSTEM_CPU_PCT ? AMBER : undefined),
			stat(localize('v3code.resourceMonitor.card.ram', 'RAM'), memLine),
			stat(localize('v3code.resourceMonitor.card.v3', 'V3Code'), formatBytes(snap.v3RssBytes), snap.v3RssBytes > HOT_V3_RSS_BYTES ? AMBER : undefined),
		);

		const divider = dom.$('div');
		divider.style.cssText = `height:1px;background:${fgMix(10)};margin:1px 0;`;

		// Per-role RSS totals.
		const buckets = this.resourceMonitor.classify(snap.processes);
		const totals = new Map<ResourceBucketId, { mem: number; cpu: number; count: number }>();
		for (const p of snap.processes) {
			const b = buckets.get(p.pid) ?? 'other';
			const t = totals.get(b) ?? { mem: 0, cpu: 0, count: 0 };
			t.mem += p.memBytes; t.cpu += p.cpuPct; t.count += 1;
			totals.set(b, t);
		}
		const list = dom.$('div');
		list.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
		for (const id of ['ideCore', 'extensions', 'terminals', 'indexerAi', 'other'] as ResourceBucketId[]) {
			const t = totals.get(id);
			if (!t || t.count === 0) { continue; }
			const row = dom.$('div');
			row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;';
			const l = dom.$('span'); l.textContent = RESOURCE_BUCKET_LABELS[id]; l.style.opacity = '.7';
			const v = dom.$('span'); v.textContent = `${formatBytes(t.mem)} · ${t.cpu.toFixed(0)}% CPU`; v.style.cssText = 'font-variant-numeric:tabular-nums;opacity:.9;';
			row.append(l, v);
			list.append(row);
		}

		const hint = dom.$('div');
		hint.textContent = hot
			? localize('v3code.resourceMonitor.card.hot', 'High resource usage · click to open the monitor')
			: localize('v3code.resourceMonitor.card.hint', 'Click to open the Resource Monitor');
		hint.style.cssText = `opacity:${hot ? '.9' : '.45'};font-size:11px;${hot ? `color:${AMBER};` : ''}`;

		card.append(title, sys, divider, list, hint);
		return card;
	}
}

registerWorkbenchContribution2(ResourceMonitorStatusBarContribution.ID, ResourceMonitorStatusBarContribution, WorkbenchPhase.AfterRestored);
