/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Native MCP connector gallery + open command.
 * Lives on the primary Sidebar / activity bar (same home as Memory Ledger).
 * NOTE: catalog of MCP servers, NOT the Open VSX / Extensions marketplace.
 */

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	Extensions as ViewContainerExtensions, IViewContainersRegistry, ViewContainerLocation, IViewsRegistry, Extensions as ViewExtensions,
	ViewVisibilityState,
} from '../../../common/views.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { getViewsStateStorageId } from '../../../services/views/common/viewContainerModel.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { mcpGalleryServiceUrlConfig } from '../../../../platform/mcp/common/mcpManagement.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { McpCommandIds } from '../../mcp/common/mcpCommandIds.js';
import { IMCPService } from '../common/mcpService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { isMcpServerUsable, MCPConfigFileEntryJSON, MCPServer } from '../common/mcpServiceTypes.js';
import {
	BRAND_ICON_PATHS,
	CATALOG,
	CATALOG_CATEGORY_FILTERS,
	CatalogCategory,
	CatalogEntry,
	humanizeError,
	installEntryForCatalogEntry,
	isRemoteEntry,
	monogramOf,
	primaryActionFor,
	recoveryActionFor,
} from '../common/mcpCatalog.js';

export const V3CODE_MARKETPLACE_VIEW_ID = 'workbench.view.v3code.marketplace';
export const V3CODE_MARKETPLACE_CONTAINER_ID = 'workbench.viewContainer.v3code.marketplace';
export const V3CodeOpenMarketplaceActionId = 'v3code.openMarketplace';

/** Fresh storage namespace — prior AuxBar/Panel/Sidebar thrash left sticky hide state. */
const MARKETPLACE_STORAGE_ID = `${V3CODE_MARKETPLACE_CONTAINER_ID}.activity`;

/**
 * Retired storage keys from AuxBar / Panel / Sidebar moves. The live
 * `MARKETPLACE_STORAGE_ID` is intentionally excluded so open does not wipe
 * healthy collapsed/size prefs every time.
 */
const MARKETPLACE_LEGACY_STORAGE_KEYS = [
	V3CODE_MARKETPLACE_CONTAINER_ID,
	`${V3CODE_MARKETPLACE_CONTAINER_ID}.hidden`,
	`${V3CODE_MARKETPLACE_CONTAINER_ID}.sidebar`,
	`${V3CODE_MARKETPLACE_CONTAINER_ID}.sidebar.hidden`,
	`${V3CODE_MARKETPLACE_CONTAINER_ID}.state`,
	`${V3CODE_MARKETPLACE_CONTAINER_ID}.state.hidden`,
	getViewsStateStorageId(`${V3CODE_MARKETPLACE_CONTAINER_ID}.sidebar`),
] as const;

const MARKETPLACE_VISIBLE_VIEWS_KEY = `${V3CODE_MARKETPLACE_CONTAINER_ID}.numberOfVisibleViews`;

/**
 * Connector card outline. Must end in a literal grey: a bare `var(--vscode-panel-border)` is
 * undefined on themes outside the grey-chrome scopes (V3Code Hard among them), which makes the
 * whole border declaration invalid at computed-value time so border-color falls back to
 * `currentColor` — every card outlined in red on first paint. Keep a concrete final fallback.
 */
const CARD_BORDER = 'var(--vscode-panel-border, var(--vscode-widget-border, rgba(255, 255, 255, 0.10)))';

// ============================================================================
// Connector catalog — the canonical model in common/mcpCatalog.ts drives this pane
// and the Settings MCP tab identically. Do not add a local catalog here again.
// ============================================================================

type Connector = CatalogEntry;

/** Known-broken entries stay in data but never on the main surface. */
const CONNECTORS: readonly Connector[] = CATALOG.filter(e => e.kind !== 'unavailable');

const CATEGORY_FILTERS: readonly { id: CatalogCategory | 'all'; label: string }[] =
	CATALOG_CATEGORY_FILTERS.filter(f => f.id === 'all' || CONNECTORS.some(c => c.category === f.id));

// ============================================================================
// Server state
// ============================================================================

/**
 * 'needs-user-interaction' is what the MCP host raises when a server answered 401
 * and the OAuth hop needs the user at the keyboard. It is read as a widened string
 * so this pane compiles whether or not the shared status union has caught up.
 */
type ServerStatus = MCPServer['status'] | 'needs-user-interaction';
type MCPServerWithEnablement = MCPServer & { readonly isEnabled?: boolean };

/** Per-card transient state; server truth always comes from IMCPService. */
type CardPhase = 'idle' | 'working' | 'failed';

/**
 * MCP was relocated AuxBar → Panel → Sidebar; Memory Ledger was registered once
 * onto Sidebar and never accumulated hide state. Two sticky failure modes:
 *
 * 1. `views.customizations.viewLocations` still parks the catalog view inside a
 *    generated Auxiliary Bar container — opening the Sidebar "MCP Servers"
 *    shell then has zero child panes (title only).
 * 2. Workspace `numberOfVisibleViews = 0` / hide flags from those moves.
 *
 * Purge legacy keys, move the view home, then force it visible.
 */
