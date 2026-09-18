/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import './media/openInAgents.css';
import { $, append, EventLike } from '../../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../../platform/accessibility/common/accessibility.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { TitleBarLeadingActionsGroup } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { CHAT_CATEGORY } from '../../browser/actions/chatActions.js';
import { IChatWidgetService } from '../../browser/chat.js';
import { ChatEditorInput } from '../../browser/widgetHosts/editor/chatEditorInput.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID, OPEN_AGENTS_WINDOW_PRECONDITION, OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../common/constants.js';

// The same-window Chat surface (the V3/IDE pill layout). Kept as the light-weight
// door that never opens a second workbench window.
const ENTER_V3_CHAT_MODE_COMMAND_ID = 'v3code.enterAgentMode';

// Independent re-entrancy guards. The two doors do different things (same-window
// chat vs. companion-window swap); one must never block or dedupe the other.
let pendingSameWindowChatOpen: Promise<void> | undefined;
let pendingAgentWindowOpen: Promise<void> | undefined;

/**
 * The "Chat" door: enter the stable same-window, full-height chat surface. This
 * never clones the IDE into a second window; projects are attached from chat with
 * the permission-gated open_project tool when the agent actually needs one.
 */
async function doOpenSameWindowChat(accessor: ServicesAccessor): Promise<void> {
	const logService = accessor.get(ILogService);
	logService.info('[V3 Chat] same-window chat requested from Chat action');
	await accessor.get(ICommandService).executeCommand(ENTER_V3_CHAT_MODE_COMMAND_ID);
}

/**
 * The "Agents" door: open (or focus) the companion Agents window and hide this
 * IDE window behind it. Leaving Agents focuses this same IDE again. Neither
 * direction closes a window, so every switch costs a focus rather than a rebuild.
 * This is the reverse of AgentWorkspaceShell.showIde(); both directions share the
 * one native swap engine so the IDE <-> Agents flip stays symmetric and smooth.
 */
async function doOpenAgentWindow(accessor: ServicesAccessor): Promise<void> {
	const logService = accessor.get(ILogService);
	const widgetService = accessor.get(IChatWidgetService);
	const editorService = accessor.get(IEditorService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const nativeHostService = accessor.get(INativeHostService);

	logService.info('[Agent Workspace] open requested from Agents action');

	// Carry the chat the user is looking at into the Agents window, so the swap
	// continues the current conversation instead of dropping them on a blank one.
	const activeSession = editorService.activeEditor instanceof ChatEditorInput
		? editorService.activeEditor.sessionResource
		: undefined;
	const sessionUri = activeSession
		?? widgetService.lastFocusedWidget?.viewModel?.sessionResource
		?? LocalChatSessionUri.getNewSessionUri();

	const workspace = workspaceContextService.getWorkspace();
	logService.info(`[Agent Workspace] swapping to Agents session=${sessionUri.toString()} workspace=${workspace.configuration?.toString() ?? workspace.folders.at(0)?.uri.toString() ?? 'empty'}`);

	await nativeHostService.swapAgentWorkspaceWindow({
		workspaceUri: workspace.configuration ?? undefined,
		folderUri: workspace.configuration ? undefined : workspace.folders.at(0)?.uri,
		sessionUri,
		agentWorkspace: true,
	});
}

async function openSameWindowChat(accessor: ServicesAccessor): Promise<void> {
	if (pendingSameWindowChatOpen) {
		return pendingSameWindowChatOpen;
	}
	const open = doOpenSameWindowChat(accessor);
	pendingSameWindowChatOpen = open;
	try {
		await open;
	} finally {
		if (pendingSameWindowChatOpen === open) {
			pendingSameWindowChatOpen = undefined;
		}
	}
}

async function openAgentWindow(accessor: ServicesAccessor): Promise<void> {
	if (pendingAgentWindowOpen) {
		return pendingAgentWindowOpen;
	}
	const open = doOpenAgentWindow(accessor);
	pendingAgentWindowOpen = open;
	try {
		await open;
	} finally {
		if (pendingAgentWindowOpen === open) {
			pendingAgentWindowOpen = undefined;
		}
	}
}

/**
 * The same-window "Chat" titlebar door. Opens the full-height chat surface in
 * this window without spawning a companion workbench window.
 */
export class OpenWorkspaceInAgentsWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID,
			title: localize2('openWorkspaceInAgentsWindow', "Chat"),
			category: CHAT_CATEGORY,
			precondition: OPEN_AGENTS_WINDOW_PRECONDITION,
			f1: true,
			menu: [{
				id: MenuId.ChatTitleBarMenu,
				group: 'c_sessions',
				order: 1,
				when: OPEN_AGENTS_WINDOW_PRECONDITION,
			}, {
				id: MenuId.TitleBar,
				group: TitleBarLeadingActionsGroup,
				// Keep Chat available while the companion Agents entry is hidden.
				order: -1000,
				when: OPEN_AGENTS_WINDOW_PRECONDITION,
			}]
		});
	}

	async run(accessor: ServicesAccessor) {
		accessor.get(ILogService).info('[V3 Chat] Chat titlebar action run');
		await openSameWindowChat(accessor);
	}
}

