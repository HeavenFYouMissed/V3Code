/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const IAgentLayoutService = createDecorator<IAgentLayoutService>('agentLayoutService');

export type UnifiedAppLayout = 'agent' | 'editor';
export type AgentsSidebarLocation = 'left' | 'right';

export const UnifiedAppLayoutContext = new RawContextKey<UnifiedAppLayout>('v3code.unifiedAppLayout', 'editor');
export const UnifiedSidebarVisibleContext = new RawContextKey<boolean>('v3code.unifiedSidebarVisible', false);
export const AgentsSidebarLocationContext = new RawContextKey<AgentsSidebarLocation>('v3code.agentsSidebarLocation', 'left');

const STORAGE_LAYOUT = 'v3code/unifiedAppLayout';
const STORAGE_AGENTS_LOCATION = 'v3code/agentLayout.sidebarLocation';
const UNIFIED_SIDEBAR_DEFAULT_WIDTH = 300;

export interface IAgentLayoutService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeLayout: Event<void>;
	readonly layout: UnifiedAppLayout;
	readonly agentsSidebarVisible: boolean;
	readonly agentsSidebarLocation: AgentsSidebarLocation;

	setUnifiedAppLayout(layout: UnifiedAppLayout): Promise<void>;
	setAgentsSidebarLocation(location: AgentsSidebarLocation): Promise<void>;
	showAgentsSidebar(focus?: boolean): Promise<void>;
	hideAgentsSidebar(): Promise<void>;
	toggleAgentsSidebar(): Promise<void>;
	enterFlowLayout(): Promise<void>;
	enterEditorSurfaceLayout(): Promise<void>;
	enterIdeLayout(): Promise<void>;
	/** Chat on the left (Editor / Browser / Terminal fronts). Agents stay independent. */
	ensureChatOnLeft(): Promise<void>;
}

/**
 * Cursor-faithful agent layout orchestration adapted to V3Code:
 * - Agents live in Parts.UNIFIED_SIDEBAR_PART (not Explorer sidebar)
 * - Chat lives in AUXILIARYBAR_PART
 * - Agents-on-left flips classic sidebar to the opposite side (Cursor rule)
 */