function purgeMarketplaceLegacyStorage(storageService: IStorageService): void {
	for (const key of MARKETPLACE_LEGACY_STORAGE_KEYS) {
		storageService.remove(key, StorageScope.WORKSPACE);
		storageService.remove(key, StorageScope.PROFILE);
	}
	// ViewPaneContainer reads this before extensions settle; 0 => not-merged empty body.
	storageService.store(MARKETPLACE_VISIBLE_VIEWS_KEY, 1, StorageScope.WORKSPACE, StorageTarget.MACHINE);

	// Drop profile drag/move customization that parks the catalog in a generated
	// AuxBar container (Sidebar shell then opens with zero child panes).
	try {
		const raw = storageService.get('views.customizations', StorageScope.PROFILE, '{}');
		const data = JSON.parse(raw) as {
			viewLocations?: Record<string, string>;
			viewContainerLocations?: Record<string, number>;
			viewContainerBadgeEnablementStates?: Record<string, boolean>;
		};
		if (data.viewLocations?.[V3CODE_MARKETPLACE_VIEW_ID]) {
			delete data.viewLocations[V3CODE_MARKETPLACE_VIEW_ID];
			storageService.store('views.customizations', JSON.stringify(data), StorageScope.PROFILE, StorageTarget.USER);
		}
	} catch {
		// Ignore corrupt customization JSON — moveViewsToContainer still heals runtime.
	}
}

function ensureMarketplaceViewHome(viewDescriptorService: IViewDescriptorService): boolean {
	const container = viewDescriptorService.getViewContainerById(V3CODE_MARKETPLACE_CONTAINER_ID);
	if (!container) {
		return false;
	}

	const loc = viewDescriptorService.getViewContainerLocation(container);
	if (loc !== ViewContainerLocation.Sidebar) {
		viewDescriptorService.moveViewContainerToLocation(
			container,
			ViewContainerLocation.Sidebar,
			undefined,
			'v3code.mcpForceSidebar',
		);
	}

	const view = viewDescriptorService.getViewDescriptorById(V3CODE_MARKETPLACE_VIEW_ID);
	if (!view) {
		return false;
	}

	const current = viewDescriptorService.getViewContainerByViewId(V3CODE_MARKETPLACE_VIEW_ID);
	if (current && current.id !== container.id) {
		// Profile customization from when MCP lived in AuxBar / was user-dragged.
		// Memory Ledger never got a viewLocations entry, so it never hit this path.
		viewDescriptorService.moveViewsToContainer(
			[view],
			container,
			ViewVisibilityState.Expand,
			'v3code.mcpReturnHome',
		);
	}

	return true;
}

function ensureMarketplaceViewVisible(
	viewDescriptorService: IViewDescriptorService,
	storageService?: IStorageService,
): boolean {
	if (storageService) {
		purgeMarketplaceLegacyStorage(storageService);
	}
	if (!ensureMarketplaceViewHome(viewDescriptorService)) {
		return false;
	}

	const container = viewDescriptorService.getViewContainerById(V3CODE_MARKETPLACE_CONTAINER_ID);
	if (!container) {
		return false;
	}

	const model = viewDescriptorService.getViewContainerModel(container);
	if (!model.allViewDescriptors.some(view => view.id === V3CODE_MARKETPLACE_VIEW_ID)) {
		return false;
	}
	if (!model.isVisible(V3CODE_MARKETPLACE_VIEW_ID)) {
		model.setVisible(V3CODE_MARKETPLACE_VIEW_ID, true);
	}
	if (model.isCollapsed(V3CODE_MARKETPLACE_VIEW_ID)) {
		model.setCollapsed(V3CODE_MARKETPLACE_VIEW_ID, false);
	}
	return model.isVisible(V3CODE_MARKETPLACE_VIEW_ID);
}

class MarketplaceViewPane extends ViewPane {
	private listContainer: HTMLElement | undefined;
	private readonly phases = new Map<string, CardPhase>();
	private readonly cardErrors = new Map<string, { text: string; raw: string }>();
	/** Cards whose local-command review panel is open — commands are never installed unseen. */
	private readonly reviewOpen = new Set<string>();
	private readonly expandedTools = new Set<string>();
	/** Lower-cased mcp.json keys — a configured server that has not started yet has no live state. */
	private configNames = new Set<string>();
	private readonly disposables = this._register(new DisposableStore());

	private query = '';
	private activeCategory: CatalogCategory | 'all' = 'all';
	private rerender: () => void = () => { };

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
		@IMCPService private readonly mcpService: IMCPService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ICommandService private readonly commandService: ICommandService,
		@IProductService private readonly productService: IProductService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.padding = '10px 8px';
		container.style.overflow = 'auto';
		container.style.background = 'var(--vscode-sideBar-background)';
		container.style.color = 'var(--vscode-foreground)';

		const blurb = dom.append(container, dom.$('div'));
		blurb.textContent = localize('v3code.marketplace.blurb', 'Connect a service and its tools become available to Agent mode. Hosted connectors sign you in through your browser — no keys to copy.');
		blurb.style.fontSize = '11px';
		blurb.style.lineHeight = '1.5';
		blurb.style.opacity = '0.7';
		blurb.style.marginBottom = '10px';

		const searchWrap = dom.append(container, dom.$('div'));
		searchWrap.style.display = 'flex';
		searchWrap.style.alignItems = 'center';
		searchWrap.style.gap = '6px';
		searchWrap.style.marginBottom = '8px';
		searchWrap.style.padding = '4px 8px';
		searchWrap.style.border = `1px solid var(--vscode-input-border, ${CARD_BORDER})`;
		searchWrap.style.borderRadius = '6px';
		searchWrap.style.background = 'var(--vscode-input-background)';

		const searchIcon = dom.append(searchWrap, dom.$('span'));
		searchIcon.className = ThemeIcon.asClassName(Codicon.search);
		searchIcon.style.opacity = '0.6';

