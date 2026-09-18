/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code Resource Monitor — the full "Resources Explorer" panel.
 *
 * Hosted as a workbench EDITOR PANE (the VoidSettingsPane pattern) rather than a bottom
 * panel view or a new react bundle: the editor pane needs zero new view-container or
 * react-build plumbing, gives a full-page surface, and the whole UI is
 * theme-var DOM in the same visual family as the status-bar hover cards.
 *
 * Tabs: Overview (CPU / Memory / Disk cards + health banner) · CPU & Memory (process
 * table bucketed by role, high-occupancy filter) · Disk (V3Code-owned paths with
 * Open Folder / Clear Logs). Data comes from IResourceMonitorService (main-process
 * enumeration shared with the stock Process Explorer).
 */

import * as dom from '../../../../base/browser/dom.js';
import * as nls from '../../../../nls.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IResourceMonitorService } from './resourceMonitorService.js';
import { DiskBucketRequest, DiskBucketResult, formatBytes, HIGH_OCCUPANCY_CPU_PCT, HIGH_OCCUPANCY_MEM_BYTES, HOT_SYSTEM_CPU_PCT, HOT_V3_RSS_BYTES, memoryPressurePct, RESOURCE_BUCKET_LABELS, ResourceBucketId, ResourceSnapshot } from '../common/resourceMonitorTypes.js';

export const OPEN_RESOURCE_MONITOR_ACTION_ID = 'v3code.resourceMonitor.open';

const AMBER = '#e8b04b';
const GREEN = 'var(--v3-venom, #6AA3CC)';
const ACCENT = 'var(--v3-accent, #9587ff)';
const fgMix = (pct: number) => `color-mix(in srgb, var(--vscode-foreground) ${pct}%, transparent)`;
const accentMix = (pct: number) => `color-mix(in srgb, ${ACCENT} ${pct}%, transparent)`;

type TabId = 'overview' | 'cpumem' | 'disk';
type BucketFilter = ResourceBucketId | 'all';

class ResourceMonitorInput extends EditorInput {
	static readonly ID = 'workbench.input.v3code.resourceMonitor';
	static readonly RESOURCE = URI.from({ scheme: 'void', path: 'resource-monitor' });
	readonly resource = ResourceMonitorInput.RESOURCE;

	override get typeId(): string { return ResourceMonitorInput.ID; }
	override getName(): string { return nls.localize('v3codeResourceMonitorInput', "Resource Monitor"); }
	override getIcon() { return Codicon.pulse; }
}

class ResourceMonitorPane extends EditorPane {
	static readonly ID = 'workbench.editor.v3code.resourceMonitor';

	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private tab: TabId = 'overview';
	private bucketFilter: BucketFilter = 'all';
	private highOnly = false;
	private diskResults: DiskBucketResult[] | undefined;
	private readonly paneDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IResourceMonitorService private readonly resourceMonitor: IResourceMonitorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(ResourceMonitorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.cssText += 'height:100%;width:100%;overflow:auto;';
		this.root = dom.append(parent, dom.$('div'));
		this.root.style.cssText = 'max-width:980px;margin:0 auto;padding:20px 28px 40px;color:var(--vscode-foreground);font-size:13px;';

		// Header + tab strip.
		const header = dom.append(this.root, dom.$('div'));
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;';
		const title = dom.append(header, dom.$('div'));
		title.textContent = nls.localize('v3codeResourceMonitor.title', "Resource Monitor");
		title.style.cssText = 'font-size:18px;font-weight:700;';
		const tabs = dom.append(header, dom.$('div'));
		tabs.style.cssText = 'display:flex;gap:4px;';
		const tabDefs: Array<{ id: TabId; label: string }> = [
			{ id: 'overview', label: nls.localize('v3codeResourceMonitor.tab.overview', "Overview") },
			{ id: 'cpumem', label: nls.localize('v3codeResourceMonitor.tab.cpumem', "CPU & Memory") },
			{ id: 'disk', label: nls.localize('v3codeResourceMonitor.tab.disk', "Disk") },
		];
		const tabButtons = new Map<TabId, HTMLElement>();
		for (const t of tabDefs) {
			const btn = dom.append(tabs, dom.$('button'));
			btn.textContent = t.label;
			btn.style.cssText = 'padding:5px 12px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--vscode-foreground);cursor:pointer;font-size:12px;';
			this.paneDisposables.add(dom.addDisposableListener(btn, dom.EventType.CLICK, () => {
				this.tab = t.id;
				for (const [id, b] of tabButtons) { this.styleTabButton(b, id === this.tab); }
				if (t.id === 'disk') { void this.loadDisk(); }
				this.renderBody();
			}));
			tabButtons.set(t.id, btn);
			this.styleTabButton(btn, t.id === this.tab);
		}

		this.body = dom.append(this.root, dom.$('div'));
		this.renderBody();

		// Live refresh while the pane is visible.
		this.paneDisposables.add(this.resourceMonitor.onDidChangeSnapshot(() => {
			if (this.isVisible()) { this.renderBody(); }
		}));
		void this.resourceMonitor.refreshNow();
	}

