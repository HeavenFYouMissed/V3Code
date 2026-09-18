/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/browser.css';
import { localize } from '../../../../nls.js';
import { $, addDisposableListener, Dimension, EventType, IDomPosition, registerExternalFocusChecker } from '../../../../base/browser/dom.js';
import { ButtonBar } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { RawContextKey, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, IConstructorSignature, BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import { IBrowserViewModel } from '../../browserView/common/browserView.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IBrowserViewKeyDownEvent, IBrowserViewNavigationEvent, IBrowserViewLoadError, IBrowserViewCertificateError } from '../../../../platform/browserView/common/browserView.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { isMacintosh, isLinux } from '../../../../base/common/platform.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { BrowserOverlayManager, BrowserOverlayType, IBrowserOverlayInfo } from './overlayManager.js';
import { getZoomFactor, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { SiteInfoWidget } from './siteInfoWidget.js';
import { Emitter } from '../../../../base/common/event.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

export const CONTEXT_BROWSER_CAN_GO_BACK = new RawContextKey<boolean>('browserCanGoBack', false, localize('browser.canGoBack', "Whether the browser can go back"));
export const CONTEXT_BROWSER_CAN_GO_FORWARD = new RawContextKey<boolean>('browserCanGoForward', false, localize('browser.canGoForward', "Whether the browser can go forward"));
export const CONTEXT_BROWSER_FOCUSED = new RawContextKey<boolean>('browserFocused', true, localize('browser.editorFocused', "Whether the browser editor is focused"));
export const CONTEXT_BROWSER_HAS_URL = new RawContextKey<boolean>('browserHasUrl', false, localize('browser.hasUrl', "Whether the browser has a URL loaded"));
export const CONTEXT_BROWSER_HAS_ERROR = new RawContextKey<boolean>('browserHasError', false, localize('browser.hasError', "Whether the browser has a load error"));

/**
 * Get the original implementation of HTMLElement focus (without window auto-focusing)
 * before it gets overridden by the workbench.
 */
const originalHtmlElementFocus = HTMLElement.prototype.focus;


/**
 * Base class for browser editor services that track the model lifecycle.
 *
 * Subclasses implement {@link subscribeToModel} which is called whenever a new model is set.
 * A {@link DisposableStore} is provided that is automatically cleared when the model
 * changes or the editor input is cleared.
 */
export abstract class BrowserEditorContribution extends Disposable {
	private readonly _modelStore = this._register(new DisposableStore());

	constructor(protected readonly editor: BrowserEditor) {
		super();
		this._register(editor.onDidChangeModel(({ model, isNew }) => {
			this._modelStore.clear();
			if (model) {
				this.subscribeToModel(model, this._modelStore, isNew);
			} else {
				this.clear();
			}
		}));
	}

	/**
	 * Called whenever the editor model changes to update state.
	 */
	protected subscribeToModel(_model: IBrowserViewModel, _store: DisposableStore, _isNew: boolean): void { }

	/**
	 * Called when the model is cleared to reset state.
	 */
	clear(): void { }

	/**
	 * Optional widgets to display inside the URL bar (on the right side of the URL input,
	 * before the actions toolbar).
	 * Contributions can override this getter to provide widgets.
	 */
	get urlBarWidgets(): readonly IBrowserEditorWidgetContribution[] { return []; }

	/**
	 * Optional toolbar-like elements to insert into the editor root between the navbar and the
	 * browser container.  Contributions can override this getter to provide elements.
	 */
	get toolbarElements(): readonly HTMLElement[] { return []; }

	/**
	 * Called when the editor is laid out with a new dimension.
	 */
	layout(_width: number): void { }

	/**
	 * Called once after the editor's browser container DOM has been created.
	 * Use to do setup that needs to attach to `editor.browserContainer`.
	 */
	onContainerReady(_container: HTMLElement): void { }

	/**
	 * Return an override to customize how the editor sizes the browser
	 * container. Returning `undefined` falls through to the next contribution
	 * (and finally to the default: container fills the wrapper's content area).
	 * The first contribution to return a non-undefined override wins.
	 */
	getContainerLayoutOverride(): IContainerLayoutOverride | undefined { return undefined; }
}

/** Customization returned by {@link BrowserEditorContribution.getContainerLayoutOverride}. */
export interface IContainerLayoutOverride {
	/**
	 * Wrapper padding (CSS px) — typically used to reserve space for widgets
	 * that sit outside the container (e.g. resize sashes). Applied as inline
	 * style before the pane is measured for {@link compute}.
	 */
	readonly padding: {
		top?: number;
		right?: number;
		bottom?: number;
		left?: number;
	};
	/** Compute the container layout given the measured pane size. */
	compute(paneWidth: number, paneHeight: number): IContainerLayout;
}

export interface IContainerLayout {
	readonly width: number;
	readonly height: number;
	readonly emulation?: {
		readonly scale: number;
	};
}

/** A widget that can be contributed to the browser editor URL bar. */
export interface IBrowserEditorWidgetContribution {
	readonly element: HTMLElement;
	/** Ordering value — lower numbers appear first (left). */
	readonly order: number;
}

class BrowserNavigationBar extends Disposable {
	private readonly _urlInput: HTMLInputElement;
	private readonly _urlDisplay: HTMLElement;
	private readonly _siteInfoWidget: SiteInfoWidget;
	private readonly _urlBarWidgetsContainer: HTMLElement;

	constructor(
		editor: BrowserEditor,
		container: HTMLElement,
		instantiationService: IInstantiationService,
		scopedContextKeyService: IContextKeyService
	) {
		super();

		// Create hover delegate for toolbar buttons
		const hoverDelegate = this._register(
			instantiationService.createInstance(
				WorkbenchHoverDelegate,
				'element',
				undefined,
				{ position: { hoverPosition: HoverPosition.ABOVE } }
			)
		);

		// Create navigation toolbar (left side) with scoped context
		const navContainer = $('.browser-nav-toolbar');
		const scopedInstantiationService = instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedContextKeyService]
		));
		const navToolbar = this._register(scopedInstantiationService.createInstance(
			MenuWorkbenchToolBar,
			navContainer,
			MenuId.BrowserNavigationToolbar,
			{
				hoverDelegate,
				highlightToggledItems: true,
				// Render all actions inline regardless of group
				toolbarOptions: { primaryGroup: () => true, useSeparatorsInPrimaryActions: true },
				menuOptions: { shouldForwardArgs: true }
			}
		));

		// URL input container (wraps input + share toggle)
		const urlContainer = $('.browser-url-container');

		// Site info widget (inside URL bar, left side, hidden by default)
		const siteInfoContainer = $('.browser-site-info-slot');
		this._siteInfoWidget = this._register(instantiationService.createInstance(
			SiteInfoWidget,
			siteInfoContainer,
			editor
		));

		// URL input (hidden by default; shown when user clicks the display)
		this._urlInput = $<HTMLInputElement>('input.browser-url-input');
		this._urlInput.type = 'text';
		this._urlInput.placeholder = localize('browser.urlPlaceholder', "Enter a URL");
		this._urlInput.style.display = 'none';

		// URL display — shows the URL when not editing; clickable to switch to input
		const urlInputWrapper = $('.browser-url-input-wrapper');
		this._urlDisplay = $('span.browser-url-display');
		this._urlDisplay.tabIndex = 0;
		urlInputWrapper.appendChild(this._urlDisplay);
		urlInputWrapper.appendChild(this._urlInput);

		this._urlBarWidgetsContainer = $('.browser-url-bar-widgets');

		urlContainer.appendChild(siteInfoContainer);
		urlContainer.appendChild(urlInputWrapper);
		urlContainer.appendChild(this._urlBarWidgetsContainer);

		// Create actions toolbar (right side) with scoped context
		const actionsContainer = $('.browser-actions-toolbar');
		const actionsToolbar = this._register(scopedInstantiationService.createInstance(
			MenuWorkbenchToolBar,
			actionsContainer,
			MenuId.BrowserActionsToolbar,
			{
				hoverDelegate,
				highlightToggledItems: true,
				toolbarOptions: { primaryGroup: (group) => group.startsWith('actions'), useSeparatorsInPrimaryActions: true },
				menuOptions: { shouldForwardArgs: true }
			}
		));

		navToolbar.context = editor;
		actionsToolbar.context = editor;

		// Assemble layout: nav | url container | actions
		container.appendChild(navContainer);
		container.appendChild(urlContainer);
		container.appendChild(actionsContainer);

		// Setup URL input handler
		this._register(addDisposableListener(this._urlInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				const url = this._urlInput.value.trim();
				if (url) {
					editor.navigateToUrl(url);
				}
			}
		}));

		// Select all URL bar text when the URL bar receives focus (like in regular browsers)
		this._register(addDisposableListener(this._urlInput, EventType.FOCUS, () => {
			this._urlInput.select();
		}));

		// Switch back to display mode when the URL bar loses focus
		this._register(addDisposableListener(this._urlInput, EventType.BLUR, () => {
			this._showDisplay();
		}));
		this._register(addDisposableListener(this._urlDisplay, EventType.FOCUS, () => {
			this._showInput();
		}));
	}

	/**
	 * Update the navigation bar state from a navigation event
	 */
	updateFromNavigationEvent(event: IBrowserViewNavigationEvent): void {
		this._urlInput.value = event.url;
		this._updateDisplay();
	}

	/**
	 * Focus the URL input and select all text
	 */
	focusUrlInput(): void {
		this._showInput();
	}

	/**
	 * Show or hide the site info indicator
	 */
	setCertificateError(certError: IBrowserViewCertificateError | undefined): void {
		this._siteInfoWidget.setCertificateError(certError);
		this._urlInput.classList.toggle('cert-error', !!certError);
		this._updateDisplay();
	}

	/**
	 * Switch to input-editing mode: hide display, show and focus input.
	 */
	private _showInput(): void {
		this._urlDisplay.style.display = 'none';
		this._urlInput.style.display = '';
		this._urlInput.select();
		this._urlInput.focus();
	}

	/**
	 * Add widget elements inside the URL bar, sorted by order.
	 */
	addUrlBarWidgets(widgets: readonly IBrowserEditorWidgetContribution[]): void {
		const sorted = widgets.slice().sort((a, b) => a.order - b.order);
		for (const widget of sorted) {
			this._urlBarWidgetsContainer.appendChild(widget.element);
		}
	}

	/**
	 * Switch to display mode: hide the input and show the styled display.
	 */
	private _showDisplay(): void {
		this._urlInput.style.display = 'none';
		this._urlDisplay.style.display = '';
		this._updateDisplay();
	}

	/**
	 * Rebuild the display element's content.  When there is a cert error
	 * and the URL starts with "https://", the protocol is rendered with
	 * a red strikethrough; otherwise the full URL is shown plainly.
	 */
	private _updateDisplay(): void {
		const url = this._urlInput.value;
		const hasCertError = this._urlInput.classList.contains('cert-error');
		const httpsPrefix = 'https:';

		// Clear previous content
		this._urlDisplay.textContent = '';
		this._urlDisplay.classList.toggle('placeholder', !url);

		if (hasCertError && url.startsWith(httpsPrefix)) {
			const protocol = document.createElement('span');
			protocol.className = 'browser-url-display-protocol-bad';
			protocol.textContent = httpsPrefix;
			this._urlDisplay.appendChild(protocol);

			const rest = document.createElement('span');
			rest.textContent = url.slice(httpsPrefix.length);
			this._urlDisplay.appendChild(rest);
		} else {
			this._urlDisplay.textContent = url || localize('browser.urlPlaceholder', "Enter a URL");
		}
	}

	clear(): void {
		this._urlInput.value = '';
		this._siteInfoWidget.setCertificateError(undefined);
		this._updateDisplay();
	}
}

