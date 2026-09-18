/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as dom from '../../../../../base/browser/dom.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ITreeContextMenuEvent, ITreeElement, ITreeFilter } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ScrollEvent } from '../../../../../base/common/scrollable.js';
import { URI } from '../../../../../base/common/uri.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asCssVariable, buttonSecondaryBackground, buttonSecondaryForeground, buttonSecondaryHoverBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { katexContainerClassName } from '../../../markdown/common/markedKatexExtension.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatFollowup, IChatSendRequestOptions, IChatService } from '../../common/chatService/chatService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { IChatRequestModeInfo } from '../../common/model/chatModel.js';
import { IChatRequestViewModel, IChatResponseViewModel, IChatViewModel, isRequestVM, isResponseVM } from '../../common/model/chatViewModel.js';
import { findV3ActiveStickyRequest, getV3LastResponseMinHeight, getV3StickyRequestHandoff, V3_STICKY_REQUEST_ENABLED } from '../../common/widget/v3codeStickyRequest.js';
import { isV3DebugResponse } from '../../../void/browser/v3DebugResponse.js';
import { resolveV3BuiltinModeName } from '../../../void/common/v3DebugMode.js';
import { IDebugSessionService } from '../../../void/browser/debugSessionService.js';
import { V3DebugEvidencePanel } from '../../../void/browser/v3DebugTranscriptView.js';
import { ChatAccessibilityProvider } from '../accessibility/chatAccessibilityProvider.js';
import { ChatTreeItem, IChatAccessibilityService, IChatCodeBlockInfo, IChatFileTreeInfo, IChatListItemRendererOptions } from '../chat.js';
import { CodeBlockPart } from './chatContentParts/codeBlockPart.js';
import { ChatListDelegate, ChatListItemRenderer, IChatListItemTemplate, IChatRendererDelegate } from './chatListRenderer.js';
import { ChatEditorOptions } from './chatOptions.js';
import { ChatPendingDragController } from './chatPendingDragAndDrop.js';

interface IChatTurnRailEntry {
	readonly request: IChatRequestViewModel;
	readonly response: IChatResponseViewModel | undefined;
	readonly requestIndex: number;
}

export interface IChatListWidgetStyles {
	listForeground?: string;
	listBackground?: string;
}

export interface IChatListWidgetOptions {
	/**
	 * Options for the list item renderer.
	 */
	readonly rendererOptions?: IChatListItemRendererOptions;

	/**
	 * Default height for list elements.
	 */
	readonly defaultElementHeight?: number;

	/**
	 * DOM node for overflow widgets (e.g., code editors).
	 */
	readonly overflowWidgetsDomNode?: HTMLElement;

	/**
	 * Optional style overrides for the list.
	 */
	readonly styles?: IChatListWidgetStyles;

	/**
	 * Callback to get the current chat mode.
	 */
	readonly currentChatMode?: () => ChatModeKind;

	/**
	 * View ID for editor options (used in ChatWidget context).
	 */
	readonly viewId?: string;

	/**
	 * Input editor background color key.
	 */
	readonly inputEditorBackground?: string;

	/**
	 * Result editor background color key.
	 */
	readonly resultEditorBackground?: string;

	/**
	 * Optional filter for the tree.
	 */
	readonly filter?: ITreeFilter<ChatTreeItem, FuzzyScore>;

	/**
	 * Initial view model.
	 */
	readonly viewModel?: IChatViewModel;

	/**
	 * Optional pre-created editor options.
	 * If provided, these will be used instead of creating new ones.
	 */
	readonly editorOptions?: ChatEditorOptions;

	/**
	 * The chat location (for rerun requests).
	 */
	readonly location?: ChatAgentLocation;

	/**
	 * Callback to get current language model ID (for rerun requests).
	 */
	readonly getCurrentLanguageModelId?: () => string | undefined;

	/**
	 * Callback to get current mode info (for rerun requests).
	 */
	readonly getCurrentModeInfo?: () => IChatRequestModeInfo | undefined;

	/**
	 * The render style for the chat widget. Affects minimum height behavior.
	 */
	readonly renderStyle?: 'compact' | 'minimal';
}

/**
 * A reusable widget that encapsulates chat list/tree rendering.
 * This can be used in various contexts such as the main chat widget,
 * hover previews, etc.
 */
export class ChatListWidget extends Disposable {

	//#region Events

	private readonly _onDidScroll = this._register(new Emitter<ScrollEvent>());
	readonly onDidScroll: Event<ScrollEvent> = this._onDidScroll.event;

	private readonly _onDidChangeContentHeight = this._register(new Emitter<void>());
	readonly onDidChangeContentHeight: Event<void> = this._onDidChangeContentHeight.event;

	private readonly _onDidClickFollowup = this._register(new Emitter<IChatFollowup>());
	readonly onDidClickFollowup: Event<IChatFollowup> = this._onDidClickFollowup.event;

	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus: Event<void> = this._onDidFocus.event;

	private readonly _onDidChangeItemHeight = this._register(new Emitter<{ element: ChatTreeItem; height: number }>());
	/** Event fired when an item's height changes. Used for dynamic layout mode. */
	readonly onDidChangeItemHeight: Event<{ element: ChatTreeItem; height: number }> = this._onDidChangeItemHeight.event;

	/**
	 * Event fired when a request item is clicked.
	 */
	get onDidClickRequest(): Event<IChatListItemTemplate> {
		return this._renderer.onDidClickRequest;
	}

	/**
	 * Event fired when an item is re-rendered.
	 */
	get onDidRerender(): Event<IChatListItemTemplate> {
		return this._renderer.onDidRerender;
	}

	/**
	 * Event fired when a template is disposed.
	 */
	get onDidDispose(): Event<IChatListItemTemplate> {
		return this._renderer.onDidDispose;
	}

	/**
	 * Event fired when focus moves outside the editing area.
	 */
	get onDidFocusOutside(): Event<void> {
		return this._renderer.onDidFocusOutside;
	}

	//#endregion

	//#region Private fields

	private readonly _tree: WorkbenchObjectTree<ChatTreeItem, FuzzyScore>;
	private readonly _renderer: ChatListItemRenderer;
	private readonly _delegate: ChatListDelegate;

	private _viewModel: IChatViewModel | undefined;
	private _visible = true;
	private _lastItem: ChatTreeItem | undefined;
	private _mostRecentlyFocusedItemIndex: number = -1;
	private _scrollLock: boolean = true;
	private _suppressAutoScroll: boolean = false;
	private _settingChangeCounter: number = 0;
	private _visibleChangeCount: number = 0;

	private readonly _container: HTMLElement;
	private readonly _scrollDownButton: Button;
	private readonly _lastItemIdContextKey: IContextKey<string[]>;

	// V3Code: floating capsule pinned to the top of the viewport showing the
	// user request that has scrolled off above (Cursor-style sticky message).
	private _stickyRequestElement: HTMLElement | undefined;
	private _stickyRequestTextElement: HTMLElement | undefined;
	private _stickyRequest: IChatRequestViewModel | undefined;
	private _stickyRequestHiddenSourceElement: HTMLElement | undefined;
	private _stickyRequestActive: boolean = false;

