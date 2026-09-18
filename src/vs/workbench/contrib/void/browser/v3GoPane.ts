/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V Go — Agents-rail dock + status-bar surface for next-edit prediction (NES).
 *
 * Lives above the account/plan chip in the Agents panel (not Explorer).
 * Compact peek when idle; pops open when predicting / ready.
 * Engine stays `nextEditService.ts`; this file is discoverability + chrome.
 */

import { $, append, clearNode, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/path.js';
import { localize, localize2 } from '../../../../nls.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewsRegistry, Extensions as ViewExtensions } from '../../../common/views.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntry, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { InlineCompletionsController } from '../../../../editor/contrib/inlineCompletions/browser/controller/inlineCompletionsController.js';
import { VIEW_CONTAINER } from '../../files/browser/explorerViewlet.js';
import { INextEditService, NextEditPhase } from './nextEditService.js';
import { ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { IAgentLayoutService } from './agentLayoutService.js';
import { mainWindow } from '../../../../base/browser/window.js';

export const V3_GO_VIEW_ID = 'v3code.vGo';
export const V3_GO_FOCUS_ID = 'v3code.vGo.focus';
export const V3_GO_TOGGLE_ID = 'v3code.vGo.toggle';

/** Soft sage — same family as before, one notch less neon. */
/* Accent is the "V Go is alive" role, not a hue. It was green (#6bbf7a), which
	survived the venom->blue sweep and then read as the only green object on an
	otherwise blue rail. These are the same colours rotated to hue 205 at
	IDENTICAL saturation and lightness, so every color-mix percentage below keeps
	its intended contrast. 205 is deliberately cooler than the ~210-220 "UI blue"
	used for focus rings and selection, so the accent still separates from chrome. */
const V3_GO_GREEN = '#6b9cbf';
const V3_GO_GREEN_SOFT = '#7daaca';
/** Compact Agents-rail peek (idle). */
export const V3_GO_DOCK_IDLE_HEIGHT = 48;
/** Expanded Agents-rail height while predicting / ready. */
export const V3_GO_DOCK_ACTIVE_HEIGHT = 214;
/** Gap under the dock before the plan / account chip. */
export const V3_GO_DOCK_MARGIN_BOTTOM = 12;
/** Debounce before compacting so keystroke flicker doesn't thrash the dock. */
const V3_GO_IDLE_DEBOUNCE_MS = 500;

const STYLES = `
@keyframes v3-go-sheen {
	0% { background-position: 120% 0; }
	100% { background-position: -120% 0; }
}
@keyframes v3-go-pulse-dot {
	0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(107, 191, 122, 0.28); }
	50% { opacity: 0.85; box-shadow: 0 0 0 4px rgba(107, 191, 122, 0); }
}
@keyframes v3-go-status-shimmer {
	0% { background-position: 200% 0; }
	100% { background-position: -200% 0; }
}
@keyframes v3-go-dock-pop {
	0% { transform: translateY(6px); opacity: 0.72; }
	100% { transform: translateY(0); opacity: 1; }
}

/* --- Agents-rail dock (above account / plan chip) --- */
.monaco-workbench .part.unifiedsidebar .v3-go-dock {
	flex: 0 0 auto;
	display: flex;
	flex-direction: column;
	margin: 4px 10px ${V3_GO_DOCK_MARGIN_BOTTOM}px;
	border-radius: 12px;
	border: 1px solid color-mix(in srgb, ${V3_GO_GREEN} 20%, transparent);
	background:
		linear-gradient(180deg, color-mix(in srgb, ${V3_GO_GREEN} 7%, transparent) 0%, transparent 48%),
		color-mix(in srgb, ${V3_GO_GREEN} 4%, var(--vscode-sideBar-background, #1a1a1d));
	box-shadow: inset 0 1px 0 rgba(107, 191, 122, 0.08);
	overflow: hidden;
	transition: min-height 220ms cubic-bezier(0.2, 0, 0, 1), max-height 220ms cubic-bezier(0.2, 0, 0, 1);
	min-height: ${V3_GO_DOCK_IDLE_HEIGHT}px;
	max-height: ${V3_GO_DOCK_IDLE_HEIGHT}px;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock.is-active {
	min-height: ${V3_GO_DOCK_ACTIVE_HEIGHT}px;
	max-height: ${V3_GO_DOCK_ACTIVE_HEIGHT}px;
	border-color: color-mix(in srgb, ${V3_GO_GREEN} 34%, transparent);
	animation: v3-go-dock-pop 220ms cubic-bezier(0.2, 0, 0, 1);
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-head {
	display: flex;
	align-items: center;
	gap: 8px;
	height: ${V3_GO_DOCK_IDLE_HEIGHT}px;
	padding: 0 12px;
	cursor: pointer;
	user-select: none;
	box-sizing: border-box;
	flex: 0 0 auto;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-head:hover {
	background: color-mix(in srgb, ${V3_GO_GREEN} 6%, transparent);
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-title {
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.12em;
	text-transform: uppercase;
	color: color-mix(in srgb, ${V3_GO_GREEN} 60%, var(--vscode-foreground));
	flex: 0 0 auto;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-head-status {
	flex: 1 1 auto;
	min-width: 0;
	font-size: 11px;
	font-weight: 550;
	color: ${V3_GO_GREEN_SOFT};
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-head-status.off {
	color: var(--vscode-descriptionForeground);
	font-weight: 500;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-chevron {
	flex: 0 0 auto;
	font-size: 12px;
	opacity: 0.55;
	color: var(--vscode-foreground);
	transition: transform 180ms ease;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock.is-active .v3-go-dock-chevron {
	transform: rotate(180deg);
	opacity: 0.8;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock-body {
	display: none;
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: 2px 12px 14px;
	box-sizing: border-box;
}
.monaco-workbench .part.unifiedsidebar .v3-go-dock.is-active .v3-go-dock-body {
	display: flex;
	flex-direction: column;
	gap: 11px;
}

@media (prefers-reduced-motion: reduce) {
	.monaco-workbench .part.unifiedsidebar .v3-go-dock,
	.monaco-workbench .part.unifiedsidebar .v3-go-dock.is-active,
	.v3-go-pane .v3-go-status.predicting,
	.v3-go-pane .v3-go-status.ready .v3-go-live-dot {
		animation: none !important;
		transition: none !important;
	}
}

/* --- Shared body chrome (also used inside the dock) --- */
.v3-go-pane {
	display: flex; flex-direction: column; gap: 10px;
	padding: 0; box-sizing: border-box; min-height: 0;
}
.v3-go-pane .v3-go-blurb {
	font-size: 11px; line-height: 1.4; margin: 0;
	color: var(--vscode-descriptionForeground);
}
.v3-go-pane .v3-go-status {
	display: inline-flex; align-items: center; gap: 7px; align-self: stretch;
	justify-content: flex-start;
	padding: 7px 12px; border-radius: 999px; font-size: 11px; font-weight: 600;
	letter-spacing: 0.02em;
	background: color-mix(in srgb, ${V3_GO_GREEN} 10%, transparent);
	color: ${V3_GO_GREEN_SOFT};
	border: 1px solid color-mix(in srgb, ${V3_GO_GREEN} 26%, transparent);
	box-shadow: none;
}
.v3-go-pane .v3-go-status.off {
	background: rgba(255,255,255,0.04); color: var(--vscode-descriptionForeground);
	border-color: rgba(255,255,255,0.08); box-shadow: none; font-weight: 500;
}
.v3-go-pane .v3-go-status.predicting {
	background: linear-gradient(90deg,
		color-mix(in srgb, ${V3_GO_GREEN} 6%, transparent) 0%,
		color-mix(in srgb, ${V3_GO_GREEN} 18%, transparent) 50%,
		color-mix(in srgb, ${V3_GO_GREEN} 6%, transparent) 100%);
	background-size: 200% 100%;
	animation: v3-go-status-shimmer 1.5s linear infinite;
}
.v3-go-pane .v3-go-status.ready {
	background: color-mix(in srgb, ${V3_GO_GREEN} 14%, transparent);
	border-color: color-mix(in srgb, ${V3_GO_GREEN} 36%, transparent);
}
.v3-go-pane .v3-go-live-dot {
	width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
	background: ${V3_GO_GREEN};
}
.v3-go-pane .v3-go-status.ready .v3-go-live-dot,
.v3-go-pane .v3-go-status.predicting .v3-go-live-dot {
	animation: v3-go-pulse-dot 1.4s ease-out infinite;
}
.v3-go-pane .v3-go-keys {
	display: flex; flex-wrap: wrap; gap: 6px;
}
.v3-go-pane .v3-go-key {
	display: inline-flex; align-items: center; gap: 6px;
	font-size: 10px; color: var(--vscode-descriptionForeground);
}
.v3-go-pane .v3-go-key kbd {
	font-family: inherit; font-size: 10px; font-weight: 600;
	padding: 2px 6px; border-radius: 4px;
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.1);
	color: var(--vscode-foreground);
}
.v3-go-pane .v3-go-point {
	display: flex; gap: 10px; align-items: flex-start;
	padding: 8px 10px; border-radius: 8px;
	cursor: pointer; -webkit-app-region: no-drag;
	border: 1px solid color-mix(in srgb, ${V3_GO_GREEN} 18%, transparent);
	background: color-mix(in srgb, ${V3_GO_GREEN} 6%, transparent);
	transition: background 160ms ease, border-color 160ms ease;
}
.v3-go-pane .v3-go-point:hover {
	background: color-mix(in srgb, ${V3_GO_GREEN} 11%, transparent);
	border-color: color-mix(in srgb, ${V3_GO_GREEN} 32%, transparent);
}
.v3-go-pane .v3-go-rail { width: 8px; flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; padding-top: 5px; }
.v3-go-pane .v3-go-dot {
	width: 8px; height: 8px; border-radius: 2px; background: ${V3_GO_GREEN};
	box-shadow: 0 0 6px rgba(107, 191, 122, 0.28);
}
.v3-go-pane .v3-go-point-body { min-width: 0; flex: 1; }
.v3-go-pane .v3-go-point-title {
	font-size: 12px; font-weight: 500; color: var(--vscode-foreground);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.v3-go-pane .v3-go-point-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.v3-go-pane .v3-go-empty { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0; }
.v3-go-pane .v3-go-cta {
	display: flex; align-items: center; gap: 10px;
	padding: 10px 12px; border-radius: 10px;
	border: 1px solid color-mix(in srgb, ${V3_GO_GREEN} 24%, transparent);
	background:
		linear-gradient(105deg, transparent 35%, rgba(107, 191, 122, 0.07) 50%, transparent 65%),
		color-mix(in srgb, ${V3_GO_GREEN} 5%, transparent);
	background-size: 220% 100%, 100% 100%;
	animation: v3-go-sheen 2.8s linear infinite;
	cursor: pointer; -webkit-app-region: no-drag;
}
.v3-go-pane .v3-go-cta .codicon { color: ${V3_GO_GREEN}; font-size: 16px; }
.v3-go-pane .v3-go-cta-title { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
.v3-go-pane .v3-go-cta-sub { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.v3-go-pane .v3-go-cta-sub a, .v3-go-pane .v3-go-cta-sub .link {
	color: ${V3_GO_GREEN_SOFT}; text-decoration: underline; cursor: pointer;
}
.v3-go-pane .v3-go-foot {
	font-size: 10px; line-height: 1.35; color: var(--vscode-descriptionForeground);
	opacity: 0.9; margin-top: 2px; padding: 8px 0 2px;
	border-top: 1px solid color-mix(in srgb, ${V3_GO_GREEN} 10%, transparent);
}

/* Status bar accent */
.monaco-workbench .part.statusbar .statusbar-item[id="status.v3code.vGo"] {
	color: ${V3_GO_GREEN_SOFT} !important;
}
.monaco-workbench .part.statusbar .statusbar-item[id="status.v3code.vGo"] a {
	color: inherit !important;
}
.monaco-workbench .part.statusbar .statusbar-item[id="status.v3code.vGo"].v3-go-sb-ready a {
	text-shadow: 0 0 8px rgba(107, 191, 122, 0.28);
}
`;

let stylesInjected = false;
function injectStyles(): void {
	if (stylesInjected) { return; }
	stylesInjected = true;
	const style = mainWindow.document.createElement('style');
	style.id = 'v3-go-pane-styles';
	style.textContent = STYLES;
	mainWindow.document.head.appendChild(style);
}

function phaseLabel(phase: NextEditPhase): string {
	switch (phase) {
		case 'off': return localize('v3Go.statusOff', "Next edit off");
		case 'predicting': return localize('v3Go.statusPredicting', "Predicting next edit…");
		case 'ready': return localize('v3Go.statusReady', "Tab to apply next edit");
		case 'idle':
		default: return localize('v3Go.statusIdle', "Watching your edits");
	}
}

function renderGoBody(
	host: HTMLElement,
	store: DisposableStore,
	nextEditService: INextEditService,
	semanticIndexService: ISemanticIndexService,
	voidSettingsService: IVoidSettingsService,
): void {
	clearNode(host);
	host.classList.add('v3-go-pane');
	const phase = nextEditService.getPhase();
	const pending = nextEditService.getPending();
	const index = semanticIndexService.getStatus();
	const autocompleteOn = !!voidSettingsService.state.globalSettings.enableAutocomplete;

	append(host, $('p.v3-go-blurb')).textContent = localize(
		'v3Go.blurb',
		"After you edit, V3Code predicts the next spot you'll want — press Tab to jump.",
	);

	const status = append(host, $('div.v3-go-status'));
	status.classList.toggle('off', phase === 'off');
	status.classList.toggle('predicting', phase === 'predicting');
	status.classList.toggle('ready', phase === 'ready');
	append(status, $('span.v3-go-live-dot'));
	append(status, $(`span.codicon.codicon-${phase === 'predicting' ? 'loading' : phase === 'ready' ? 'check' : 'sync'}`));
	append(status, $('span')).textContent = pending
		? localize('v3Go.statusProcessed', "Ready · 1 change point")
		: phaseLabel(phase);

	const keys = append(host, $('div.v3-go-keys'));
	const addKey = (label: string, key: string) => {
		const row = append(keys, $('span.v3-go-key'));
		append(row, $('kbd')).textContent = key;
		append(row, $('span')).textContent = label;
	};
	addKey(localize('v3Go.keyAccept', 'Accept'), 'Tab');
	addKey(localize('v3Go.keyReject', 'Reject'), 'Esc');

	if (pending) {
		const point = append(host, $('div.v3-go-point'));
		point.title = localize('v3Go.jumpTitle', "Jump to predicted edit");
		const rail = append(point, $('div.v3-go-rail'));
		append(rail, $('div.v3-go-dot'));
		const body = append(point, $('div.v3-go-point-body'));
		append(body, $('div.v3-go-point-title')).textContent = pending.preview || localize('v3Go.unnamed', "Predicted edit");
		append(body, $('div.v3-go-point-meta')).textContent = `${basename(pending.uri)} · L${pending.range.startLineNumber}`;
		store.add(addDisposableListener(point, EventType.CLICK, () => nextEditService.revealPending()));
	} else if (!autocompleteOn || phase === 'off') {
		const cta = append(host, $('div.v3-go-cta'));
		append(cta, $('span.codicon.codicon-sparkle'));
		const ctaBody = append(cta, $('div'));
		append(ctaBody, $('div.v3-go-cta-title')).textContent = localize('v3Go.ctaTitle', "Next-edit prediction is off");
		const sub = append(ctaBody, $('div.v3-go-cta-sub'));
		sub.appendChild(mainWindow.document.createTextNode(localize('v3Go.ctaPrefix', 'Turn on ')));
		const link = append(sub, $('span.link'));
		link.textContent = localize('v3Go.ctaLink', 'Autocomplete');
		sub.appendChild(mainWindow.document.createTextNode(localize('v3Go.ctaSuffix', ' to enable V Go')));
		store.add(addDisposableListener(cta, EventType.CLICK, () => {
			voidSettingsService.setGlobalSetting('enableAutocomplete', true);
		}));
	} else {
		append(host, $('p.v3-go-empty')).textContent = localize(
			'v3Go.empty',
			"No change points yet — make an edit and pause; V Go fills in here.",
		);
	}

	const files = index.filesIndexed ?? index.filesTotal ?? 0;
	const foot = append(host, $('div.v3-go-foot'));
	foot.textContent = localize(
		'v3Go.foot',
		"Index · {0} files · Context Bridge feeds predictions",
		String(files),
	);
}

/** Tiny registry so status-bar / commands can focus the Agents-rail dock. */
export const IV3GoDockService = createDecorator<IV3GoDockService>('v3GoDockService');
export interface IV3GoDockService {
	readonly _serviceBrand: undefined;
	register(dock: V3GoDock): void;
	unregister(dock: V3GoDock): void;
	focus(): void;
	readonly onDidChangeHeight: Event<number>;
}

class V3GoDockService extends Disposable implements IV3GoDockService {
	declare readonly _serviceBrand: undefined;
	private _dock: V3GoDock | undefined;
	private readonly _heightListener = this._register(new MutableDisposable());
	private readonly _onDidChangeHeight = this._register(new Emitter<number>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	register(dock: V3GoDock): void {
		this._dock = dock;
		this._heightListener.value = dock.onDidChangeHeight(h => this._onDidChangeHeight.fire(h));
	}
	unregister(dock: V3GoDock): void {
		if (this._dock === dock) {
			this._dock = undefined;
			this._heightListener.clear();
		}
	}
	focus(): void {
		this._dock?.focus();
	}
}

registerSingleton(IV3GoDockService, V3GoDockService, InstantiationType.Delayed);

/**
 * Compact / expandable V Go strip for the Agents rail — sits above the plan/account chip.
 */
export class V3GoDock extends Disposable {
	readonly element: HTMLElement;
	private readonly _head: HTMLElement;
	private readonly _headStatus: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _bodyStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly _editorAutorun = this._register(new MutableDisposable());
	private readonly _idleScheduler: RunOnceScheduler;
	private _inlineSuggestionActive = false;
	private _expanded = false;
	private _pinnedOpen = false;
	private readonly _onDidChangeHeight = this._register(new Emitter<number>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(
		@INextEditService private readonly nextEditService: INextEditService,
		@ISemanticIndexService private readonly semanticIndexService: ISemanticIndexService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IV3GoDockService private readonly dockService: IV3GoDockService,
	) {
		super();
		injectStyles();
		this.element = $('.v3-go-dock');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('v3Go.dockAria', 'V Go next-edit prediction'));

		this._head = append(this.element, $('.v3-go-dock-head'));
		this._head.tabIndex = 0;
		append(this._head, $('span.v3-go-dock-title')).textContent = localize('v3Go.nameShort', 'V Go');
		this._headStatus = append(this._head, $('span.v3-go-dock-head-status'));
		const chevron = append(this._head, $('span.v3-go-dock-chevron.codicon.codicon-chevron-up'));
		chevron.setAttribute('aria-hidden', 'true');

		this._body = append(this.element, $('.v3-go-dock-body'));

		this._idleScheduler = this._register(new RunOnceScheduler(() => this._applyIdle(), V3_GO_IDLE_DEBOUNCE_MS));

		this._register(addDisposableListener(this._head, EventType.CLICK, () => {
			this._pinnedOpen = !this._expanded;
			this._setExpanded(this._pinnedOpen);
		}));
		this._register(addDisposableListener(this._head, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._pinnedOpen = !this._expanded;
				this._setExpanded(this._pinnedOpen);
			}
		}));

		this._register(this.nextEditService.onDidChangeState(() => this._recompute()));
		this._register(this.semanticIndexService.onDidChangeStatus(() => this._render()));
		this._register(this.voidSettingsService.onDidChangeState(() => this._render()));
		this._bindFocusedEditor();
		for (const editor of this.codeEditorService.listCodeEditors()) {
			this._trackEditorFocus(editor);
		}
		this._register(this.codeEditorService.onCodeEditorAdd(editor => this._trackEditorFocus(editor)));

		this.dockService.register(this);
		this._register({ dispose: () => this.dockService.unregister(this) });

		this._render();
		this._recompute();
	}

	get height(): number {
		const content = this._expanded ? V3_GO_DOCK_ACTIVE_HEIGHT : V3_GO_DOCK_IDLE_HEIGHT;
		// Top (4) + bottom margin so Agents list layout reserves the full footprint.
		return content + 4 + V3_GO_DOCK_MARGIN_BOTTOM;
	}

	focus(): void {
		this._pinnedOpen = true;
		this._setExpanded(true);
		this._head.focus();
	}

	private _trackEditorFocus(editor: ICodeEditor): void {
		this._register(editor.onDidFocusEditorText(() => this._bindFocusedEditor()));
		this._register(editor.onDidBlurEditorText(() => this._bindFocusedEditor()));
	}

	private _bindFocusedEditor(): void {
		const editor = this.codeEditorService.getFocusedCodeEditor()
			?? this.codeEditorService.listCodeEditors().find(e => e.hasTextFocus());
		this._editorAutorun.clear();
		if (!editor) {
			this._inlineSuggestionActive = false;
			this._recompute();
			return;
		}
		const model = editor.getModel();
		if (model?.uri.scheme === Schemas.vscodeChatInput) {
			this._inlineSuggestionActive = false;
			this._recompute();
			return;
		}
		const controller = InlineCompletionsController.get(editor);
		if (!controller) {
			this._inlineSuggestionActive = false;
			this._recompute();
			return;
		}
		this._editorAutorun.value = autorun(reader => {
			const state = controller.model.read(reader)?.state.read(reader);
			this._inlineSuggestionActive = !!state;
			this._recompute();
		});
	}

	private _isBusy(): boolean {
		const phase = this.nextEditService.getPhase();
		const nesBusy = phase === 'predicting' || phase === 'ready' || !!this.nextEditService.getPending();
		return nesBusy || this._inlineSuggestionActive;
	}

	private _recompute(): void {
		this._render();
		if (this._isBusy()) {
			this._idleScheduler.cancel();
			this._setExpanded(true);
		} else if (!this._pinnedOpen) {
			this._idleScheduler.schedule();
		}
	}

	private _applyIdle(): void {
		if (this._isBusy() || this._pinnedOpen) {
			return;
		}
		this._setExpanded(false);
	}

	private _setExpanded(expanded: boolean): void {
		if (this._expanded === expanded) {
			this._render();
			return;
		}
		this._expanded = expanded;
		this.element.classList.toggle('is-active', expanded);
		this._render();
		this._onDidChangeHeight.fire(this.height);
	}

	private _render(): void {
		const phase = this.nextEditService.getPhase();
		const pending = this.nextEditService.getPending();
		this._headStatus.textContent = pending
			? localize('v3Go.statusProcessed', "Ready · 1 change point")
			: phaseLabel(phase);
		this._headStatus.classList.toggle('off', phase === 'off');

		const store = new DisposableStore();
		this._bodyStore.value = store;
		renderGoBody(this._body, store, this.nextEditService, this.semanticIndexService, this.voidSettingsService);
	}
}

/** Strip any leftover Explorer registration from older builds. */
class V3GoPurgeExplorerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.vGo.purgeExplorer';
	constructor() {
		super();
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const leftover = viewsRegistry.getViews(VIEW_CONTAINER).filter(v => v.id === V3_GO_VIEW_ID);
		if (leftover.length) {
			viewsRegistry.deregisterViews(leftover, VIEW_CONTAINER);
		}
	}
}
registerWorkbenchContribution2(V3GoPurgeExplorerContribution.ID, V3GoPurgeExplorerContribution, WorkbenchPhase.BlockStartup);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3_GO_TOGGLE_ID,
			title: localize2('v3Go.toggle', 'Toggle V Go / Next Edit'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const settings = accessor.get(IVoidSettingsService);
		const agentLayout = accessor.get(IAgentLayoutService);
		const dock = accessor.get(IV3GoDockService);
		const on = !!settings.state.globalSettings.enableAutocomplete;
		settings.setGlobalSetting('enableAutocomplete', !on);
		await agentLayout.showAgentsSidebar(true);
		dock.focus();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3_GO_FOCUS_ID,
			title: localize2('v3Go.focus', 'Focus V Go'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const agentLayout = accessor.get(IAgentLayoutService);
		const dock = accessor.get(IV3GoDockService);
		await agentLayout.showAgentsSidebar(true);
		dock.focus();
	}
});