	private styleTabButton(btn: HTMLElement, active: boolean): void {
		btn.style.background = active ? accentMix(16) : 'transparent';
		btn.style.borderColor = active ? accentMix(45) : 'transparent';
		btn.style.color = active ? ACCENT : 'var(--vscode-foreground)';
		btn.style.fontWeight = active ? '600' : '400';
	}

	private renderBody(): void {
		if (!this.body) { return; }
		dom.clearNode(this.body);
		const snap = this.resourceMonitor.snapshot;
		if (!snap) {
			const waiting = dom.append(this.body, dom.$('div'));
			waiting.textContent = nls.localize('v3codeResourceMonitor.waiting', "Collecting the first resource sample…");
			waiting.style.cssText = 'opacity:.6;padding:24px 0;';
			return;
		}
		switch (this.tab) {
			case 'overview': this.renderOverview(this.body, snap); break;
			case 'cpumem': this.renderCpuMem(this.body, snap); break;
			case 'disk': this.renderDisk(this.body); break;
		}
	}

	// ---------- Overview ----------

	private renderOverview(container: HTMLElement, snap: ResourceSnapshot): void {
		const ramPct = memoryPressurePct(snap);
		const memAvailable = snap.systemMemAvailableBytes;
		const hotCpu = snap.systemCpuPct > HOT_SYSTEM_CPU_PCT;
		const hotV3 = snap.v3RssBytes > HOT_V3_RSS_BYTES;
		const hot = hotCpu || hotV3;

		// Health banner.
		const banner = dom.append(container, dom.$('div'));
		banner.style.cssText = `display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;margin-bottom:16px;border:1px solid ${hot ? `color-mix(in srgb, ${AMBER} 45%, transparent)` : `color-mix(in srgb, ${GREEN} 35%, transparent)`};background:${hot ? `color-mix(in srgb, ${AMBER} 10%, transparent)` : `color-mix(in srgb, ${GREEN} 7%, transparent)`};`;
		const bannerIcon = dom.append(banner, dom.$('span.codicon.' + (hot ? 'codicon-warning' : 'codicon-check')));
		bannerIcon.style.color = hot ? AMBER : GREEN;
		const bannerText = dom.append(banner, dom.$('span'));
		bannerText.textContent = hot
			? (hotCpu
				? nls.localize('v3codeResourceMonitor.banner.hotCpu', "High CPU usage — open CPU & Memory to see which processes are hot")
				: nls.localize('v3codeResourceMonitor.banner.hotV3', "V3Code is using a lot of memory — open CPU & Memory for the breakdown"))
			: nls.localize('v3codeResourceMonitor.banner.ok', "No high resource usage");
		bannerText.style.fontWeight = '600';

		// Cards.
		const cards = dom.append(container, dom.$('div'));
		cards.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;';

		const v3CpuShare = Math.min(100, snap.v3CpuLoadSum / Math.max(1, snap.cpuCount));
		this.card(cards, nls.localize('v3codeResourceMonitor.card.cpu', "CPU"), `${snap.systemCpuPct.toFixed(0)}%`, hotCpu, [
			[nls.localize('v3codeResourceMonitor.card.cpu.v3', "V3Code share"), `~${v3CpuShare.toFixed(0)}%`],
			[nls.localize('v3codeResourceMonitor.card.cpu.other', "Everything else"), `~${Math.max(0, snap.systemCpuPct - v3CpuShare).toFixed(0)}%`],
			[nls.localize('v3codeResourceMonitor.card.cpu.cores', "Logical cores"), `${snap.cpuCount}`],
		], snap.systemCpuPct);

		this.card(cards, nls.localize('v3codeResourceMonitor.card.mem', "Memory"),
			memAvailable !== undefined
				? nls.localize('v3codeResourceMonitor.card.mem.availBig', "{0} available", formatBytes(memAvailable))
				: `${ramPct.toFixed(0)}%`,
			hotV3,
			memAvailable !== undefined
				? [
					[nls.localize('v3codeResourceMonitor.card.mem.inUse', "In use (incl. file cache)"), `${formatBytes(snap.systemMemTotalBytes - memAvailable)} / ${formatBytes(snap.systemMemTotalBytes)}`],
					[nls.localize('v3codeResourceMonitor.card.mem.v3', "V3Code processes"), formatBytes(snap.v3RssBytes)],
					[nls.localize('v3codeResourceMonitor.card.mem.other', "Everything else"), formatBytes(Math.max(0, snap.systemMemTotalBytes - memAvailable - snap.v3RssBytes))],
				]
				: [
					[nls.localize('v3codeResourceMonitor.card.mem.used', "System used"), `${formatBytes(snap.systemMemUsedBytes)} / ${formatBytes(snap.systemMemTotalBytes)}`],
					[nls.localize('v3codeResourceMonitor.card.mem.v3', "V3Code processes"), formatBytes(snap.v3RssBytes)],
					[nls.localize('v3codeResourceMonitor.card.mem.other', "Everything else"), formatBytes(Math.max(0, snap.systemMemUsedBytes - snap.v3RssBytes))],
				],
			ramPct,
			memAvailable !== undefined
				? nls.localize('v3codeResourceMonitor.card.mem.macNote', "macOS keeps recently used files in RAM as cache — high \"in use\" is normal and reclaimed when apps need it.")
				: undefined);

		const diskTotal = this.diskResults?.reduce((sum, b) => sum + Math.max(0, b.bytes), 0);
		this.card(cards, nls.localize('v3codeResourceMonitor.card.disk', "Disk (V3Code data)"), diskTotal !== undefined ? formatBytes(diskTotal) : '…', false, (this.diskResults ?? []).slice(0, 3).map(b => [b.label, formatBytes(b.bytes)] as [string, string]));
		if (this.diskResults === undefined) { void this.loadDisk(); }
	}

