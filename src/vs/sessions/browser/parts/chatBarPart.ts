/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/chatBarPart.css';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground, agentsBadgeBackground, agentsBadgeForeground } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { Extensions, PaneComposite } from '../../../workbench/browser/panecomposite.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { Menus } from '../menus.js';
import { ActiveChatBarContext, ChatBarFocusContext } from '../../common/contextkeys.js';
import { ChatCompositeBar } from './chatCompositeBar.js';
import { $, append, prepend, size, Dimension } from '../../../base/browser/dom.js';

export class ChatBarPart extends AbstractPaneCompositePart { // TODO: should not be a AbstractPaneCompositePart but instead a custom Part with a CompositeBar

	static readonly activeViewSettingsKey = 'workbench.chatbar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.chatbar.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.chatbar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.chatbar.viewContainersWorkspaceState';

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return false; }

	/**
	 * Visual margins are zero: the glass layout renders parts as one seamless
	 * sheet with 1px CSS dividers (drawn via box-shadow, which takes no layout
	 * space) instead of margin-gapped floating cards.
	 */
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_LEFT = 0;
	static readonly MARGIN_RIGHT = 0;
	static readonly MARGIN_BOTTOM = 0;

	/** Border width — 0; column dividers are box-shadow hairlines in CSS */
	static readonly BORDER_WIDTH = 0;

	/** Inset so chat floats inside the grid leaf — room for top veil + side breathing (~0.25in). */
	static readonly INSET_TOP = 28;
	static readonly INSET_X = 16;
	static readonly INSET_BOTTOM = 12;

	/** Height of the session composite bar when visible */
	private static readonly SESSION_BAR_HEIGHT = 35;

	private _sessionCompositeBar: ChatCompositeBar | undefined;
	private _chromeHost: HTMLElement | undefined;

	protected _lastLayout: { readonly width: number; readonly height: number; readonly top: number; readonly left: number } | undefined;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	readonly priority = LayoutPriority.Normal;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService
	) {
		super(
			Parts.CHATBAR_PART,
			{
				hasTitle: false,
				trailingSeparator: true,
				borderWidth: () => 0,
			},
			ChatBarPart.activeViewSettingsKey,
			ActiveChatBarContext.bindTo(contextKeyService),
			ChatBarFocusContext.bindTo(contextKeyService),
			'chatbar',
			'chatbar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.ChatBar,
			Extensions.ChatBar,
			Menus.ChatBarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);

		// Floating top chrome in the inset veil: sidebar toggle (left) +
		// Cursor-style maximize / workplace toggle (right). Content scrolls
		// under the fade mask so it feels like it disappears into the page.
		this._chromeHost = prepend(parent, $('.sessions-chat-chrome'));
		const chromeLeft = append(this._chromeHost, $('.sessions-chat-chrome-left'));
		const chromeRight = append(this._chromeHost, $('.sessions-chat-chrome-right'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, chromeLeft, Menus.ChatBarChromeLeft, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
			telemetrySource: 'sessionsChatChromeLeft',
		}));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, chromeRight, Menus.ChatBarChromeRight, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
			telemetrySource: 'sessionsChatChromeRight',
		}));

		// Create the session composite bar and prepend it before the content area
		this._sessionCompositeBar = this._register(this.instantiationService.createInstance(ChatCompositeBar));
		prepend(parent, this._sessionCompositeBar.element);

		// Relayout when session bar visibility changes
		this._register(this._sessionCompositeBar.onDidChangeVisibility(() => {
			if (this._lastLayout) {
				this.layout(this._lastLayout.width, this._lastLayout.height, this._lastLayout.top, this._lastLayout.left);
			}
		}));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		// Store background and border as CSS variables for the card styling on .part
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		// No inline backgroundColor: the chat column is open glass over the
		// shell gradient (style.css keeps it transparent).
		container.style.backgroundColor = '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.CHATBAR_PART)) {
			return;
		}

		this._lastLayout = { width, height, top, left };

		const insetTop = ChatBarPart.INSET_TOP;
		const insetX = ChatBarPart.INSET_X;
		const insetBottom = ChatBarPart.INSET_BOTTOM;
		const sessionBarHeight = this._sessionCompositeBar?.visible ? ChatBarPart.SESSION_BAR_HEIGHT : 0;

		// Lay out the part at the full grid leaf size first.
		super.layout(width, height, top, left);

		// Then shrink + center the content so left/right insets stay equal.
		// (Previously content was inset-width but left-aligned → sticky left,
		// fat gap on the right.)
		const contentWidth = Math.max(0, width - insetX * 2);
		const contentHeight = Math.max(0, height - insetTop - insetBottom - sessionBarHeight);
		const container = this.getContainer();
		const contentArea = this.contentArea;
		if (contentArea) {
			size(contentArea, contentWidth, contentHeight);
			contentArea.style.marginTop = `${insetTop}px`;
			contentArea.style.marginLeft = `${insetX}px`;
			contentArea.style.marginRight = `${insetX}px`;
			contentArea.style.marginBottom = `${insetBottom}px`;
			const active = this.getActivePaneComposite() as PaneComposite | undefined;
			active?.layout(new Dimension(contentWidth, contentHeight));
		}

		if (container) {
			container.style.setProperty('--sessions-chat-inset-top', `${insetTop}px`);
			container.style.setProperty('--sessions-chat-inset-x', `${insetX}px`);
			container.style.setProperty('--sessions-chat-inset-bottom', `${insetBottom}px`);
		}

		if (this._chromeHost) {
			this._chromeHost.style.top = '0';
			this._chromeHost.style.left = `${insetX}px`;
			this._chromeHost.style.width = `${contentWidth}px`;
			this._chromeHost.style.height = `${insetTop}px`;
		}

		if (this._sessionCompositeBar?.visible) {
			this._sessionCompositeBar.element.style.top = `${insetTop - sessionBarHeight}px`;
			this._sessionCompositeBar.element.style.left = `${insetX}px`;
			this._sessionCompositeBar.element.style.width = `${contentWidth}px`;
		}

		// Keep Part.dimension at the full grid allocation for relayout().
		Part.prototype.layout.call(this, width, height, top, left);
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'chatbar',
			pinnedViewContainersKey: ChatBarPart.pinnedViewsKey,
			placeholderViewContainersKey: ChatBarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: ChatBarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: () => { },
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(agentsPanelBackground),
				inactiveBackgroundColor: theme.getColor(agentsPanelBackground),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(agentsBadgeBackground),
				badgeForeground: theme.getColor(agentsBadgeForeground),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override toJSON(): object {
		return {
			type: Parts.CHATBAR_PART
		};
	}
}
