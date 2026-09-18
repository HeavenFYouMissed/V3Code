/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3 Agent Mode — a "V3 / IDE" pill in the top-left of the title bar.
 *
 * Clicking the pill (or Ctrl+Alt+\) slides the editor off-screen and brings up
 * the agent layout: a dedicated full-height Sessions sidebar beside the native
 * chat auxiliary bar. We reuse real workbench parts and only orchestrate their
 * layout + a transform-based slide, so nothing is rebuilt from scratch.
 */

import { $, append, addDisposableListener, EventType, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IAgentLayoutService } from './agentLayoutService.js';
import { initialV3AgentModePreference, V3_AGENT_MODE_LEGACY_WORKSPACE_KEY, V3_AGENT_MODE_PREFERENCE_KEY } from '../common/v3AgentModeState.js';

const TOGGLE_COMMAND_ID = 'v3code.toggleAgentMode';
const ENTER_COMMAND_ID = 'v3code.enterAgentMode';
const ANIM_MS = 320;
const STYLE_ELEMENT_ID = 'v3-agent-mode-styles';

/**
 * Styles are injected at runtime rather than imported as a CSS module. VS Code's
 * build bundles known CSS into workbench.desktop.main.css via a manifest; a brand
 * new `import './x.css'` isn't in that manifest and breaks the ESM module graph.
 * A <style> tag sidesteps the build entirely and is fully reliable.
 */
const STYLES = `
.monaco-workbench .titlebar-left .v3-mode-pill {
	position: relative; z-index: 10;
	display: inline-flex; align-items: center; height: 22px;
	margin: 0 8px 0 6px; padding: 2px; border-radius: 6px; gap: 1px;
	background: rgba(255, 255, 255, 0.055);
	border: 1px solid rgba(255, 255, 255, 0.07);
	box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.18);
	-webkit-app-region: no-drag; user-select: none; cursor: pointer; flex: 0 0 auto;
}
/* Native macOS traffic lights are not represented by a titlebar DOM node.
 * Keep the mode switch outside their control area without leaving a wide gap. */
.monaco-workbench.mac:not(.web):not(.fullscreen) .titlebar-left .v3-mode-pill {
	margin-left: 66px;
}
.monaco-workbench .titlebar-left .v3-mode-pill-side {
	display: inline-flex; align-items: center; justify-content: center;
	height: 18px; padding: 0 7px; border-radius: 4px;
	font-size: 10px; font-weight: 700; letter-spacing: 0.3px;
	color: var(--vscode-descriptionForeground, #9599a6);
	transition: background 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
.monaco-workbench .titlebar-left .v3-mode-pill-side.active {
	color: #0a0a0c;
	background: linear-gradient(180deg, #ffffff 0%, #e9e9ec 100%);
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}
.monaco-workbench .part.editor, .monaco-workbench .part.auxiliarybar { will-change: transform; }
.monaco-workbench.v3-agent-animating .part.editor,
.monaco-workbench.v3-agent-animating .part.auxiliarybar,
.monaco-workbench.v3-agent-animating .part.sidebar {
	transition: transform 320ms cubic-bezier(0.33, 1, 0.68, 1), opacity 240ms ease;
}
.monaco-workbench.v3-agent-enter .part.editor { transform: translateX(-8%); opacity: 0; }
.monaco-workbench.v3-agent-return-start .part.editor { transform: translateX(-8%); opacity: 0; }
.monaco-workbench.v3-agent-mode .part.auxiliarybar {
	background: radial-gradient(120% 120% at 50% 0%,
		var(--vscode-editor-background, #15171a) 0%, var(--vscode-sideBar-background, #1a1b1d) 100%);
}
.monaco-workbench.v3-agent-mode .part.auxiliarybar .pane-body { display: flex; justify-content: center; }
.monaco-workbench.v3-agent-mode .part.auxiliarybar .pane-body > * { width: 100%; max-width: 920px; }
`;