	private card(parent: HTMLElement, title: string, big: string, hot: boolean, rows: Array<[string, string]>, meterPct?: number, footnote?: string): void {
		const card = dom.append(parent, dom.$('div'));
		card.style.cssText = `display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:10px;border:1px solid ${fgMix(12)};background:${fgMix(4)};`;
		const t = dom.append(card, dom.$('div'));
		t.textContent = title;
		t.style.cssText = 'font-size:12px;font-weight:600;opacity:.7;letter-spacing:.2px;';
		const b = dom.append(card, dom.$('div'));
		b.textContent = big;
		b.style.cssText = `font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;${hot ? `color:${AMBER};` : ''}`;
		if (meterPct !== undefined) {
			const track = dom.append(card, dom.$('div'));
			track.style.cssText = `height:5px;border-radius:999px;overflow:hidden;background:${fgMix(12)};`;
			const fill = dom.append(track, dom.$('div'));
			fill.style.cssText = `height:100%;width:${Math.min(100, meterPct).toFixed(1)}%;border-radius:999px;background:${hot ? AMBER : ACCENT};`;
		}
		for (const [label, value] of rows) {
			const row = dom.append(card, dom.$('div'));
			row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-size:12px;';
			const l = dom.append(row, dom.$('span')); l.textContent = label; l.style.opacity = '.6';
			const v = dom.append(row, dom.$('span')); v.textContent = value; v.style.cssText = 'font-variant-numeric:tabular-nums;';
		}
		if (footnote) {
			const note = dom.append(card, dom.$('div'));
			note.textContent = footnote;
			note.style.cssText = 'font-size:11px;opacity:.45;line-height:1.35;margin-top:2px;';
		}
	}