		const search = dom.append(searchWrap, dom.$('input')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('v3code.marketplace.search', 'Search connectors...');
		search.style.flex = '1';
		search.style.border = 'none';
		search.style.outline = 'none';
		search.style.background = 'transparent';
		search.style.color = 'inherit';
		search.style.fontSize = '12px';

		const categoryRow = dom.append(container, dom.$('div'));
		categoryRow.style.display = 'flex';
		categoryRow.style.flexWrap = 'wrap';
		categoryRow.style.gap = '4px';
		categoryRow.style.marginBottom = '10px';

		this.listContainer = dom.append(container, dom.$('div'));
		this.listContainer.style.display = 'flex';
		this.listContainer.style.flexDirection = 'column';
		this.listContainer.style.gap = '8px';

		const categoryButtons: HTMLButtonElement[] = [];
		for (const filter of CATEGORY_FILTERS) {
			const pill = dom.append(categoryRow, dom.$('button')) as HTMLButtonElement;
			pill.textContent = filter.label;
			categoryButtons.push(pill);
			pill.onclick = () => {
				this.activeCategory = filter.id;
				this.rerender();
			};
		}

		const stylePills = () => {
			for (let i = 0; i < categoryButtons.length; i++) {
				this._styleCategoryPill(categoryButtons[i], CATEGORY_FILTERS[i].id === this.activeCategory);
			}
		};

		this.rerender = () => {
			stylePills();
			this._renderList();
		};

		search.addEventListener('input', () => {
			this.query = search.value.trim().toLowerCase();
			this.rerender();
		});
		this.disposables.add(this.mcpService.onDidChangeState(() => void this._refreshConfigNames()));
		this.disposables.add(this.voidSettingsService.onDidChangeState(() => this.rerender()));
		this.rerender();
		void this._refreshConfigNames();
	}

	private async _refreshConfigNames(): Promise<void> {
		try {
			const names = await this.mcpService.getMcpConfigServerNames();
			this.configNames = new Set(names.map(n => n.toLowerCase()));
		} catch {
			// A malformed mcp.json is surfaced by the service itself; the gallery just
			// falls back to live server state.
		}
		this.rerender();
	}

	// ------------------------------------------------------------------------
	// State lookup
	// ------------------------------------------------------------------------

	/** Install-identity map FIRST — display must resolve to the same server the action
	 *  buttons act on (a suffixed install like "slack-2" otherwise shows one server's
	 *  status while the buttons drive another). Fall back to the loose id/name match
	 *  only for servers installed outside the catalog (hand-edited mcp.json). */
	private _serverFor(connector: Connector): MCPServer | undefined {
		const servers = this.mcpService.state.mcpServerOfName;
		const installedName = this.mcpService.installedServerNameFor(connector.id);
		if (installedName !== undefined && servers[installedName] !== undefined) {
			return servers[installedName];
		}
		for (const name of Object.keys(servers)) {
			const lower = name.toLowerCase();
			if (lower === connector.id || lower === connector.name.toLowerCase()) {
				return servers[name];
			}
		}
		return undefined;
	}

	private _isConfigured(connector: Connector): boolean {
		return this._serverFor(connector) !== undefined
			|| this.configNames.has(connector.id)
			|| this.configNames.has(connector.name.toLowerCase());
	}

	private _isOn(connector: Connector): boolean {
		return (this._serverFor(connector) as MCPServerWithEnablement | undefined)?.isEnabled
			?? this.voidSettingsService.state.mcpUserStateOfName[connector.id]?.isOn
			?? false;
	}

	// ------------------------------------------------------------------------
	// Actions
	// ------------------------------------------------------------------------

	private async _connect(connector: Connector): Promise<void> {
		// Guides never get a connection path; local commands are ALWAYS reviewed first.
		if (connector.kind === 'skill-or-guide') {
			void this._openGuide(connector);
			return;
		}
		if (connector.kind === 'local-command' && !this.reviewOpen.has(connector.id)) {
			this.reviewOpen.add(connector.id);
			this.cardErrors.delete(connector.id);
			this.rerender();
			return;
		}

		this.phases.set(connector.id, 'working');
		this.cardErrors.delete(connector.id);
		this.rerender();

		try {
			// Remote one-click entries carry URL only: the extension host discovers auth from
			// the server's 401. Required inputs (tokens, headers) become bare placeholders here
			// and the install pipeline turns each into a secure, password-masked prompt —
			// no token field lives in this pane, and no value is ever written to the catalog.
			// ${workspaceFolder} stays symbolic; upstream resolves it per-window at launch.
			const entry = installEntryForCatalogEntry(connector) as MCPConfigFileEntryJSON | undefined;
			if (entry === undefined) {
				return;
			}
			await this.mcpService.installMcpServer(connector.id, entry, connector.requiredInputs);
			this.phases.set(connector.id, 'idle');
			this.reviewOpen.delete(connector.id);
		} catch (err) {
			this._failCard(connector, err);
		}
		this.rerender();
	}

	private async _openGuide(connector: Connector): Promise<void> {
		const target = connector.docsUrl ?? (connector.domain !== undefined ? `https://${connector.domain}` : undefined);
		if (target !== undefined) {
			await this.openerService.open(target, { openExternal: true });
		}
	}

	private async _disconnect(connector: Connector): Promise<void> {
		this.phases.set(connector.id, 'working');
		this.cardErrors.delete(connector.id);
		this.rerender();

		try {
			await this.mcpService.uninstallMcpServer(connector.id);
			this.phases.set(connector.id, 'idle');
		} catch (err) {
			this._failCard(connector, err);
		}
		this.rerender();
	}

	private async _signIn(connector: Connector, fresh = false): Promise<void> {
		this.phases.set(connector.id, 'working');
		this.cardErrors.delete(connector.id);
		this.rerender();

		try {
			await (fresh ? this.mcpService.resetServerAuth(connector.id) : this.mcpService.reauthenticateServer(connector.id));
			this.phases.set(connector.id, 'idle');
		} catch (err) {
			this._failCard(connector, err);
		}
		this.rerender();
	}

	private _failCard(connector: Connector, err: unknown): void {
		const raw = err instanceof Error ? err.message : String(err);
		this.phases.set(connector.id, 'failed');
		this.cardErrors.set(connector.id, { text: humanizeError(raw, connector), raw });
	}

	// ------------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------------