	// V3Code Debug: the runtime-evidence sink's tail, pinned as a single floating strip at the
	// top of the chat (borrowing the sticky-capsule mount) instead of living inside a response
	// row. Out of the virtualized list, it grows and shrinks on its own poll clock without ever
	// perturbing message scroll — the churn that an in-row panel caused. One per widget, shown
	// only in the Debug chat while a sink is coming up or running.
	private _evidenceDock: V3DebugEvidencePanel | undefined;

	// V3Code conversation rail: a compact, position-aware map of user turns.
	// It handles historical navigation while the sticky capsule is deliberately
	// limited to the single active turn.
	private _turnRailElement: HTMLElement | undefined;
	private _turnRailMarkersElement: HTMLElement | undefined;
	private _turnRailPreviewElement: HTMLElement | undefined;
	private _turnRailPreviewTitleElement: HTMLElement | undefined;
	private _turnRailPreviewBodyElement: HTMLElement | undefined;
	private _turnRailEntries: IChatTurnRailEntry[] = [];
	private readonly _turnRailMarkers = new Map<string, HTMLSpanElement>();
	private _turnRailInteractionRequestId: string | undefined;
	private _turnRailIsScrubbing = false;

	private readonly _location: ChatAgentLocation | undefined;
	private readonly _getCurrentLanguageModelId: (() => string | undefined) | undefined;
	private readonly _getCurrentModeInfo: (() => IChatRequestModeInfo | undefined) | undefined;
	private readonly _renderStyle: 'compact' | 'minimal' | undefined;

	//#endregion

	//#region Properties

	get domNode(): HTMLElement {
		return this._container;
	}

	get scrollTop(): number {
		return this._tree.scrollTop;
	}

	set scrollTop(value: number) {
		this._tree.scrollTop = value;
	}

	get scrollHeight(): number {
		return this._tree.scrollHeight;
	}

	get renderHeight(): number {
		return this._tree.renderHeight;
	}

	get contentHeight(): number {
		return this._tree.contentHeight;
	}

	/**
	 * Whether the list is scrolled to the bottom.
	 */
	get isScrolledToBottom(): boolean {
		return this._tree.scrollTop + this._tree.renderHeight >= this._tree.scrollHeight - 2;
	}

	/**
	 * The last item in the list.
	 */
	get lastItem(): ChatTreeItem | undefined {
		return this._lastItem;
	}



	//#endregion

