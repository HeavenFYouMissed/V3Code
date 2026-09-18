/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3 SOLO Tabs — compact surface tabs in the titlebar, shown only in V3 agent mode.
 *
 * Sits right beside the V3/IDE pill (v3AgentMode.ts). Each tab swaps what occupies
 * the window next to the chat:
 *
 *   Flow     → Sessions sidebar + separate full-height Chat area
 *   Editor   → chat + editor + explorer + top activity bar + half-height terminal
 *   Browser  → chat + integrated browser — no activity bar, no explorer
 *   Terminal → chat + full-screen terminal — no activity bar, no explorer
 *
 * Visibility is pure CSS: v3AgentMode toggles `v3-agent-mode` on <body>, the strip
 * only renders under that class. No cross-contribution wiring needed beyond the
 * shared context key for state reset.
 */

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IAgentLayoutService } from './agentLayoutService.js';
import { shouldRestoreFlow, V3RestoreTrigger, V3SoloSurface } from '../common/v3FlowLayoutState.js';

const STYLE_ELEMENT_ID = 'v3-solo-tabs-styles';

/** The currently selected V3 surface tab, so other contributions (agent-surface hygiene)
 *  can tell an agent-revealed browser apart from a Browser surface the user chose. */
export const V3_SOLO_SURFACE_CONTEXT_KEY = new RawContextKey<V3SoloSurface>('v3code.soloSurface', 'flow');

/**
 * Same runtime <style> injection trick as v3AgentMode.ts — a fresh CSS module
 * import would break the bundled CSS manifest, a <style> tag always works.
 * All backgrounds are rgba so the pills tint ANY theme's titlebar (the tinting trick).
 */
const STYLES = `
.monaco-workbench .titlebar-left .v3-solo-tabs {
	display: none; align-items: center; height: 22px;
	margin: 0 4px 0 0; padding: 2px; border-radius: 6px; gap: 1px;
	background: rgba(255, 255, 255, 0.045);
	border: 1px solid rgba(255, 255, 255, 0.06);
	box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.15);
	-webkit-app-region: no-drag; user-select: none; flex: 0 0 auto;
}
body.v3-agent-mode .monaco-workbench .titlebar-left .v3-solo-tabs { display: inline-flex; }
.monaco-workbench .titlebar-left .v3-solo-tab {
	display: inline-flex; align-items: center; justify-content: center;
	height: 18px; padding: 0 9px; border-radius: 4px;
	font-size: 10px; font-weight: 600; letter-spacing: 0.25px;
	color: var(--vscode-descriptionForeground, #9599a6);
	cursor: pointer;
	transition: background 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
.monaco-workbench .titlebar-left .v3-solo-tab:hover {
	color: var(--vscode-foreground, #dddddd);
	background: rgba(255, 255, 255, 0.07);
}
.monaco-workbench .titlebar-left .v3-solo-tab.active {
	color: #0a0a0c;
	background: linear-gradient(180deg, #ffffff 0%, #e9e9ec 100%);
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}
`;