export class BrowserEditor extends EditorPane {

	// -- Contribution registry --------------------------------------------

	private static readonly _contributions: IConstructorSignature<BrowserEditorContribution, [BrowserEditor]>[] = [];
	static registerContribution<Services extends BrandedService[]>(ctor: { new(editor: BrowserEditor, ...services: Services): BrowserEditorContribution }): void {
		BrowserEditor._contributions.push(ctor as IConstructorSignature<BrowserEditorContribution, [BrowserEditor]>);
	}

	private readonly _contributionInstances = new Map<IConstructorSignature<BrowserEditorContribution, [BrowserEditor]>, BrowserEditorContribution>();
	getContribution<T extends BrowserEditorContribution, Services extends BrandedService[]>(ctor: { new(editor: BrowserEditor, ...services: Services): T }): T | undefined {
		return this._contributionInstances.get(ctor as IConstructorSignature<BrowserEditorContribution, [BrowserEditor]>) as T | undefined;
	}

	// -- Model lifecycle ------------------------------------------------

	private _model: IBrowserViewModel | undefined;
	get model(): IBrowserViewModel | undefined { return this._model; }
	private readonly _onDidChangeModel = this._register(new Emitter<{
		model: IBrowserViewModel | undefined;
		isNew: boolean;
	}>());
	readonly onDidChangeModel = this._onDidChangeModel.event;

