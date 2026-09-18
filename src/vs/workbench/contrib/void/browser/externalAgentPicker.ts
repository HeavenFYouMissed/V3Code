/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IChatWidget, IChatWidgetService } from '../../chat/browser/chat.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { IChatSessionsService } from '../../chat/common/chatSessionsService.js';
import { getExternalAgentSessionIcon, v3AgentMark } from '../../chat/browser/agentSessions/agentSessions.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from '../../chat/browser/widget/input/chatInputPickerActionItem.js';
import { getChatSessionType, LocalChatSessionUri } from '../../chat/common/model/chatUri.js';
import { IExternalAgentsService } from '../common/externalAgentsService.js';
import { getExternalAgentPickerItems } from '../common/externalAgentPickerItems.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';

export const EXTERNAL_AGENT_PICKER_ID = 'v3code.externalAgents.pickChatAgent';

/** Selects the owner of a new chat, never transfers the current transcript. */
export class ExternalAgentPicker extends ChatInputPickerActionViewItem {
	constructor(
		action: MenuItemAction,
		private readonly widget: IChatWidget,
		private readonly position: 'sidebar' | 'editor',
		options: IChatInputPickerOptions,
		@IExternalAgentsService private readonly agents: IExternalAgentsService,
		@ICommandService private readonly commands: ICommandService,
		@IChatSessionsService private readonly sessions: IChatSessionsService,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@IV3CodeAccountService private readonly account: IV3CodeAccountService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(action, { actionProvider: { getActions: () => this.getActions() } }, options, actionWidgetService, keybindingService, contextKeyService, telemetryService);
		const refresh = () => { if (this.element) { this.renderLabel(this.element); } };
		this._register(widget.onDidChangeViewModel(refresh));
		this._register(agents.onDidChangeState(refresh));
		this._register(sessions.onDidChangeAvailability(refresh));
	}

	private get currentType(): string {
		return this.widget.viewModel ? getChatSessionType(this.widget.viewModel.sessionResource) : 'local';
	}

