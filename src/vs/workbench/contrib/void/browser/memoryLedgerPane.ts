/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Phase 3 MemLegend -- the Memory Ledger.
 * Opens via F1 / settings — NOT as a Chat auxiliary-bar title tab (Cursor chat chrome
 * is Chat-only; MCP/Memory must not fight the Agents + Chat layout).
 *
 * Design language is lifted from docs/mockups/memory-heatmap.html: a near-black gradient
 * surface, a monospace/uppercase chrome, a custom dark scrollbar, and a floating rounded
 * detail card. Two things make the real data usable that a mockup never has to solve:
 *   1. READS DOMINATE -- so runs of consecutive reads collapse into one "N reads" rung;
 *      the rail then shows the SHAPE of work (prompts / edits / decisions punctuating read
 *      clusters) instead of a wall of identical lines, and the search finally has signal.
 *   2. COLOR BY KIND, not session -- the axis that varies in a single-session workspace.
 * The legend chips are live filters; the search filters within them; clicking a rung traces
 * to the floating card (+ Open file). UI-only, no new storage.
 */

import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions, IViewContainersRegistry,
	ViewContainerLocation, IViewsRegistry, Extensions as ViewExtensions,
	IViewDescriptorService,
} from '../../../common/views.js';
import * as nls from '../../../../nls.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMemoryService } from './memoryService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatEvent, MemoryCheckpoint, MemoryStats, TimelineEntry, TimelineKind } from '../common/memory/memoryTypes.js';

// ---- palette (from the mockup tokens) --------------------------------------------------
interface KindStyle { color: string; label: string; signal: boolean; }
const KIND: Record<TimelineKind, KindStyle> = {
	read: { color: '#6f93de', label: 'read', signal: false },
	prompt: { color: '#9a8cf2', label: 'prompt', signal: true },
	diff: { color: '#54b9a8', label: 'edit', signal: true },
	decision: { color: '#d9a64a', label: 'decision', signal: true },
	escalation: { color: '#e06c75', label: 'escalation', signal: true },
	phase: { color: '#b48ead', label: 'phase', signal: true },
	digest: { color: '#6fcf97', label: 'digest', signal: true },
};
function styleOf(kind: TimelineKind): KindStyle { return KIND[kind] ?? KIND.read; }
const FILTERABLE: TimelineKind[] = ['read', 'prompt', 'diff', 'decision', 'escalation', 'digest'];

// near-black surface + greyscale chrome (mockup --bg-* / --text-* / --chrome-*)
const C = {
	text0: '#e7e7ea', text1: '#c0c0c6', text2: '#8e8e96', text3: '#5f5f67',
	faint: '#1b1b1f', dim: '#26262c', strong: '#34343c',
	card: '#141417', sub: '#0d0d0f', chipBg: '#1a1a1e',
};