function injectStyles(): void {
	const doc = mainWindow.document;
	if (doc.getElementById(STYLE_ELEMENT_ID)) { return; }
	const style = doc.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

class V3SoloTabsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3SoloTabs';

	private _strip: HTMLElement | undefined;
	private readonly _tabEls = new Map<V3SoloSurface, HTMLElement>();
	private _activeTab: V3SoloSurface = 'flow';
	private _v3ModeActive = false;
	private _pendingSurface: V3SoloSurface | undefined;
	private _surfaceTransition: Promise<void> = Promise.resolve();
	private readonly _restoreFlowScheduler: RunOnceScheduler;
	private readonly _activateSurfaceScheduler: RunOnceScheduler;
	private readonly _reinjectObserver = this._register(new MutableDisposable());
	private readonly _surfaceKey: IContextKey<V3SoloSurface>;
	/** A rubber-band restore is in flight: ignore the layout events it causes itself. */
	private _restoring = false;
	/** An explicit surface tab is being applied: its own reveal/open steps must not be
	 *  read as "the right side is empty" by the band mid-flight. */
	private _applyingSurface = false;
	/** Once per genuine emptying: after a restore, don't try again until something was
	 *  open on the right — bounds any thrash to one attempt. */
	private _restoredForEmptyState = false;
	/** What triggered the pending band check, captured at event time (before the layout
	 *  engine reacts): an editor close remembers whether the panel was already up. */
	private _pendingTrigger: { trigger: V3RestoreTrigger; panelWasVisibleBefore: boolean } | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IHistoryService private readonly historyService: IHistoryService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IAgentLayoutService private readonly agentLayoutService: IAgentLayoutService,
	) {
		super();
		this._v3ModeActive = contextKeyService.getContextKeyValue<boolean>('v3code.agentMode') === true;
		this._surfaceKey = V3_SOLO_SURFACE_CONTEXT_KEY.bindTo(contextKeyService);
		this._restoreFlowScheduler = this._register(new RunOnceScheduler(() => void this._maybeRestoreFlow(), 0));
		this._activateSurfaceScheduler = this._register(new RunOnceScheduler(() => this._flushPendingSurface(), 60));

		injectStyles();
		this._ensureStrip();
		this._observeTitleBar();

		// Entering V3 mode always lands on the split Sessions + Chat Flow layout.
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set(['v3code.agentMode']))) {
				this._v3ModeActive = contextKeyService.getContextKeyValue<boolean>('v3code.agentMode') === true;
				if (this._v3ModeActive) {
					this._setActive('flow');
				}
			}
		}));

		// The rubber band: whenever the right side may have just become empty — an editor
		// closed, a group went away, the panel was hidden — check whether Chat should
		// snap back to full width. The pure decision (shouldRestoreFlow) only fires when
		// NOTHING is left on the right, so open files are never hidden from under the user.
		this._register(this.editorService.onDidCloseEditor(() => this._scheduleBandCheck('editor-close')));
		this._register(this.editorGroupsService.onDidRemoveGroup(() => this._scheduleBandCheck('editor-close')));
		this._register(this.layoutService.onDidChangePartVisibility(() => this._scheduleBandCheck('part-visibility')));
	}

	private _scheduleBandCheck(trigger: V3RestoreTrigger): void {
		// Coalesce a burst into one check. An editor close wins over the visibility
		// events it causes (the layout engine reopening the remembered terminal is
		// exactly the stray case the decision needs to see as 'editor-close').
		if (trigger === 'editor-close') {
			this._pendingTrigger = { trigger, panelWasVisibleBefore: this.layoutService.isVisible(Parts.PANEL_PART) };
		} else if (!this._pendingTrigger) {
			this._pendingTrigger = { trigger, panelWasVisibleBefore: this.layoutService.isVisible(Parts.PANEL_PART) };
		}
		this._restoreFlowScheduler.schedule();
	}

	private _openEditorCount(): number {
		let count = 0;
		for (const group of this.editorGroupsService.groups) { count += group.count; }
		return count;
	}

	// --- DOM -----------------------------------------------------------------

	private _observeTitleBar(): void {
		const observer = new MutationObserver(() => {
			if (!this._strip || !this._strip.isConnected) {
				this._ensureStrip();
			}
		});
		observer.observe(mainWindow.document.body, { childList: true, subtree: true });
		this._reinjectObserver.value = { dispose: () => observer.disconnect() };
	}

	private _ensureStrip(): void {
		const titlebarLeft = mainWindow.document.querySelector('.titlebar-left') as HTMLElement | null;
		if (!titlebarLeft) { return; }
		if (this._strip && this._strip.isConnected) { return; }

		const strip = $('div.v3-solo-tabs');
		strip.setAttribute('role', 'tablist');
		strip.setAttribute('aria-label', localize('v3SoloTabs.aria', 'V3 surface tabs'));

		const tabs: Array<{ id: V3SoloSurface; label: string; title: string }> = [
			{ id: 'flow', label: localize('v3SoloTabs.flow', "Flow"), title: localize('v3SoloTabs.flowTitle', "Full chat") },
			{ id: 'editor', label: localize('v3SoloTabs.editor', "Editor"), title: localize('v3SoloTabs.editorTitle', "Chat + editor") },
			{ id: 'browser', label: localize('v3SoloTabs.browser', "Browser"), title: localize('v3SoloTabs.browserTitle', "Chat + integrated browser") },
			{ id: 'terminal', label: localize('v3SoloTabs.terminal', "Terminal"), title: localize('v3SoloTabs.terminalTitle', "Chat + terminal") },
		];

		this._tabEls.clear();
		for (const { id, label, title } of tabs) {
			const el = append(strip, $(`div.v3-solo-tab.v3-solo-tab-${id}`));
			el.textContent = label;
			el.title = title;
			el.setAttribute('role', 'tab');
			this._register(addDisposableListener(el, EventType.CLICK, () => this._activate(id)));
			this._tabEls.set(id, el);
		}

		// Mount right after the V3/IDE pill when present, otherwise at the front.
		const pill = titlebarLeft.querySelector('.v3-mode-pill');
		if (pill && pill.nextSibling) {
			titlebarLeft.insertBefore(strip, pill.nextSibling);
		} else if (pill) {
			titlebarLeft.appendChild(strip);
		} else {
			titlebarLeft.insertBefore(strip, titlebarLeft.firstChild);
		}

		this._strip = strip;
		this._setActive(this._activeTab);
	}

	private _setActive(tab: V3SoloSurface): void {
		this._activeTab = tab;
		this._surfaceKey.set(tab);
		for (const [id, el] of this._tabEls) {
			el.classList.toggle('active', id === tab);
		}
	}

	// --- Surface switching ---------------------------------------------------

	/**
	 * Activity bar rules:
	 *   IDE mode       → left rail (`default`) via agentLayoutService.enterIdeLayout
	 *   V3 Flow/Editor → top-of-sidebar (`top`) — never DEFAULT while sidebar is right
	 *   Browser/Terminal → hidden (no explorer rail on those surfaces)
	 */
	private _setV3ActivityBarVisible(visible: boolean): void {
		void this.configurationService.updateValue(
			LayoutSettings.ACTIVITY_BAR_LOCATION,
			visible ? ActivityBarPosition.TOP : ActivityBarPosition.HIDDEN,
		);
	}

	private _setExplorerVisible(visible: boolean): void {
		if (visible) {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		} else if (this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}
	}

	private _activate(tab: V3SoloSurface): void {
		this.logService.info(`[v3SoloTabs] activate ${tab}`);
		this._setActive(tab);
		// Coalesce a rapid run of clicks to the final requested surface. Replaying
		// Browser → Terminal → Flow in full can leave an awaited Terminal view open
		// while the UI already says Flow. A short debounce makes the visible final
		// choice the only transition that runs.
		this._pendingSurface = tab;
		this._activateSurfaceScheduler.schedule();
	}

	private _flushPendingSurface(): void {
		const tab = this._pendingSurface;
		this._pendingSurface = undefined;
		if (!tab) { return; }
		this._applyingSurface = true;
		this._surfaceTransition = this._surfaceTransition
			.then(() => this._applySurface(tab))
			.catch(err => this.logService.error(`[v3SoloTabs] activate ${tab} failed`, err))
			.finally(() => {
				this._applyingSurface = false;
				if (this._pendingSurface) {
					this._activateSurfaceScheduler.schedule(0);
				}
			});
	}

	private async _applySurface(tab: V3SoloSurface): Promise<void> {
		switch (tab) {
				case 'flow': {
					if (this.layoutService.isPanelMaximized()) { this.layoutService.toggleMaximizedPanel(); }
					await this.agentLayoutService.enterFlowLayout();
					break;
				}
				case 'editor': {
					await this.agentLayoutService.enterEditorSurfaceLayout();
					// Editor surface = editor area + a HALF-HEIGHT terminal panel docked
					// under it. Showing a hidden panel can restore its remembered
					// maximized state, so normalize it only after it is visible.
					this.layoutService.setPartHidden(false, Parts.PANEL_PART);
					if (this.layoutService.isPanelMaximized()) { this.layoutService.toggleMaximizedPanel(); }
					if (this.editorGroupsService.activeGroup.count === 0) {
						await this._openMostRecentEditor();
					}
					this.editorGroupsService.activeGroup.focus();
					break;
				}
				case 'browser': {
					await this.agentLayoutService.ensureChatOnLeft();
					this._setV3ActivityBarVisible(false);
					this._setExplorerVisible(false);
					await this.agentLayoutService.showAgentsSidebar(false);
					this._revealSurfaceArea();
					if (this.layoutService.isVisible(Parts.PANEL_PART)) { this.layoutService.setPartHidden(true, Parts.PANEL_PART); }
					await this._openOrRevealBrowser();
					break;
				}
				case 'terminal': {
					await this.agentLayoutService.ensureChatOnLeft();
					this._setV3ActivityBarVisible(false);
					this._setExplorerVisible(false);
					await this.agentLayoutService.showAgentsSidebar(false);
					// Terminal button = FULL-SCREEN terminal surface beside chat.
					this._revealSurfaceArea();
					this.layoutService.setPartHidden(false, Parts.PANEL_PART);
					await this.viewsService.openView(TERMINAL_VIEW_ID, true);
					if (!this.layoutService.isPanelMaximized()) { this.layoutService.toggleMaximizedPanel(); }
					break;
				}
		}
	}

	private _shouldRestoreNow(pending: { trigger: V3RestoreTrigger; panelWasVisibleBefore: boolean }): boolean {
		const openEditorCount = this._openEditorCount();
		// Something was on the right again: re-arm the once-per-emptying breaker.
		if (openEditorCount > 0) { this._restoredForEmptyState = false; }
		return shouldRestoreFlow({
			v3ModeActive: this._v3ModeActive,
			activeSurface: this._activeTab,
			openEditorCount,
			editorPartVisible: this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
			panelVisible: this.layoutService.isVisible(Parts.PANEL_PART),
			auxiliaryBarMaximized: this.layoutService.isAuxiliaryBarMaximized(),
			trigger: pending.trigger,
			panelWasVisibleBeforeTrigger: pending.panelWasVisibleBefore,
		});
	}

	private async _maybeRestoreFlow(): Promise<void> {
		const pending = this._pendingTrigger;
		this._pendingTrigger = undefined;
		if (!pending) { return; }
		// Events raised by a restore or by an explicit surface tab's own reveal/open
		// steps must not re-enter: the final state of those transitions is what the
		// user asked for, and the Browser/Editor tabs open their content only AFTER
		// revealing the (momentarily empty) editor area.
		if (this._restoring || this._applyingSurface || this._pendingSurface !== undefined) { return; }
		if (!this._shouldRestoreNow(pending)) { return; }
		if (this._restoredForEmptyState) { return; } // already restored for this emptying; no thrash
		this.logService.info('[v3SoloTabs] right side is empty; Chat takes the window back');
		this._restoring = true;
		this._surfaceTransition = this._surfaceTransition
			.then(async () => {
				// Re-evaluate at ACTION time: a queued transition ahead of us (a surface
				// tab click, another restore) may have changed what is on the right.
				if (this._applyingSurface || !this._shouldRestoreNow(pending)) { return; }
				this._restoredForEmptyState = true;
				this._setActive('flow');
				await this.agentLayoutService.enterFlowLayout();
			})
			.catch(err => this.logService.error('[v3SoloTabs] failed to restore Flow', err))
			.finally(() => { this._restoring = false; });
		await this._surfaceTransition;
	}

	/** Chat stays put; bring the editor area back beside it. */
	private _revealSurfaceArea(): void {
		if (this.layoutService.isAuxiliaryBarMaximized()) { this.layoutService.setAuxiliaryBarMaximized(false); }
		// Clear any leftover maximized-panel state from the Terminal surface so the
		// editor/browser is actually visible.
		if (this.layoutService.isPanelMaximized()) { this.layoutService.toggleMaximizedPanel(); }
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
	}

	/** Reopen the most recently used file so the Editor surface never shows up empty. */
	private async _openMostRecentEditor(): Promise<void> {
		// getHistory() yields (EditorInput | IResourceEditorInput); both expose
		// `.resource`, so read it off the union directly (no unsafe cast).
		for (const entry of this.historyService.getHistory()) {
			const resource = entry.resource;
			if (resource) {
				await this.editorService.openEditor({ resource, options: { pinned: false } });
				return;
			}
		}
	}

	private async _openOrRevealBrowser(): Promise<void> {
		// Reuse an existing browser editor anywhere in the window before spawning one.
		for (const group of this.editorGroupsService.groups) {
			const existing = group.editors.find(e => e instanceof BrowserEditorInput);
			if (existing) {
				await this.editorService.openEditor(existing, undefined, group);
				return;
			}
		}
		await this.editorService.openEditor({
			resource: BrowserViewUri.forId(generateUuid()),
			options: { pinned: true },
		});
	}

	override dispose(): void {
		this._strip?.remove();
		super.dispose();
	}
}

registerWorkbenchContribution2(V3SoloTabsContribution.ID, V3SoloTabsContribution, WorkbenchPhase.AfterRestored);