function injectStyles(): void {
	const doc = mainWindow.document;
	if (doc.getElementById(STYLE_ELEMENT_ID)) { return; }
	const style = doc.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

const V3_AGENT_MODE_KEY = new RawContextKey<boolean>('v3code.agentMode', false);

interface SavedLayout {
	sidebarHidden: boolean;
	sidebarContainerId: string | undefined;
	sidebarWidth: number;
	auxBarHidden: boolean;
	panelHidden: boolean;
	editorHidden: boolean;
	auxBarMaximized: boolean;
}

class V3AgentModeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3AgentMode';
	static INSTANCE: V3AgentModeContribution | undefined;

	private _active = false;
	private _animating = false;
	private _saved: SavedLayout | null = null;

	private readonly _ctxKey: IContextKey<boolean>;

	// Pill DOM
	private _pill: HTMLElement | undefined;
	private _v3Side: HTMLElement | undefined;
	private _ideSide: HTMLElement | undefined;
	private readonly _reinjectObserver = this._register(new MutableDisposable());

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IViewsService private readonly viewsService: IViewsService,
		@IAgentLayoutService private readonly agentLayoutService: IAgentLayoutService,
	) {
		super();
		V3AgentModeContribution.INSTANCE = this;
		this._ctxKey = V3_AGENT_MODE_KEY.bindTo(contextKeyService);

		injectStyles();

		// Inject the pill once the workbench DOM exists, and keep it injected if
		// the title bar is recreated (config/layout changes rebuild it).
		this._ensurePill();
		this._observeTitleBar();

		// V3 is the fresh-install default and follows the user across projects. Honor
		// the old per-workspace value once when upgrading, then move the choice to
		// profile scope so opening a folder cannot silently switch the product mode.
		const profilePreference = this.storageService.getBoolean(V3_AGENT_MODE_PREFERENCE_KEY, StorageScope.PROFILE);
		const legacyWorkspacePreference = this.storageService.getBoolean(V3_AGENT_MODE_LEGACY_WORKSPACE_KEY, StorageScope.WORKSPACE);
		const startInV3 = initialV3AgentModePreference(profilePreference, legacyWorkspacePreference);
		if (profilePreference === undefined) {
			this.storageService.store(V3_AGENT_MODE_PREFERENCE_KEY, startInV3, StorageScope.PROFILE, StorageTarget.USER);
		}
		if (startInV3) {
			scheduleAtNextAnimationFrame(mainWindow, () => {
				if (!this._active) { this._enter(/*animate*/ false); }
			});
		}
	}

	// --- Pill ----------------------------------------------------------------

	private get _workbenchEl(): HTMLElement | null {
		return mainWindow.document.querySelector('.monaco-workbench') as HTMLElement | null;
	}

	private _observeTitleBar(): void {
		const observer = new MutationObserver(() => {
			if (!this._pill || !this._pill.isConnected) {
				this._ensurePill();
			}
		});
		observer.observe(mainWindow.document.body, { childList: true, subtree: true });
		this._reinjectObserver.value = { dispose: () => observer.disconnect() };
	}

	private _ensurePill(): void {
		const titlebarLeft = mainWindow.document.querySelector('.titlebar-left') as HTMLElement | null;
		if (!titlebarLeft) { return; }
		if (this._pill && this._pill.isConnected) { return; }

		const pill = $('div.v3-mode-pill');
		pill.setAttribute('role', 'button');
		pill.setAttribute('aria-label', localize('v3AgentMode.aria', 'V3 / IDE mode switch'));
		pill.title = localize('v3AgentMode.tooltip', 'Switch V3 / IDE mode (Ctrl+Alt+\\)');

		const v3 = append(pill, $('div.v3-mode-pill-side.v3-side'));
		v3.textContent = 'V3';

		const ide = append(pill, $('div.v3-mode-pill-side.ide-side'));
		ide.textContent = 'IDE';

		// The whole pill toggles — clicking either side flips modes.
		this._register(addDisposableListener(pill, EventType.CLICK, () => this.toggle()));

		// Insert right after the window app-icon if present, else at the front.
		const appIcon = titlebarLeft.querySelector('.window-appicon');
		if (appIcon && appIcon.nextSibling) {
			titlebarLeft.insertBefore(pill, appIcon.nextSibling);
		} else if (appIcon) {
			titlebarLeft.appendChild(pill);
		} else {
			titlebarLeft.insertBefore(pill, titlebarLeft.firstChild);
		}

		this._pill = pill;
		this._v3Side = v3;
		this._ideSide = ide;
		this._updatePill();
	}

	private _updatePill(): void {
		this._v3Side?.classList.toggle('active', this._active);
		this._ideSide?.classList.toggle('active', !this._active);
	}

	// --- Toggle / Enter / Exit -----------------------------------------------

	toggle(): void {
		this.logService.info(`[v3AgentMode] toggle() active=${this._active} animating=${this._animating}`);
		if (this._animating) { return; }
		if (this._active) { this._exit(/*animate*/ true); }
		else { this._enter(/*animate*/ true); }
	}

	enter(): void {
		if (!this._active && !this._animating) {
			this._enter(/*animate*/ true);
		}
	}

	private _enter(animate: boolean): void {
		if (this._active) { return; }
		const wb = this._workbenchEl;

		let sidebarWidth = 300;
		try {
			sidebarWidth = this.layoutService.getSize(Parts.SIDEBAR_PART).width;
		} catch {
			// Grid may still be initializing on restore — keep a safe default.
		}
		this._saved = {
			sidebarHidden: !this.layoutService.isVisible(Parts.SIDEBAR_PART),
			sidebarContainerId: this.viewsService.getVisibleViewContainer(ViewContainerLocation.Sidebar)?.id,
			sidebarWidth,
			auxBarHidden: !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART),
			panelHidden: !this.layoutService.isVisible(Parts.PANEL_PART),
			editorHidden: !this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
			auxBarMaximized: this.layoutService.isAuxiliaryBarMaximized(),
		};

		const commit = () => {
			void this.agentLayoutService.enterFlowLayout().then(() => {
				this.logService.info('[v3AgentMode] enter committed: unified Agents rail + Chat Flow');
			}, err => {
				this.logService.error('[v3AgentMode] enter commit failed', err);
			}).finally(() => {
				mainWindow.document.body.classList.add('v3-agent-mode');
				wb?.classList.remove('v3-agent-enter', 'v3-agent-animating');
				this._animating = false;
			});
		};

		this._active = true;
		this._ctxKey.set(true);
		this._updatePill();
		this.storageService.store(V3_AGENT_MODE_PREFERENCE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);

		if (animate && wb) {
			this._animating = true;
			wb.classList.add('v3-agent-animating');
			// Next frame: apply the target transform so the transition plays.
			scheduleAtNextAnimationFrame(mainWindow, () => {
				wb.classList.add('v3-agent-enter');
				mainWindow.setTimeout(commit, ANIM_MS);
			});
		} else {
			commit();
		}
	}

	private _exit(animate: boolean): void {
		if (!this._active) { return; }
		const wb = this._workbenchEl;

		// IDE mode = stock VS Code: chat RIGHT, activity DEFAULT, Explorer LEFT.
		mainWindow.document.body.classList.remove('v3-agent-mode');
		void this.agentLayoutService.enterIdeLayout().then(() => {
			if (this._saved) {
				this.layoutService.setPartHidden(this._saved.panelHidden, Parts.PANEL_PART);
				if (!this._saved.sidebarHidden && this._saved.sidebarContainerId) {
					void this.viewsService.openViewContainer(this._saved.sidebarContainerId, false);
					const sidebarSize = this.layoutService.getSize(Parts.SIDEBAR_PART);
					this.layoutService.setSize(Parts.SIDEBAR_PART, { ...sidebarSize, width: this._saved.sidebarWidth });
				}
				// Never restore aux-bar maximize into IDE. Flow always maximizes
				// Chat; re-applying _saved.auxBarMaximized left IDE looking like
				// fullscreen Chat with Welcome peeking underneath.
			}
		}, err => {
			this.logService.error('[v3AgentMode] exit layout failed', err);
		});

		this._active = false;
		this._ctxKey.set(false);
		this._updatePill();
		this.storageService.store(V3_AGENT_MODE_PREFERENCE_KEY, false, StorageScope.PROFILE, StorageTarget.USER);

		if (animate && wb) {
			this._animating = true;
			// Pre-position the editor off-screen with no transition, then animate
			// it sliding back to its natural position.
			wb.classList.add('v3-agent-return-start');
			void wb.offsetWidth; // force reflow so the start state sticks
			wb.classList.add('v3-agent-animating');
			wb.classList.remove('v3-agent-return-start');
			mainWindow.setTimeout(() => {
				wb.classList.remove('v3-agent-animating');
				this._animating = false;
			}, ANIM_MS);
		}
	}

	get isActive(): boolean { return this._active; }

	override dispose(): void {
		if (V3AgentModeContribution.INSTANCE === this) { V3AgentModeContribution.INSTANCE = undefined; }
		this._pill?.remove();
		mainWindow.document.body.classList.remove('v3-agent-mode');
		const wb = this._workbenchEl;
		wb?.classList.remove('v3-agent-animating', 'v3-agent-enter', 'v3-agent-return-start');
		super.dispose();
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TOGGLE_COMMAND_ID,
			title: localize2('v3AgentMode.toggle', 'V3Code: Toggle Agent Mode'),
			category: localize2('v3code.category', 'V3Code'),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Backslash,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}
	run(_accessor: ServicesAccessor): void {
		V3AgentModeContribution.INSTANCE?.toggle();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ENTER_COMMAND_ID,
			title: localize2('v3AgentMode.enter', 'V3Code: Open V3 Chat'),
			category: localize2('v3code.category', 'V3Code'),
		});
	}
	run(_accessor: ServicesAccessor): void {
		V3AgentModeContribution.INSTANCE?.enter();
	}
});

registerWorkbenchContribution2(V3AgentModeContribution.ID, V3AgentModeContribution, WorkbenchPhase.BlockRestore);