	// -- State ----------------------------------------------------------

	private _overlayVisible = false;
	private _editorVisible = false;

	private _navigationBar!: BrowserNavigationBar;
	private _browserContainerWrapper!: HTMLElement;
	private _browserContainer!: HTMLElement;
	get browserContainer(): HTMLElement { return this._browserContainer; }
	private _placeholderScreenshot!: HTMLElement;
	private _overlayPauseContainer!: HTMLElement;
	private _errorContainer!: HTMLElement;
	private _welcomeContainer!: HTMLElement;
	private _canGoBackContext!: IContextKey<boolean>;
	private _canGoForwardContext!: IContextKey<boolean>;
	private _hasUrlContext!: IContextKey<boolean>;
	private _hasErrorContext!: IContextKey<boolean>;

	private readonly _inputDisposables = this._register(new DisposableStore());
	private overlayManager: BrowserOverlayManager | undefined;
	private _placeholderBlobUrl: string | undefined;
	private _captureInFlight = false;
	/** Set when updateVisibility() captures the placeholder just before a hide, so the
	 *  onDidChangeVisibility(false) fallback doesn't re-capture a black post-hide frame. */
	private _suppressNextHideCapture = false;
	/** Debounces the pause transition for TRANSIENT overlays (hover/tooltip/context-view) so a
	 *  quick tooltip flash never swaps the live view. Hard overlays pause immediately. */
	private readonly _overlayPauseScheduler = this._register(new RunOnceScheduler(() => {
		if (this.overlayManager) {
			this._setOverlayState(this.overlayManager.getOverlappingOverlays(this._browserContainer));
		}
	}, 120));
	/** Overlay-state listener, live only while the editor is visible (a background browser tab
	 *  shouldn't keep the body-wide overlay MutationObserver running). */
	private readonly _overlayStateListener = this._register(new MutableDisposable());
	private readonly _certActionButton = this._register(new MutableDisposable<ButtonBar>());
	private _currentPadding: { top: number; right: number; bottom: number; left: number } = { top: 3, right: 3, bottom: 3, left: 3 };

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super(BrowserEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		// Create scoped context key service for this editor instance
		const contextKeyService = this._register(this.contextKeyService.createScoped(parent));

		// Create window-specific overlay manager for this editor
		this.overlayManager = this._register(new BrowserOverlayManager(this.window));

		// Bind navigation capability context keys
		this._canGoBackContext = CONTEXT_BROWSER_CAN_GO_BACK.bindTo(contextKeyService);
		this._canGoForwardContext = CONTEXT_BROWSER_CAN_GO_FORWARD.bindTo(contextKeyService);
		this._hasUrlContext = CONTEXT_BROWSER_HAS_URL.bindTo(contextKeyService);
		this._hasErrorContext = CONTEXT_BROWSER_HAS_ERROR.bindTo(contextKeyService);

		// Currently this is always true since it is scoped to the editor container
		CONTEXT_BROWSER_FOCUSED.bindTo(contextKeyService);

		// Create a scoped instantiation service so contributions get the scoped context key service
		const scopedInstantiationService = this._register(this.instantiationService.createChild(
			new ServiceCollection([IContextKeyService, contextKeyService])
		));

		// Instantiate all registered contributions
		for (const ctor of BrowserEditor._contributions) {
			const instance = this._register(scopedInstantiationService.createInstance(ctor, this));
			this._contributionInstances.set(ctor, instance);
		}

		// Create root container
		const root = $('.browser-root');
		root.tabIndex = -1; // Click focusable (for kb shortcuts), but not in tab order
		parent.appendChild(root);

		// Create navbar with navigation buttons and URL input
		const navbar = $('.browser-navbar');

		// Create navigation bar widget with scoped context
		this._navigationBar = this._register(new BrowserNavigationBar(this, navbar, this.instantiationService, contextKeyService));

		// Inject URL bar widgets from contributions
		const allWidgets: IBrowserEditorWidgetContribution[] = [];
		for (const contribution of this._contributionInstances.values()) {
			allWidgets.push(...contribution.urlBarWidgets);
		}
		this._navigationBar.addUrlBarWidgets(allWidgets);

		root.appendChild(navbar);

		// Collect toolbar elements from contributions (e.g. find widget container)
		for (const contribution of this._contributionInstances.values()) {
			for (const element of contribution.toolbarElements) {
				root.appendChild(element);
			}
		}

		// Create browser container wrapper (flex item that fills remaining space)
		this._browserContainerWrapper = $('.browser-container-wrapper');
		this._browserContainerWrapper.style.setProperty('--zoom-factor', String(getZoomFactor(this.window)));
		root.appendChild(this._browserContainerWrapper);

		// Create browser container (stub element for positioning)
		this._browserContainer = $('.browser-container');
		this._browserContainer.tabIndex = 0; // make focusable
		this._browserContainerWrapper.appendChild(this._browserContainer);

		// Notify contributions that the container DOM is ready (used e.g. by
		// the device feature to attach resize sashes to the container).
		for (const contribution of this._contributionInstances.values()) {
			contribution.onContainerReady(this._browserContainer);
		}

		// Create additional wrapper around placeholder contents for applying border radius clipping.
		const placeholderContents = $('.browser-placeholder-contents');
		this._browserContainer.appendChild(placeholderContents);

		// Create placeholder screenshot (background placeholder when WebContentsView is hidden)
		this._placeholderScreenshot = $('.browser-placeholder-screenshot');
		placeholderContents.appendChild(this._placeholderScreenshot);

		// Create overlay pause container (hidden by default via CSS)
		this._overlayPauseContainer = $('.browser-overlay-paused');
		const overlayPauseMessage = $('.browser-overlay-paused-message');
		const overlayPauseHeading = $('.browser-overlay-paused-heading');
		const overlayPauseDetail = $('.browser-overlay-paused-detail');
		overlayPauseHeading.textContent = localize('browser.overlayPauseHeading.notification', "Paused due to Notification");
		overlayPauseDetail.textContent = localize('browser.overlayPauseDetail.notification', "Dismiss the notification to continue using the browser.");
		overlayPauseMessage.appendChild(overlayPauseHeading);
		overlayPauseMessage.appendChild(overlayPauseDetail);
		this._overlayPauseContainer.appendChild(overlayPauseMessage);
		placeholderContents.appendChild(this._overlayPauseContainer);

		// Create error container (hidden by default)
		this._errorContainer = $('.browser-error-container');
		this._errorContainer.style.display = 'none';
		placeholderContents.appendChild(this._errorContainer);

		// Create welcome container (shown when no URL is loaded)
		this._welcomeContainer = this.createWelcomeContainer();
		placeholderContents.appendChild(this._welcomeContainer);

		this._register(addDisposableListener(this._browserContainer, EventType.FOCUS, (event) => {
			// When the browser container gets focus, make sure the browser view also gets focused.
			// But only if focus was already in the workbench (and not e.g. clicking back into the workbench from the browser view).
			if (event.relatedTarget && this._model && this.shouldShowView) {
				this.requestFocus();
			}
		}));

		this._register(addDisposableListener(this._browserContainer, EventType.BLUR, () => {
			// If the container becomes blurred, cancel any scheduled focus call.
			// This can happen when e.g. a menu closes and focus shifts back to the browser, then immediately focuses another element.
			this.cancelFocus();
		}));

		// Register external focus checker so that cross-window focus logic knows when
		// this browser view has focus (since it's outside the normal DOM tree).
		// Include window info so that UI like dialogs appear in the correct window.
		this._register(registerExternalFocusChecker(() => ({
			hasFocus: this._model?.focused ?? false,
			window: this._model?.focused ? this.window : undefined
		})));
	}