const STYLE_ID = 'v3cml-styles';
const STYLESHEET = `
.v3cml{ display:flex; flex-direction:column; height:100%; background:linear-gradient(180deg,#0a0a0c,#070708);
	color:${C.text1}; font-family:var(--monaco-monospace-font, monospace); font-size:12px; }
.v3cml *{ box-sizing:border-box; }
.v3cml-scroll{ overflow-y:auto; overflow-x:hidden; }
.v3cml-scroll::-webkit-scrollbar{ width:10px; height:10px; }
.v3cml-scroll::-webkit-scrollbar-track{ background:transparent; }
.v3cml-scroll::-webkit-scrollbar-thumb{ background:#1c1c20; border-radius:6px; border:2px solid transparent; background-clip:padding-box; }
.v3cml-scroll::-webkit-scrollbar-thumb:hover{ background:#33333b; background-clip:padding-box; }
.v3cml-head{ flex:0 0 auto; padding:12px 14px 11px; border-bottom:1px solid ${C.faint}; display:flex; flex-direction:column; gap:9px; }
.v3cml-topline{ display:flex; align-items:baseline; justify-content:space-between; }
.v3cml-h2{ font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:${C.text2}; }
.v3cml-count{ font-size:11px; letter-spacing:.08em; color:${C.text3}; font-variant-numeric:tabular-nums; }
.v3cml-legend{ display:flex; flex-wrap:wrap; gap:7px; }
.v3cml-fchip{ display:inline-flex; align-items:center; gap:6px; padding:3px 9px 3px 7px; border-radius:20px;
	border:1px solid ${C.faint}; background:${C.chipBg}; color:${C.text2}; font-size:10.5px; cursor:pointer;
	user-select:none; transition:opacity .12s, border-color .12s, color .12s; }
.v3cml-fchip:hover{ color:${C.text0}; border-color:${C.dim}; }
.v3cml-fchip.off{ opacity:.34; }
.v3cml-fdot{ width:9px; height:9px; border-radius:3px; flex:0 0 auto; }
.v3cml-searchwrap{ flex:0 0 auto; margin:10px 14px 6px; padding:6px 10px; display:flex; align-items:center; gap:7px;
	border:1px solid ${C.faint}; border-radius:7px; background:${C.sub}; }
.v3cml-searchwrap:focus-within{ border-color:${C.strong}; }
.v3cml-search{ flex:1; border:0; outline:0; background:transparent; color:${C.text0}; font-size:12px; font-family:inherit; }
.v3cml-search::placeholder{ color:${C.text3}; }
.v3cml-main{ flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.v3cml-rail{ flex:1 1 auto; min-height:0; min-width:0; padding:4px 0 14px; }
.v3cml-section{ padding:13px 14px 5px; color:${C.text3}; font-size:10px; letter-spacing:.18em; text-transform:uppercase; }
.v3cml-rung{ display:flex; align-items:center; gap:9px; min-height:23px; padding:1px 14px; cursor:pointer;
	border-left:2px solid transparent; transition:background .1s; }
.v3cml-rung:hover{ background:rgba(255,255,255,.045); }
.v3cml-rung.sel{ background:rgba(255,255,255,.07); }
.v3cml-spine{ flex:0 0 auto; width:4px; border-radius:2px; }
.v3cml-kind{ flex:0 0 auto; min-width:60px; font-size:11px; }
.v3cml-where{ flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${C.text1}; font-size:11.5px; }
.v3cml-via{ flex:0 0 auto; color:${C.text3}; font-size:10px; opacity:.7; }
.v3cml-diff{ flex:0 0 auto; font-size:10.5px; font-variant-numeric:tabular-nums; }
.v3cml-time{ flex:0 0 auto; min-width:50px; text-align:right; color:${C.text3}; font-size:10px; font-variant-numeric:tabular-nums; }
.v3cml-stack{ flex:0 0 auto; width:13px; display:flex; flex-direction:column; gap:2px; }
.v3cml-stack i{ height:2px; border-radius:1px; background:${C.text3}; display:block; }
.v3cml-empty{ padding:16px 14px; color:${C.text3}; line-height:1.6; }
.v3cml-detail{ overflow:auto; padding:14px; border-top:1px solid ${C.faint}; }
.v3cml-card{ background:${C.card}; border:1px solid ${C.dim}; border-radius:10px; padding:14px 15px 13px;
	box-shadow:0 14px 34px rgba(0,0,0,.5); }
.v3cml-cardhead{ display:flex; align-items:center; gap:9px; margin-bottom:3px; }
.v3cml-carddot{ width:11px; height:11px; border-radius:3px; flex:0 0 auto; }
.v3cml-cardkind{ font-size:20px; font-weight:800; letter-spacing:.01em; }
.v3cml-when{ color:${C.text2}; font-size:11px; margin:2px 0 12px; }
.v3cml-dl{ display:grid; grid-template-columns:74px 1fr; gap:5px 10px; font-size:12px; margin-bottom:11px; }
.v3cml-dl dt{ color:${C.text2}; }
.v3cml-dl dd{ color:${C.text0}; overflow:hidden; text-overflow:ellipsis; }
.v3cml-chips{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.v3cml-chip{ font-size:10px; color:${C.text1}; background:${C.chipBg}; border:1px solid ${C.faint};
	border-radius:5px; padding:3px 7px; white-space:nowrap; }
.v3cml-chip span{ color:${C.text3}; }
.v3cml-btn{ padding:5px 12px; border-radius:6px; border:1px solid ${C.dim}; background:${C.chipBg};
	color:${C.text0}; font-family:inherit; font-size:11px; cursor:pointer; margin-bottom:12px; }
.v3cml-btn:hover{ border-color:${C.strong}; }
.v3cml-body{ color:${C.text1}; font-size:11.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word;
	background:${C.sub}; border:1px solid ${C.faint}; border-radius:7px; padding:10px 11px; max-height:340px; overflow:auto; }
.v3cml-readline{ display:flex; align-items:center; gap:8px; padding:4px 2px; border-bottom:1px solid ${C.faint};
	cursor:pointer; font-size:11px; }
.v3cml-readline:last-child{ border-bottom:0; }
.v3cml-readline:hover{ color:${C.text0}; }
.v3cml-hint{ color:${C.text2}; font-size:11.5px; line-height:1.6; }

/* --- checkpoint scrub bar (LOOK BACK) --- */
.v3cml-scrub{ flex:0 0 auto; display:flex; align-items:center; gap:11px; padding:9px 14px 10px;
	border-top:1px solid ${C.faint}; background:${C.sub}; }
.v3cml-scrub.empty{ color:${C.text3}; font-size:10.5px; letter-spacing:.06em; }
.v3cml-scrublabel{ flex:0 0 auto; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:${C.text3};
	white-space:nowrap; }
.v3cml-scrubtrack{ flex:1 1 auto; min-width:0; position:relative; height:22px; display:flex; align-items:center; cursor:pointer; }
/* the gradient line the ticks sit on */
.v3cml-scrubtrack::before{ content:''; position:absolute; left:0; right:0; height:2px; border-radius:1px;
	background:linear-gradient(90deg,#2a2a31,#4a4a8f,#54b9a8); }
.v3cml-tick{ position:absolute; width:2px; height:9px; border-radius:1px; background:${C.text3};
	transform:translateX(-1px); transition:background .12s, height .12s; }
.v3cml-tick.pinned{ background:#d8a657; }
.v3cml-tick.sel{ background:${C.text0}; height:15px; }
.v3cml-scrubnow{ flex:0 0 auto; font-size:10px; color:${C.text2}; font-variant-numeric:tabular-nums; white-space:nowrap; }

/* --- index health + storage --- */
.v3cml-health{ flex:0 0 auto; display:flex; align-items:center; flex-wrap:wrap; gap:7px 14px;
	padding:8px 14px; border-top:1px solid ${C.faint}; background:${C.sub}; font-size:10.5px; color:${C.text2}; }
.v3cml-hgroup{ display:flex; align-items:center; gap:6px; min-width:0; }
.v3cml-hlabel{ font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:${C.text3}; white-space:nowrap; }
.v3cml-hval{ color:${C.text0}; font-variant-numeric:tabular-nums; white-space:nowrap; }
.v3cml-hval.warn{ color:#d8a657; }
.v3cml-hval.bad{ color:#e07a5f; }
/* coverage meter: how much raw history is actually reachable by search */
.v3cml-meter{ position:relative; width:56px; height:4px; border-radius:2px; background:${C.dim}; overflow:hidden; }
.v3cml-meterfill{ position:absolute; left:0; top:0; bottom:0; border-radius:2px;
	background:linear-gradient(90deg,#4a4a8f,#54b9a8); transition:width .2s; }
.v3cml-meterfill.warn{ background:linear-gradient(90deg,#8f7a3a,#d8a657); }

/* --- checkpoint (snapshot) detail --- */
.v3cml-cpmeta{ display:flex; flex-wrap:wrap; gap:6px; margin:2px 0 11px; }
.v3cml-evrow{ display:flex; gap:9px; padding:5px 2px; border-bottom:1px solid ${C.faint}; font-size:11px; align-items:baseline; }
.v3cml-evrow:last-child{ border-bottom:0; }
.v3cml-evkind{ flex:0 0 auto; min-width:64px; color:${C.text2}; font-size:10px; letter-spacing:.06em; text-transform:uppercase; }
.v3cml-evtext{ flex:1 1 auto; min-width:0; color:${C.text1}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.v3cml-pager{ display:flex; align-items:center; gap:9px; margin-top:10px; }
.v3cml-pager .v3cml-btn{ margin-bottom:0; }
.v3cml-pageinfo{ color:${C.text3}; font-size:10.5px; font-variant-numeric:tabular-nums; }
`;

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function base(path: string): string { return path.split(/[\\/]/).pop() || path; }
function isAbs(path: string): boolean { return /^([a-zA-Z]:[\\/]|[\\/]|[a-zA-Z]+:\/\/)/.test(path); }
function rel(ts: number, now: number): string {
	const s = Math.max(0, Math.floor((now - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
/** Thousands separator only — these are exact counts, so 5,845 must not become "5.8k". */
function fmtCount(n: number): string { return n.toLocaleString(); }
function fmtBytes(n: number): string {
	if (n < 1024) { return `${n} B`; }
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024, i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
function bucketOf(ts: number, now: number): string {
	const m = (now - ts) / 60000;
	if (m < 5) return 'Just now';
	if (m < 60) return 'Past hour';
	if (m < 60 * 12) return 'Earlier today';
	if (m < 60 * 36) return 'Yesterday';
	if (m < 60 * 24 * 7) return 'This week';
	return 'Older';
}

interface Row { e: TimelineEntry; recency: number; }
interface Single { kind: 'single'; row: Row; ts: number; }
interface Cluster { kind: 'cluster'; rows: Row[]; ts: number; recency: number; }
type Item = Single | Cluster;

class MemoryLedgerViewPane extends ViewPane {

	private _count: HTMLElement | null = null;
	private _rail: HTMLElement | null = null;
	private _detail: HTMLElement | null = null;
	private _main: HTMLElement | null = null;
	private _selectedRow: HTMLElement | null = null;
	private _rows: Row[] = [];
	private _hidden = new Set<TimelineKind>();
	/** Compaction checkpoints for the scrub bar, sorted OLDEST first (render order). */
	private _checkpoints: MemoryCheckpoint[] = [];
	private _scrub: HTMLElement | null = null;
	private _selectedCheckpoint: string | null = null;
	private _health: HTMLElement | null = null;
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => {
		void this._load();
		void this._loadCheckpoints();
		void this._loadStats();
		this._refreshScheduler.schedule(8000);
	}, 8000));

	constructor(
		options: IViewPaneOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IMemoryService private readonly memoryService: IMemoryService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IEditorService private readonly editorService: IEditorService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	private _injectStyles(): void {
		if (document.getElementById(STYLE_ID)) { return; }
		const el = document.createElement('style');
		el.id = STYLE_ID;
		el.textContent = STYLESHEET;
		document.head.appendChild(el);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this._injectStyles();
		parent.classList.add('v3cml');

		if (!this.voidSettingsService.state.globalSettings.memoryLedger) {
			const hint = document.createElement('div');
			hint.className = 'v3cml-empty';
			hint.textContent = 'Memory is off, so there is nothing to show here yet.';
			parent.appendChild(hint);
			return;
		}

		// header: title + count + clickable kind-filter legend
		const head = document.createElement('div');
		head.className = 'v3cml-head';
		const topline = document.createElement('div');
		topline.className = 'v3cml-topline';
		const h2 = document.createElement('span'); h2.className = 'v3cml-h2'; h2.textContent = 'Memory Ledger';
		const count = document.createElement('span'); count.className = 'v3cml-count';
		topline.append(h2, count);
		head.appendChild(topline);
		this._count = count;

		const legend = document.createElement('div');
		legend.className = 'v3cml-legend';
		for (const k of FILTERABLE) {
			const s = styleOf(k);
			const chip = document.createElement('span');
			chip.className = 'v3cml-fchip';
			const dot = document.createElement('span'); dot.className = 'v3cml-fdot'; dot.style.background = s.color;
			const tx = document.createElement('span'); tx.textContent = s.label;
			chip.append(dot, tx);
			chip.addEventListener('click', () => {
				if (this._hidden.has(k)) { this._hidden.delete(k); chip.classList.remove('off'); }
				else { this._hidden.add(k); chip.classList.add('off'); }
				this._renderRail(this._query());
			});
			legend.appendChild(chip);
		}
		head.appendChild(legend);
		parent.appendChild(head);

		// search
		const searchWrap = document.createElement('div');
		searchWrap.className = 'v3cml-searchwrap';
		const search = document.createElement('input');
		search.className = 'v3cml-search';
		search.type = 'text';
		search.placeholder = 'Search memory (file, tool, kind, session)…';
		search.addEventListener('input', () => this._renderRail(search.value));
		searchWrap.appendChild(search);
		this._search = search;
		parent.appendChild(searchWrap);

		// main: rail + detail
		const main = document.createElement('div');
		main.className = 'v3cml-main';
		parent.appendChild(main);
		this._main = main;

		const rail = document.createElement('div');
		rail.className = 'v3cml-rail v3cml-scroll';
		main.appendChild(rail);
		this._rail = rail;

		const detail = document.createElement('div');
		detail.className = 'v3cml-detail v3cml-scroll';
		this._detail = detail;
		this._renderDetailEmpty();
		main.appendChild(detail);

		// LOOK BACK: one tick per compaction checkpoint, oldest -> newest. Each checkpoint is a
		// snapshot of a real event range, so the strip doubles as a time scrubber over the session.
		const scrub = document.createElement('div');
		scrub.className = 'v3cml-scrub';
		parent.appendChild(scrub);
		this._scrub = scrub;

		// Index health + storage. Bottom strip rather than a panel: these are numbers you
		// glance at to answer "is my history reachable yet", not something you read down.
		const health = document.createElement('div');
		health.className = 'v3cml-health';
		parent.appendChild(health);
		this._health = health;

		void this._load();
		void this._loadCheckpoints();
		void this._loadStats();
		this._refreshScheduler.schedule(8000);
	}

	private async _loadStats(): Promise<void> {
		const host = this._health;
		if (!host) { return; }
		try {
			const stats = await this.memoryService.getStats();
			if (this._health !== host) { return; }   // pane re-rendered underneath us
			this._renderHealth(stats);
		} catch (e) {
			this.logService.warn('[v3cml] failed to load memory stats', e);
		}
	}

	/**
	 * Render the index-health / storage strip.
	 *
	 * Leads with COVERAGE (events reachable by search_memory) because that is the number
	 * that decides whether recall can work at all — vectors and bytes are downstream of it.
	 * A non-zero backlog is normal and self-clearing, so it only turns amber; a failed
	 * document is not self-clearing, so it turns red and the last error is surfaced.
	 */
	private _renderHealth(stats: MemoryStats | null): void {
		const host = this._health;
		if (!host) { return; }
		host.textContent = '';

		if (!stats) {
			host.textContent = this.memoryService.hasWorkspace
				? 'INDEX · unavailable'
				: 'INDEX · open a folder to index memory';
			return;
		}

		const group = (label: string, value: string, tone?: 'warn' | 'bad', title?: string): HTMLElement => {
			const g = document.createElement('div');
			g.className = 'v3cml-hgroup';
			const l = document.createElement('span');
			l.className = 'v3cml-hlabel';
			l.textContent = label;
			const v = document.createElement('span');
			v.className = 'v3cml-hval' + (tone ? ` ${tone}` : '');
			v.textContent = value;
			if (title) { g.title = title; }
			g.append(l, v);
			host.appendChild(g);
			return g;
		};

		// Coverage: events inside some archive page. 100% with 0 events is vacuous, so show n/a.
		const pct = stats.totalEvents > 0 ? Math.min(100, Math.round((stats.coveredEvents / stats.totalEvents) * 100)) : 0;
		const covGroup = group(
			'coverage',
			stats.totalEvents > 0 ? `${pct}% · ${fmtCount(stats.coveredEvents)}/${fmtCount(stats.totalEvents)}` : 'no events yet',
			stats.totalEvents > 0 && pct < 100 ? 'warn' : undefined,
			'Chat events reachable by search_memory. The idle indexer fills this in over time.'
		);
		if (stats.totalEvents > 0) {
			const meter = document.createElement('div');
			meter.className = 'v3cml-meter';
			const fill = document.createElement('div');
			fill.className = 'v3cml-meterfill' + (pct < 100 ? ' warn' : '');
			fill.style.width = `${pct}%`;
			meter.appendChild(fill);
			covGroup.appendChild(meter);
		}

		// Embedded vs total documents. Vectors can legitimately be 0 when embeddings are off,
		// so say that plainly instead of showing it as a failure.
		group(
			'embedded',
			stats.vectors === 0 && stats.documents > 0 ? `0/${fmtCount(stats.documents)} · off` : `${fmtCount(stats.vectors)}/${fmtCount(stats.documents)}`,
			stats.documents > 0 && stats.vectors === 0 ? 'warn' : undefined,
			'Index documents with a stored embedding. Semantic search falls back to BM25 without them.'
		);

		if (stats.pending > 0) {
			group('queued', fmtCount(stats.pending), 'warn', 'Documents waiting for the idle indexer.');
		}
		if (stats.failed > 0) {
			group('failed', fmtCount(stats.failed), 'bad', stats.lastError ? `Last error: ${stats.lastError}` : 'Documents that could not be indexed.');
		}

		group('snapshots', fmtCount(stats.checkpoints), undefined, 'Compaction checkpoints. One is written per /compact or automatic condensation.');
		group('facts', fmtCount(stats.totalFacts), undefined, 'Curated facts and symbol notes.');

		const kinds = stats.byKind.map(k => `${k.kind} ${fmtCount(k.documents)}`).join(' · ');
		group(
			'storage',
			fmtBytes(stats.dbBytes + stats.walBytes),
			undefined,
			[`Database ${fmtBytes(stats.dbBytes)}`, stats.walBytes > 0 ? `WAL ${fmtBytes(stats.walBytes)}` : '', kinds].filter(Boolean).join(' · ')
		);

		if (stats.oldestMemoryTs) {
			group('reaches back', new Date(stats.oldestMemoryTs).toLocaleDateString(), undefined, 'Date of the oldest remembered event in this workspace.');
		}
	}

	/**
	 * Load compaction checkpoints for the scrub bar.
	 *
	 * Kept separate from _load() because checkpoints change far more slowly than the timeline
	 * (one per compaction vs. one per tool call) and a re-render would drop the user's current
	 * snapshot selection.
	 */
	private async _loadCheckpoints(): Promise<void> {
		const scrub = this._scrub;
		if (!scrub) { return; }
		try {
			const checkpoints = await this.memoryService.listCheckpoints(undefined, 200);
			if (this._scrub !== scrub) { return; }   // pane re-rendered underneath us
			// listCheckpoints returns newest-first; the rail reads left-to-right as time.
			this._checkpoints = checkpoints.slice().sort((a, b) => a.endedAt - b.endedAt);
			this._renderScrub();
		} catch (e) {
			this.logService.warn('[v3cml] failed to load checkpoints', e);
		}
	}

	private _renderScrub(): void {
		const scrub = this._scrub;
		if (!scrub) { return; }
		scrub.textContent = '';
		const cps = this._checkpoints;

		if (!cps.length) {
			scrub.classList.add('empty');
			// Say what would fill it, rather than a bare "no data" — checkpoints only appear
			// after a /compact or an automatic condensation, which is not obvious.
			scrub.textContent = this.memoryService.hasWorkspace
				? 'LOOK BACK · no snapshots yet — one is written each time a long chat is compacted'
				: 'LOOK BACK · open a folder to record snapshots';
			return;
		}
		scrub.classList.remove('empty');

		const label = document.createElement('span');
		label.className = 'v3cml-scrublabel';
		label.textContent = 'Look back';
		scrub.appendChild(label);

		const track = document.createElement('div');
		track.className = 'v3cml-scrubtrack';
		track.tabIndex = 0;
		track.setAttribute('role', 'slider');
		track.setAttribute('aria-label', 'Memory snapshots');
		track.setAttribute('aria-valuemin', '1');
		track.setAttribute('aria-valuemax', String(cps.length));

		const now = document.createElement('span');
		now.className = 'v3cml-scrubnow';

		// Span the full session so tick spacing reflects real elapsed time, not just ordinal
		// position — a burst of compactions should visibly cluster.
		const first = cps[0].endedAt;
		const last = cps[cps.length - 1].endedAt;
		const span = Math.max(1, last - first);

		const ticks: HTMLElement[] = [];
		const selectAt = (i: number) => {
			const cp = cps[i];
			if (!cp) { return; }
			this._selectedCheckpoint = cp.id;
			for (const [j, t] of ticks.entries()) { t.classList.toggle('sel', j === i); }
			track.setAttribute('aria-valuenow', String(i + 1));
			now.textContent = `snapshot ${i + 1}/${cps.length}`;
			void this._showCheckpointDetail(cp, 1);
		};

		for (const [i, cp] of cps.entries()) {
			const tick = document.createElement('span');
			tick.className = 'v3cml-tick';
			if (cp.pinned) { tick.classList.add('pinned'); }
			if (cp.id === this._selectedCheckpoint) { tick.classList.add('sel'); }
			// Single-checkpoint case would divide by a synthetic span; pin it to the end instead.
			tick.style.left = cps.length === 1 ? '100%' : `${((cp.endedAt - first) / span) * 100}%`;
			tick.title = `${new Date(cp.endedAt).toLocaleString()} · ${cp.sourceEventCount} events`;
			tick.addEventListener('click', (ev) => { ev.stopPropagation(); selectAt(i); });
			ticks.push(tick);
			track.appendChild(tick);
		}

		// Click anywhere on the track: jump to the nearest snapshot, so you never have to hit a 2px tick.
		track.addEventListener('click', (ev) => {
			const rect = track.getBoundingClientRect();
			if (rect.width <= 0) { return; }
			const t = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
			const target = first + t * span;
			let best = 0;
			for (const [i, cp] of cps.entries()) {
				if (Math.abs(cp.endedAt - target) < Math.abs(cps[best].endedAt - target)) { best = i; }
			}
			selectAt(best);
		});
		track.addEventListener('keydown', (ev) => {
			const cur = cps.findIndex(c => c.id === this._selectedCheckpoint);
			if (ev.key === 'ArrowLeft') { ev.preventDefault(); selectAt(Math.max(0, (cur < 0 ? cps.length : cur) - 1)); }
			else if (ev.key === 'ArrowRight') { ev.preventDefault(); selectAt(Math.min(cps.length - 1, cur + 1)); }
		});

		const sel = cps.findIndex(c => c.id === this._selectedCheckpoint);
		now.textContent = sel >= 0 ? `snapshot ${sel + 1}/${cps.length}` : `${cps.length} snapshot${cps.length === 1 ? '' : 's'}`;
		scrub.append(track, now);
	}

	private _search: HTMLInputElement | null = null;
	private _query(): string { return this._search?.value ?? ''; }

	private _renderDetailEmpty(): void {
		const detail = this._detail;
		if (!detail) { return; }
		detail.textContent = '';
		const hint = document.createElement('div');
		hint.className = 'v3cml-hint';
		hint.textContent = 'Click any rung to trace it back to the moment it happened — the prompt, the edit, the decision, and the file it touched.';
		detail.appendChild(hint);
	}

	private async _load(): Promise<void> {
		const rail = this._rail;
		if (!rail) { return; }
		const entries = await this.memoryService.getTimeline(200);
		if (this._rail !== rail) { return; }
		const N = entries.length;
		this._rows = entries.map((e, i) => ({ e, recency: N <= 1 ? 1 : 0.4 + 0.6 * ((N - 1 - i) / (N - 1)) }));
		if (this._count) { this._count.textContent = `${N} ${N === 1 ? 'entry' : 'entries'}`; }
		this._renderRail('');
	}

	/** Collapse runs of >=2 consecutive reads into a cluster; everything else stays single. */
	private _buildItems(rows: Row[]): Item[] {
		const items: Item[] = [];
		let run: Row[] = [];
		const flush = () => {
			if (run.length >= 2) { items.push({ kind: 'cluster', rows: run, ts: run[0].e.ts, recency: run[0].recency }); }
			else if (run.length === 1) { items.push({ kind: 'single', row: run[0], ts: run[0].e.ts }); }
			run = [];
		};
		for (const r of rows) {
			if (r.e.kind === 'read') { run.push(r); }
			else { flush(); items.push({ kind: 'single', row: r, ts: r.e.ts }); }
		}
		flush();
		return items;
	}

	private _matches(r: Row, q: string): boolean {
		if (!q) { return true; }
		return `${styleOf(r.e.kind).label} ${r.e.kind} ${r.e.file ?? ''} ${str(r.e.meta?.['tool'])} ${r.e.sessionId ?? ''}`.toLowerCase().includes(q);
	}

	private _renderRail(query: string): void {
		const rail = this._rail;
		if (!rail) { return; }
		const q = query.trim().toLowerCase();
		const visible = this._rows.filter(r => !this._hidden.has(r.e.kind) && this._matches(r, q));
		rail.textContent = '';
		this._selectedRow = null;
		if (!visible.length) {
			const empty = document.createElement('div');
			empty.className = 'v3cml-empty';
			if (this._rows.length) {
				empty.textContent = 'Nothing matches that filter.';
			} else if (!this.memoryService.hasWorkspace) {
				// Ledger / chat timeline is workspace-scoped (.context-bridge). Global
				// symbol notes still work with no folder; this rail does not.
				empty.textContent = 'Open a folder to start the Memory Ledger. Chat history for empty windows is not filed here — the ledger tracks the project you have open.';
			} else {
				empty.textContent = 'No memory yet — your chats and edits will fill this rail as you work.';
			}
			rail.appendChild(empty);
			return;
		}
		const now = Date.now();
		let lastBucket = '';
		for (const it of this._buildItems(visible)) {
			const b = bucketOf(it.ts, now);
			if (b !== lastBucket) {
				const h = document.createElement('div'); h.className = 'v3cml-section'; h.textContent = b;
				rail.appendChild(h);
				lastBucket = b;
			}
			rail.appendChild(it.kind === 'cluster' ? this._renderCluster(it, now) : this._renderRung(it.row, now));
		}
	}

	private _renderRung(r: Row, now: number): HTMLElement {
		const { e, recency } = r;
		const s = styleOf(e.kind);
		const add = num(e.meta?.['add']);
		const del = num(e.meta?.['del']);
		const tool = str(e.meta?.['tool']);

		const row = document.createElement('div');
		row.className = 'v3cml-rung';

		const spine = document.createElement('span');
		spine.className = 'v3cml-spine';
		spine.style.background = s.color;
		spine.style.height = s.signal ? '15px' : '9px';
		spine.style.opacity = recency.toFixed(2);
		row.appendChild(spine);

		const kindEl = document.createElement('span');
		kindEl.className = 'v3cml-kind';
		kindEl.textContent = s.label;
		kindEl.style.color = s.color;
		kindEl.style.fontWeight = s.signal ? '600' : '400';
		kindEl.style.opacity = (recency * 0.7 + 0.3).toFixed(2);
		row.appendChild(kindEl);

		const where = document.createElement('span');
		where.className = 'v3cml-where';
		where.textContent = e.file ? base(e.file) : tool;
		where.style.opacity = (recency * 0.55 + 0.3).toFixed(2);
		row.appendChild(where);

		if (e.file && tool) {
			const via = document.createElement('span'); via.className = 'v3cml-via'; via.textContent = tool;
			row.appendChild(via);
		}
		if (e.kind === 'diff' && (add || del)) {
			const d = document.createElement('span'); d.className = 'v3cml-diff';
			const delEl = document.createElement('span'); delEl.style.color = '#e06c75'; delEl.textContent = `-${del}`;
			const addEl = document.createElement('span'); addEl.style.color = '#54b9a8'; addEl.textContent = `+${add}`;
			d.append(delEl, document.createTextNode(' '), addEl);
			row.appendChild(d);
		}

		const time = document.createElement('span');
		time.className = 'v3cml-time';
		time.textContent = rel(e.ts, now);
		row.appendChild(time);

		row.addEventListener('click', () => { this._select(row, s.color); void this._showDetail(e); });
		return row;
	}

	private _renderCluster(c: Cluster, now: number): HTMLElement {
		const s = styleOf('read');
		const files = new Set<string>();
		for (const r of c.rows) { if (r.e.file) { files.add(base(r.e.file)); } }
		const fileList = [...files];

		const row = document.createElement('div');
		row.className = 'v3cml-rung';

		const stack = document.createElement('span');
		stack.className = 'v3cml-stack';
		for (let i = 0; i < 3; i++) {
			const bar = document.createElement('i');
			if (i === 0) { bar.style.background = s.color; }
			stack.appendChild(bar);
		}
		row.appendChild(stack);

		const kindEl = document.createElement('span');
		kindEl.className = 'v3cml-kind';
		kindEl.textContent = `${c.rows.length} reads`;
		kindEl.style.color = s.color;
		kindEl.style.opacity = (c.recency * 0.7 + 0.3).toFixed(2);
		row.appendChild(kindEl);

		const where = document.createElement('span');
		where.className = 'v3cml-where';
		where.textContent = fileList.length
			? (fileList.slice(0, 2).join(', ') + (fileList.length > 2 ? `  +${fileList.length - 2}` : ''))
			: 'browsing the codebase';
		where.style.opacity = (c.recency * 0.55 + 0.3).toFixed(2);
		row.appendChild(where);

		const time = document.createElement('span');
		time.className = 'v3cml-time';
		time.textContent = rel(c.ts, now);
		row.appendChild(time);

		row.addEventListener('click', () => { this._select(row, s.color); this._showClusterDetail(c); });
		return row;
	}

	/**
	 * Render one checkpoint as a snapshot card: its summary, the exact source range it covers,
	 * and a page of the underlying raw events.
	 *
	 * Evidence is fetched per page rather than whole because a checkpoint can cover thousands of
	 * events, and the bodies arrive redacted (tool payloads blanked) from the database layer.
	 */
	private async _showCheckpointDetail(cp: MemoryCheckpoint, page: number): Promise<void> {
		const detail = this._detail;
		if (!detail) { return; }

		let evidence: { events: ChatEvent[]; page: number; totalPages: number; rawAvailable: boolean } | null = null;
		try {
			evidence = await this.memoryService.getCheckpoint(cp.id, true, page, 25);
		} catch (e) {
			this.logService.warn('[v3cml] failed to load checkpoint evidence', e);
		}
		// Selection may have moved while the fetch was in flight — do not clobber the newer card.
		if (this._detail !== detail || this._selectedCheckpoint !== cp.id) { return; }

		detail.textContent = '';
		const card = document.createElement('div');
		card.className = 'v3cml-card';

		const head = document.createElement('div');
		head.className = 'v3cml-cardhead';
		const dot = document.createElement('span');
		dot.className = 'v3cml-carddot';
		dot.style.background = styleOf('digest').color;
		const kind = document.createElement('span');
		kind.className = 'v3cml-cardkind';
		kind.textContent = 'snapshot';
		head.append(dot, kind);
		card.appendChild(head);

		const when = document.createElement('div');
		when.className = 'v3cml-when';
		when.textContent = `${rel(cp.endedAt, Date.now())} · ${new Date(cp.startedAt).toLocaleString()} → ${new Date(cp.endedAt).toLocaleString()}`;
		card.appendChild(when);

		const meta = document.createElement('div');
		meta.className = 'v3cml-cpmeta';
		const chip = (label: string, value: string) => {
			const c = document.createElement('span');
			c.className = 'v3cml-chip';
			const l = document.createElement('span'); l.textContent = `${label} `;
			c.append(l, document.createTextNode(value));
			return c;
		};
		meta.appendChild(chip('trigger', cp.trigger));
		meta.appendChild(chip('events', String(cp.sourceEventCount)));
		meta.appendChild(chip('size', `${Math.max(1, Math.round(cp.sourceBytes / 1024))} KB`));
		if (cp.status !== 'complete') { meta.appendChild(chip('status', cp.status)); }
		if (cp.pinned) { meta.appendChild(chip('pinned', 'yes')); }
		card.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'v3cml-body';
		body.textContent = cp.summary || '(no summary recorded for this snapshot)';
		card.appendChild(body);

		// Raw evidence. `source-pruned` is a real state after retention: the summary survives but
		// the events behind it were deleted, and saying so beats rendering a silent empty list.
		const evHead = document.createElement('div');
		evHead.className = 'v3cml-when';
		evHead.style.marginTop = '13px';
		if (!evidence || !evidence.rawAvailable) {
			evHead.textContent = cp.status === 'source-pruned'
				? 'Raw evidence for this snapshot was deleted; the summary above is what remains.'
				: 'Raw evidence is unavailable for this snapshot.';
			card.appendChild(evHead);
			detail.appendChild(card);
			return;
		}

		evHead.textContent = `Evidence · ${cp.startEventId.slice(0, 8)} → ${cp.endEventId.slice(0, 8)}`;
		card.appendChild(evHead);

		const list = document.createElement('div');
		for (const ev of evidence.events) {
			const row = document.createElement('div');
			row.className = 'v3cml-evrow';
			const k = document.createElement('span');
			k.className = 'v3cml-evkind';
			k.textContent = ev.kind;
			const t = document.createElement('span');
			t.className = 'v3cml-evtext';
			t.textContent = ev.title || ev.body.slice(0, 160) || '(empty)';
			t.title = ev.title;
			const time = document.createElement('span');
			time.className = 'v3cml-time';
			time.textContent = rel(ev.ts, Date.now());
			row.append(k, t, time);
			if (ev.files?.length) {
				const f = ev.files[0];
				row.style.cursor = 'pointer';
				row.addEventListener('click', () => this._openFile(f));
			}
			list.appendChild(row);
		}
		card.appendChild(list);

		if (evidence.totalPages > 1) {
			const pager = document.createElement('div');
			pager.className = 'v3cml-pager';
			const prev = document.createElement('button');
			prev.className = 'v3cml-btn'; prev.textContent = '← older';
			prev.disabled = evidence.page <= 1;
			prev.addEventListener('click', () => void this._showCheckpointDetail(cp, evidence!.page - 1));
			const next = document.createElement('button');
			next.className = 'v3cml-btn'; next.textContent = 'newer →';
			next.disabled = evidence.page >= evidence.totalPages;
			next.addEventListener('click', () => void this._showCheckpointDetail(cp, evidence!.page + 1));
			const info = document.createElement('span');
			info.className = 'v3cml-pageinfo';
			info.textContent = `page ${evidence.page}/${evidence.totalPages}`;
			pager.append(prev, next, info);
			card.appendChild(pager);
		}

		detail.appendChild(card);
	}

	private _select(row: HTMLElement, color: string): void {
		if (this._selectedRow) { this._selectedRow.classList.remove('sel'); this._selectedRow.style.borderLeftColor = 'transparent'; }
		this._selectedRow = row;
		row.classList.add('sel');
		row.style.borderLeftColor = color;
	}

	private _openFile(path: string): void {
		void this.editorService.openEditor({ resource: URI.file(path) });
	}

	private _showClusterDetail(c: Cluster): void {
		const detail = this._detail;
		if (!detail) { return; }
		const s = styleOf('read');
		detail.textContent = '';
		const card = document.createElement('div'); card.className = 'v3cml-card';

		const head = document.createElement('div'); head.className = 'v3cml-cardhead';
		const dot = document.createElement('span'); dot.className = 'v3cml-carddot'; dot.style.background = s.color;
		const kind = document.createElement('span'); kind.className = 'v3cml-cardkind'; kind.style.color = s.color;
		kind.textContent = `${c.rows.length} reads`;
		head.append(dot, kind);
		card.appendChild(head);

		const when = document.createElement('div'); when.className = 'v3cml-when';
		when.textContent = `${rel(c.rows[c.rows.length - 1].e.ts, Date.now())} → ${rel(c.ts, Date.now())}`;
		card.appendChild(when);

		const body = document.createElement('div'); body.className = 'v3cml-body';
		for (const r of c.rows) {
			const line = document.createElement('div'); line.className = 'v3cml-readline';
			const tool = str(r.e.meta?.['tool']);
			line.textContent = `${r.e.file ? base(r.e.file) : (tool || 'read')}`;
			if (r.e.file && isAbs(r.e.file)) { const f = r.e.file; line.addEventListener('click', () => this._openFile(f)); }
			body.appendChild(line);
		}
		card.appendChild(body);
		detail.appendChild(card);
	}

	private async _showDetail(e: TimelineEntry): Promise<void> {
		const detail = this._detail;
		if (!detail) { return; }
		const s = styleOf(e.kind);
		detail.textContent = '';
		const card = document.createElement('div'); card.className = 'v3cml-card';

		const head = document.createElement('div'); head.className = 'v3cml-cardhead';
		const dot = document.createElement('span'); dot.className = 'v3cml-carddot'; dot.style.background = s.color;
		const kind = document.createElement('span'); kind.className = 'v3cml-cardkind'; kind.style.color = s.color;
		kind.textContent = s.label;
		head.append(dot, kind);
		card.appendChild(head);

		const when = document.createElement('div'); when.className = 'v3cml-when';
		when.textContent = `${rel(e.ts, Date.now())}  ·  ${new Date(e.ts).toLocaleString()}`;
		card.appendChild(when);

		// chips
		const add = num(e.meta?.['add']);
		const del = num(e.meta?.['del']);
		const chips: Array<[string, string]> = [];
		if (e.file) { chips.push(['file', base(e.file)]); }
		if (e.meta?.['tool']) { chips.push(['tool', str(e.meta['tool'])]); }
		if (e.sessionId) { chips.push(['session', e.sessionId.slice(0, 8)]); }
		if (e.meta?.['model']) { chips.push(['model', str(e.meta['model'])]); }
		if (e.meta?.['tokens'] !== undefined) { chips.push(['tokens', String(e.meta['tokens'])]); }
		if (add || del) { chips.push(['diff', `-${del} +${add}`]); }
		if (chips.length) {
			const wrap = document.createElement('div'); wrap.className = 'v3cml-chips';
			for (const [k, v] of chips) {
				const chip = document.createElement('span'); chip.className = 'v3cml-chip';
				const label = document.createElement('span'); label.textContent = k;
				chip.append(label, document.createTextNode(' ' + v));
				wrap.appendChild(chip);
			}
			card.appendChild(wrap);
		}

		if (e.file && isAbs(e.file)) {
			const open = document.createElement('button'); open.className = 'v3cml-btn'; open.textContent = 'Open file';
			const f = e.file; open.addEventListener('click', () => this._openFile(f));
			card.appendChild(open);
		}

		const body = document.createElement('div'); body.className = 'v3cml-body'; body.textContent = 'tracing…';
		card.appendChild(body);
		detail.appendChild(card);

		const h = await this.memoryService.hydrateTimeline(e.id);
		if (this._detail !== detail) { return; }
		if (!h) { body.textContent = '(could not load this rung)'; }
		else if (h.gone) { body.style.color = C.text3; body.textContent = 'The original was removed from disk — but the rung still proves it happened.'; }
		else if (h.chatEvent) { body.textContent = (h.chatEvent.title ? h.chatEvent.title + '\n\n' : '') + (h.chatEvent.body || '(empty)'); }
		else if (h.fact) { body.textContent = `${h.fact.subject}\n\n${h.fact.body || '(empty)'}`; }
		else if (h.escalation) { body.textContent = `Escalation triggered by: ${h.escalation.triggerRule}`; }
		else { body.textContent = '(no detail recorded)'; }
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.element.style.height = `${height}px`;
		this.element.style.width = `${width}px`;
		if (this._main && this._detail) {
			const wide = width >= 720;
			this._main.style.flexDirection = wide ? 'row' : 'column';
			this._detail.style.flex = wide ? '1 1 54%' : '0 0 42%';
			this._detail.style.borderTop = wide ? 'none' : `1px solid ${C.faint}`;
			this._detail.style.borderLeft = wide ? `1px solid ${C.faint}` : 'none';
		}
	}
}

// ---------- Memory Ledger on the primary Sidebar / activity bar (with Explorer) ----------

export const MEMORY_LEDGER_CONTAINER_ID = 'workbench.view.v3codeMemoryLedger';
export const MEMORY_LEDGER_VIEW_ID = MEMORY_LEDGER_CONTAINER_ID;

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const ledgerContainer = viewContainerRegistry.registerViewContainer({
	id: MEMORY_LEDGER_CONTAINER_ID,
	title: nls.localize2('v3codeMemoryLedger', 'Memory Ledger'),
	icon: Codicon.history,
	order: 8,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MEMORY_LEDGER_CONTAINER_ID, {
		mergeViewWithContainerWhenSingleView: true,
		orientation: Orientation.HORIZONTAL,
	}]),
	storageId: MEMORY_LEDGER_CONTAINER_ID,
	hideIfEmpty: false,
	alwaysUseContainerInfo: true,
}, ViewContainerLocation.Sidebar);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
viewsRegistry.registerViews([{
	id: MEMORY_LEDGER_VIEW_ID,
	name: nls.localize2('v3codeMemoryLedgerView', 'Memory Ledger'),
	ctorDescriptor: new SyncDescriptor(MemoryLedgerViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
}], ledgerContainer);

// Discoverable command (F1 -> "Open Memory Ledger").
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'v3code.openMemoryLedger', title: nls.localize2('v3code.openMemoryLedger', 'Open Memory Ledger'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(MEMORY_LEDGER_VIEW_ID, true);
	}
});