	constructor(
		container: HTMLElement,
		options: IChatListWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatAccessibilityService private readonly chatAccessibilityService: IChatAccessibilityService,
		@IDebugSessionService private readonly _debugSessionService: IDebugSessionService,
	) {
		super();

		this._viewModel = options.viewModel;
		this._location = options.location;
		this._getCurrentLanguageModelId = options.getCurrentLanguageModelId;
		this._getCurrentModeInfo = options.getCurrentModeInfo;
		this._lastItemIdContextKey = ChatContextKeys.lastItemId.bindTo(this.contextKeyService);
		this._container = container;

		// Toggle link-style for inline reference widgets based on configuration (single listener for all widgets)
		const updateInlineReferencesStyle = () => {
			const style = this.configurationService.getValue<string>(ChatConfiguration.InlineReferencesStyle);
			this._container.classList.toggle('chat-inline-references-link-style', style === 'link');
		};
		updateInlineReferencesStyle();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.InlineReferencesStyle)) {
				updateInlineReferencesStyle();
			}
		}));

		const scopedInstantiationService = this._register(this.instantiationService.createChild(
			new ServiceCollection([IContextKeyService, this.contextKeyService])
		));
		this._renderStyle = options.renderStyle ?? options.rendererOptions?.renderStyle;

		// Create overflow widgets container
		const overflowWidgetsContainer = options.overflowWidgetsDomNode ?? document.createElement('div');
		if (!options.overflowWidgetsDomNode) {
			overflowWidgetsContainer.classList.add('chat-overflow-widget-container', 'monaco-editor');
			this._container.append(overflowWidgetsContainer);
			this._register(toDisposable(() => overflowWidgetsContainer.remove()));
		}

		// Create editor options (use provided or create new)
		const editorOptions = options.editorOptions ?? this._register(scopedInstantiationService.createInstance(
			ChatEditorOptions,
			options.viewId,
			'foreground',
			options.inputEditorBackground ?? 'chat.requestEditor.background',
			options.resultEditorBackground ?? 'chat.responseEditor.background'
		));

		// Create delegate
		this._delegate = scopedInstantiationService.createInstance(
			ChatListDelegate,
			options.defaultElementHeight ?? 200
		);

		// Create renderer delegate
		const rendererDelegate: IChatRendererDelegate = {
			getListLength: () => this._tree.getNode(null).visibleChildrenCount,
			onDidScroll: this.onDidScroll,
			container: this._container,
			currentChatMode: options.currentChatMode ?? (() => ChatModeKind.Ask),
		};

		// Create renderer
		this._renderer = this._register(scopedInstantiationService.createInstance(
			ChatListItemRenderer,
			editorOptions,
			options.rendererOptions ?? {},
			rendererDelegate,
			overflowWidgetsContainer,
			this._viewModel,
		));

		// Wire up renderer events
		this._register(this._renderer.onDidClickFollowup(item => {
			this._onDidClickFollowup.fire(item);
		}));

		this._register(this._renderer.onDidChangeItemHeight(e => {
			this._updateElementHeight(e.element, e.height);

			// If the second-to-last item's height changed, update the last item's min height
			const secondToLastItem = this._viewModel?.getItems().at(-2);
			if (e.element.id === secondToLastItem?.id) {
				this.updateLastItemMinHeight();
			}

			this._onDidChangeItemHeight.fire(e);
		}));

		// Handle rerun with agent or command detection internally
		this._register(this._renderer.onDidClickRerunWithAgentOrCommandDetection(e => {
			const request = this.chatService.getSession(e.sessionResource)?.getRequests().find(candidate => candidate.id === e.requestId);
			if (request) {
				const sendOptions: IChatSendRequestOptions = {
					noCommandDetection: true,
					attempt: request.attempt + 1,
					location: this._location,
					userSelectedModelId: this._getCurrentLanguageModelId?.(),
					modeInfo: this._getCurrentModeInfo?.(),
				};
				this.chatAccessibilityService.acceptRequest(e.sessionResource);
				this.chatService.resendRequest(request, sendOptions).catch(e => this.logService.error('FAILED to rerun request', e));
			}
		}));

		// Create drag-and-drop controller for reordering pending requests
		this._renderer.pendingDragController = this._register(
			scopedInstantiationService.createInstance(ChatPendingDragController, this._container, () => this._viewModel)
		);

		// Create tree
		const styles = options.styles ?? {};
		this._tree = this._register(scopedInstantiationService.createInstance(
			WorkbenchObjectTree<ChatTreeItem, FuzzyScore>,
			'ChatList',
			this._container,
			this._delegate,
			[this._renderer],
			{
				identityProvider: { getId: (e: ChatTreeItem) => e.id },
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: false,
				supportDynamicHeights: true,
				hideTwistiesOfChildlessElements: true,
				accessibilityProvider: this.instantiationService.createInstance(ChatAccessibilityProvider),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (e: ChatTreeItem) =>
						isRequestVM(e) ? e.message : isResponseVM(e) ? e.response.value : ''
				},
				setRowLineHeight: false,
				scrollToActiveElement: true,
				filter: options.filter,
				overrideStyles: {
					listFocusBackground: styles.listBackground,
					listInactiveFocusBackground: styles.listBackground,
					listActiveSelectionBackground: styles.listBackground,
					listFocusAndSelectionBackground: styles.listBackground,
					listInactiveSelectionBackground: styles.listBackground,
					listHoverBackground: styles.listBackground,
					listBackground: styles.listBackground,
					listFocusForeground: styles.listForeground,
					listHoverForeground: styles.listForeground,
					listInactiveFocusForeground: styles.listForeground,
					listInactiveSelectionForeground: styles.listForeground,
					listActiveSelectionForeground: styles.listForeground,
					listFocusAndSelectionForeground: styles.listForeground,
					listActiveSelectionIconForeground: undefined,
					listInactiveSelectionIconForeground: undefined,
				}
			}
		));

		this._ensureTurnRail();

		// Create scroll-down button
		this._scrollDownButton = this._register(new Button(this._container, {
			buttonBackground: asCssVariable(buttonSecondaryBackground),
			buttonForeground: asCssVariable(buttonSecondaryForeground),
			buttonHoverBackground: asCssVariable(buttonSecondaryHoverBackground),
			buttonSecondaryBackground: undefined,
			buttonSecondaryForeground: undefined,
			buttonSecondaryHoverBackground: undefined,
			buttonSeparator: undefined,
			supportIcons: true,
		}));
		this._scrollDownButton.element.classList.add('chat-scroll-down');
		this._scrollDownButton.label = `$(${Codicon.chevronDown.id})`;
		this._scrollDownButton.element.style.display = 'none'; // Hidden by default

		this._register(this._scrollDownButton.onDidClick(() => {
			this.setScrollLock(true);
			this.scrollToEnd();
		}));

		// Wire up tree events

		// Handle content height changes (fires high-level event, internal scroll handling)
		this._register(this._tree.onDidChangeContentHeight(() => {
			this._onDidChangeContentHeight.fire();
		}));

		this._register(this._tree.onDidFocus(() => {
			this._onDidFocus.fire();
		}));

		// Handle focus changes internally (update mostRecentlyFocusedItemIndex)
		this._register(this._tree.onDidChangeFocus(() => {
			const focused = this.getFocus();
			if (focused && focused.length > 0) {
				const focusedItem = focused[0];
				const items = this.getItems();
				const idx = items.findIndex(i => i === focusedItem);
				if (idx !== -1) {
					this._mostRecentlyFocusedItemIndex = idx;
				}
			}
		}));

		// Handle scroll events (fire public event and manage scroll-down button)
		this._register(this._tree.onDidScroll((e) => {
			this._onDidScroll.fire(e);
			this.updateScrollDownButtonVisibility();
			this._updateStickyRequest();
			this._updateTurnRailActiveMarker();
		}));

		// Row heights settle asynchronously — keep the sticky capsule in sync.
		this._register(this._tree.onDidChangeContentHeight(() => {
			this._updateStickyRequest();
			this._syncTurnRail();
		}));

		// The sink can start, stop or gain evidence at any time — the floating dock's
		// visibility follows the session phase, so react to every change.
		this._register(this._debugSessionService.onDidChange(() => this._updateEvidenceDock()));
		// The dock is recreated on demand rather than held for the widget's lifetime, so dispose
		// whichever instance is live when the widget goes away.
		this._register(toDisposable(() => { this._evidenceDock?.dispose(); this._evidenceDock = undefined; }));

		// Set initial at-bottom state (scrollLock defaults to true)
		this.updateScrollDownButtonVisibility();

		// Handle context menu internally
		this._register(this._tree.onContextMenu(e => {
			this.handleContextMenu(e);
		}));

		this._register(this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(ChatConfiguration.EditRequests) || e.affectsConfiguration(ChatConfiguration.CheckpointsEnabled)) {
				this._settingChangeCounter++;
				this.refresh();
			}
		}));
	}

	//#region Internal event handlers

	/**
	 * Update scroll-down button visibility based on scroll position and scroll lock.
	 */
	private updateScrollDownButtonVisibility(): void {
		const atBottom = this.isScrolledToBottom || this._scrollLock;
		this._scrollDownButton.element.style.display = atBottom ? 'none' : '';
		this._container.classList.toggle('chat-list-at-bottom', atBottom);
	}

	/**
	 * V3Code sticky request capsule: while the active response grows, its user
	 * request is pinned as soon as its row top crosses the viewport top. Historical
	 * navigation remains the conversation rail's job; the returned row geometry
	 * preserves the original moving handoff without letting older turns compete.
	 */
	private _findStickyRequest(): ReturnType<typeof findV3ActiveStickyRequest> {
		if (!V3_STICKY_REQUEST_ENABLED) {
			// Single gate for the whole capsule: no owner means no element is ever
			// created, and updateLastItemMinHeight falls back to its pre-capsule
			// request cap, so the transcript keeps the layout it had before.
			return undefined;
		}
		if (!this._viewModel || this._viewModel.editing) {
			// The inline edit session pins its own row; stay out of the way.
			return undefined;
		}
		return findV3ActiveStickyRequest(
			this._viewModel.getItems(),
			this._stickyRequestActive,
			this._tree.scrollTop,
			item => this._delegate.getHeight(item),
		);
	}

	private _ensureStickyRequestElement(): HTMLElement {
		if (!this._stickyRequestElement) {
			const element = document.createElement('div');
			element.classList.add('chat-sticky-request');
			element.setAttribute('role', 'button');
			element.tabIndex = 0;
			element.setAttribute('aria-label', 'Scroll to this message');
			const text = document.createElement('div');
			text.classList.add('chat-sticky-request-text');
			element.appendChild(text);
			this._stickyRequestTextElement = text;
			// The element is created lazily, possibly after the working state was
			// already set — reflect the current state on first creation.
			element.classList.toggle('working', this._stickyRequestActive);
			const revealRequest = () => {
				if (this._stickyRequest && this._tree.hasElement(this._stickyRequest)) {
					this.setScrollLock(false);
					this._tree.reveal(this._stickyRequest, 0);
				}
			};
			this._register(dom.addDisposableListener(element, dom.EventType.CLICK, revealRequest));
			this._register(dom.addDisposableListener(element, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key !== 'Enter' && event.key !== ' ') {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				revealRequest();
			}));
			this._register(toDisposable(() => element.remove()));
			this._container.appendChild(element);
			this._stickyRequestElement = element;
		}
		return this._stickyRequestElement;
	}

	private _updateStickyRequest(): void {
		const found = this._findStickyRequest();
		const sticky = found?.item;
		const stickyChanged = sticky !== this._stickyRequest;
		if (stickyChanged) {
			this._stickyRequest = sticky;
			if (sticky) {
				const element = this._ensureStickyRequestElement();
				if (this._stickyRequestTextElement) {
					this._stickyRequestTextElement.textContent = sticky.messageText;
				}
				element.title = sticky.messageText;
				element.classList.add('visible');
			} else {
				this._stickyRequestElement?.classList.remove('visible');
			}
		}
		// Position on every update, not only when ownership changes. A short request
		// rides its original row until the capsule docks at the viewport top, so the
		// handoff reads as one moving surface rather than duplicated prompt text.
		if (found && this._stickyRequestElement) {
			const capsuleHeight = this._stickyRequestElement.offsetHeight;
			const handoff = getV3StickyRequestHandoff(found, capsuleHeight);
			this._stickyRequestElement.style.transform = handoff.offsetY > 0.5 ? `translateY(${handoff.offsetY}px)` : '';
			this._setStickyRequestSourceHidden(found.item, handoff.hideSource);
		} else if (this._stickyRequestElement) {
			this._stickyRequestElement.style.transform = '';
			this._setStickyRequestSourceHidden(undefined, false);
		}
		if (stickyChanged) {
			// The latest-response viewport spacer used the real request's capped
			// height before the capsule appeared. Recompute it now that the visible
			// request surface has a precise rendered height (and again when it leaves).
			this.updateLastItemMinHeight();
		}
	}

	/**
	 * True when this widget is showing a built-in Debug chat. The sink is workspace-scoped and
	 * every chat widget shares one session service, so the dock must be gated on the widget's own
	 * mode — otherwise a Debug session would sprout an evidence strip in every open chat.
	 *
	 * Reads the composer's current mode first (a fresh Debug chat with no turns yet), then falls
	 * back to the newest request's persisted mode (a reopened Debug chat being scrolled).
	 */
	private _isDebugChat(): boolean {
		if (resolveV3BuiltinModeName(this._getCurrentModeInfo?.()?.modeName) === 'debug') {
			return true;
		}
		const items = this.getItems();
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (isResponseVM(item)) {
				return isV3DebugResponse(item);
			}
		}
		return false;
	}

	/**
	 * Show, hide and mount the floating evidence dock. The panel owns its own polling, states and
	 * run boundary; this only decides whether it exists and whether the red "working" beam runs.
	 * Called on session change, request lifecycle and list refresh.
	 */
	private _updateEvidenceDock(): void {
		const phase = this._debugSessionService.getState().phase;
		// The dock is worth showing whenever the sink is coming up or up — 'starting', 'running'.
		// Everything else ('idle', 'stopped', 'unavailable') means there is nothing live to watch,
		// so a Debug chat with no sink shows no strip rather than a permanent "Off" box.
		const wantsDock = this._isDebugChat() && (phase === 'starting' || phase === 'running');
		if (!wantsDock) {
			if (this._evidenceDock) {
				this._evidenceDock.dispose();
				this._evidenceDock = undefined;
			}
			return;
		}
		if (!this._evidenceDock) {
			// isComplete is only used to slow the poll cadence; the dock outlives any single
			// response, so "no request in flight" is the right idle signal.
			this._evidenceDock = this.instantiationService.createInstance(
				V3DebugEvidencePanel,
				this._container,
				() => !this._stickyRequestActive,
				() => { /* height changes are free: the dock floats outside the virtualized list */ },
			);
			this._evidenceDock.domNode.classList.add('v3-debug-evidence-dock');
			this._evidenceDock.domNode.classList.toggle('working', this._stickyRequestActive);
		}
		this._evidenceDock.update();
	}

	private _setStickyRequestSourceHidden(request: IChatRequestViewModel | undefined, hidden: boolean): void {
		const nextSource = hidden && request
			? this._renderer.getTemplateDataForRequestId(request.id)?.rowContainer
			: undefined;
		if (nextSource === this._stickyRequestHiddenSourceElement) {
			return;
		}
		this._stickyRequestHiddenSourceElement?.classList.remove('chat-sticky-request-source-hidden');
		nextSource?.classList.add('chat-sticky-request-source-hidden');
		this._stickyRequestHiddenSourceElement = nextSource;
	}

	private _ensureTurnRail(): void {
		if (this._turnRailElement) {
			return;
		}

		const rail = document.createElement('nav');
		rail.classList.add('chat-turn-rail');
		rail.setAttribute('aria-label', 'User messages');

		const markers = document.createElement('div');
		markers.classList.add('chat-turn-rail-markers');
		rail.appendChild(markers);

		const preview = document.createElement('div');
		preview.classList.add('chat-turn-rail-preview');
		preview.setAttribute('aria-hidden', 'true');
		const previewTitle = document.createElement('div');
		previewTitle.classList.add('chat-turn-rail-preview-title');
		const previewBody = document.createElement('div');
		previewBody.classList.add('chat-turn-rail-preview-body');
		preview.append(previewTitle, previewBody);
		rail.appendChild(preview);

		this._turnRailElement = rail;
		this._turnRailMarkersElement = markers;
		this._turnRailPreviewElement = preview;
		this._turnRailPreviewTitleElement = previewTitle;
		this._turnRailPreviewBodyElement = previewBody;
		this._container.appendChild(rail);

		this._register(dom.addDisposableListener(rail, dom.EventType.CLICK, (event: MouseEvent) => {
			// Pointer taps are completed from pointerup using the marker captured on
			// pointerdown. Pointer capture may retarget this synthetic click to the
			// rail itself, so this path is intentionally keyboard-only.
			if (event.detail > 0) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			const marker = this._getTurnRailMarker(event.target);
			const requestId = marker?.dataset.requestId;
			const entry = requestId ? this._turnRailEntries.find(candidate => candidate.request.id === requestId) : undefined;
			if (!entry || !this._tree.hasElement(entry.request)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this._revealTurnRailEntry(entry, true);
		}));

		let scrubPointerId: number | undefined;
		let scrubStartY = 0;
		let scrubbed = false;
		let pointerDownMarker: HTMLSpanElement | undefined;
		let lastScrubbedRequestId: string | undefined;
		this._register(dom.addDisposableListener(rail, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			const marker = this._getTurnRailMarker(event.target);
			if (!marker || !event.isPrimary || event.button !== 0) {
				return;
			}
			scrubPointerId = event.pointerId;
			scrubStartY = event.clientY;
			scrubbed = false;
			pointerDownMarker = marker;
			lastScrubbedRequestId = marker.dataset.requestId;
			this._turnRailIsScrubbing = true;
			rail.classList.add('scrubbing', 'interacting');
			// We own pointer activation below. Preventing the native button focus on
			// pointerdown avoids a persistent focus rectangle after a mouse tap;
			// keyboard focus and activation remain untouched.
			event.preventDefault();
			try {
				rail.setPointerCapture(event.pointerId);
			} catch { /* Pointer capture is not available in every embedded browser. */ }
		}));

		this._register(dom.addDisposableListener(rail, dom.EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (scrubPointerId !== event.pointerId) {
				return;
			}
			if (!scrubbed && Math.abs(event.clientY - scrubStartY) < 4) {
				return;
			}
			scrubbed = true;
			let nearestMarker: HTMLSpanElement | undefined;
			let nearestDistance = Number.POSITIVE_INFINITY;
			for (const candidate of this._turnRailMarkers.values()) {
				const rect = candidate.getBoundingClientRect();
				const distance = Math.abs(event.clientY - (rect.top + rect.height / 2));
				if (distance < nearestDistance) {
					nearestDistance = distance;
					nearestMarker = candidate;
				}
			}
			const requestId = nearestMarker?.dataset.requestId;
			if (!nearestMarker || !requestId || requestId === lastScrubbedRequestId) {
				return;
			}
			lastScrubbedRequestId = requestId;
			const entry = this._turnRailEntries.find(candidate => candidate.request.id === requestId);
			if (entry) {
				this._showTurnRailPreview(nearestMarker);
				this._revealTurnRailEntry(entry, false);
			}
			event.preventDefault();
		}));

		const endScrub = (event: PointerEvent) => {
			if (scrubPointerId !== event.pointerId) {
				return;
			}
			const tapMarker = pointerDownMarker;
			const tapRequestId = tapMarker?.dataset.requestId;
			const wasScrubbed = scrubbed;
			const wasCancelled = event.type === 'pointercancel';
			scrubPointerId = undefined;
			pointerDownMarker = undefined;
			this._turnRailIsScrubbing = false;
			rail.classList.remove('scrubbing', 'interacting');
			try {
				rail.releasePointerCapture(event.pointerId);
			} catch { /* Ignore a capture that the browser already released. */ }
			if (!wasCancelled && !wasScrubbed && tapRequestId) {
				const entry = this._turnRailEntries.find(candidate => candidate.request.id === tapRequestId);
				if (entry) {
					this._revealTurnRailEntry(entry, true);
				}
			}
			// A click is synthesized after pointerup and may be retargeted to the
			// rail because of pointer capture. The gesture has already been handled.
			if (!wasCancelled) {
				const swallowClick = (clickEvent: MouseEvent) => {
					clickEvent.preventDefault();
					clickEvent.stopPropagation();
					rail.removeEventListener('click', swallowClick, true);
				};
				rail.addEventListener('click', swallowClick, true);
				dom.getWindow(rail).setTimeout(() => rail.removeEventListener('click', swallowClick, true), 0);
			}
			tapMarker?.blur();
			event.preventDefault();
			event.stopPropagation();
			this._hideTurnRailPreview();
		};
		this._register(dom.addDisposableListener(rail, dom.EventType.POINTER_UP, endScrub));
		this._register(dom.addDisposableListener(rail, 'pointercancel', endScrub));

		this._register(dom.addDisposableListener(rail, dom.EventType.MOUSE_OVER, (event: MouseEvent) => {
			const marker = this._getTurnRailMarker(event.target);
			if (marker) {
				this._showTurnRailPreview(marker);
			}
		}));

		this._register(dom.addDisposableListener(rail, dom.EventType.MOUSE_OUT, (event: MouseEvent) => {
			const marker = this._getTurnRailMarker(event.target);
			if (marker && event.relatedTarget instanceof Node && marker.contains(event.relatedTarget)) {
				return;
			}
			this._hideTurnRailPreview();
		}));

		this._register(dom.addDisposableListener(rail, dom.EventType.FOCUS_IN, (event: FocusEvent) => {
			const marker = this._getTurnRailMarker(event.target);
			if (marker) {
				this._showTurnRailPreview(marker);
			}
		}));

		this._register(dom.addDisposableListener(rail, dom.EventType.FOCUS_OUT, (event: FocusEvent) => {
			if (event.relatedTarget instanceof Node && rail.contains(event.relatedTarget)) {
				return;
			}
			this._hideTurnRailPreview();
		}));

		this._register(dom.addDisposableListener(rail, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				const marker = this._getTurnRailMarker(event.target);
				const requestId = marker?.dataset.requestId;
				const entry = requestId ? this._turnRailEntries.find(candidate => candidate.request.id === requestId) : undefined;
				if (!entry || !this._tree.hasElement(entry.request)) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				this._revealTurnRailEntry(entry, true);
				return;
			}
			if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
				return;
			}
			const marker = this._getTurnRailMarker(event.target);
			const currentIndex = marker?.dataset.requestId
				? this._turnRailEntries.findIndex(entry => entry.request.id === marker.dataset.requestId)
				: -1;
			if (currentIndex < 0) {
				return;
			}
			const delta = event.key === 'ArrowUp' ? -1 : 1;
			const targetIndex = Math.max(0, Math.min(this._turnRailEntries.length - 1, currentIndex + delta));
			const targetEntry = this._turnRailEntries[targetIndex];
			const targetMarker = this._turnRailMarkers.get(targetEntry.request.id);
			if (!targetMarker || targetIndex === currentIndex) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			targetMarker.focus();
			this._showTurnRailPreview(targetMarker);
			this._revealTurnRailEntry(targetEntry, true);
		}));

		this._register(toDisposable(() => {
			rail.remove();
		}));
	}

	private _getTurnRailMarker(target: EventTarget | null): HTMLSpanElement | undefined {
		const marker = dom.isHTMLElement(target) ? target.closest('.chat-turn-rail-marker') : null;
		return dom.isHTMLSpanElement(marker) && this._turnRailElement?.contains(marker) ? marker : undefined;
	}

	private _collectTurnRailEntries(): IChatTurnRailEntry[] {
		const entries: IChatTurnRailEntry[] = [];
		const items = this._viewModel?.getItems() ?? [];

		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (isRequestVM(item) && !item.isSystemInitiated) {
				let response: IChatResponseViewModel | undefined;
				for (let nextIndex = index + 1; nextIndex < items.length; nextIndex++) {
					const next = items[nextIndex];
					if (isRequestVM(next)) {
						break;
					}
					if (isResponseVM(next)) {
						response = next;
						break;
					}
				}
				entries.push({
					request: item,
					response,
					requestIndex: index,
				});
			}
		}

		return entries;
	}

	private _syncTurnRail(): void {
		if (!this._turnRailElement || !this._turnRailMarkersElement) {
			return;
		}

		const entries = this._collectTurnRailEntries();
		this._turnRailEntries = entries;
		const renderHeight = this._tree.renderHeight;
		const shouldShow = this._renderStyle !== 'compact'
			&& this._renderStyle !== 'minimal'
			&& entries.length > 0
			&& renderHeight >= 180
			&& this._hasTurnRailGutter();

		this._container.classList.toggle('chat-turn-rail-visible', shouldShow);
		this._turnRailElement.classList.toggle('visible', shouldShow);
		if (!shouldShow) {
			this._hideTurnRailPreview();
			return;
		}

		const entryIds = new Set(entries.map(entry => entry.request.id));
		for (const [requestId, marker] of this._turnRailMarkers) {
			if (!entryIds.has(requestId)) {
				marker.remove();
				this._turnRailMarkers.delete(requestId);
			}
		}

		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			let marker = this._turnRailMarkers.get(entry.request.id);
			if (!marker) {
				// A native button inherits workbench/theme button paint in some active
				// session states, turning the whole 36x10 hit target into an accent bar.
				// Keep semantic keyboard behavior without exposing the rail to button CSS.
				marker = document.createElement('span');
				marker.role = 'button';
				marker.tabIndex = 0;
				marker.classList.add('chat-turn-rail-marker');
				marker.dataset.requestId = entry.request.id;
				this._turnRailMarkers.set(entry.request.id, marker);
				this._turnRailMarkersElement.appendChild(marker);
			}

			const prompt = this._compactTurnRailText(entry.request.messageText, 110);
			marker.setAttribute('aria-label', `Jump to user message ${index + 1}: ${prompt}`);
			// Re-appending preserves transcript order when pending turns are reordered.
			this._turnRailMarkersElement.appendChild(marker);
		}
		const availableRailHeight = Math.min(Math.max(renderHeight - 16, 0), dom.getWindow(this._container).innerHeight * 0.7, 640);
		this._turnRailMarkersElement.classList.toggle('overflowing', entries.length * 10 > availableRailHeight);

		this._updateTurnRailActiveMarker();
	}

	/**
	 * True when the transcript's left gutter is wide enough to hold the floating turn
	 * rail without the rungs painting over the first characters of every row.
	 *
	 * The requirement is NOT a universal constant: it is the rail's own footprint
	 * (`left` + marker width, chat.css:677/740), and a host may shrink the rail to fit a
	 * narrower column. So hosts declare what their rail actually needs via
	 * `--v3-turn-rail-required-gutter`; 47.5 is the stock 16px offset + 26px marker plus
	 * breathing room. The agent workspace paints a 24px gutter and scales the rail down
	 * to match, so hardcoding 47.5 here would hide a rail that does in fact fit.
	 */
	private _hasTurnRailGutter(): boolean {
		const style = dom.getWindow(this._container).getComputedStyle(this._container);
		const edgeInset = Number.parseFloat(style.getPropertyValue('--v3-chat-edge-inset')) || 0;
		const textInset = Number.parseFloat(style.getPropertyValue('--v3-chat-text-inset')) || 0;
		const requiredGutter = Number.parseFloat(style.getPropertyValue('--v3-turn-rail-required-gutter')) || 47.5;
		return edgeInset + textInset >= requiredGutter;
	}

	private _updateTurnRailActiveMarker(): void {
		if (!this._turnRailElement?.classList.contains('visible') || this._turnRailEntries.length === 0) {
			return;
		}

		const firstVisibleItem = this._tree.firstVisibleElement;
		const visibleItemIndex = firstVisibleItem ? (this._viewModel?.getItems().indexOf(firstVisibleItem) ?? -1) : -1;
		let currentIndex = 0;
		for (let index = 0; index < this._turnRailEntries.length; index++) {
			if (this._turnRailEntries[index].requestIndex <= visibleItemIndex) {
				currentIndex = index;
			} else {
				break;
			}
		}
		const interactionIndex = this._turnRailInteractionRequestId
			? this._turnRailEntries.findIndex(entry => entry.request.id === this._turnRailInteractionRequestId)
			: -1;
		const activeClusterSize = Math.min(4, this._turnRailEntries.length);
		const activeClusterStart = Math.max(0, Math.min(currentIndex - 1, this._turnRailEntries.length - activeClusterSize));

		for (let index = 0; index < this._turnRailEntries.length; index++) {
			const marker = this._turnRailMarkers.get(this._turnRailEntries[index].request.id);
			if (!marker) {
				continue;
			}
			const interactionDistance = interactionIndex >= 0 ? Math.abs(index - interactionIndex) : -1;
			marker.classList.toggle('active-cluster', index >= activeClusterStart && index < activeClusterStart + activeClusterSize);
			marker.classList.toggle('current', index === currentIndex);
			marker.classList.toggle('target', interactionDistance === 0);
			marker.classList.toggle('near-one', interactionDistance === 1);
			marker.classList.toggle('near-two', interactionDistance === 2);
			marker.classList.toggle('near-three', interactionDistance === 3);
			if (index === currentIndex) {
				marker.setAttribute('aria-current', 'true');
			} else {
				marker.removeAttribute('aria-current');
			}
		}

		const markerToRevealIndex = interactionIndex >= 0 ? interactionIndex : currentIndex;
		const targetMarker = this._turnRailMarkers.get(this._turnRailEntries[markerToRevealIndex].request.id);
		if (targetMarker && this._turnRailMarkersElement) {
			const markerTop = targetMarker.offsetTop;
			const markerBottom = markerTop + targetMarker.offsetHeight;
			if (markerTop < this._turnRailMarkersElement.scrollTop) {
				this._turnRailMarkersElement.scrollTop = markerTop;
			} else if (markerBottom > this._turnRailMarkersElement.scrollTop + this._turnRailMarkersElement.clientHeight) {
				this._turnRailMarkersElement.scrollTop = markerBottom - this._turnRailMarkersElement.clientHeight;
			}
		}
	}

	private _showTurnRailPreview(marker: HTMLSpanElement): void {
		const requestId = marker.dataset.requestId;
		const entry = requestId ? this._turnRailEntries.find(candidate => candidate.request.id === requestId) : undefined;
		if (!entry || !this._turnRailPreviewElement || !this._turnRailPreviewTitleElement || !this._turnRailPreviewBodyElement || !this._turnRailElement) {
			return;
		}

		this._turnRailInteractionRequestId = entry.request.id;
		this._turnRailElement.classList.add('interacting');
		this._updateTurnRailActiveMarker();
		this._turnRailPreviewTitleElement.textContent = this._compactTurnRailText(entry.request.messageText, 150);
		const responseText = entry.response?.response.toString() ?? '';
		this._turnRailPreviewBodyElement.textContent = responseText
			? this._compactTurnRailText(responseText, 260)
			: 'Waiting for a response…';
		this._turnRailPreviewElement.classList.add('visible');
		this._turnRailPreviewElement.setAttribute('aria-hidden', 'false');

		const markerTop = marker.offsetTop - (this._turnRailMarkersElement?.scrollTop ?? 0) + marker.offsetHeight / 2;
		const previewHeight = this._turnRailPreviewElement.offsetHeight;
		const maxTop = Math.max(4, this._turnRailElement.clientHeight - previewHeight - 4);
		this._turnRailPreviewElement.style.top = `${Math.max(4, Math.min(maxTop, markerTop - previewHeight / 2))}px`;
	}

	private _hideTurnRailPreview(): void {
		if (this._turnRailIsScrubbing) {
			return;
		}
		this._turnRailInteractionRequestId = undefined;
		this._turnRailElement?.classList.remove('interacting');
		this._turnRailPreviewElement?.classList.remove('visible');
		this._turnRailPreviewElement?.setAttribute('aria-hidden', 'true');
		this._updateTurnRailActiveMarker();
	}

	private _revealTurnRailEntry(entry: IChatTurnRailEntry, flash: boolean): void {
		if (!this._tree.hasElement(entry.request)) {
			return;
		}
		this.setScrollLock(false);
		// The object tree owns row geometry and virtualization. Revealing the real
		// request element is reliable after rows resize; a parallel pixel estimate
		// is not (tool calls and progressive responses change height constantly).
		this._tree.reveal(entry.request, 0);
		this._updateTurnRailActiveMarker();
		if (flash) {
			dom.scheduleAtNextAnimationFrame(dom.getWindow(this._container), () => this._flashTurnRailEntry(entry.request));
		}
	}

	private _flashTurnRailEntry(request: IChatRequestViewModel): void {
		const row = this._renderer.getTemplateDataForRequestId(request.id)?.rowContainer;
		if (!row) {
			return;
		}
		row.classList.remove('chat-turn-rail-flash');
		dom.scheduleAtNextAnimationFrame(dom.getWindow(row), () => row.classList.add('chat-turn-rail-flash'));
		const clear = () => row.classList.remove('chat-turn-rail-flash');
		row.addEventListener('animationend', clear, { once: true });
		dom.getWindow(row).setTimeout(clear, 1500);
	}

	private _compactTurnRailText(value: string, maxLength: number): string {
		const compact = value.replace(/\s+/g, ' ').trim();
		return compact.length > maxLength ? `${compact.slice(0, maxLength - 1).trimEnd()}…` : compact;
	}

	/**
	 * Mirror the actual request lifecycle onto the sticky capsule. This is kept
	 * independent from the optional composer-border animation setting.
	 */
	setStickyRequestActive(active: boolean): void {
		if (this._stickyRequestActive === active) {
			return;
		}
		this._stickyRequestActive = active;
		this._stickyRequestElement?.classList.toggle('working', active);
		// The floating evidence dock shares the request lifecycle: the red beam runs only while a
		// request is genuinely in flight, and appears/disappears as a Debug turn starts and stops.
		this._evidenceDock?.domNode.classList.toggle('working', active);
		this._updateEvidenceDock();
		this._updateStickyRequest();
	}

	/**
	 * Handle context menu events.
	 */
	private handleContextMenu(e: ITreeContextMenuEvent<ChatTreeItem | null>): void {
		e.browserEvent.preventDefault();
		e.browserEvent.stopPropagation();

		const selected = e.element;

		// Check if the context menu was opened on a KaTeX element
		const target = e.browserEvent.target as HTMLElement;
		const isKatexElement = target.closest(`.${katexContainerClassName}`) !== null;

		const scopedContextKeyService = this.contextKeyService.createOverlay([
			[ChatContextKeys.isResponse.key, isResponseVM(selected)],
			[ChatContextKeys.responseIsFiltered.key, isResponseVM(selected) && !!selected.errorDetails?.responseIsFiltered],
			[ChatContextKeys.isKatexMathElement.key, isKatexElement]
		]);
		this.contextMenuService.showContextMenu({
			menuId: MenuId.ChatContext,
			menuActionOptions: { shouldForwardArgs: true },
			contextKeyService: scopedContextKeyService,
			getAnchor: () => e.anchor,
			getActionsContext: () => selected,
		});
	}

	//#endregion

	//#region ViewModel methods

	/**
	 * Set the view model for the list to render.
	 */
	setViewModel(viewModel: IChatViewModel | undefined): void {
		this._viewModel = viewModel;
		this._renderer.updateViewModel(viewModel);
	}

	/**
	 * Refresh the list from the current view model.
	 * Uses internal state for diff identity calculation.
	 */
	refresh(): void {
		if (!this._viewModel) {
			this._tree.setChildren(null, []);
			this._lastItem = undefined;
			this._lastItemIdContextKey.set([]);
			this._updateStickyRequest();
			this._syncTurnRail();
			return;
		}

		const items = this._viewModel.getItems();
		this._lastItem = items.at(-1);
		this._lastItemIdContextKey.set(this._lastItem ? [this._lastItem.id] : []);

		const treeItems: ITreeElement<ChatTreeItem>[] = items.map(item => ({
			element: item,
			collapsed: false,
			collapsible: false,
		}));

		const editing = this._viewModel.editing;

		this._withPersistedAutoScroll(() => {
			this._tree.setChildren(null, treeItems, {
				diffIdentityProvider: {
					getId: (element) => {
						// Pending types only have 'id', request/response have 'dataId'
						const baseId = (isRequestVM(element) || isResponseVM(element)) ? element.dataId : element.id;
						const disablement = (isRequestVM(element) || isResponseVM(element)) ? element.shouldBeRemovedOnSend : undefined;
						// Per-element editing state: only re-render items whose editing role changed
						const isEditTarget = isRequestVM(element) && editing?.id === element.id;
						const isBlocked = (isRequestVM(element) || isResponseVM(element)) ? element.shouldBeBlocked.get() : false;
						return baseId +
							// If a response is in the process of progressive rendering, we need to ensure that it will
							// be re-rendered so progressive rendering is restarted, even if the model wasn't updated.
							`${isResponseVM(element) && element.renderData ? `_${this._visibleChangeCount}` : ''}` +
							// Re-render once content references are loaded
							(isResponseVM(element) ? `_${element.contentReferences.length}` : '') +
							// Re-render if element becomes hidden due to undo/redo
							`_${disablement ? `${disablement.afterUndoStop || '1'}` : '0'}` +
							// Re-render the request being edited and requests whose blocked state changed
							`_${isEditTarget ? 'edit' : ''}` +
							`_${isBlocked ? 'blocked' : ''}` +
							// Re-render requests when editing starts/stops (for hover button visibility, click handlers)
							(isRequestVM(element) ? `_${editing ? '1' : '0'}` : '') +
							// Re-render all if invoked by setting change
							`_setting${this._settingChangeCounter}` +
							// Rerender request if we got new content references in the response
							// since this may change how we render the corresponding attachments in the request
							(isRequestVM(element) && element.contentReferences ? `_${element.contentReferences?.length}` : '');
					},
				}
			});
		});

		this._updateStickyRequest();
		this._updateEvidenceDock();
		this._syncTurnRail();
	}

	/**
	 * Set scroll lock state.
	 */
	setScrollLock(value: boolean): void {
		this._scrollLock = value;
		this.updateScrollDownButtonVisibility();
	}

	/**
	 * Get scroll lock state.
	 */
	get scrollLock(): boolean {
		return this._scrollLock;
	}

	/**
	 * Set the visible change count (for diff identity).
	 */
	setVisibleChangeCount(value: number): void {
		this._visibleChangeCount = value;
	}

	/**
	 * Scroll to reveal an element if editing.
	 */
	scrollToCurrentItem(currentElement: IChatRequestViewModel): void {
		if (!this._viewModel?.editing || !currentElement) {
			return;
		}
		if (!this._tree.hasElement(currentElement)) {
			return;
		}
		const relativeTop = this._tree.getRelativeTop(currentElement);
		if (relativeTop === null || relativeTop < 0 || relativeTop > 1) {
			this._tree.reveal(currentElement, 0);
		}
	}

	//#endregion

	//#region Tree methods

	/**
	 * Rerender the tree.
	 */
	rerender(): void {
		this._tree.rerender();
	}

	private getItems(): ChatTreeItem[] {
		const items: ChatTreeItem[] = [];
		const root = this._tree.getNode(null);
		for (const child of root.children) {
			if (child.element) {
				items.push(child.element);
			}
		}
		return items;
	}


	/**
	 * Delegate scroll events from a mouse wheel event to the tree.
	 */
	delegateScrollFromMouseWheelEvent(event: IMouseWheelEvent): void {
		this._tree.delegateScrollFromMouseWheelEvent(event);
	}

	/**
	 * Whether the tree has a specific element.
	 */
	hasElement(element: ChatTreeItem): boolean {
		return this._tree.hasElement(element);
	}

	/**
	 * Update the height of an element.
	 */
	private _updateElementHeight(element: ChatTreeItem, height?: number): void {
		if (this._tree.hasElement(element) && this._visible) {
			this._withPersistedAutoScroll(() => {
				this._tree.updateElementHeight(element, height);
			});
		}
	}

	/**
	 * Scroll to reveal an element.
	 */
	reveal(element: ChatTreeItem, relativeTop?: number): void {
		this._tree.reveal(element, relativeTop);
	}

	/**
	 * Get the focused elements.
	 */
	getFocus(): ChatTreeItem[] {
		return this._tree.getFocus().filter((e): e is ChatTreeItem => e !== null);
	}

	/**
	 * Set the focused elements.
	 */
	setFocus(elements: ChatTreeItem[]): void {
		this._tree.setFocus(elements);
	}

	focusItem(item: ChatTreeItem): void {
		if (!this.hasElement(item)) {
			return;
		}
		this._tree.setFocus([item]);
		this._tree.domFocus();
	}

	/**
	 * Focus the last item in the list. Returns the index of the focused item.
	 * @param useMostRecentlyFocusedIndex If true, use the mostRecentlyFocusedIndex if valid
	 */
	focusLastItem(useMostRecentlyFocusedIndex?: boolean): number {
		const items = this.getItems();
		if (items.length === 0) {
			return -1;
		}

		let focusIndex: number;
		if (useMostRecentlyFocusedIndex && this._mostRecentlyFocusedItemIndex >= 0 && this._mostRecentlyFocusedItemIndex < items.length) {
			focusIndex = this._mostRecentlyFocusedItemIndex;
		} else {
			focusIndex = items.length - 1;
		}

		this._tree.setFocus([items[focusIndex]]);
		this._tree.domFocus();
		return focusIndex;
	}

	/**
	 * Scroll the list to reveal the last item.
	 */
	scrollToEnd(): void {
		if (this._lastItem) {
			const offset = Math.max(this._lastItem.currentRenderedHeight ?? 0, 1e6);
			if (this._tree.hasElement(this._lastItem)) {
				this._tree.reveal(this._lastItem, offset);
			}
		}
	}

	/**
	 * Suppress auto-scroll behavior temporarily. While suppressed,
	 * _withPersistedAutoScroll will not scroll to bottom after operations.
	 */
	set suppressAutoScroll(value: boolean) {
		this._suppressAutoScroll = value;
	}

	private _withPersistedAutoScroll(fn: () => void): void {
		if (this._suppressAutoScroll) {
			fn();
			return;
		}
		const wasScrolledToBottom = this.isScrolledToBottom;
		fn();
		if (wasScrolledToBottom && !this._hasActiveTextSelection()) {
			this.scrollToEnd();
		}
	}

	/**
	 * Returns true when the user has an active text selection inside the chat
	 * container. During selection, auto-scroll would fight the user's read
	 * position and make copying impossible — so we suppress it.
	 */
	private _hasActiveTextSelection(): boolean {
		const selection = dom.getActiveWindow().getSelection();
		if (!selection || selection.isCollapsed) {
			return false;
		}
		// Only suppress when the selection is inside our chat tree
		const anchorNode = selection.anchorNode;
		return !!anchorNode && dom.isAncestor(anchorNode, this._container);
	}

	/**
	 * Focus the list.
	 */
	focus(): void {
		this._tree.domFocus();
	}

	/**
	 * Get the DOM focus state.
	 */
	isDOMFocused(): boolean {
		return this._tree.isDOMFocused();
	}

	//#endregion

	//#region Renderer methods

	/**
	 * Get code block info for a response.
	 */
	getCodeBlockInfosForResponse(response: IChatResponseViewModel): IChatCodeBlockInfo[] {
		return this._renderer.getCodeBlockInfosForResponse(response);
	}

	/**
	 * Get code block info by URI.
	 */
	getCodeBlockInfoForEditor(uri: URI): IChatCodeBlockInfo | undefined {
		return this._renderer.getCodeBlockInfoForEditor(uri);
	}

	/**
	 * Get file tree info for a response.
	 */
	getFileTreeInfosForResponse(response: IChatResponseViewModel): IChatFileTreeInfo[] {
		return this._renderer.getFileTreeInfosForResponse(response);
	}

	/**
	 * Get the last focused file tree for a response.
	 */
	getLastFocusedFileTreeForResponse(response: IChatResponseViewModel): IChatFileTreeInfo | undefined {
		return this._renderer.getLastFocusedFileTreeForResponse(response);
	}

	/**
	 * Get editors currently in use.
	 */
	editorsInUse(): Iterable<CodeBlockPart> {
		return this._renderer.editorsInUse();
	}



	/**
	 * Get template data for a request ID.
	 */
	getTemplateDataForRequestId(requestId: string | undefined): IChatListItemTemplate | undefined {
		if (!requestId) {
			return undefined;
		}
		return this._renderer.getTemplateDataForRequestId(requestId);
	}

	/**
	 * Update renderer options.
	 */
	updateRendererOptions(options: IChatListItemRendererOptions): void {
		this._renderer.updateOptions(options);
	}

	/**
	 * Set the visibility of the list.
	 */
	setVisible(visible: boolean): void {
		this._visible = visible;
		this._renderer.setVisible(visible);
	}

	/**
	 * Layout the list.
	 */
	layout(height: number, width: number, rendererWidth: number = width): void {
		this._bodyDimension = new dom.Dimension(width ?? this._container.clientWidth, height);
		this.updateLastItemMinHeight();
		this._tree.layout(height, width);
		this._renderer.layout(rendererWidth);
		this._syncTurnRail();
	}

	private _bodyDimension: dom.Dimension | null = null;
	private _previousLastItemMinHeight: number | null = null;

	private updateLastItemMinHeight(): void {
		if (!this._bodyDimension) {
			return;
		}

		const contentHeight = this._bodyDimension.height;
		if (this._renderStyle === 'compact' || this._renderStyle === 'minimal') {
			this._container.style.removeProperty('--chat-current-response-min-height');
		} else {
			const secondToLastItem = this._viewModel?.getItems().at(-2);
			const secondToLastItemHeight = (isRequestVM(secondToLastItem) || isResponseVM(secondToLastItem))
				? secondToLastItem.currentRenderedHeight ?? 150
				: 150;
			const stickyCapsuleHeight = this._stickyRequest && this._stickyRequestElement?.classList.contains('visible')
				? this._stickyRequestElement.offsetHeight
				: undefined;
			const lastItemMinHeight = getV3LastResponseMinHeight(contentHeight, secondToLastItemHeight, stickyCapsuleHeight);
			this._container.style.setProperty('--chat-current-response-min-height', lastItemMinHeight + 'px');
			if (lastItemMinHeight !== this._previousLastItemMinHeight) {
				this._previousLastItemMinHeight = lastItemMinHeight;
				const lastItem = this._viewModel?.getItems().at(-1);
				if (lastItem && this._visible && this._tree.hasElement(lastItem)) {
					this._updateElementHeight(lastItem, undefined);
				}
			}
		}
	}

	//#endregion

}