/**
 * The companion "Agents" window door. Opens/focuses the Agents window (with its
 * native panel shell) and hides this IDE behind it. Also bound to Cmd/Ctrl+Shift+A.
 */
export class OpenAgentsWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENTS_WINDOW_COMMAND_ID,
			title: localize2('openAgentsWindow', "Agents"),
			category: CHAT_CATEGORY,
			precondition: OPEN_AGENTS_WINDOW_PRECONDITION,
			f1: true,
			keybinding: [{
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(IsSessionsWindowContext.toNegated(), CONTEXT_ACCESSIBILITY_MODE_ENABLED.toNegated()),
			}, {
				// In screen reader mode, Cmd/Ctrl+Shift+A conflicts with many screen reader keybindings,
				// so require an additional Alt modifier.
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(IsSessionsWindowContext.toNegated(), CONTEXT_ACCESSIBILITY_MODE_ENABLED),
			}],
			// The companion panel is not ready for the public titlebar. Keep its
			// command and shortcut available without advertising a top-bar button.
		});
	}

	async run(accessor: ServicesAccessor) {
		accessor.get(ILogService).info('[Agent Workspace] Agents titlebar/command action run');
		await openAgentWindow(accessor);
	}
}

/**
 * Shared base for the two labelled titlebar doors. A visible word is more
 * discoverable than a bare glyph, and keeping both buttons on the same widget
 * shape lets them sit flush next to each other in the titlebar.
 */
abstract class AgentDoorTitleBarWidget extends BaseActionViewItem {

	protected abstract readonly hoverText: string;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@ILogService protected readonly logService: ILogService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('open-in-agents-titlebar-widget');
		container.setAttribute('role', 'button');

		container.setAttribute('aria-label', this.hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, this.hoverText));

		const labelEl = append(container, $('span.open-in-agents-titlebar-widget-label'));
		labelEl.textContent = this.action.label;
	}

	override onClick(event: EventLike, preserveFocus = false): void {
		this.logService.info(`[Agent Workspace] titlebar click id=${this.action.id} enabled=${this.action.enabled}`);
		super.onClick(event, preserveFocus);
	}
}

/** The same-window "Chat" titlebar button. */
class OpenWorkspaceInAgentsTitleBarWidget extends AgentDoorTitleBarWidget {
	protected readonly hoverText = localize('openInAgentsHover',
		"Chat\n\nOpen V3Code's full-screen chat. You can start without a project and attach one later when the agent needs files.");
}

/** The companion-window "Agents" titlebar button, sitting left of Chat. */
class OpenAgentsWindowTitleBarWidget extends AgentDoorTitleBarWidget {
	protected readonly hoverText = localize('openAgentsWindowHover',
		"Agents\n\nOpen the Agents window. Your IDE hides while you work in Agents and comes back when you switch to IDE.");
}

export class OpenWorkspaceInAgentsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openWorkspaceInAgents.desktop';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBar, OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID, (action, options) => {
			return instantiationService.createInstance(OpenWorkspaceInAgentsTitleBarWidget, action, options);
		}, undefined));
		this._register(actionViewItemService.register(MenuId.TitleBar, OPEN_AGENTS_WINDOW_COMMAND_ID, (action, options) => {
			return instantiationService.createInstance(OpenAgentsWindowTitleBarWidget, action, options);
		}, undefined));
	}
}