	private _styleCategoryPill(btn: HTMLButtonElement, active: boolean): void {
		btn.style.fontSize = '11px';
		btn.style.padding = '3px 10px';
		btn.style.borderRadius = '999px';
		btn.style.cursor = 'pointer';
		if (active) {
			btn.style.background = 'color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent)';
			btn.style.border = '1px solid color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent)';
			btn.style.color = 'var(--vscode-foreground)';
		} else {
			btn.style.background = 'var(--vscode-input-background)';
			btn.style.border = `1px solid ${CARD_BORDER}`;
			btn.style.color = 'var(--vscode-descriptionForeground)';
		}
	}

	private _renderList(): void {
		if (!this.listContainer) {
			return;
		}
		dom.clearNode(this.listContainer);

		let items = CONNECTORS;
		if (this.activeCategory !== 'all') {
			items = items.filter(c => c.category === this.activeCategory);
		}
		if (this.query) {
			items = items.filter(c =>
				c.name.toLowerCase().includes(this.query)
				|| c.description.toLowerCase().includes(this.query)
				|| c.id.includes(this.query));
		}

		if (items.length === 0) {
			const empty = dom.append(this.listContainer, dom.$('div'));
			empty.textContent = localize('v3code.marketplace.noMatch', 'No connectors match that search.');
			empty.style.fontSize = '11px';
			empty.style.opacity = '0.7';
			empty.style.padding = '16px 4px';
			empty.style.textAlign = 'center';
			return;
		}

		const configured = items.filter(c => this._isConfigured(c));
		const connected = configured.filter(c => {
			const server = this._serverFor(c);
			return isMcpServerUsable(server, this._isOn(c), isRemoteEntry(c));
		});
		const needsAttention = configured.filter(c => !connected.includes(c));
		const available = items.filter(c => !this._isConfigured(c));

		if (connected.length > 0) {
			this._renderGroupLabel(localize('v3code.marketplace.connectedGroup', 'Connected'));
			for (const connector of connected) {
				this._renderCard(connector);
			}
		}
		if (needsAttention.length > 0) {
			this._renderGroupLabel(localize('v3code.marketplace.needsAttentionGroup', 'Configured — needs attention'));
			for (const connector of needsAttention) {
				this._renderCard(connector);
			}
		}
		if (available.length > 0) {
			if (configured.length > 0) {
				this._renderGroupLabel(localize('v3code.marketplace.availableGroup', 'Available'));
			}
			for (const connector of available) {
				this._renderCard(connector);
			}
		}

		// Cross-link to the deep catalog: this pane is the curated front door, the native
		// marketplace browses the full MCP registry (with a one-click enable if it is off).
		const browseAll = dom.append(this.listContainer!, dom.$('button')) as HTMLButtonElement;
		browseAll.textContent = localize('v3code.marketplace.browseRegistry', 'Browse the full MCP registry…');
		browseAll.style.fontSize = '11px';
		browseAll.style.padding = '6px 8px';
		browseAll.style.marginTop = '4px';
		browseAll.style.borderRadius = '6px';
		browseAll.style.border = `1px dashed ${CARD_BORDER}`;
		browseAll.style.background = 'transparent';
		browseAll.style.color = 'var(--vscode-descriptionForeground)';
		browseAll.style.cursor = 'pointer';
		browseAll.onclick = () => void this._browseFullRegistry();
	}