/** Footer control — always-visible V Go in the status bar. */
class V3GoStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.vGo.statusBar';

	private entry: IStatusbarEntryAccessor | null = null;

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@INextEditService private readonly nextEditService: INextEditService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
		injectStyles();
		this._render();
		this._register(this.nextEditService.onDidChangeState(() => this._render()));
		this._register(this.voidSettingsService.onDidChangeState(() => this._render()));
	}

	private _render(): void {
		const phase = this.nextEditService.getPhase();
		const pending = this.nextEditService.getPending();
		let text: string;
		let tooltip: string;
		if (phase === 'off') {
			text = '$(circle-slash) V Go';
			tooltip = localize('v3Go.sb.off', "V Go off — click to enable next-edit prediction");
		} else if (phase === 'predicting') {
			text = '$(sync~spin) V Go';
			tooltip = localize('v3Go.sb.predicting', "Predicting your next edit…");
		} else if (phase === 'ready' || pending) {
			text = '$(check) V Go · Tab';
			tooltip = localize('v3Go.sb.ready', "Next edit ready — press Tab, or click to open V Go");
		} else {
			text = '$(arrow-right) V Go';
			tooltip = localize('v3Go.sb.idle', "V Go watching — click to open in Agents");
		}

		const entry: IStatusbarEntry = {
			name: localize('v3Go.sb.name', 'V Go'),
			text,
			ariaLabel: localize('v3Go.sb.aria', 'V Go next-edit prediction'),
			tooltip,
			command: phase === 'off' ? V3_GO_TOGGLE_ID : V3_GO_FOCUS_ID,
			kind: phase === 'ready' || pending ? 'prominent' : undefined,
		};

		if (!this.entry) {
			this.entry = this._register(this.statusbar.addEntry(entry, 'v3code.vGo', StatusbarAlignment.RIGHT, 56));
		} else {
			this.entry.update(entry);
		}

		const el = mainWindow.document.getElementById('status.v3code.vGo');
		if (el) {
			el.classList.toggle('v3-go-sb-ready', phase === 'ready' || !!pending);
			el.classList.toggle('v3-go-sb-off', phase === 'off');
		}
	}
}

registerWorkbenchContribution2(V3GoStatusBarContribution.ID, V3GoStatusBarContribution, WorkbenchPhase.AfterRestored);