	private getActions(): IActionWidgetDropdownAction[] {
		const current = this.currentType;
		const state = this.agents.state;
		const actions: IActionWidgetDropdownAction[] = [{
			id: 'local', label: 'V3Code', icon: v3AgentMark, checked: current === 'local', enabled: true,
			category: { label: 'agents', order: 0, showHeader: false },
			description: current === 'local' ? localize('agentPicker.current', "Current") : undefined,
			tooltip: localize('agentPicker.newLocal', "Open a new V3Code chat; keep this conversation"),
			class: undefined,
			run: async () => {
				if (!this.widget.viewModel || this.currentType !== 'local') {
					await this.commands.executeCommand('workbench.action.chat.openNewChatSessionInPlace.local', this.position, false);
				}
			},
		}];
		// V3Code: restored built-in/legacy providers are not ACP catalogue entries.
		// Never silently label them local or replace their provider on reopen.
		if (current !== 'local' && !getExternalAgentPickerItems(state, current).some(entry => entry.checked)) {
			const identity = this.currentIdentity;
			actions.unshift({
				id: current, label: identity.name, icon: identity.icon, checked: true, enabled: true,
				category: { label: 'agents', order: 0, showHeader: false }, class: undefined,
				description: localize('agentPicker.current', "Current"), run: () => {},
				tooltip: localize('agentPicker.originalOwner', "This conversation belongs to {0}", identity.name),
			});
		}
		for (const entry of getExternalAgentPickerItems(state, current)) {
			const { type, reason } = entry;
			actions.push({
				id: type, label: entry.name, icon: getExternalAgentSessionIcon(type) ?? Codicon.plug,
				category: { label: 'agents', order: 0, showHeader: false },
				checked: entry.checked, enabled: entry.enabled, description: reason ?? (entry.checked ? localize('agentPicker.current', "Current") : undefined), class: undefined,
				tooltip: reason ?? localize('agentPicker.newExternal', "Open a new chat with {0}; keep this conversation", entry.name),
				run: async () => {
					if (this.currentType !== type && !reason) {
						await this.agents.openChat(entry.id, this.position, true);
					}
				},
			});
		}
		if (current === 'agent-host-claude') {
			actions.push({
				id: 'reconnect-claude', label: localize('agentPicker.reconnectClaude', "Reconnect Claude: sign in to V3Code"), icon: Codicon.account,
				category: { label: 'manage', order: 1, showHeader: false }, class: undefined, enabled: true,
				tooltip: localize('agentPicker.reconnectClaudeHint', "This original Claude host uses account authentication, not the ACP terminal login. Sign in, then retry in this chat."),
				run: () => this.account.signIn(),
			});
		}
		const setupEntry = state.catalogue.agents.find(entry => `agent-host-acp-${entry.id}` === current);
		if (setupEntry) {
			actions.push({
				id: 'setup-current', label: localize('agentPicker.setupCurrent', "Set up / sign in to {0}", setupEntry.name), icon: Codicon.terminal,
				category: { label: 'manage', order: 1, showHeader: false }, class: undefined, enabled: true,
				tooltip: localize('agentPicker.setupCurrentHint', "Configure the current agent without replacing this conversation"),
				run: () => this.agents.openSetupTerminal(setupEntry.id),
			});
		}
		if (current !== 'local' && this.widget.viewModel?.model.getRequests().length) {
			actions.push({
				id: 'continue-local', label: localize('agentPicker.continueLocal', "Continue in V3Code"), icon: v3AgentMark,
				category: { label: 'manage', order: 1, showHeader: false }, class: undefined, enabled: true,
				tooltip: localize('agentPicker.continueDraft', "Copy this conversation into a new unsent draft; keep the original chat"),
				run: async () => {
					const requests = this.widget.viewModel?.model.getRequests() ?? [];
					const transcript = requests.map(request => `User: ${request.message.text}\nAssistant: ${request.response?.response.toString() ?? ''}`).join('\n\n');
					const target = await this.widgets.openSession(LocalChatSessionUri.getNewSessionUri(), ACTIVE_GROUP, { pinned: true });
					target?.setInput(localize('agentPicker.contextDraft', "Continue from this conversation. This is historical context, not a transfer of the original agent's tools or session state.\n\n{0}", transcript));
					target?.focusInput();
				},
			});
		}
		actions.push({
			id: 'manage', label: localize('agentPicker.add', "Add agents"), icon: Codicon.plus,
			class: undefined, enabled: true, tooltip: localize('agentPicker.settings', "Open ACP agent settings"),
			category: { label: 'manage', order: 1, showHeader: false },
			run: () => this.agents.openSettings(),
		});
		return actions;
	}

	private get currentIdentity(): { name: string; icon: ThemeIcon } {
		const type = this.currentType;
		if (type === 'local') { return { name: 'V3Code', icon: v3AgentMark }; }
		const entry = this.agents.state.catalogue.agents.find(entry => `agent-host-acp-${entry.id}` === type);
		const contribution = this.sessions.getChatSessionContribution(type);
		const claude = type === 'agent-host-claude' || type === 'claude-code';
		return {
			name: entry?.name ?? contribution?.displayName ?? (claude ? 'Claude' : type),
			icon: getExternalAgentSessionIcon(type) ?? (claude ? Codicon.claude : ThemeIcon.isThemeIcon(contribution?.icon) ? contribution.icon : Codicon.plug),
		};
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const { name, icon } = this.currentIdentity;
		dom.reset(element, renderIcon(icon));
		this.setAriaLabelAttributes(element);
		const label = localize('agentPicker.label', "{0} — choose an agent for a new chat", name);
		element.setAttribute('aria-label', label);
		// The base action item owns the managed hover; a native title conflicts.
		element.removeAttribute('title');
		return null;
	}
}