	// ---------- CPU & Memory ----------

	private renderCpuMem(container: HTMLElement, snap: ResourceSnapshot): void {
		const buckets = this.resourceMonitor.classify(snap.processes);

		// Filter chips + high-occupancy checkbox.
		const controls = dom.append(container, dom.$('div'));
		controls.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:12px;';
		const filters: Array<{ id: BucketFilter; label: string }> = [
			{ id: 'all', label: nls.localize('v3codeResourceMonitor.filter.all', "All") },
			...(['ideCore', 'extensions', 'terminals', 'indexerAi', 'other'] as ResourceBucketId[]).map(id => ({ id: id as BucketFilter, label: RESOURCE_BUCKET_LABELS[id] })),
		];
		for (const f of filters) {
			const chip = dom.append(controls, dom.$('button'));
			chip.textContent = f.label;
			const active = this.bucketFilter === f.id;
			chip.style.cssText = `padding:3px 10px;border-radius:999px;font-size:11px;cursor:pointer;border:1px solid ${active ? accentMix(45) : fgMix(15)};background:${active ? accentMix(16) : 'transparent'};color:${active ? ACCENT : 'var(--vscode-foreground)'};`;
			this.paneDisposables.add(dom.addDisposableListener(chip, dom.EventType.CLICK, () => { this.bucketFilter = f.id; this.renderBody(); }));
		}
		const spacer = dom.append(controls, dom.$('span'));
		spacer.style.flex = '1';
		const highLabel = dom.append(controls, dom.$('label'));
		highLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;opacity:.85;cursor:pointer;';
		const highBox = dom.append(highLabel, dom.$('input')) as HTMLInputElement;
		highBox.type = 'checkbox';
		highBox.checked = this.highOnly;
		this.paneDisposables.add(dom.addDisposableListener(highBox, dom.EventType.CHANGE, () => { this.highOnly = highBox.checked; this.renderBody(); }));
		dom.append(highLabel, document.createTextNode(nls.localize('v3codeResourceMonitor.highOnly', "Show only high occupancy (>{0}% CPU or >{1})", HIGH_OCCUPANCY_CPU_PCT, formatBytes(HIGH_OCCUPANCY_MEM_BYTES))));

		// Restart extension host — the one safe "restart" action (never kill main/renderer).
		const restart = dom.append(controls, dom.$('button'));
		restart.textContent = nls.localize('v3codeResourceMonitor.restartExtHost', "Restart Extension Host");
		restart.style.cssText = `padding:3px 10px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid ${fgMix(15)};background:transparent;color:var(--vscode-foreground);`;
		this.paneDisposables.add(dom.addDisposableListener(restart, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand('workbench.action.restartExtensionHost');
		}));