	override focus(): void {
		if (this._model?.url && !this._model.error) {
			this.requestFocus();
		} else {
			this.focusUrlInput();
		}
	}

	private _focusTimeout: ReturnType<typeof setTimeout> | undefined;
	private requestFocus(): void {
		this.ensureBrowserFocus();
		if (this._focusTimeout) {
			return;
		}
		this._focusTimeout = setTimeout(() => {
			this._focusTimeout = undefined;
			if (this._model) {
				void this._model.focus();
			}
		}, 0);
	}

	private cancelFocus(): void {
		if (this._focusTimeout) {
			clearTimeout(this._focusTimeout);
			this._focusTimeout = undefined;
		}
	}

	override async setInput(input: BrowserEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}

		this._inputDisposables.clear();

		let model = input.model;
		const isNew = !model;
		if (!model) {
			// Set initial navigation state from the input so that the UI is populated while the model is loading.
			this.updateNavigationState({
				url: input.url || '',
				title: input.title || '',
				canGoBack: false,
				canGoForward: false,
				certificateError: undefined
			});

			// Resolve the browser view model from the input
			model = await input.resolve();
		}

		if (token.isCancellationRequested || this.input !== input) {
			return;
		}

		this._model = model;
		this._onDidChangeModel.fire({ model, isNew });

		// Initialize UI state and context keys from model
		this.updateNavigationState({
			url: this._model.url,
			title: this._model.title,
			canGoBack: this._model.canGoBack,
			canGoForward: this._model.canGoForward,
			certificateError: this._model.certificateError
		});
		this.setBackgroundImage(this._model.screenshot);

		// When closing a tab, the model gets disposed before the editor input is cleared.
		// So we make sure we don't keep a reference to the disposed model.
		this._inputDisposables.add(this._model.onWillDispose(() => {
			this._model = undefined;
		}));

		// Capture a placeholder screenshot only when hiding the live WebContentsView. This is the
		// FALLBACK for externally-triggered hides; updateVisibility() captures while still visible
		// and sets _suppressNextHideCapture so this doesn't overwrite the fresh frame with black.
		this._inputDisposables.add(this._model.onDidChangeVisibility(visible => {
			if (!visible) {
				if (this._suppressNextHideCapture) {
					this._suppressNextHideCapture = false;
					return;
				}
				void this.capturePlaceholderScreenshot();
			} else {
				this._suppressNextHideCapture = false;
				this.cancelScheduledScreenshot();
			}
		}));

		// Listen to model events for UI updates
		this._inputDisposables.add(this._model.onDidKeyCommand(keyEvent => {
			// Handle like webview does - convert to webview KeyEvent format
			this.handleKeyEventFromBrowserView(keyEvent);
		}));

		this._inputDisposables.add(this._model.onDidNavigate((navEvent: IBrowserViewNavigationEvent) => {
			this.group.pinEditor(this.input); // pin editor on navigation

			// Update navigation bar and context keys from model
			this.updateNavigationState(navEvent);
		}));

		this._inputDisposables.add(this._model.onDidChangeLoadingState(() => {
			this.updateErrorDisplay();
		}));

