/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// === CHAT SURFACE: MAIN_EDITOR_CHAT ===
// Engine: NATIVE (IChatService / ChatModel, keyed by sessionResource). The sidebar/aux-bar
// chat ViewPane in the MAIN window. Agent Sessions lives in an independent sidebar container.
// Reused by AGENTS_WINDOW_CHAT, but that runs in a SEPARATE renderer/IChatService instance.
// Not connected to the legacy IChatThreadService. See CHAT_SURFACES_MAP.md.

import './media/chatViewPane.css';
import { $, addDisposableListener, append, EventHelper, EventType, getWindow } from '../../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../../base/browser/mouseEvent.js';

import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { MutableDisposable, toDisposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
import { autorun, IReader } from '../../../../../../base/common/observable.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { editorBackground } from '../../../../../../platform/theme/common/colorRegistry.js';
import { ChatViewTitleControl } from './chatViewTitleControl.js';
import { ChatViewTabsControl } from './chatViewTabsControl.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../browser/parts/views/viewPane.js';
import { Memento } from '../../../../../common/memento.js';
import { SIDE_BAR_FOREGROUND } from '../../../../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../../common/views.js';
import { ILifecycleService, StartupKind } from '../../../../../services/lifecycle/common/lifecycle.js';
import { IChatViewTitleActionContext } from '../../../common/actions/chatActions.js';
import { IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { IChatModel, IChatModelInputState } from '../../../common/model/chatModel.js';
import { CHAT_PROVIDER_ID } from '../../../common/participants/chatParticipantContribTypes.js';
import { IChatModelReference, IChatService } from '../../../common/chatService/chatService.js';
import { IChatSessionsService, localChatSessionType } from '../../../common/chatSessionsService.js';
import { LocalChatSessionUri, getChatSessionType } from '../../../common/model/chatUri.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../../common/constants.js';

import { ChatWidget } from '../../widget/chatWidget.js';
import { ChatViewWelcomeController, IViewWelcomeDelegate } from '../../viewsWelcome/chatViewWelcomeController.js';
import { IChatViewsWelcomeDescriptor } from '../../viewsWelcome/chatViewsWelcome.js';
import { IWorkbenchLayoutService, LayoutSettings, Parts } from '../../../../../services/layout/browser/layoutService.js';
import { IProgressService } from '../../../../../../platform/progress/common/progress.js';
import { ChatViewId } from '../../chat.js';
import { IActivityService, ProgressBadge } from '../../../../../services/activity/common/activity.js';
import { disposableTimeout } from '../../../../../../base/common/async.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { toErrorMessage } from '../../../../../../base/common/errorMessage.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { ACTION_ID_NEW_CHAT } from '../../actions/chatActions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';


interface IChatViewPaneState extends Partial<IChatModelInputState> {
	/**
	 * @deprecated This is kept around to support old view states. However it should not be set on new states and `sessionResource` should be used instead.
	 */
	sessionId?: string;
	sessionResource?: URI;
}

type ChatViewPaneOpenedClassification = {
	owner: 'sbatten';
	comment: 'Event fired when the chat view pane is opened';
};

export class ChatViewPane extends ViewPane implements IViewWelcomeDelegate {

	private readonly memento: Memento<IChatViewPaneState>;
	private readonly viewState: IChatViewPaneState;

	private viewPaneContainer: HTMLElement | undefined;
	private readonly chatViewLocationContext: IContextKey<ViewContainerLocation>;

	private lastDimensions: { height: number; width: number } | undefined;

	private welcomeController: ChatViewWelcomeController | undefined;

	private restoringSession: Promise<void> | undefined;
	private readonly restoreSessionCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly loadSessionCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());

	private readonly activityBadge = this._register(new MutableDisposable());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IProgressService private readonly progressService: IProgressService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IActivityService private readonly activityService: IActivityService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// View state for the ViewPane is currently global per-provider basically,
		// but some other strictly per-model state will require a separate memento.
		this.memento = new Memento(`interactive-session-view-${CHAT_PROVIDER_ID}`, this.storageService);
		this.viewState = this.memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (
			lifecycleService.startupKind !== StartupKind.ReloadedWindow &&
			this.configurationService.getValue<boolean>(ChatConfiguration.RestoreLastPanelSession) === false
		) {
			// clear persisted session on fresh start
			this.viewState.sessionId = undefined;
			this.viewState.sessionResource = undefined;
		}
		// Contextkeys
		this.chatViewLocationContext = ChatContextKeys.panelLocation.bindTo(contextKeyService);

		this.updateContextKeys();

		this.registerListeners();
	}

	private updateContextKeys(): void {
		this.chatViewLocationContext.set(this.viewDescriptorService.getViewLocationById(this.id) ?? ViewContainerLocation.AuxiliaryBar);
	}

	private updateViewPaneClasses(fromEvent: boolean): void {
		const activityBarLocationDefault = this.configurationService.getValue<string>(LayoutSettings.ACTIVITY_BAR_LOCATION) === 'default';
		this.viewPaneContainer?.classList.toggle('activity-bar-location-default', activityBarLocationDefault);
		this.viewPaneContainer?.classList.toggle('activity-bar-location-other', !activityBarLocationDefault);

		const location = this.viewDescriptorService.getViewLocationById(this.id) ?? ViewContainerLocation.AuxiliaryBar;

		this.viewPaneContainer?.classList.toggle('chat-view-location-auxiliarybar', location === ViewContainerLocation.AuxiliaryBar);
		this.viewPaneContainer?.classList.toggle('chat-view-location-sidebar', location === ViewContainerLocation.Sidebar);
		this.viewPaneContainer?.classList.toggle('chat-view-location-panel', location === ViewContainerLocation.Panel);

		if (fromEvent) {
			this.relayout();
		}
	}

	private registerListeners(): void {

		// Agent changes
		this._register(this.chatAgentService.onDidChangeAgents(() => this.onDidChangeAgents()));

		// Session changes
		this._register(this.chatSessionsService.onDidCommitSession(async (e) => {
			if (!this.modelRef.value) {
				return;
			}

			if (!isEqual(e.original, this.modelRef.value.object.sessionResource)) {
				return;
			}

			const modelRef = await this.chatService.acquireOrLoadSession(e.committed, ChatAgentLocation.Chat, CancellationToken.None, 'ChatViewPane#onDidCommitSession');
			await this.showModel(CancellationToken.None, modelRef);
		}));

		// Layout changes
		this._register(Event.any(
			Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('workbench.sideBar.location')),
			this.layoutService.onDidChangePanelPosition,
			Event.filter(this.viewDescriptorService.onDidChangeContainerLocation, e => e.viewContainer === this.viewDescriptorService.getViewContainerByViewId(this.id)),
			Event.filter(this.contextKeyService.onDidChangeContext, e => e.affectsSome(new Set(['v3code.agentMode'])))
		)(() => {
			this.updateContextKeys();
			this.updateViewPaneClasses(true /* layout here */);
		}));

		// Settings changes
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => {
			return e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_LOCATION);
		})(() => this.updateViewPaneClasses(true)));
	}

	private onDidChangeAgents(): void {
		if (this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat)) {
			if (this._widget && !this._widget.viewModel && !this.restoringSession && !this.loadSessionCts.value) {
				this.applyModel();
			}
		}

		this._onDidChangeViewWelcomeState.fire();
	}

	private getTransferredOrPersistedSessionInfo(): URI | undefined {
		if (this.chatService.transferredSessionResource) {
			return this.chatService.transferredSessionResource;
		}

		if (this.viewState.sessionResource) {
			return this.viewState.sessionResource;
		}

		return this.viewState.sessionId ? LocalChatSessionUri.forSession(this.viewState.sessionId) : undefined;
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.telemetryService.publicLog2<{}, ChatViewPaneOpenedClassification>('chatViewPaneOpened');

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('chat-viewpane');
		this.updateViewPaneClasses(false);

		this.createControls(parent);

		this.setupContextMenu(parent);

		this.applyModel();
	}

	private createControls(parent: HTMLElement): void {

		// Welcome Control (used to show chat specific extension provided welcome views via `chatViewsWelcome` contribution point)
		const welcomeController = this.welcomeController = this._register(this.instantiationService.createInstance(ChatViewWelcomeController, parent, this, ChatAgentLocation.Chat));

		// Chat Control
		const chatWidget = this.createChatControl(parent);

		// Controls Listeners
		this.registerControlsListeners(chatWidget, welcomeController);
	}

	//#region Chat Control


	private _widget!: ChatWidget;
	get widget(): ChatWidget { return this._widget; }

	private titleControl: ChatViewTitleControl | undefined;
	private tabsControl: ChatViewTabsControl | undefined;

	private createChatControl(parent: HTMLElement): ChatWidget {
		const chatControlsContainer = append(parent, $('.chat-controls-container'));

		const locationBasedColors = this.getLocationBasedColors();

		const editorOverflowWidgetsDomNode = this.layoutService.getContainer(getWindow(chatControlsContainer)).appendChild($('.chat-editor-overflow.monaco-editor'));
		this._register(toDisposable(() => editorOverflowWidgetsDomNode.remove()));

		// Cursor-style open-chat tabs (shown when Agents unified sidebar is collapsed)
		if (this.viewDescriptorService.getViewLocationById(this.id) !== ViewContainerLocation.ChatBar) {
			this.createChatTabsControl(chatControlsContainer);
			this.createChatTitleControl(chatControlsContainer);
		}

		// Chat Widget
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService])));
		this._widget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ viewId: this.id },
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				clear: () => this.clear(),
				rendererOptions: {
					renderTextEditsAsSummary: (uri) => {
						return true;
					},
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				editorOverflowWidgetsDomNode,
				enableImplicitContext: true,
				enableWorkingSet: this.workbenchEnvironmentService.isSessionsWindow
					? 'implicit'
					: 'explicit',
				supportsChangingModes: true,
				dndContainer: parent,
				// V3Code: compact at rest, measured growth as the draft gains lines.
				inputEditorMinLines: 1.5,
				isSessionsWindow: this.workbenchEnvironmentService.isSessionsWindow,
			},
			{
				listForeground: SIDE_BAR_FOREGROUND,
				listBackground: locationBasedColors.background,
				overlayBackground: locationBasedColors.overlayBackground,
				inputEditorBackground: locationBasedColors.background,
				resultEditorBackground: editorBackground,
			}));
		this._widget.render(chatControlsContainer);

		const updateWidgetVisibility = (reader?: IReader) => this._widget.setVisible(this.isBodyVisible() && !this.welcomeController?.isShowingWelcome.read(reader));
		this._register(this.onDidChangeBodyVisibility(() => updateWidgetVisibility()));
		this._register(autorun(reader => updateWidgetVisibility(reader)));

		return this._widget;
	}

	private createChatTitleControl(parent: HTMLElement): void {
		this.titleControl = this._register(this.instantiationService.createInstance(ChatViewTitleControl,
			parent,
			{
				focusChat: () => this._widget.focusInput()
			}
		));

		this._register(this.titleControl.onDidChangeHeight(() => {
			this.relayout();
		}));
	}

	private createChatTabsControl(parent: HTMLElement): void {
		this.tabsControl = this._register(this.instantiationService.createInstance(ChatViewTabsControl, parent, {
			getActiveResource: () => this._widget?.viewModel?.sessionResource,
			onSelect: async resource => { await this.loadSession(resource); },
			onNew: () => this.commandService.executeCommand(ACTION_ID_NEW_CHAT),
			onClose: async () => {
				// Close is UI-only — never archive/delete/cancel.
			},
		}));
		this._register(this.tabsControl.onDidChangeHeight(() => this.relayout()));
		const syncTabsVisibility = () => {
			// Cursor-faithful: the chat column top is ALWAYS the tab strip
			// (tabs + new + history + options). The legacy session-title strip
			// is never shown — the active tab carries the session identity.
			this.tabsControl?.setVisible(true);
			if (this.titleControl?.element) {
				this.titleControl.element.style.display = 'none';
			}
			this.relayout();
		};
		syncTabsVisibility();
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.UNIFIED_SIDEBAR_PART) {
				syncTabsVisibility();
			}
		}));
	}

	//#endregion

	private registerControlsListeners(chatWidget: ChatWidget, welcomeController: ChatViewWelcomeController): void {

		this._register(chatWidget.onDidChangeViewModel(() => {
			this.titleControl?.update(chatWidget.viewModel?.model);
			this.tabsControl?.notifyActiveChanged(chatWidget.viewModel?.sessionResource);
		}));

		// When the currently displayed session is archived, start a new session
		this._register(this.agentSessionsService.model.onDidChangeSessionArchivedState(e => {
			if (e.isArchived()) {
				const currentSessionResource = chatWidget.viewModel?.sessionResource;
				if (currentSessionResource && isEqual(currentSessionResource, e.resource)) {
					this.clear();
				}
			}
		}));


		// Show progress badge when the current session is in progress
		const progressBadgeDisposables = this._register(new MutableDisposable<DisposableStore>());
		const updateProgressBadge = () => {
			progressBadgeDisposables.value = new DisposableStore();

			if (!this.configurationService.getValue<boolean>(ChatConfiguration.ChatViewProgressBadgeEnabled)) {
				this.activityBadge.clear();
				return;
			}

			const model = chatWidget.viewModel?.model;
			if (model) {
				progressBadgeDisposables.value.add(autorun(reader => {
					if (model.requestInProgress.read(reader)) {
						this.activityBadge.value = this.activityService.showViewActivity(this.id, {
							badge: new ProgressBadge(() => localize('sessionInProgress', "Agent Session in Progress"))
						});
					} else {
						this.activityBadge.clear();
					}
				}));
			} else {
				this.activityBadge.clear();
			}
		};
		this._register(chatWidget.onDidChangeViewModel(() => updateProgressBadge()));
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(ChatConfiguration.ChatViewProgressBadgeEnabled))(() => updateProgressBadge()));
		updateProgressBadge();
	}

	private setupContextMenu(parent: HTMLElement): void {
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e, true);

			this.contextMenuService.showContextMenu({
				menuId: MenuId.ChatWelcomeContext,
				contextKeyService: this.contextKeyService,
				getAnchor: () => new StandardMouseEvent(getWindow(parent), e)
			});
		}));
	}

	//#region Model Management

	private applyModel(): void {
		this.restoreSessionCts.value?.cancel();
		const cts = this.restoreSessionCts.value = new CancellationTokenSource();
		const restore = this._applyModel(cts.token).catch(async error => {
			if (!cts.token.isCancellationRequested) {
				this.logService.warn('[ChatViewPane] Failed to restore previous chat; opening a new local chat', error);
				await this.showModel(cts.token, this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { debugOwner: 'ChatViewPane#restoreFallback' }));
			}
		}).finally(() => {
			if (this.restoringSession === restore) {
				this.restoringSession = undefined;
			}
		});
		this.restoringSession = restore;
	}

	private async _applyModel(token: CancellationToken): Promise<void> {
		const sessionResource = this.getTransferredOrPersistedSessionInfo();
		const modelRef = sessionResource ? await this.chatService.acquireOrLoadSession(sessionResource, ChatAgentLocation.Chat, token, 'ChatViewPane#applyModel') : undefined;
		if (token.isCancellationRequested) {
			modelRef?.dispose();
			return;
		}
		await this.showModel(token, modelRef);
	}

	private async showModel(token: CancellationToken, modelRef?: IChatModelReference | undefined, startNewSession = true): Promise<IChatModel | undefined> {
		if (token.isCancellationRequested) {
			modelRef?.dispose();
			return undefined;
		}

		let ref: IChatModelReference | undefined;
		if (startNewSession) {
			ref = modelRef ?? (this.chatService.transferredSessionResource
				? await this.chatService.acquireOrLoadSession(this.chatService.transferredSessionResource, ChatAgentLocation.Chat, token, 'ChatViewPane#showModel')
				: this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { debugOwner: 'ChatViewPane#showModel' }));
			if (!ref) {
				throw new Error('Could not start chat session');
			}
		}

		if (token.isCancellationRequested) {
			ref?.dispose();
			return undefined;
		}

		const model = ref?.object;

		if (model) {
			await this.updateWidgetLockState(getChatSessionType(model.sessionResource), token); // Update widget lock state based on session type

			if (token.isCancellationRequested) {
				ref?.dispose();
				return undefined;
			}

			// remember as model to restore in view state
			this.viewState.sessionResource = model.sessionResource;
		}

		this.modelRef.value = ref;
		this._widget.setModel(model);

		// Update title control
		this.titleControl?.update(model);

		// Update the toolbar context with new sessionId
		this.updateActions();

		// Opening a session acknowledges its latest completed response. Do not mark the
		// session being left as read: it may still be running and should become unread
		// if it completes while another chat is visible.
		if (model) {
			const openedResource = model.sessionResource;
			this.tabsControl?.notifyActiveChanged(openedResource);
			this._register(disposableTimeout(() => {
				this.agentSessionsService.model.getSession(openedResource)?.setRead(true);
			}, 0));
		}

		return model;
	}

	private async updateWidgetLockState(sessionType: string, token: CancellationToken): Promise<void> {
		if (sessionType === localChatSessionType) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		let canResolve = false;
		try {
			canResolve = await this.chatSessionsService.canResolveChatSession(sessionType);
		} catch (error) {
			this.logService.warn(`Failed to resolve chat session type '${sessionType}' for locking`, error);
		}

		if (token.isCancellationRequested) {
			return;
		}

		if (!canResolve) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		if (contribution) {
			this._widget.lockToCodingAgent(contribution.name, contribution.displayName, sessionType);
		} else {
			this._widget.unlockFromCodingAgent();
		}
	}

	private async clear(): Promise<void> {
		this.restoreSessionCts.value?.cancel();
		// Cancel any in-flight loadSession call to prevent it from
		// overwriting the fresh session we are about to create.
		this.loadSessionCts.value?.cancel();
		const cts = this.loadSessionCts.value = new CancellationTokenSource();

		// Grab the widget's latest view state because it will be loaded back into the widget
		this.updateViewState();
		await this.showModel(cts.token, this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { debugOwner: 'ChatViewPane#clear' }));

		// Update the toolbar context with new sessionId
		this.updateActions();
	}

	async loadSession(sessionResource: URI): Promise<IChatModel | undefined> {
		const t0 = Date.now();
		this.logService.trace(`[ChatViewPane] loadSession start uri=${sessionResource.toString()}`);

		// Cancel any in-flight loadSession call so the last one always wins
		this.loadSessionCts.value?.cancel();
		const cts = this.loadSessionCts.value = new CancellationTokenSource();
		const token = cts.token;

		// An unavailable saved provider must not block explicit navigation. A late
		// restore result is disposed rather than replacing this user-selected chat.
		this.restoreSessionCts.value?.cancel();

		if (token.isCancellationRequested) {
			this.logService.trace(`[ChatViewPane] loadSession done total=${Date.now() - t0}ms uri=${sessionResource.toString()} cancelled=true phase=preAcquire`);
			return undefined;
		}

		return this.progressService.withProgress({ location: ChatViewId, delay: 200 }, async () => {
			let queue: Promise<void> = Promise.resolve();

			// A delay here to avoid blinking because only Cloud sessions are slow, most others are fast
			const clearWidget = disposableTimeout(() => {
				// Only clear the current model if this loadSession call is still the active one
				// and has not been cancelled. This preserves the "last call wins" behavior.
				if (token.isCancellationRequested || this.loadSessionCts.value !== cts) {
					return;
				}
				// clear current model without starting a new one
				queue = this.showModel(token, undefined, false).then(() => { });
			}, 100);
			const clearWidgetCancellationListener = token.onCancellationRequested(() => clearWidget.dispose());

			try {
				const newModelRef = await this.chatService.acquireOrLoadSession(sessionResource, ChatAgentLocation.Chat, token, 'ChatViewPane#loadSession');
				clearWidget.dispose();
				await queue;

				if (token.isCancellationRequested) {
					newModelRef?.dispose();
					this.logService.trace(`[ChatViewPane] loadSession done total=${Date.now() - t0}ms uri=${sessionResource.toString()} cancelled=true phase=postAcquire`);
					return undefined;
				}

				const result = await this.showModel(token, newModelRef);
				this.logService.trace(`[ChatViewPane] loadSession done total=${Date.now() - t0}ms uri=${sessionResource.toString()}`);
				return result;
			} catch (err) {
				clearWidget.dispose();
				await queue;

				if (token.isCancellationRequested) {
					this.logService.trace(`[ChatViewPane] loadSession done total=${Date.now() - t0}ms uri=${sessionResource.toString()} cancelled=true phase=error`);
					return undefined;
				}

				// Recover by starting a fresh empty session so the widget
				// is not left in a broken state without title or back button.
				this.logService.error(`Failed to load chat session '${sessionResource.toString()}'`, err);
				this.notificationService.error(localize('chat.loadSessionFailed', "Failed to open chat session: {0}", toErrorMessage(err)));
				const result = await this.showModel(token, undefined);
				this.logService.trace(`[ChatViewPane] loadSession done total=${Date.now() - t0}ms uri=${sessionResource.toString()} error=true`);
				return result;
			} finally {
				clearWidgetCancellationListener.dispose();
			}
		});
	}

	//#endregion

	override focus(): void {
		super.focus();

		this.focusInput();
	}

	focusInput(): void {
		this._widget.focusInput();
	}


	//#region Layout

	private layoutingBody = false;

	private relayout(): void {
		if (this.lastDimensions) {
			this.layoutBody(this.lastDimensions.height, this.lastDimensions.width);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		if (this.layoutingBody) {
			return; // prevent re-entrancy
		}

		this.layoutingBody = true;
		try {
			this.doLayoutBody(height, width);
		} finally {
			this.layoutingBody = false;
		}
	}

	private doLayoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.lastDimensions = { height, width };

		let remainingHeight = height;

		const tabsHeight = this.tabsControl?.getHeight() ?? 0;
		remainingHeight -= tabsHeight;

		// Title Control
		const titleHeight = this.titleControl?.getHeight() ?? 0;
		remainingHeight -= titleHeight;

		this._widget.setInputPartMaxHeightOverride(undefined);
		this._widget.layout(remainingHeight, width);
	}

	//#endregion

	override saveState(): void {

		// Don't do saveState when no widget, or no viewModel in which case
		// the state has not yet been restored - in that case the default
		// state would overwrite the real state
		if (this._widget?.viewModel) {
			this._widget.saveState();

			this.updateViewState();
			this.memento.saveMemento();
		}

		super.saveState();
	}

	private updateViewState(viewState?: IChatModelInputState): void {
		const newViewState = viewState ?? this._widget.getViewState();
		if (newViewState) {
			for (const [key, value] of Object.entries(newViewState)) {
				(this.viewState as Record<string, unknown>)[key] = value; // Assign all props to the memento so they get saved
			}
		}
	}

	override shouldShowWelcome(): boolean {
		const noPersistedSessions = !this.chatService.hasSessions();
		const hasCoreAgent = this.chatAgentService.getAgents().some(agent => agent.isCore && agent.locations.includes(ChatAgentLocation.Chat));
		const hasDefaultAgent = this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat) !== undefined; // only false when Hide AI Features has run and unregistered the setup agents
		const shouldShow = !hasCoreAgent && (!hasDefaultAgent || !this._widget?.viewModel && noPersistedSessions);

		this.logService.trace(`ChatViewPane#shouldShowWelcome() = ${shouldShow}: hasCoreAgent=${hasCoreAgent} hasDefaultAgent=${hasDefaultAgent} || noViewModel=${!this._widget?.viewModel} && noPersistedSessions=${noPersistedSessions}`);

		return !!shouldShow;
	}

	getMatchingWelcomeView(): IChatViewsWelcomeDescriptor | undefined {
		return this.welcomeController?.getMatchingWelcomeView();
	}

	override getActionsContext(): IChatViewTitleActionContext | undefined {
		return this._widget?.viewModel ? {
			sessionResource: this._widget.viewModel.sessionResource,
			$mid: MarshalledId.ChatViewContext
		} : undefined;
	}
}