		// Table.
		let rows = snap.processes
			.map(p => ({ ...p, bucket: buckets.get(p.pid) ?? 'other' as ResourceBucketId }))
			.filter(p => this.bucketFilter === 'all' || p.bucket === this.bucketFilter);
		if (this.highOnly) {
			rows = rows.filter(p => p.cpuPct > HIGH_OCCUPANCY_CPU_PCT || p.memBytes > HIGH_OCCUPANCY_MEM_BYTES);
		}
		rows.sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes);

		const table = dom.append(container, dom.$('div'));
		table.style.cssText = `border:1px solid ${fgMix(12)};border-radius:10px;overflow:hidden;`;
		const headerRow = dom.append(table, dom.$('div'));
		headerRow.style.cssText = `display:grid;grid-template-columns:1fr 110px 90px 90px 70px 34px;gap:8px;padding:8px 12px;font-size:11px;font-weight:600;opacity:.65;background:${fgMix(6)};`;
		for (const h of [
			nls.localize('v3codeResourceMonitor.col.name', "Name"),
			nls.localize('v3codeResourceMonitor.col.role', "Role"),
			nls.localize('v3codeResourceMonitor.col.cpu', "CPU %"),
			nls.localize('v3codeResourceMonitor.col.mem', "Memory"),
			nls.localize('v3codeResourceMonitor.col.pid', "PID"),
			'',
		]) {
			const cell = dom.append(headerRow, dom.$('span'));
			cell.textContent = h;
		}

		if (rows.length === 0) {
			const empty = dom.append(table, dom.$('div'));
			empty.textContent = this.highOnly
				? nls.localize('v3codeResourceMonitor.empty.high', "Nothing above the high-occupancy thresholds — all quiet.")
				: nls.localize('v3codeResourceMonitor.empty', "No processes in this bucket.");
			empty.style.cssText = `padding:16px 12px;opacity:.6;${this.highOnly ? `color:${GREEN};opacity:.9;` : ''}`;
		}

		for (const p of rows) {
			const row = dom.append(table, dom.$('div'));
			row.title = p.cmd;
			row.style.cssText = `display:grid;grid-template-columns:1fr 110px 90px 90px 70px 34px;gap:8px;padding:6px 12px;font-size:12px;border-top:1px solid ${fgMix(7)};align-items:center;`;
			const hotRow = p.cpuPct > HIGH_OCCUPANCY_CPU_PCT || p.memBytes > HIGH_OCCUPANCY_MEM_BYTES;
			const name = dom.append(row, dom.$('span'));
			name.textContent = p.name || p.cmd.slice(0, 60);
			name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
			const role = dom.append(row, dom.$('span'));
			role.textContent = RESOURCE_BUCKET_LABELS[p.bucket];
			role.style.cssText = 'opacity:.6;font-size:11px;';
			const cpu = dom.append(row, dom.$('span'));
			cpu.textContent = `${p.cpuPct.toFixed(1)}%`;
			cpu.style.cssText = `font-variant-numeric:tabular-nums;${p.cpuPct > HIGH_OCCUPANCY_CPU_PCT ? `color:${AMBER};font-weight:600;` : ''}`;
			const mem = dom.append(row, dom.$('span'));
			mem.textContent = formatBytes(p.memBytes);
			mem.style.cssText = `font-variant-numeric:tabular-nums;${p.memBytes > HIGH_OCCUPANCY_MEM_BYTES ? `color:${AMBER};font-weight:600;` : ''}`;
			const pid = dom.append(row, dom.$('span'));
			pid.textContent = `${p.pid}`;
			pid.style.cssText = 'font-variant-numeric:tabular-nums;opacity:.6;';
			const copy = dom.append(row, dom.$('button'));
			copy.className = 'codicon codicon-copy';
			copy.title = nls.localize('v3codeResourceMonitor.copyRow', "Copy row");
			copy.style.cssText = `border:none;background:transparent;cursor:pointer;color:var(--vscode-foreground);opacity:${hotRow ? '.8' : '.4'};`;
			this.paneDisposables.add(dom.addDisposableListener(copy, dom.EventType.CLICK, () => {
				void this.clipboardService.writeText(`${p.name}\tCPU ${p.cpuPct.toFixed(1)}%\t${formatBytes(p.memBytes)}\tPID ${p.pid}\t${p.cmd}`);
			}));
		}
	}

	// ---------- Disk ----------

	private diskBucketRequests(): DiskBucketRequest[] {
		const buckets: DiskBucketRequest[] = [];
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			buckets.push({ id: `ws:${folder.uri.fsPath}`, label: nls.localize('v3codeResourceMonitor.disk.ws', "Workspace index ({0}/.v3code)", folder.name), path: `${folder.uri.fsPath}/.v3code` });
		}
		buckets.push({ id: 'logs', label: nls.localize('v3codeResourceMonitor.disk.logs', "Logs"), path: this.environmentService.logsHome.fsPath });
		return buckets;
	}

	private async loadDisk(): Promise<void> {
		try {
			this.diskResults = await this.resourceMonitor.getDiskUsage(this.diskBucketRequests());
		} catch {
			this.diskResults = [];
		}
		if (this.isVisible()) { this.renderBody(); }
	}

	private renderDisk(container: HTMLElement): void {
		if (this.diskResults === undefined) {
			void this.loadDisk();
			const waiting = dom.append(container, dom.$('div'));
			waiting.textContent = nls.localize('v3codeResourceMonitor.disk.measuring', "Measuring V3Code folders…");
			waiting.style.cssText = 'opacity:.6;padding:16px 0;';
			return;
		}
		const list = dom.append(container, dom.$('div'));
		list.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
		for (const bucket of this.diskResults) {
			const row = dom.append(list, dom.$('div'));
			row.style.cssText = `display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;border:1px solid ${fgMix(12)};background:${fgMix(4)};`;
			const info = dom.append(row, dom.$('div'));
			info.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;';
			const label = dom.append(info, dom.$('span'));
			label.textContent = bucket.label;
			label.style.fontWeight = '600';
			const path = dom.append(info, dom.$('span'));
			path.textContent = bucket.path;
			path.style.cssText = 'opacity:.5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
			const size = dom.append(row, dom.$('span'));
			size.textContent = formatBytes(bucket.bytes);
			size.style.cssText = 'font-variant-numeric:tabular-nums;font-weight:600;font-size:14px;';

			const openBtn = dom.append(row, dom.$('button'));
			openBtn.textContent = nls.localize('v3codeResourceMonitor.disk.open', "Open Folder");
			openBtn.style.cssText = `padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid ${fgMix(15)};background:transparent;color:var(--vscode-foreground);`;
			this.paneDisposables.add(dom.addDisposableListener(openBtn, dom.EventType.CLICK, () => {
				void this.nativeHostService.showItemInFolder(bucket.path);
			}));

			if (bucket.id === 'logs') {
				const clearBtn = dom.append(row, dom.$('button'));
				clearBtn.textContent = nls.localize('v3codeResourceMonitor.disk.clearLogs', "Clear Logs");
				clearBtn.style.cssText = `padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid color-mix(in srgb, ${AMBER} 40%, transparent);background:transparent;color:${AMBER};`;
				this.paneDisposables.add(dom.addDisposableListener(clearBtn, dom.EventType.CLICK, () => void this.clearLogs(bucket)));
			}
		}
		const note = dom.append(container, dom.$('div'));
		note.textContent = nls.localize('v3codeResourceMonitor.disk.note', "Sizes are cached for a minute. The global bucket includes downloaded models and grammars — large is normal.");
		note.style.cssText = 'opacity:.45;font-size:11px;margin-top:10px;';
	}

	private async clearLogs(bucket: DiskBucketResult): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: nls.localize('v3codeResourceMonitor.clearLogs.title', "Clear V3Code logs?"),
			detail: nls.localize('v3codeResourceMonitor.clearLogs.detail', "Deletes the contents of {0}. Logs for the current session may be recreated immediately.", bucket.path),
			primaryButton: nls.localize('v3codeResourceMonitor.clearLogs.confirm', "Clear Logs"),
		});
		if (!confirmed) { return; }
		try {
			const dirUri = URI.file(bucket.path);
			const entries = await this.fileService.resolve(dirUri);
			for (const child of entries.children ?? []) {
				await this.fileService.del(child.resource, { recursive: true, useTrash: false }).catch(() => { /* files in use are expected */ });
			}
		} catch { /* folder missing — nothing to clear */ }
		this.diskResults = undefined;
		void this.loadDisk();
	}

	layout(_dimension: Dimension): void { /* fluid layout — the scroll container handles overflow */ }

	override get minimumWidth() { return 560; }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ResourceMonitorPane, ResourceMonitorPane.ID, nls.localize('v3codeResourceMonitorPane', "V3Code Resource Monitor")),
	[new SyncDescriptor(ResourceMonitorInput)]
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_RESOURCE_MONITOR_ACTION_ID,
			title: nls.localize2('v3codeResourceMonitor.openAction', "V3Code: Open Resource Monitor"),
			icon: Codicon.pulse,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const existing = editorService.findEditors(ResourceMonitorInput.RESOURCE);
		if (existing.length > 0) {
			await editorService.openEditor(existing[0].editor);
			return;
		}
		await editorService.openEditor(instantiationService.createInstance(ResourceMonitorInput));
	}
});