		this._inputDisposables.add(this._model.onDidChangeFocus(({ focused }) => {
			// When the view gets focused, make sure the editor reports that it has focus,
			// but focus is removed from the workbench.
			if (focused) {
				this._onDidFocus?.fire();
				this.ensureBrowserFocus();
			}
		}));

		// Overlay listener is attached only while the editor is visible (see _syncOverlayListener),
		// so a background browser tab stops the body-wide overlay MutationObserver.
		this._syncOverlayListener();

		// Listen for workbench zoom level changes and update browser view placeholder screenshot's zoom factor
		this._inputDisposables.add(onDidChangeZoomLevel(targetWindowId => {
			if (targetWindowId === this.window.vscodeWindowId) {
				// Update CSS variable for size calculations
				this._browserContainerWrapper.style.setProperty('--zoom-factor', String(getZoomFactor(this.window)));
				// Re-push container bounds and emulation: zoom-factor affects
				// both the screen-px conversion in main and the Chromium
				// emulation scale (so the emulated viewport fills the WCV).
				this.layoutBrowserContainer();
			}
		}));

		this.updateErrorDisplay();
		this.layout();
		this.updateVisibility();
	}

	protected override setEditorVisible(visible: boolean): void {
		this._editorVisible = visible;
		this._syncOverlayListener();
		this.updateVisibility();
	}

	/** Attach the overlay-state listener only while visible; detach (and stop the overlay
	 *  MutationObserver) when hidden. Safe to call before the overlayManager exists. */
	private _syncOverlayListener(): void {
		if (this._editorVisible && this.overlayManager) {
			if (!this._overlayStateListener.value) {
				this._overlayStateListener.value = this.overlayManager.onDidChangeOverlayState(() => this.checkOverlays());
			}
			this.checkOverlays();
		} else {
			this._overlayStateListener.clear();
			this._overlayPauseScheduler.cancel();
		}
	}

	/**
	 * Make the browser container the active element without moving focus from the browser view.
	 */
	ensureBrowserFocus(): void {
		originalHtmlElementFocus.call(this._browserContainer);
	}

	private updateVisibility(): void {
		const hasUrl = !!this._model?.url;
		const hasError = !!this._model?.error;
		const isViewingPage = !hasError && hasUrl;
		const isPaused = isViewingPage && this._editorVisible && this._overlayVisible;

		// Welcome container: shown when no URL is loaded
		this._welcomeContainer.style.display = hasUrl ? 'none' : '';

		// Error container: shown when there's a load error
		this._errorContainer.style.display = hasError ? '' : 'none';

		// Placeholder screenshot: shown when there is a page loaded (even when the view is not hidden, so hiding is smooth)
		this._placeholderScreenshot.style.display = isViewingPage ? '' : 'none';

		// Pause overlay: fades in when an overlay is detected
		this._overlayPauseContainer.classList.toggle('visible', isPaused);

		if (this._model) {
			const show = this.shouldShowView;
			if (show === this._model.visible) {
				return;
			}

			if (show) {
				this._model.setVisible(true);
				if (
					this._browserContainer.ownerDocument.hasFocus() &&
					this._browserContainer.ownerDocument.activeElement === this._browserContainer
				) {
					// If the editor is focused, ensure the browser view also gets focus
					this.requestFocus();
				}
			} else {
				// Capture the placeholder from the CURRENT (still-visible) frame, then hide once
				// it's painted — capturing after the hide returns black on macOS. Suppress the
				// onDidChangeVisibility(false) fallback so it can't overwrite this with a black frame.
				this._suppressNextHideCapture = true;
				void this.capturePlaceholderScreenshot({ allowWhileVisible: true })
					.finally(() => this.window.requestAnimationFrame(() => this._model?.setVisible(false)));
			}
		}
	}

	private get shouldShowView(): boolean {
		return this._editorVisible && !this._overlayVisible && !this._model?.error && !!this._model?.url;
	}

	private checkOverlays(): void {
		if (!this.overlayManager) {
			return;
		}
		const overlappingOverlays = this.overlayManager.getOverlappingOverlays(this._browserContainer);
		const hasOverlappingOverlay = overlappingOverlays.length > 0;
		// A pure hover/tooltip/context-view appearing is debounced so a quick flash never swaps
		// the live view. Hard overlays (menu, dialog, quick input, notification) and any clearing
		// apply immediately.
		const onlyTransient = hasOverlappingOverlay && overlappingOverlays.every(o =>
			o.type === BrowserOverlayType.Hover || o.type === BrowserOverlayType.Unknown);
		if (hasOverlappingOverlay && onlyTransient && !this._overlayVisible) {
			this._overlayPauseScheduler.schedule();
			return;
		}
		this._overlayPauseScheduler.cancel();
		this._setOverlayState(overlappingOverlays);
	}

	private _setOverlayState(overlappingOverlays: readonly IBrowserOverlayInfo[]): void {
		const hasOverlappingOverlay = overlappingOverlays.length > 0;
		this.updateOverlayPauseMessage(overlappingOverlays);
		if (hasOverlappingOverlay !== this._overlayVisible) {
			this._overlayVisible = hasOverlappingOverlay;
			this.updateVisibility();
		}
	}

	private updateOverlayPauseMessage(overlappingOverlays: readonly IBrowserOverlayInfo[]): void {
		// Only show the pause message for notification overlays
		const hasNotificationOverlay = overlappingOverlays.some(overlay => overlay.type === BrowserOverlayType.Notification);
		this._overlayPauseContainer.classList.toggle('show-message', hasNotificationOverlay);
	}

	private updateErrorDisplay(): void {
		if (!this._model) {
			return;
		}

		const error: IBrowserViewLoadError | undefined = this._model.error;
		this._hasErrorContext.set(!!error);

		this._navigationBar.setCertificateError(
			this._model.certificateError ?? error?.certificateError
		);

		if (error) {
			// Update error content
			this._certActionButton.clear();

			while (this._errorContainer.firstChild) {
				this._errorContainer.removeChild(this._errorContainer.firstChild);
			}

			const errorContent = $('.browser-error-content');
			const isCertError = !!error.certificateError;

			const errorIcon = $('.browser-error-icon');
			errorIcon.classList.toggle('cert-error', isCertError);
			errorIcon.appendChild(renderIcon(isCertError ? Codicon.workspaceUntrusted : Codicon.globe));

			const errorTitle = $('.browser-error-title');
			errorTitle.textContent = isCertError
				? localize('browser.certErrorLabel', "Certificate Error")
				: localize('browser.loadErrorLabel', "Failed to Load Page");

			const errorMessage = $('.browser-error-detail');
			const errorText = $('span');
			errorText.textContent = isCertError
				? localize('browser.certErrorDescription', "This site's security certificate could not be verified.")
				: `${error.errorDescription} (${error.errorCode})`;
			errorMessage.appendChild(errorText);

			const errorUrl = $('.browser-error-detail');
			const urlLabel = $('strong');
			urlLabel.textContent = localize('browser.errorUrlLabel', "URL:");
			const urlValue = $('code');
			urlValue.textContent = error.url;
			errorUrl.appendChild(urlLabel);
			errorUrl.appendChild(document.createTextNode(' '));
			errorUrl.appendChild(urlValue);

			errorContent.appendChild(errorIcon);
			errorContent.appendChild(errorTitle);
			errorContent.appendChild(errorMessage);

			// Show cert error name below description, above URL
			if (error.certificateError) {
				const extraWarning = $('b.browser-error-detail');
				extraWarning.textContent = localize('browser.certErrorExtraWarning', " Your connection is not private.");
				errorMessage.appendChild(extraWarning);
			}

			errorContent.appendChild(errorUrl);

			// Show certificate details table and actions
			if (error.certificateError) {
				const certError = error.certificateError;

				const certDetailsTable = $('.browser-cert-details-table');

				const heading = $('.browser-cert-details-heading');
				heading.textContent = localize('browser.certDetailsHeading', "Certificate Details");
				certDetailsTable.appendChild(heading);

				const addRow = (label: string, value: string) => {
					const row = $('.browser-cert-details-row');
					const labelEl = $('.browser-cert-details-label');
					labelEl.textContent = label;
					const valueEl = $('.browser-cert-details-value');
					valueEl.textContent = value;
					row.appendChild(labelEl);
					row.appendChild(valueEl);
					certDetailsTable.appendChild(row);
				};

				addRow(localize('browser.certError', "Error"), certError.error);
				addRow(localize('browser.certIssuer', "Issuer"), certError.issuerName);
				addRow(localize('browser.certSubject', "Subject"), certError.subjectName);

				const formatDate = (epoch: number) => new Date(epoch * 1000).toLocaleDateString();
				addRow(
					localize('browser.certValid', "Valid"),
					`${formatDate(certError.validStart)} - ${formatDate(certError.validExpiry)}`
				);

				addRow(localize('browser.certFingerprint', "Fingerprint"), certError.fingerprint);

				errorContent.appendChild(certDetailsTable);

				const actionContainer = $('.browser-cert-action');
				actionContainer.classList.toggle('reverse', isMacintosh || isLinux);
				const canGoBack = this._model.canGoBack;
				const buttonBar = new ButtonBar(actionContainer);
				this._certActionButton.value = buttonBar;

				const primaryButton = buttonBar.addButton({ ...defaultButtonStyles });
				primaryButton.label = canGoBack
					? localize('browser.certGoBack', "Go Back")
					: localize('browser.certCloseTab', "Close Tab");
				primaryButton.onDidClick(() => {
					if (canGoBack) {
						this.goBack();
					} else {
						this.group?.closeEditor(this.input);
					}
				});

				const secondaryButton = buttonBar.addButton({ ...defaultButtonStyles, secondary: true });
				secondaryButton.label = localize('browser.certProceed', "Proceed anyway (unsafe)");
				secondaryButton.onDidClick(() => {
					this._model?.trustCertificate(certError.host, certError.fingerprint);
				});

				errorContent.appendChild(actionContainer);
			}

			this._errorContainer.appendChild(errorContent);

			this.setBackgroundImage(undefined);
		} else {
			this.setBackgroundImage(this._model.screenshot);
		}

		this.updateVisibility();
	}

	getUrl(): string | undefined {
		return this._model?.url;
	}

	getCertificateError(): IBrowserViewCertificateError | undefined {
		return this._model?.certificateError;
	}

	/**
	 * Revoke trust for the certificate and close this editor tab.
	 */
	revokeAndClose(certError: IBrowserViewCertificateError): void {
		// This method automatically closes the browser view.
		this._model?.untrustCertificate(certError.host, certError.fingerprint);
	}

	async navigateToUrl(url: string): Promise<void> {
		if (this._model) {
			this.group.pinEditor(this.input); // pin editor on navigation

			// Special case localhost URLs (e.g., "localhost:3000") to add http://
			if (/^localhost(:|\/|$)/i.test(url)) {
				url = 'http://' + url;
			} else if (!URL.parse(url)?.protocol) {
				// If no scheme provided, default to http (sites will generally upgrade to https)
				url = 'http://' + url;
			}

			this.ensureBrowserFocus();
			await this._model.loadURL(url);
		}
	}

	focusUrlInput(): void {
		this._navigationBar.focusUrlInput();
	}

	async goBack(): Promise<void> {
		return this._model?.goBack();
	}

	async goForward(): Promise<void> {
		return this._model?.goForward();
	}

	async reload(hard?: boolean): Promise<void> {
		return this._model?.reload(hard);
	}

	async toggleDevTools(): Promise<void> {
		return this._model?.toggleDevTools();
	}

	async clearStorage(): Promise<void> {
		return this._model?.clearStorage();
	}

	/**
	 * Update navigation state and context keys
	 */
	private updateNavigationState(event: IBrowserViewNavigationEvent): void {
		// Update navigation bar UI
		this._navigationBar.updateFromNavigationEvent(event);
		this._navigationBar.setCertificateError(event.certificateError);

		// Update context keys for command enablement
		this._canGoBackContext.set(event.canGoBack);
		this._canGoForwardContext.set(event.canGoForward);
		this._hasUrlContext.set(!!event.url);

		// Update visibility (welcome screen, error, browser view)
		this.updateVisibility();
	}

	/**
	 * Create the welcome container shown when no URL is loaded
	 */
	private createWelcomeContainer(): HTMLElement {
		const container = $('.browser-welcome-container');
		const content = $('.browser-welcome-content');

		const iconContainer = $('.browser-welcome-icon');
		iconContainer.appendChild(renderIcon(Codicon.globe));
		content.appendChild(iconContainer);

		const title = $('.browser-welcome-title');
		title.textContent = localize('browser.welcomeTitle', "Browser");
		content.appendChild(title);

		const subtitle = $('.browser-welcome-subtitle');
		const chatEnabled = this.contextKeyService.getContextKeyValue<boolean>(ChatContextKeys.enabled.key);
		subtitle.textContent = chatEnabled
			? localize('browser.welcomeSubtitleChat', "Use Add Element to Chat to reference UI elements in chat prompts.")
			: localize('browser.welcomeSubtitle', "Enter a URL above to get started.");
		content.appendChild(subtitle);

		container.appendChild(content);
		return container;
	}

	private setBackgroundImage(buffer: VSBuffer | undefined): void {
		if (this._placeholderBlobUrl) {
			URL.revokeObjectURL(this._placeholderBlobUrl);
			this._placeholderBlobUrl = undefined;
		}
		if (buffer) {
			const blob = new Blob([Uint8Array.from(buffer.buffer)], { type: 'image/jpeg' });
			this._placeholderBlobUrl = URL.createObjectURL(blob);
			this._placeholderScreenshot.style.backgroundImage = `url('${this._placeholderBlobUrl}')`;
		} else {
			this._placeholderScreenshot.style.backgroundImage = '';
		}
	}

	/**
	 * One-shot capture for the placeholder layer. No polling loop. By default only captures
	 * while the live view is hidden; pass `allowWhileVisible` to capture the CURRENT frame just
	 * before a hide — a post-hide capture returns a black frame on macOS, which is the stale/
	 * black placeholder bug this avoids.
	 */
	private async capturePlaceholderScreenshot(opts?: { allowWhileVisible?: boolean }): Promise<void> {
		if (!this._model || this._captureInFlight) {
			return;
		}
		if (this._model.visible && !opts?.allowWhileVisible) {
			return;
		}

		this._captureInFlight = true;
		try {
			const screenshot = await this._model.captureScreenshot({ quality: 80 });
			this.setBackgroundImage(screenshot);
		} catch (error) {
			this.logService.error('Failed to capture browser view screenshot', error);
		} finally {
			this._captureInFlight = false;
		}
	}

	private cancelScheduledScreenshot(): void {
		// no-op — legacy hook from when we polled every 1s; kept so visibility handlers stay stable
	}

	private async handleKeyEventFromBrowserView(keyEvent: IBrowserViewKeyDownEvent): Promise<void> {
		try {
			const syntheticEvent = new KeyboardEvent('keydown', keyEvent);
			const standardEvent = new StandardKeyboardEvent(syntheticEvent);

			this.keybindingService.dispatchEvent(standardEvent, this._browserContainer);
		} catch (error) {
			this.logService.error('BrowserEditor.handleKeyEventFromBrowserView: Error dispatching key event', error);
		}
	}

	override layout(dimension?: Dimension, _position?: IDomPosition): void {
		if (dimension) {
			for (const contribution of this._contributionInstances.values()) {
				contribution.layout(dimension.width);
			}
		}

		const whenContainerStylesLoaded = this.layoutService.whenContainerStylesLoaded(this.window);
		if (whenContainerStylesLoaded) {
			// In floating windows, we need to ensure that the
			// container is ready for us to compute certain
			// layout related properties.
			whenContainerStylesLoaded.then(() => this.layoutBrowserContainer());
		} else {
			this.layoutBrowserContainer();
		}

		// ...and again once the DOM has actually reflowed.
		//
		// The call above runs synchronously inside layout(), when the workbench has handed us our new
		// dimension but the browser has not laid out yet — so getBoundingClientRect() on the wrapper
		// still reports the PREVIOUS geometry. The native view is therefore placed at stale
		// coordinates and stays there, overhanging its container onto the sash, until something
		// unrelated triggers another layout pass. That is why a tooltip opening over the panel
		// visibly snapped the browser back into place: the tooltip caused a second layout, and by
		// then the rect was correct.
		//
		// The retry inside layoutBrowserContainer does not catch this. It only re-runs when the rect
		// measures ZERO, and a stale rect is a perfectly plausible non-zero one.
		//
		// Keeping the synchronous call means the common case (no geometry change) still updates in
		// the same frame; this second pass only corrects it when the reflow moved something.
		this.scheduleBrowserContainerSettle();
	}

	/**
	 * Re-layout on the next frame, coalescing multiple layout() calls into one.
	 *
	 * A drag of the sash fires layout() continuously, and pushing bounds to the main process on
	 * every one of those would be wasteful; one settle per frame is enough to stay glued to the
	 * container.
	 */
	private _settleFrame: number | undefined;

	private scheduleBrowserContainerSettle(): void {
		this.cancelBrowserContainerSettle();
		this._settleFrame = this.window.requestAnimationFrame(() => {
			this._settleFrame = undefined;
			this.layoutBrowserContainer();
		});
	}

	private cancelBrowserContainerSettle(): void {
		if (this._settleFrame !== undefined) {
			this.window.cancelAnimationFrame(this._settleFrame);
			this._settleFrame = undefined;
		}
	}

	/**
	 * Recompute the layout of the browser container and push the resulting
	 * bounds + emulation to the WebContentsView. Should generally only be
	 * called via {@link layout} so the container is fully styled first.
	 */
	layoutBrowserContainer(retries = 2): void {
		if (!this._model) {
			return;
		}
		this.checkOverlays();

		// Pick the first contribution that wants to override sizing.
		let override: IContainerLayoutOverride | undefined;
		for (const c of this._contributionInstances.values()) {
			const o = c.getContainerLayoutOverride();
			if (o) {
				override = o;
				break;
			}
		}

		// Apply the wrapper padding the editor will assume below. Inline style is the single
		// source of truth — the wrapper's CSS has no padding. With an active override (emulation
		// resize sashes on the edges) keep a roomy 10px so the sashes stay reachable; with NO
		// override, use a tight 3px so normal browsing doesn't get an ugly gutter.
		// Top is included so the 2px shared-with-agent ring, which paints outside the
		// container box, is not clipped away by the wrapper's overflow:hidden.
		const raw = override?.padding;
		const padding = raw
			? {
				top: Math.max(3, raw.top ?? 0),
				right: Math.max(10, raw.right ?? 0),
				bottom: Math.max(10, raw.bottom ?? 0),
				left: Math.max(3, raw.left ?? 0),
			}
			: { top: 3, right: 3, bottom: 3, left: 3 };
		this._currentPadding = padding;
		this._browserContainerWrapper.style.padding = `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`;

		const wrapperRect = this._browserContainerWrapper.getBoundingClientRect();
		if ((wrapperRect.width === 0 || wrapperRect.height === 0) && retries > 0) {
			// Wrapper not measured yet; retry on the next frame.
			this.window.requestAnimationFrame(() => this.layoutBrowserContainer(retries - 1));
			return;
		}

		const paneWidth = Math.max(0, wrapperRect.width - padding.left - padding.right);
		const paneHeight = Math.max(0, wrapperRect.height - padding.top - padding.bottom);
		let layout: IContainerLayout;
		if (override) {
			layout = override.compute(paneWidth, paneHeight);
		} else {
			const z = getZoomFactor(this.window);
			const snap = (v: number) => Math.floor(v * z) / z;
			layout = { width: snap(paneWidth), height: snap(paneHeight) };
		}

		// Derive the container's absolute screen rect analytically: the wrapper's flex
		// rules center the container within the pane.
		let containerLeft = wrapperRect.left + padding.left + (paneWidth - layout.width) / 2;
		let containerTop = wrapperRect.top + padding.top + (paneHeight - layout.height) / 2;
		let outWidth = layout.width;
		let outHeight = layout.height;

		// Clamp to the part that actually clips us.
		//
		// The fork's floating-card chrome shrinks every `.part` by margin:5px plus
		// width/height:calc(100% - 10px), but nothing subtracts that gap from the dimension
		// handed to Part.layout(). So `.content` — and therefore this wrapper — is laid out
		// 2*gap larger than the card containing it, with the origin unchanged, which puts the
		// excess entirely on the right and bottom. Measured in a live DOM: the part's own
		// drop-block-overlay is 612x830 while .monaco-scrollable-element is 622x840, a
		// difference of exactly 10x10.
		//
		// DOM children are invisibly guillotined by the card's overflow:hidden and clip-path.
		// The WebContentsView is not a DOM node — it composites over the window and no CSS
		// can clip it — so it renders that oversized rectangle faithfully, spilling onto the
		// sash and covering the sharing ring's right and bottom edges. That is why the two
		// earlier fixes here changed nothing visible: sub-pixel rounding and a stale-rect
		// settle pass both made a WRONG rectangle more precisely wrong.
		//
		// The root fix is to subtract the gap where the layout dimension is produced, which
		// touches core workbench layout for every part. This clamp is the local defence: keep
		// the native view inside the box that clips everything else, so it can never paint
		// outside its card no matter how the ancestor chain is sized.
		const clipRect = this._browserContainer.closest('.part')?.getBoundingClientRect();
		if (clipRect && clipRect.width > 0 && clipRect.height > 0) {
			const clampedLeft = Math.max(containerLeft, clipRect.left);
			const clampedTop = Math.max(containerTop, clipRect.top);
			const clampedRight = Math.min(containerLeft + outWidth, clipRect.right);
			const clampedBottom = Math.min(containerTop + outHeight, clipRect.bottom);
			containerLeft = clampedLeft;
			containerTop = clampedTop;
			outWidth = Math.max(0, clampedRight - clampedLeft);
			outHeight = Math.max(0, clampedBottom - clampedTop);
		}

		// Size the DOM container from the CLAMPED values, so the element and the native view
		// describe the same box. Writing the unclamped size here would leave the ring drawn
		// around a rectangle the page no longer fills.
		this._browserContainer.style.width = `${outWidth}px`;
		this._browserContainer.style.height = `${outHeight}px`;
		const cornerRadius = parseFloat(this.window.getComputedStyle(this._browserContainer).borderTopLeftRadius ?? '0');
		void this._model.layout({
			windowId: this.group.windowId,
			x: containerLeft,
			y: containerTop,
			width: outWidth,
			height: outHeight,
			zoomFactor: getZoomFactor(this.window),
			cornerRadius,
			emulation: layout.emulation,
		});
	}

	/**
	 * Wrapper content-area size in CSS px — the maximum room the container
	 * can occupy after the active padding is applied. Derived from the last
	 * padding we wrote to the wrapper, so it stays in sync without re-reading
	 * the computed style.
	 */
	get paneSize(): { width: number; height: number } {
		const r = this._browserContainerWrapper.getBoundingClientRect();
		const p = this._currentPadding;
		return {
			width: Math.max(0, r.width - p.left - p.right),
			height: Math.max(0, r.height - p.top - p.bottom),
		};
	}

	override clearInput(): void {
		this._inputDisposables.clear();

		// Cancel any scheduled timers
		this.cancelScheduledScreenshot();
		this.cancelFocus();
		this.cancelBrowserContainerSettle();

		void this._model?.setVisible(false);
		this._model = undefined;
		this._onDidChangeModel.fire({ model: undefined, isNew: false });

		this._canGoBackContext.reset();
		this._canGoForwardContext.reset();
		this._hasUrlContext.reset();
		this._hasErrorContext.reset();

		this._navigationBar.clear();
		this.setBackgroundImage(undefined);

		super.clearInput();
	}
}
