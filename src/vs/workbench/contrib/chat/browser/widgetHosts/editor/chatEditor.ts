/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// === CHAT SURFACE: EDITOR_TAB_CHAT ===
// Engine: NATIVE (IChatService / ChatModel). Chat hosted as an editor tab. Session is owned by
// ChatEditorInput.resolve() (see chatEditorInput.ts), keyed per-tab by sessionResource.
// Not connected to the legacy IChatThreadService. See CHAT_SURFACES_MAP.md.

import * as dom from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { raceCancellationError } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as nls from '../../../../../../nls.js';
import { ITextResourceConfigurationService } from '../../../../../../editor/common/services/textResourceConfiguration.js';
import { IContextKeyService, IScopedContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { editorBackground, editorForeground, inputBackground } from '../../../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { AbstractEditorWithViewState } from '../../../../../browser/parts/editor/editorWithViewState.js';
import { IEditorOpenContext } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../../common/theme.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { IChatModel, IChatModelInputState, IExportableChatData, ISerializableChatData } from '../../../common/model/chatModel.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { IChatSessionsService, localChatSessionType } from '../../../common/chatSessionsService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../common/constants.js';
import { clearChatEditor } from '../../actions/chatClear.js';
import { AgentWorkspaceShell } from './agentWorkspaceShell.js';
import { ChatEditorInput } from './chatEditorInput.js';
import { ChatWidget } from '../../widget/chatWidget.js';

export interface IChatEditorOptions extends IEditorOptions {
	/**
	 * Input state of the model when the editor is opened. Currently needed since
	 * new sessions are not persisted but may go away with
	 * https://github.com/microsoft/vscode/pull/278476 as input state is stored on the model.
	 */
	modelInputState?: IChatModelInputState;
	target?: { data: IExportableChatData | ISerializableChatData };
	title?: {
		preferred?: string;
		fallback?: string;
	};
	/** Open this ChatEditor inside the native multipane Agents workspace frame. */
	agentWorkspace?: boolean;
}

export interface IChatEditorViewState {
	scrollTop: number;
}

/**
 * Upstream's `ChatListRenderer.layout` derives every Monaco code-block width
 * from `width - 40`, a constant that encodes upstream's row padding of
 * `.interactive-item-container { padding: 12px 16px }`.
 */
const UPSTREAM_ROW_CHROME = 40;

/**
 * Width allowance for the chat list's vertical scrollbar, which shares the Agent
 * Workspace grid column with the conversation.
 */
const AGENT_WORKSPACE_SCROLLBAR_ALLOWANCE = 8;

/** Fallback matching `--agent-workspace-chat-gutter` in agentWorkspaceShell.css. */
const AGENT_WORKSPACE_GUTTER_FALLBACK = 24;

/**
 * Horizontal space the Agent Workspace chat column spends on chrome that
 * `ChatListRenderer.layout` does not know about, in px.
 *
 * DERIVED, never hardcoded. The Agent Workspace overrides the row padding to
 * `--agent-workspace-chat-gutter` per side, so the upstream constant
 * under-subtracts and fenced blocks lay out wider than the column they live in -
 * the conversation then reads "fatter" than the composer. This was previously a
 * literal calibrated against a 22px gutter; when the gutter moved to 24px the
 * literal silently went stale and the overhang came back. Reading the gutter
 * from the same CSS custom property that paints it makes the two impossible to
 * drift apart. Ordinary editor chat keeps the upstream number and is untouched:
 * only this host lets CSS cap the column, so only this host has to correct for it.
 */
function agentWorkspaceContentInset(container: HTMLElement | undefined): number {
	let gutter = AGENT_WORKSPACE_GUTTER_FALLBACK;
	if (container) {
		const declared = dom.getWindow(container)
			.getComputedStyle(container)
			.getPropertyValue('--agent-workspace-chat-gutter');
		const parsed = parseFloat(declared);
		if (Number.isFinite(parsed) && parsed >= 0) {
			gutter = parsed;
		}
	}
	return Math.max(0, (gutter * 2) - UPSTREAM_ROW_CHROME + AGENT_WORKSPACE_SCROLLBAR_ALLOWANCE);
}

export class ChatEditor extends AbstractEditorWithViewState<IChatEditorViewState> {
	private static readonly VIEW_STATE_KEY = 'chatEditorViewState';

	private _widget!: ChatWidget;
	public get widget(): ChatWidget {
		return this._widget;
	}
	private _scopedContextKeyService!: IScopedContextKeyService;
	override get scopedContextKeyService() {
		return this._scopedContextKeyService;
	}

	private dimension = new dom.Dimension(0, 0);
	private agentWorkspaceHostDimension = new dom.Dimension(0, 0);
	private agentWorkspaceChatCellDimension = new dom.Dimension(0, 0);
	private _loadingContainer: HTMLElement | undefined;
	private _editorContainer: HTMLElement | undefined;
	private _workspaceShell: AgentWorkspaceShell | undefined;

	/**
	 * The shell element claimed as a chat drop target. Only a guard against claiming it
	 * twice - ChatDragAndDrop clears its own overlays when the input part is disposed.
	 */
	private agentWorkspaceDropHost: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super(ChatEditorInput.EditorID, group, ChatEditor.VIEW_STATE_KEY, telemetryService, instantiationService, storageService, textResourceConfigurationService, themeService, editorService, editorGroupService);
	}

	private async clear() {
		if (this.input) {
			return this.instantiationService.invokeFunction(clearChatEditor, this.input as ChatEditorInput);
		}
	}

	protected override createEditor(parent: HTMLElement): void {
		this._editorContainer = parent;
		// Ensure the container has position relative for the loading overlay
		parent.classList.add('chat-editor-relative');
		this._scopedContextKeyService = this._register(this.contextKeyService.createScoped(parent));
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService])));
		ChatContextKeys.inChatEditor.bindTo(this._scopedContextKeyService).set(true);
		this._workspaceShell = this._register(scopedInstantiationService.createInstance(AgentWorkspaceShell, parent, this.group));

		this._widget = this._register(
			scopedInstantiationService.createInstance(
				ChatWidget,
				ChatAgentLocation.Chat,
				undefined,
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
					enableImplicitContext: true,
					enableWorkingSet: 'explicit',
					supportsChangingModes: true,
					// Make the whole editor a drop target, the way the chat view pane
					// already does. Without this the chat only accepted a drop on the
					// composer box itself, so anything dropped over the conversation fell
					// through to the editor group's own drop target and opened as a file
					// in the utility pane instead of attaching to the prompt.
					dndContainer: parent,
				},
				{
					listForeground: editorForeground,
					listBackground: editorBackground,
					overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
					inputEditorBackground: inputBackground,
					resultEditorBackground: editorBackground
				}));
		this._register(this.widget.onDidSubmitAgent(() => {
			this.group.pinEditor(this.input);
		}));
		this._register(this.widget.onDidChangeEmptyState(() => {
			this._workspaceShell?.setChatEmpty(this.widget.isEmpty());
		}));
		this._register(this.widget.onDidChangeViewModel((e) => {
			if (e.currentSessionResource && this.input instanceof ChatEditorInput) {
				const newModel = this.chatService.getSession(e.currentSessionResource);
				if (newModel) {
					this.input.updateModel(newModel);
				}
			}
		}));
		this.widget.render(parent);
		let forceWorkspaceLayout = false;
		const workspaceLayoutScheduler = this._register(new dom.AnimationFrameScheduler(parent, () => {
			const force = forceWorkspaceLayout;
			forceWorkspaceLayout = false;
			this.layoutAgentWorkspaceFromHost(force);
		}));
		const scheduleWorkspaceLayout = (force = false) => {
			forceWorkspaceLayout ||= force;
			workspaceLayoutScheduler.schedule();
		};
		const workspaceResizeObserver = this._register(new dom.DisposableResizeObserver('ChatEditor.agentWorkspaceHost', () => {
			if (!parent.classList.contains('agent-workspace-enabled')) {
				return;
			}

			const hostWidth = Math.floor(parent.clientWidth);
			const hostHeight = Math.floor(parent.clientHeight);
			const chatCellWidth = Math.floor(this.widget.domNode.clientWidth);
			const chatCellHeight = Math.floor(this.widget.domNode.clientHeight);
			if (hostWidth <= 0 || hostHeight <= 0 ||
				(hostWidth === this.agentWorkspaceHostDimension.width &&
					hostHeight === this.agentWorkspaceHostDimension.height &&
					chatCellWidth === this.agentWorkspaceChatCellDimension.width &&
					chatCellHeight === this.agentWorkspaceChatCellDimension.height)) {
				return;
			}

			scheduleWorkspaceLayout();
		}, dom.getWindow(parent)));
		this._register(workspaceResizeObserver.observe(parent));
		// The shell changes the real chat cell without necessarily changing the
		// ChatEditor host: enabling the rail, normalizing restored groups, and
		// opening/closing the utility pane all reshape this node. Observe that
		// structural boundary too so startup geometry does not wait for a manual
		// window resize before the native widget learns its actual viewport.
		this._register(workspaceResizeObserver.observe(this.widget.domNode));
		this._register(this._workspaceShell.onDidRequestLayout(() => scheduleWorkspaceLayout(true)));
		this._workspaceShell.attachToChatInput();
		this._workspaceShell.setChatEmpty(this.widget.isEmpty());
		this.widget.setVisible(true);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);

		this.widget?.setVisible(visible);
		this._workspaceShell?.setVisible(visible);

		if (visible && this.widget) {
			this.layoutChatWidget(this.dimension);
		}
	}

	public override focus(): void {
		super.focus();

		this.widget?.focusInput();
	}

	override clearInput(): void {
		this.widget?.setModel(undefined);
		super.clearInput();
	}

	private showLoadingInChatWidget(message: string): void {
		if (!this._editorContainer) {
			return;
		}

		// If already showing, just update text
		if (this._loadingContainer) {
			// eslint-disable-next-line no-restricted-syntax
			const existingText = this._loadingContainer.querySelector('.chat-loading-content span');
			if (existingText) {
				existingText.textContent = message;
				return; // aria-live will announce the text change
			}
			this.hideLoadingInChatWidget(); // unexpected structure
		}

		// Mark container busy for assistive technologies
		this._editorContainer.setAttribute('aria-busy', 'true');

		this._loadingContainer = dom.append(this._editorContainer, dom.$('.chat-loading-overlay'));
		// Accessibility: announce loading state politely without stealing focus
		this._loadingContainer.setAttribute('role', 'status');
		this._loadingContainer.setAttribute('aria-live', 'polite');
		// Rely on live region text content instead of aria-label to avoid duplicate announcements
		this._loadingContainer.tabIndex = -1; // ensure it isn't focusable
		const loadingContent = dom.append(this._loadingContainer, dom.$('.chat-loading-content'));
		const spinner = renderIcon(ThemeIcon.modify(Codicon.loading, 'spin'));
		spinner.setAttribute('aria-hidden', 'true');
		loadingContent.appendChild(spinner);
		const text = dom.append(loadingContent, dom.$('span'));
		text.textContent = message;
	}

	private hideLoadingInChatWidget(): void {
		if (this._loadingContainer) {
			this._loadingContainer.remove();
			this._loadingContainer = undefined;
		}
		if (this._editorContainer) {
			this._editorContainer.removeAttribute('aria-busy');
		}
	}

	override async setInput(input: ChatEditorInput, options: IChatEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		// Show loading indicator early for non-local sessions to prevent layout shifts
		let isContributedChatSession = false;
		const chatSessionType = input.getSessionType();
		if (chatSessionType !== localChatSessionType) {
			const loadingMessage = nls.localize('chatEditor.loadingSession', "Loading...");
			this.showLoadingInChatWidget(loadingMessage);
		}

		await super.setInput(input, options, context, token);
		// `agentWorkspace` describes the top-level window, not the chat session.
		// Older builds persisted the flag with ChatEditorInput, so guard the
		// editor option with the live window designation. This prevents a normal
		// fresh IDE window from recreating the Agent-only rail and grid when
		// it restores the same session.
		this.setAgentWorkspaceEnabled(options?.agentWorkspace ?? input.options.agentWorkspace ?? false);
		if (token.isCancellationRequested) {
			this.hideLoadingInChatWidget();
			return;
		}

		if (!this.widget) {
			throw new Error('ChatEditor lifecycle issue: no editor widget');
		}

		if (chatSessionType !== localChatSessionType) {
			try {
				await raceCancellationError(this.chatSessionsService.canResolveChatSession(chatSessionType), token);
				const contributions = this.chatSessionsService.getAllChatSessionContributions();
				const contribution = contributions.find(c => c.type === chatSessionType);
				if (contribution) {
					this.widget.lockToCodingAgent(contribution.name, contribution.displayName, contribution.type);
					isContributedChatSession = true;
				} else {
					this.widget.unlockFromCodingAgent();
				}
			} catch (error) {
				this.hideLoadingInChatWidget();
				throw error;
			}
		} else {
			this.widget.unlockFromCodingAgent();
		}

		try {
			const editorModel = await raceCancellationError(input.resolve(), token);

			if (!editorModel) {
				throw new Error(`Failed to get model for chat editor. resource: ${input.sessionResource}`);
			}

			// Hide loading state before updating model
			if (chatSessionType !== localChatSessionType) {
				this.hideLoadingInChatWidget();
			}

			if (options?.modelInputState) {
				editorModel.model.inputModel.setState(options.modelInputState);
			}

			this._workspaceShell?.bindSessionToWorkspace(editorModel.model);
			this.updateModel(editorModel.model);
			this._workspaceShell?.setChatEmpty(this.widget.isEmpty());

			const viewState = this.loadEditorViewState(input, context);
			if (viewState) {
				this._widget.scrollTop = viewState.scrollTop;
			}

			if (isContributedChatSession && options?.title?.preferred && input.sessionResource) {
				this.chatService.setChatSessionTitle(input.sessionResource, options.title.preferred);
			}
		} catch (error) {
			this.hideLoadingInChatWidget();
			throw error;
		}
	}

	/**
	 * Apply the Agent Workspace host to an already-open ChatEditor.
	 *
	 * An Agent companion CodeWindow can restore the same chat session before the
	 * native Agent Workspace IPC arrives. The editor resolver then correctly
	 * reuses this pane because the session resource matches, so `setInput` is not
	 * guaranteed to run a second time with Agent-specific options. Keep the
	 * window mode explicit on the live pane instead of relying on input creation
	 * order.
	 */
	public setAgentWorkspaceEnabled(enabled: boolean): void {
		// Use the window's own identity rather than probing for the shell's CSS class.
		// That class is added late by the `vscode:openAgentWorkspace` IPC, and the
		// probe also read as `true` whenever `_editorContainer` was undefined, because
		// `undefined !== null`. This is the same flag the editor part keys its state
		// persistence on, so the two cannot disagree.
		const shouldEnable = enabled && this.environmentService.isAgentWorkspaceWindow;

		// Editor groups decline external file drops in this window, so claim the whole
		// shell as a drop target: a file dropped over the rail or the utility pane
		// reaches the prompt instead of doing nothing, and nothing opens a pane.
		if (shouldEnable && !this.agentWorkspaceDropHost) {
			const host = this._editorContainer?.closest<HTMLElement>('.monaco-workbench') ?? undefined;
			if (host) {
				this.agentWorkspaceDropHost = host;
				this.widget.inputPart.dnd.addOverlay(host, host);
			}
		}
		this._workspaceShell?.setEnabled(shouldEnable);
		this.widget?.setListRendererWidthOffset(shouldEnable ? agentWorkspaceContentInset(this._editorContainer) : 0);

		if (shouldEnable && this.widget) {
			// The widget's onDidStyleChange() sets --vscode-chat-list-background,
			// --vscode-interactive-result-editor-background-color, and
			// --vscode-interactive-session-foreground as INLINE styles from the
			// theme's editorBackground token. Inline styles beat any CSS variable
			// override, so the agent panel's dark surface-base never wins and every
			// upstream consumer paints the lighter IDE grey. Removing the inline
			// properties lets CSS inheritance take over from the variable block at
			// agentWorkspaceShell.css:1319.
			this.clearInlineStyleOverrides();
			this._workspaceShell?.setChatEmpty(this.widget.isEmpty());
			this.layoutAgentWorkspaceFromHost(true);
		}
	}

	private updateModel(model: IChatModel): void {
		this.widget.setModel(model);
	}

	private layoutAgentWorkspaceFromHost(force = false): void {
		if (!this.widget || !this._editorContainer || !this._workspaceShell?.isEnabled()) {
			return;
		}

		const width = Math.floor(this._editorContainer.clientWidth);
		const height = Math.floor(this._editorContainer.clientHeight);
		const chatCellWidth = Math.floor(this.widget.domNode.clientWidth);
		const chatCellHeight = Math.floor(this.widget.domNode.clientHeight);
		if (width <= 0 || height <= 0 || (!force &&
			width === this.agentWorkspaceHostDimension.width &&
			height === this.agentWorkspaceHostDimension.height &&
			chatCellWidth === this.agentWorkspaceChatCellDimension.width &&
			chatCellHeight === this.agentWorkspaceChatCellDimension.height)) {
			return;
		}

		this.applyAgentWorkspaceLayout(height, width);
	}

	/** Remove the inline style properties that chatWidget.onDidStyleChange() sets
	 *  on the widget container. Those resolve to the theme's editorBackground
	 *  (lighter grey) and, being inline styles, beat any CSS variable override.
	 *  Clearing them lets CSS inheritance take over from the variable block at
	 *  agentWorkspaceShell.css:1319, which redefines the same custom properties
	 *  to the dark surface-base family. Called from both setAgentWorkspaceEnabled
	 *  and the layout path, because onDidStyleChange re-fires on theme changes. */
	private clearInlineStyleOverrides(): void {
		const container = this.widget?.domNode;
		if (!container) {
			return;
		}
		container.style.removeProperty('--vscode-chat-list-background');
		container.style.removeProperty('--vscode-interactive-result-editor-background-color');
		container.style.removeProperty('--vscode-interactive-session-foreground');
	}

	private applyAgentWorkspaceLayout(height: number, width: number): void {
		this.agentWorkspaceHostDimension = new dom.Dimension(width, height);
		this.clearInlineStyleOverrides();
		const chatDimension = this._workspaceShell!.layout(height, width);
		// The shell owns the structural rail split, while CSS may further cap the
		// readable chat column. Monaco-backed chat parts need the width of the
		// rendered cell, not the wider host, or their inline pixel widths escape.
		const renderedWidth = Math.floor(this.widget.domNode.clientWidth);
		const widgetWidth = renderedWidth > 0 ? Math.min(chatDimension.width, renderedWidth) : chatDimension.width;
		this.widget.setListRendererWidthOffset(agentWorkspaceContentInset(this._editorContainer));
		this.widget.layout(chatDimension.height, widgetWidth);
		this.agentWorkspaceChatCellDimension = new dom.Dimension(
			Math.floor(this.widget.domNode.clientWidth),
			Math.floor(this.widget.domNode.clientHeight)
		);
	}

	private layoutChatWidget(fallback: dom.Dimension): void {
		if (this._workspaceShell?.isEnabled() && this._editorContainer) {
			const width = Math.floor(this._editorContainer.clientWidth);
			const height = Math.floor(this._editorContainer.clientHeight);
			if (width > 0 && height > 0) {
				this.applyAgentWorkspaceLayout(height, width);
				return;
			}
		}

		const chatDimension = this._workspaceShell?.layout(fallback.height, fallback.width) ?? fallback;
		this.widget.setListRendererWidthOffset(0);
		this.widget.layout(chatDimension.height, chatDimension.width);
	}

	protected computeEditorViewState(_resource: URI): IChatEditorViewState | undefined {
		if (!this._widget) {
			return undefined;
		}
		return { scrollTop: this._widget.scrollTop };
	}

	protected tracksEditorViewState(input: EditorInput): boolean {
		return input instanceof ChatEditorInput;
	}

	protected toEditorViewStateResource(input: EditorInput): URI | undefined {
		return (input as ChatEditorInput).sessionResource;
	}

	override layout(dimension: dom.Dimension, position?: dom.IDomPosition | undefined): void {
		this.dimension = dimension;
		if (this.widget) {
			this.layoutChatWidget(dimension);
		}
	}
}