	/**
	 * The upstream browse views are gated on a configured registry; opening them while
	 * it is off shows a blank pane. Offer the one-click enable first (mirrors the
	 * Browse Marketplace empty-state offer) so the cross-link never dead-ends.
	 */
	private async _browseFullRegistry(): Promise<void> {
		const configured = this.configurationService.getValue<string>(mcpGalleryServiceUrlConfig) || this.productService.mcpGallery?.serviceUrl;
		if (!configured) {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('v3code.marketplace.enableRegistry', 'Registry browsing is off. Turn it on?'),
				detail: localize('v3code.marketplace.enableRegistryDetail', 'Browsing uses the public MCP registry. Nothing is contacted until you turn it on, and you can change or clear the registry URL in Settings at any time.'),
				primaryButton: localize('v3code.marketplace.enableRegistryOk', 'Enable and Browse'),
			});
			if (!confirmed) {
				return;
			}
			try {
				await this.configurationService.updateValue(mcpGalleryServiceUrlConfig, 'https://registry.modelcontextprotocol.io');
			} catch (err) {
				this.dialogService.error(localize('v3code.marketplace.enableRegistryFailed', 'Could not save the registry setting.'), String(err instanceof Error ? err.message : err));
				return;
			}
		}
		await this.commandService.executeCommand(McpCommandIds.Browse);
	}

	private _renderGroupLabel(text: string): void {
		const label = dom.append(this.listContainer!, dom.$('div'));
		label.textContent = text;
		label.style.fontSize = '10px';
		label.style.textTransform = 'uppercase';
		label.style.letterSpacing = '0.06em';
		label.style.fontWeight = '600';
		label.style.opacity = '0.55';
		label.style.marginTop = '4px';
	}

	private _renderCard(connector: Connector): void {
		const server = this._serverFor(connector);
		const status = server?.status as ServerStatus | undefined;
		const needsSignIn = status === 'needs-user-interaction';
		const phase = this.phases.get(connector.id) ?? 'idle';
		const tools = server?.tools ?? [];
		const isOn = this._isOn(connector);

		const card = dom.append(this.listContainer!, dom.$('div'));
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '8px';
		card.style.padding = '10px 12px';
		card.style.borderRadius = '8px';
		card.style.background = 'var(--vscode-editor-background)';
		card.style.border = needsSignIn
			? `1px solid color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 50%, ${CARD_BORDER})`
			: `1px solid ${CARD_BORDER}`;

		// Header — icon, name, kind glyph, description.
		const head = dom.append(card, dom.$('div'));
		head.style.display = 'flex';
		head.style.alignItems = 'flex-start';
		head.style.gap = '10px';

		this._renderConnectorIcon(head, connector);

		const info = dom.append(head, dom.$('div'));
		info.style.flex = '1';
		info.style.minWidth = '0';

		const titleRow = dom.append(info, dom.$('div'));
		titleRow.style.display = 'flex';
		titleRow.style.alignItems = 'center';
		titleRow.style.gap = '6px';

		const title = dom.append(titleRow, dom.$('div'));
		title.textContent = connector.name;
		title.style.fontWeight = '600';
		title.style.fontSize = '12px';
		title.style.overflow = 'hidden';
		title.style.textOverflow = 'ellipsis';
		title.style.whiteSpace = 'nowrap';

		const kindGlyph = dom.append(titleRow, dom.$('span'));
		kindGlyph.className = ThemeIcon.asClassName(
			connector.kind === 'skill-or-guide' ? Codicon.book
				: isRemoteEntry(connector) ? Codicon.globe : Codicon.terminal);
		kindGlyph.style.opacity = '0.55';
		kindGlyph.style.fontSize = '11px';
		kindGlyph.title = connector.kind === 'skill-or-guide'
			? localize('v3code.marketplace.kindGuide', 'Setup guide — not a connector')
			: isRemoteEntry(connector)
				? localize('v3code.marketplace.kindRemote', 'Hosted by the service — signs in through your browser')
				: localize('v3code.marketplace.kindLocal', 'Runs as a process on this machine');

		const desc = dom.append(info, dom.$('div'));
		desc.textContent = connector.description;
		desc.style.fontSize = '11px';
		desc.style.lineHeight = '1.5';
		desc.style.opacity = '0.75';
		desc.style.marginTop = '2px';

		this._renderBadges(card, connector);

		if (connector.caveat) {
			const caveat = dom.append(card, dom.$('div'));
			caveat.textContent = connector.caveat;
			caveat.style.fontSize = '11px';
			caveat.style.lineHeight = '1.45';
			caveat.style.opacity = '0.6';
		}

		this._renderActionRow(card, connector, { configured: this._isConfigured(connector), server, status, needsSignIn, phase, isOn, toolCount: tools.length });

		if (needsSignIn) {
			const hint = dom.append(card, dom.$('div'));
			hint.textContent = localize('v3code.marketplace.signInHint', '{0} asked you to authorize V3Code. Sign in opens {1} in your browser — approve there and the tools appear here.', connector.name, connector.domain);
			hint.style.fontSize = '11px';
			hint.style.lineHeight = '1.45';
			hint.style.color = 'var(--vscode-notificationsWarningIcon-foreground)';
		}

		if (isOn && tools.length > 0) {
			this._renderTools(card, connector, tools);
		}

		if (this.reviewOpen.has(connector.id) && connector.kind === 'local-command') {
			this._renderReviewPanel(card, connector);
		}

		this._renderError(card, connector, server, needsSignIn);
	}

	private _renderConnectorIcon(parent: HTMLElement, connector: Connector): void {
		const iconWrap = dom.append(parent, dom.$('div'));
		iconWrap.style.width = '30px';
		iconWrap.style.height = '30px';
		iconWrap.style.borderRadius = '7px';
		iconWrap.style.overflow = 'hidden';
		iconWrap.style.flexShrink = '0';
		iconWrap.style.display = 'flex';
		iconWrap.style.alignItems = 'center';
		iconWrap.style.justifyContent = 'center';
		iconWrap.style.background = 'var(--vscode-input-background)';
		iconWrap.style.border = `1px solid ${CARD_BORDER}`;

		// Real brand marks, bundled locally: no icon CDN, nothing to break offline.
		const pathData = connector.brandIcon !== undefined ? BRAND_ICON_PATHS[connector.brandIcon] : undefined;
		if (pathData !== undefined) {
			const svgNS = 'http://www.w3.org/2000/svg';
			const svg = document.createElementNS(svgNS, 'svg');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('width', '18');
			svg.setAttribute('height', '18');
			svg.setAttribute('fill', 'currentColor');
			svg.setAttribute('aria-hidden', 'true');
			const path = document.createElementNS(svgNS, 'path');
			path.setAttribute('d', pathData);
			svg.appendChild(path);
			iconWrap.appendChild(svg);
		} else {
			iconWrap.textContent = monogramOf(connector);
			iconWrap.style.fontWeight = '700';
			iconWrap.style.fontSize = '13px';
		}
	}

	private _renderBadges(card: HTMLElement, connector: Connector): void {
		const badges = dom.append(card, dom.$('div'));
		badges.style.display = 'flex';
		badges.style.flexWrap = 'wrap';
		badges.style.gap = '4px';

		const badge = (text: string, warn: boolean, tooltip?: string) => {
			const el = dom.append(badges, dom.$('span'));
			el.textContent = text;
			el.style.fontSize = '10px';
			el.style.fontWeight = '500';
			el.style.padding = '1px 6px';
			el.style.borderRadius = '4px';
			el.style.whiteSpace = 'nowrap';
			if (warn) {
				el.style.background = 'color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 12%, transparent)';
				el.style.border = '1px solid color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 34%, transparent)';
				el.style.color = 'var(--vscode-notificationsWarningIcon-foreground)';
			} else {
				el.style.background = 'var(--vscode-input-background)';
				el.style.border = `1px solid ${CARD_BORDER}`;
				el.style.color = 'var(--vscode-descriptionForeground)';
			}
			if (tooltip) {
				el.title = tooltip;
			}
		};

		badge(localize('v3code.marketplace.badgeOfficial', 'Official'), false, localize('v3code.marketplace.badgeOfficialTip', 'Published by the service itself'));
		if (connector.unverified) {
			badge(localize('v3code.marketplace.badgeUnverified', 'Unconfirmed endpoint'), true, localize('v3code.marketplace.badgeUnverifiedTip', 'Endpoint reported by third parties, not confirmed against first-party docs'));
		}
		const secretInputs = (connector.requiredInputs ?? []).filter(i => i.isSecret === true);
		if (secretInputs.length > 0) {
			badge(localize('v3code.marketplace.badgeToken', 'Token required'), false, secretInputs.map(i => i.name).join(', '));
		}
		if (connector.authHint === 'oauth-preregistered') {
			badge(localize('v3code.marketplace.badgePreregistered', 'Client ID required'), true, localize('v3code.marketplace.badgePreregisteredTip', 'This provider only signs in pre-registered apps; automatic registration will not complete'));
		}
	}

	private _renderActionRow(
		card: HTMLElement,
		connector: Connector,
		ctx: { configured: boolean; server: MCPServer | undefined; status: ServerStatus | undefined; needsSignIn: boolean; phase: CardPhase; isOn: boolean; toolCount: number },
	): void {
		const row = dom.append(card, dom.$('div'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';

		const working = ctx.phase === 'working';

		if (!ctx.configured) {
			// The primary action is an editorial claim from the catalog's kind — a guide
			// never gets Connect, a local command is always reviewed before install.
			const action = primaryActionFor(connector);
			if (action === null) {
				return;
			}
			const label = working
				? (isRemoteEntry(connector) ? localize('v3code.marketplace.connecting', 'Connecting…') : localize('v3code.marketplace.installing', 'Installing…'))
				: action === 'connect' ? localize('v3code.marketplace.connect', 'Connect')
					: action === 'set-up' ? localize('v3code.marketplace.setUp', 'Set up')
						: action === 'review-command' ? (this.reviewOpen.has(connector.id) ? localize('v3code.marketplace.install', 'Install') : localize('v3code.marketplace.reviewCommand', 'Review command'))
							: localize('v3code.marketplace.openGuide', 'Open setup guide');
			const connect = this._primaryButton(row, label);
			connect.disabled = working;
			connect.onclick = () => void (action === 'open-guide' ? this._openGuide(connector) : this._connect(connector));
			if (action === 'review-command' && this.reviewOpen.has(connector.id)) {
				const cancel = dom.append(row, dom.$('button')) as HTMLButtonElement;
				cancel.textContent = localize('v3code.marketplace.reviewCancel', 'Cancel');
				cancel.style.fontSize = '11px';
				cancel.style.padding = '3px 8px';
				cancel.style.borderRadius = '5px';
				cancel.style.border = `1px solid ${CARD_BORDER}`;
				cancel.style.background = 'transparent';
				cancel.style.color = 'var(--vscode-descriptionForeground)';
				cancel.style.cursor = 'pointer';
				cancel.onclick = () => {
					this.reviewOpen.delete(connector.id);
					this.rerender();
				};
			}
			return;
		}

		if (ctx.needsSignIn) {
			const signIn = this._primaryButton(row, working
				? localize('v3code.marketplace.opening', 'Opening…')
				: localize('v3code.marketplace.signIn', 'Sign in'));
			signIn.disabled = working;
			signIn.onclick = () => void this._signIn(connector);
		} else {
			const statusWrap = dom.append(row, dom.$('div'));
			statusWrap.style.display = 'flex';
			statusWrap.style.alignItems = 'center';
			statusWrap.style.gap = '6px';

			const dot = dom.append(statusWrap, dom.$('span'));
			dot.style.width = '6px';
			dot.style.height = '6px';
			dot.style.borderRadius = '999px';
			dot.style.flexShrink = '0';
			dot.style.background = this._statusColor(ctx.status, ctx.isOn);

			const label = dom.append(statusWrap, dom.$('span'));
			label.textContent = ctx.isOn && ctx.toolCount > 0
				? localize('v3code.marketplace.statusWithTools', '{0} · {1} tools', this._statusLabel(ctx.status, ctx.isOn), ctx.toolCount)
				: this._statusLabel(ctx.status, ctx.isOn);
			label.style.fontSize = '11px';
			label.style.opacity = '0.75';
		}

		// Which recovery button shows is shared, tested logic — not per-surface conditionals.
		// Reconnect = cheap stop/start; Sign in again = full fresh auth (wipes the cached
		// client registration and sessions, the only recovery from authorize-time failures).
		const recovery = recoveryActionFor(connector, ctx.server, ctx.isOn);
		if (!ctx.needsSignIn && (recovery === 'reconnect' || recovery === 'sign-in-again')) {
			const reconnect = this._primaryButton(row, recovery === 'sign-in-again'
				? localize('v3code.marketplace.signInAgain', 'Sign in again')
				: localize('v3code.marketplace.reconnect', 'Reconnect'));
			reconnect.disabled = working;
			reconnect.onclick = () => void this._signIn(connector, recovery === 'sign-in-again');
		}

		const controls = dom.append(row, dom.$('div'));
		controls.style.display = 'flex';
		controls.style.alignItems = 'center';
		controls.style.gap = '8px';
		controls.style.marginLeft = 'auto';

		this._renderToggle(controls, connector, ctx.isOn);

		const disconnect = dom.append(controls, dom.$('button')) as HTMLButtonElement;
		disconnect.textContent = localize('v3code.marketplace.disconnect', 'Disconnect');
		disconnect.disabled = working;
		disconnect.style.fontSize = '11px';
		disconnect.style.padding = '3px 8px';
		disconnect.style.borderRadius = '5px';
		disconnect.style.border = `1px solid ${CARD_BORDER}`;
		disconnect.style.background = 'transparent';
		disconnect.style.color = 'var(--vscode-descriptionForeground)';
		disconnect.style.cursor = working ? 'default' : 'pointer';
		disconnect.onclick = () => void this._disconnect(connector);
	}

	private _primaryButton(parent: HTMLElement, text: string): HTMLButtonElement {
		const btn = dom.append(parent, dom.$('button')) as HTMLButtonElement;
		btn.textContent = text;
		btn.style.fontSize = '11px';
		btn.style.fontWeight = '500';
		btn.style.padding = '4px 12px';
		btn.style.borderRadius = '6px';
		btn.style.cursor = 'pointer';
		btn.style.background = 'color-mix(in srgb, var(--vscode-focusBorder) 24%, transparent)';
		btn.style.border = '1px solid color-mix(in srgb, var(--vscode-focusBorder) 58%, transparent)';
		btn.style.color = 'var(--vscode-foreground)';
		return btn;
	}

	private _renderToggle(parent: HTMLElement, connector: Connector, isOn: boolean): void {
		const track = dom.append(parent, dom.$('div'));
		track.setAttribute('role', 'switch');
		track.setAttribute('aria-checked', String(isOn));
		track.title = isOn
			? localize('v3code.marketplace.toggleOff', 'Disable — keeps the connection but hides its tools from the agent')
			: localize('v3code.marketplace.toggleOn', 'Enable — expose this server\'s tools to the agent');
		track.style.width = '26px';
		track.style.height = '15px';
		track.style.borderRadius = '999px';
		track.style.position = 'relative';
		track.style.flexShrink = '0';
		track.style.cursor = 'pointer';
		track.style.transition = 'background 120ms ease';
		track.style.background = isOn
			? 'color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent)'
			: 'var(--vscode-input-background)';
		track.style.border = `1px solid ${CARD_BORDER}`;

		const knob = dom.append(track, dom.$('div'));
		knob.style.width = '11px';
		knob.style.height = '11px';
		knob.style.borderRadius = '999px';
		knob.style.position = 'absolute';
		knob.style.top = '1px';
		knob.style.left = isOn ? '12px' : '1px';
		knob.style.transition = 'left 120ms ease';
		knob.style.background = 'var(--vscode-foreground)';

		track.onclick = () => void this.mcpService.toggleServerIsOn(connector.id, !isOn);
	}

	private _renderTools(card: HTMLElement, connector: Connector, tools: { name: string; description?: string }[]): void {
		const wrap = dom.append(card, dom.$('div'));
		wrap.style.display = 'flex';
		wrap.style.flexWrap = 'wrap';
		wrap.style.gap = '4px';

		const expanded = this.expandedTools.has(connector.id);
		const shown = expanded ? tools : tools.slice(0, 6);

		for (const tool of shown) {
			const chip = dom.append(wrap, dom.$('span'));
			// MCP tool names arrive namespaced as "<server>_<tool>"; the server is the card.
			chip.textContent = tool.name.split('_').slice(1).join('_') || tool.name;
			chip.title = tool.description ?? '';
			chip.style.fontSize = '10px';
			chip.style.fontFamily = 'var(--monaco-monospace-font)';
			chip.style.padding = '1px 6px';
			chip.style.borderRadius = '4px';
			chip.style.background = 'var(--vscode-input-background)';
			chip.style.border = `1px solid ${CARD_BORDER}`;
			chip.style.opacity = '0.85';
		}

		const hidden = tools.length - shown.length;
		if (hidden > 0) {
			const more = dom.append(wrap, dom.$('button')) as HTMLButtonElement;
			more.textContent = localize('v3code.marketplace.moreTools', '+{0} more', hidden);
			more.style.fontSize = '10px';
			more.style.padding = '1px 6px';
			more.style.borderRadius = '4px';
			more.style.border = `1px dashed ${CARD_BORDER}`;
			more.style.background = 'transparent';
			more.style.color = 'var(--vscode-descriptionForeground)';
			more.style.cursor = 'pointer';
			more.onclick = () => {
				this.expandedTools.add(connector.id);
				this.rerender();
			};
		}
	}

	/**
	 * Local commands are never installed unseen: the exact command line, the inputs it
	 * will ask for, and a trust warning are shown before Install does anything. Values
	 * themselves are collected later by the editor's secure input prompts (masked,
	 * stored encrypted) — this panel never contains a secret.
	 */
	private _renderReviewPanel(card: HTMLElement, connector: Connector): void {
		const wrap = dom.append(card, dom.$('div'));
		wrap.style.display = 'flex';
		wrap.style.flexDirection = 'column';
		wrap.style.gap = '6px';
		wrap.style.padding = '8px';
		wrap.style.borderRadius = '6px';
		wrap.style.background = 'var(--vscode-input-background)';
		wrap.style.border = `1px solid ${CARD_BORDER}`;

		const label = dom.append(wrap, dom.$('div'));
		label.textContent = localize('v3code.marketplace.reviewLabel', 'This command will run on your computer');
		label.style.fontSize = '10px';
		label.style.textTransform = 'uppercase';
		label.style.letterSpacing = '0.06em';
		label.style.opacity = '0.6';

		const cmd = dom.append(wrap, dom.$('code'));
		cmd.textContent = [connector.command, ...(connector.args ?? [])].join(' ');
		cmd.style.fontSize = '11px';
		cmd.style.fontFamily = 'var(--monaco-monospace-font)';
		cmd.style.whiteSpace = 'pre-wrap';
		cmd.style.wordBreak = 'break-word';

		const requiredInputs = connector.requiredInputs ?? [];
		if (requiredInputs.length > 0) {
			const inputsNote = dom.append(wrap, dom.$('div'));
			inputsNote.textContent = localize(
				'v3code.marketplace.reviewInputs',
				'On first connect you will be asked for: {0}. Secrets are entered in a masked prompt and stored encrypted — never in a config file.',
				requiredInputs.map(i => i.name).join(', '));
			inputsNote.style.fontSize = '10px';
			inputsNote.style.lineHeight = '1.45';
			inputsNote.style.opacity = '0.7';
		}

		const trustNote = dom.append(wrap, dom.$('div'));
		trustNote.textContent = localize(
			'v3code.marketplace.reviewTrust',
			'Review the package and its publisher before installing. Install asks for confirmation before the process ever starts.');
		trustNote.style.fontSize = '10px';
		trustNote.style.lineHeight = '1.45';
		trustNote.style.color = 'var(--vscode-notificationsWarningIcon-foreground)';
	}

	private _renderError(card: HTMLElement, connector: Connector, server: MCPServer | undefined, needsSignIn: boolean): void {
		const cardError = this.cardErrors.get(connector.id);
		const serverError = server && 'error' in server ? server.error : undefined;
		const shown = cardError
			?? (serverError && !needsSignIn ? { text: humanizeError(serverError, connector), raw: serverError } : undefined);
		if (!shown) {
			return;
		}

		const box = dom.append(card, dom.$('div'));
		box.textContent = shown.text;
		box.title = shown.raw;
		box.style.fontSize = '11px';
		box.style.lineHeight = '1.45';
		box.style.padding = '6px 8px';
		box.style.borderRadius = '5px';
		box.style.color = 'var(--vscode-errorForeground)';
		box.style.background = 'color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent)';
		box.style.border = '1px solid color-mix(in srgb, var(--vscode-errorForeground) 28%, transparent)';
	}

	private _statusColor(status: ServerStatus | undefined, isOn: boolean): string {
		if (!isOn) {
			return 'var(--vscode-descriptionForeground)';
		}
		switch (status) {
			case 'success': return 'var(--vscode-testing-iconPassed, #6AA3CC)';
			case 'ready': return 'var(--vscode-charts-blue, #3794FF)';
			case 'error': return 'var(--vscode-errorForeground)';
			case 'loading':
			case 'needs-user-interaction': return 'var(--vscode-notificationsWarningIcon-foreground)';
			default: return 'var(--vscode-descriptionForeground)';
		}
	}

	private _statusLabel(status: ServerStatus | undefined, isOn: boolean): string {
		if (!isOn) {
			return localize('v3code.marketplace.statusDisabled', 'Disabled');
		}
		switch (status) {
			case 'success': return localize('v3code.marketplace.statusConnected', 'Connected');
			case 'ready': return localize('v3code.marketplace.statusReady', 'Ready — connects on first use');
			case 'error': return localize('v3code.marketplace.statusError', 'Error');
			case 'loading': return localize('v3code.marketplace.statusLoading', 'Connecting…');
			case 'needs-user-interaction': return localize('v3code.marketplace.statusNeedsAuth', 'Sign-in required');
			default: return localize('v3code.marketplace.statusOffline', 'Offline');
		}
	}
}

class V3CodeMarketplaceContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeMarketplace';

	constructor(
		@IViewsService _viewsService: IViewsService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		// Drop AuxBar/Panel/Sidebar thrash keys, then pull the view out of any
		// generated AuxBar customization and back onto the Sidebar container.
		purgeMarketplaceLegacyStorage(storageService);

		const container = viewDescriptorService.getViewContainerById(V3CODE_MARKETPLACE_CONTAINER_ID);

		// The container model can be created one lifecycle turn before its
		// registered child descriptors are attached. Repair immediately when
		// possible; otherwise repair on the first descriptor-model update.
		if (!ensureMarketplaceViewVisible(viewDescriptorService, storageService) && container) {
			const model = viewDescriptorService.getViewContainerModel(container);
			const registrationListener = model.onDidChangeAllViewDescriptors(() => {
				if (ensureMarketplaceViewVisible(viewDescriptorService, storageService)) {
					registrationListener.dispose();
				}
			});
			this._register(registrationListener);
		}
	}
}