export class AgentLayoutService extends Disposable implements IAgentLayoutService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLayout = this._register(new Emitter<void>());
	readonly onDidChangeLayout = this._onDidChangeLayout.event;

	private _layout: UnifiedAppLayout = 'editor';
	private _agentsLocation: AgentsSidebarLocation = 'left';

	private readonly layoutCtx: IContextKey<UnifiedAppLayout>;
	private readonly unifiedVisibleCtx: IContextKey<boolean>;
	private readonly agentsLocationCtx: IContextKey<AgentsSidebarLocation>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.layoutCtx = UnifiedAppLayoutContext.bindTo(contextKeyService);
		this.unifiedVisibleCtx = UnifiedSidebarVisibleContext.bindTo(contextKeyService);
		this.agentsLocationCtx = AgentsSidebarLocationContext.bindTo(contextKeyService);

		const stored = this.storageService.get(STORAGE_LAYOUT, StorageScope.WORKSPACE) as UnifiedAppLayout | undefined;
		if (stored === 'agent' || stored === 'editor') {
			this._layout = stored;
		}
		const loc = this.storageService.get(STORAGE_AGENTS_LOCATION, StorageScope.WORKSPACE) as AgentsSidebarLocation | undefined;
		if (loc === 'left' || loc === 'right') {
			this._agentsLocation = loc;
		}
		this.layoutCtx.set(this._layout);
		this.agentsLocationCtx.set(this._agentsLocation);
		this.syncUnifiedVisibleContext();
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.UNIFIED_SIDEBAR_PART) {
				this.syncUnifiedVisibleContext();
				this._onDidChangeLayout.fire();
			}
		}));
	}

	get layout(): UnifiedAppLayout { return this._layout; }
	get agentsSidebarVisible(): boolean { return this.layoutService.isVisible(Parts.UNIFIED_SIDEBAR_PART); }
	get agentsSidebarLocation(): AgentsSidebarLocation { return this._agentsLocation; }

	private syncUnifiedVisibleContext(): void {
		const visible = this.layoutService.isVisible(Parts.UNIFIED_SIDEBAR_PART);
		this.unifiedVisibleCtx.set(visible);
		const body = globalThis.document?.body;
		if (body) {
			body.classList.toggle('unifiedsidebarvisible', visible);
			body.classList.toggle('unifiedsidebarhidden', !visible);
			if (visible) {
				body.setAttribute('unifiedsidebarvisible', 'true');
				body.removeAttribute('unifiedsidebarhidden');
			} else {
				body.setAttribute('unifiedsidebarhidden', 'true');
				body.removeAttribute('unifiedsidebarvisible');
			}
		}
	}

	async setUnifiedAppLayout(layout: UnifiedAppLayout): Promise<void> {
		this._layout = layout;
		this.layoutCtx.set(layout);
		this.storageService.store(STORAGE_LAYOUT, layout, StorageScope.WORKSPACE, StorageTarget.USER);
		if (layout === 'agent') {
			await this.enterFlowLayout();
		} else {
			await this.enterIdeLayout();
		}
		this._onDidChangeLayout.fire();
	}

	async setAgentsSidebarLocation(location: AgentsSidebarLocation): Promise<void> {
		this._agentsLocation = location;
		this.agentsLocationCtx.set(location);
		this.storageService.store(STORAGE_AGENTS_LOCATION, location, StorageScope.WORKSPACE, StorageTarget.USER);
		// Only Flow/agent layout flips classic sidebar (Cursor Agents-left rule).
		// IDE must keep Explorer LEFT + Chat RIGHT — flipping here is the "flop".
		if (this._layout === 'agent') {
			const classicSide = location === 'left' ? 'right' : 'left';
			await this.configurationService.updateValue('workbench.sideBar.location', classicSide);
		}
		this._onDidChangeLayout.fire();
	}

	async showAgentsSidebar(focus = false): Promise<void> {
		// IDE: Agents sit on the RIGHT next to Chat (sidebar stays left).
		// Flow/agent: Agents on the LEFT next to Chat fill.
		const location: AgentsSidebarLocation = this._layout === 'agent' ? 'left' : 'right';
		await this.setAgentsSidebarLocation(location);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.UNIFIED_SIDEBAR_PART);
		const size = this.layoutService.getSize(Parts.UNIFIED_SIDEBAR_PART);
		this.layoutService.setSize(Parts.UNIFIED_SIDEBAR_PART, { ...size, width: UNIFIED_SIDEBAR_DEFAULT_WIDTH });
		// Force grid order — adjustPartPositions alone used to leave Agents stranded.
		this.layoutService.alignUnifiedSidebarToChat(location);
		if (focus) {
			this.layoutService.focusPart(Parts.UNIFIED_SIDEBAR_PART);
		}
		this.syncUnifiedVisibleContext();
		this._onDidChangeLayout.fire();
	}

	async hideAgentsSidebar(): Promise<void> {
		this.layoutService.setPartHidden(true, Parts.UNIFIED_SIDEBAR_PART);
		this.syncUnifiedVisibleContext();
		this._onDidChangeLayout.fire();
	}

	async toggleAgentsSidebar(): Promise<void> {
		if (this.agentsSidebarVisible) {
			await this.hideAgentsSidebar();
		} else {
			await this.showAgentsSidebar(true);
		}
	}

	/** V3 Flow / Cursor default-agent: Agents own left rail + Chat fill. */
	async enterFlowLayout(): Promise<void> {
		this.logService.info('[agentLayout] enterFlowLayout');
		this._layout = 'agent';
		this.layoutCtx.set('agent');
		this.storageService.store(STORAGE_LAYOUT, 'agent', StorageScope.WORKSPACE, StorageTarget.USER);

		await this.setAgentsSidebarLocation('left');
		// V3 puts classic sidebar on the right of Chat. Activity bar DEFAULT would
		// then sit on the right rail — force TOP so MCP / Explorer never land there.
		await this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.TOP);
		if (this.layoutService.isAuxiliaryBarMaximized()) {
			this.layoutService.setAuxiliaryBarMaximized(false);
		}
		// A previously broken Flow snapshot can restore the panel maximized when the
		// auxiliary bar is unmaximized. Normalize that state before taking the next
		// Flow snapshot.
		if (this.layoutService.isPanelMaximized()) {
			this.layoutService.toggleMaximizedPanel();
		}
		// Keep the editor visible until auxiliary-bar maximization owns hiding it.
		// Hiding both the editor and panel here makes core layout reopen the panel to
		// preserve a valid grid, which is how Terminal became Flow's restore state.
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
		this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART); // classic Explorer away
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		// The panel (terminal) is NOT Flow's to hide. It was hidden here, recorded by
		// the maximize snapshot, and replayed full-height on restore — the terminal-pop.
		// skipHidePanel below keeps it out of both halves of the maximize transaction.
		await this.showAgentsSidebar(false);
		await this.viewsService.openView(ChatViewId, true);
		this.layoutService.setAuxiliaryBarMaximized(true, {
			skipHideSidebar: true,
			skipHideUnifiedSidebar: true,
			skipHidePanel: true,
		});
		// After maximize, re-pin Agents flush left of Chat.
		this.layoutService.alignUnifiedSidebarToChat('left');
		this.syncUnifiedVisibleContext();
		this._onDidChangeLayout.fire();
	}

	/** V3 Editor surface: chat left, explorer right, agents optional own part. */
	async enterEditorSurfaceLayout(): Promise<void> {
		this.logService.info('[agentLayout] enterEditorSurfaceLayout');
		this._layout = 'agent';
		this.layoutCtx.set('agent');
		if (this.layoutService.isAuxiliaryBarMaximized()) {
			this.layoutService.setAuxiliaryBarMaximized(false);
		}
		// Chat left => classic sidebar on right
		await this.configurationService.updateValue('workbench.sideBar.location', 'right');
		await this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.TOP);
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		// A restored Explorer sidebar can come back absurdly wide (users report it eating
		// the right side). Only correct the clearly-broken case — wider than 40% of the
		// window — so a deliberate manual resize is respected.
		const sidebarSize = this.layoutService.getSize(Parts.SIDEBAR_PART);
		const windowWidth = this.layoutService.mainContainerDimension.width;
		if (windowWidth > 0 && sidebarSize.width > windowWidth * 0.4) {
			this.layoutService.setSize(Parts.SIDEBAR_PART, { ...sidebarSize, width: Math.round(Math.min(300, windowWidth * 0.25)) });
		}
		this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		await this.viewsService.openViewContainer('workbench.view.explorer', false);
		await this.viewsService.openView(ChatViewId, false);
		// V3 surfaces: Agents left of Chat when visible
		if (this.agentsSidebarVisible) {
			await this.setAgentsSidebarLocation('left');
			this.layoutService.alignUnifiedSidebarToChat('left');
		} else {
			await this.hideAgentsSidebar();
		}
		this._onDidChangeLayout.fire();
	}

	/** IDE mode: stock VS Code — chat right, activity DEFAULT, Explorer left. */
	async enterIdeLayout(): Promise<void> {
		this.logService.info('[agentLayout] enterIdeLayout');
		this._layout = 'editor';
		this.layoutCtx.set('editor');
		this.storageService.store(STORAGE_LAYOUT, 'editor', StorageScope.WORKSPACE, StorageTarget.USER);

		if (this.layoutService.isAuxiliaryBarMaximized()) {
			this.layoutService.setAuxiliaryBarMaximized(false);
		}
		if (this.layoutService.isPanelMaximized()) {
			this.layoutService.toggleMaximizedPanel();
		}
		await this.hideAgentsSidebar();
		await this.configurationService.updateValue('workbench.sideBar.location', 'left');
		await this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.DEFAULT);
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await this.viewsService.openViewContainer('workbench.view.explorer', false);
		await this.viewsService.openView(ChatViewId, false);
		this.syncUnifiedVisibleContext();
		this._onDidChangeLayout.fire();
	}

	async ensureChatOnLeft(): Promise<void> {
		this.logService.info('[agentLayout] ensureChatOnLeft');
		this._layout = 'agent';
		this.layoutCtx.set('agent');
		if (this.layoutService.isAuxiliaryBarMaximized()) {
			this.layoutService.setAuxiliaryBarMaximized(false);
		}
		// Chat is the auxiliary bar; put classic sidebar on the right so chat sits left.
		await this.configurationService.updateValue('workbench.sideBar.location', 'right');
		// Same TOP rule as Flow/Editor — never leave DEFAULT on a right-docked sidebar.
		await this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.TOP);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await this.viewsService.openView(ChatViewId, false);
		if (this.agentsSidebarVisible) {
			await this.setAgentsSidebarLocation('left');
			this.layoutService.alignUnifiedSidebarToChat('left');
		}
		this._onDidChangeLayout.fire();
	}
}

registerSingleton(IAgentLayoutService, AgentLayoutService, InstantiationType.Delayed);