registerAction2(class V3CodeOpenMarketplaceAction extends Action2 {
	constructor() {
		super({
			id: V3CodeOpenMarketplaceActionId,
			title: localize2('v3code.openMarketplace', 'Open MCP Servers'),
			icon: Codicon.extensions,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		ensureMarketplaceViewVisible(
			accessor.get(IViewDescriptorService),
			accessor.get(IStorageService),
		);
		await viewsService.openView(V3CODE_MARKETPLACE_VIEW_ID, true);
	}
});

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const marketplaceContainer = viewContainerRegistry.registerViewContainer({
	id: V3CODE_MARKETPLACE_CONTAINER_ID,
	title: localize2('v3code.marketplace.container', 'MCP Servers'),
	// serverProcess paints reliably in the activity bar (Codicon.mcp can look blank
	// if the codicon font in a given build hasn't shipped that glyph yet).
	icon: Codicon.serverProcess,
	order: 9,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [V3CODE_MARKETPLACE_CONTAINER_ID, {
		mergeViewWithContainerWhenSingleView: true,
		orientation: Orientation.HORIZONTAL,
	}]),
	// Bust prior AuxBar / Panel / Sidebar storage from older builds.
	storageId: MARKETPLACE_STORAGE_ID,
	hideIfEmpty: false,
	alwaysUseContainerInfo: true,
}, ViewContainerLocation.Sidebar);

viewsRegistry.registerViews([{
	id: V3CODE_MARKETPLACE_VIEW_ID,
	name: localize2('v3code.marketplace.view', 'MCP Servers'),
	ctorDescriptor: new SyncDescriptor(MarketplaceViewPane),
	// Must stay toggleable so ensureMarketplaceViewVisible can clear sticky
	// hide state. Memory Ledger never relocated, so it can keep false.
	canToggleVisibility: true,
	canMoveView: false,
	order: 1,
}], marketplaceContainer);

registerWorkbenchContribution2(V3CodeMarketplaceContribution.ID, V3CodeMarketplaceContribution, WorkbenchPhase.BlockRestore);
