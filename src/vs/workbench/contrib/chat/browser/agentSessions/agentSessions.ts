/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import './media/v3AgentIcon.css';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { foreground, listActiveSelectionForeground, registerColor, transparent } from '../../../../../platform/theme/common/colorRegistry.js';
import { getChatSessionType } from '../../common/model/chatUri.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { isAgentHostTarget, SessionType } from '../../common/chatSessionsService.js';

export const v3AgentMark = registerIcon('v3-agent-mark', Codicon.commentDiscussion, localize('v3AgentMark', "V3Code agent"));
const externalAgentMarks = [1, 2, 3, 4].map(index => registerIcon(`v3-external-agent-${index}`, Codicon.plug, localize('externalAgentMark', "External agent")));

/** Registry provider IDs are integration data, not model-reported identities. */
export function getExternalAgentSessionIcon(provider: string): ThemeIcon | undefined {
	switch (provider.replace(/^agent-host-/, '')) {
		case 'acp-v3code-terminal': return v3AgentMark;
		case 'acp-claude-acp': return externalAgentMarks[0];
		case 'acp-grok-build': return externalAgentMarks[1];
		case 'acp-github-copilot-cli': return externalAgentMarks[2];
		case 'acp-codex-acp': return Codicon.openai;
		case 'acp-gemini': return externalAgentMarks[3];
		default: return undefined;
	}
}

export enum AgentSessionProviders {
	Local = SessionType.Local,
	Background = SessionType.CopilotCLI,
	Cloud = SessionType.CopilotCloud,
	Claude = SessionType.ClaudeCode,
	Codex = SessionType.Codex,
	Growth = SessionType.Growth,
	AgentHostCopilot = SessionType.AgentHostCopilot,
}

/**
 * A session target is either a well-known {@link AgentSessionProviders} enum
 * value or a dynamic string for dynamically-registered providers (e.g. remote
 * agent hosts like `remote-{authority}-copilot`).
 * TODO@roblourens HACK
 */
export type AgentSessionTarget = AgentSessionProviders | (string & {});

export function isBuiltInAgentSessionProvider(provider: AgentSessionTarget): boolean {
	return provider === AgentSessionProviders.Local ||
		provider === AgentSessionProviders.Background ||
		provider === AgentSessionProviders.Cloud ||
		provider === AgentSessionProviders.Claude;
}

export function getAgentSessionProvider(sessionResource: URI | string): AgentSessionProviders | undefined {
	const type = URI.isUri(sessionResource) ? getChatSessionType(sessionResource) : sessionResource;
	switch (type) {
		case AgentSessionProviders.Local:
		case AgentSessionProviders.Background:
		case AgentSessionProviders.Cloud:
		case AgentSessionProviders.Claude:
		case AgentSessionProviders.Codex:
		case AgentSessionProviders.AgentHostCopilot:
			return type;
		default:
			return undefined;
	}
}

export function getAgentSessionProviderName(provider: AgentSessionTarget): string {
	switch (provider) {
		case AgentSessionProviders.Local:
			return localize('chat.session.providerLabel.local', "Local");
		case AgentSessionProviders.Background:
			return localize('chat.session.providerLabel.background', "V3Code Agent");
		case AgentSessionProviders.Cloud:
			return localize('chat.session.providerLabel.cloud', "Cloud");
		case AgentSessionProviders.Claude:
			return 'Claude';
		case AgentSessionProviders.Codex:
			return 'Codex';
		case AgentSessionProviders.Growth:
			return 'Growth';
		case AgentSessionProviders.AgentHostCopilot:
			return 'V3Code Agent [Local]';
		default:
			return provider;
	}
}

export function getAgentSessionProviderIcon(provider: AgentSessionTarget): ThemeIcon {
	switch (provider) {
		case AgentSessionProviders.Local:
			/* Chat bubble — not the ugly VM/monitor square */
			return Codicon.commentDiscussion;
		case AgentSessionProviders.Background:
			return Codicon.sparkle;
		case AgentSessionProviders.Cloud:
			return Codicon.cloud;
		case AgentSessionProviders.Codex:
			return Codicon.openai;
		case AgentSessionProviders.Claude:
			return Codicon.claude;
		case AgentSessionProviders.Growth:
			return Codicon.lightbulb;
		case AgentSessionProviders.AgentHostCopilot:
			return v3AgentMark;
		default:
			return Codicon.extensions;
	}
}

/**
 * Returns the compact V3Code mark for sessions hosted in the editor.
 */
export function getAgentHostIcon(_productService: IProductService): ThemeIcon {
	return v3AgentMark;
}

export function isFirstPartyAgentSessionProvider(provider: AgentSessionTarget): boolean {
	switch (provider) {
		case AgentSessionProviders.Local:
		case AgentSessionProviders.Background:
		case AgentSessionProviders.Cloud:
		case AgentSessionProviders.AgentHostCopilot:
			return true;
		case AgentSessionProviders.Claude:
		case AgentSessionProviders.Codex:
		case AgentSessionProviders.Growth:
			return false;
		default:
			return false;
	}
}

/**
 * Re-exported from `common/chatSessionsService.ts` so existing browser-layer
 * callers keep working without changing imports.
 */
export { isAgentHostTarget };

export function getAgentCanContinueIn(provider: AgentSessionTarget): boolean {
	switch (provider) {
		case AgentSessionProviders.Local:
		case AgentSessionProviders.Background:
		case AgentSessionProviders.Cloud:
			return true;
		case AgentSessionProviders.Claude:
		case AgentSessionProviders.Codex:
		case AgentSessionProviders.Growth:
		case AgentSessionProviders.AgentHostCopilot:
			return false;
		default:
			return false;
	}
}

export function getAgentSessionProviderDescription(provider: AgentSessionTarget): string {
	switch (provider) {
		case AgentSessionProviders.Local:
			return localize('chat.session.providerDescription.local', "Run tasks within VS Code chat. The agent iterates via chat and works interactively to implement changes on your main workspace.");
		case AgentSessionProviders.Background:
			return localize('chat.session.providerDescription.background', "Delegate tasks to a background agent running locally on your machine. The agent iterates via chat and works asynchronously in a Git worktree to implement changes isolated from your main workspace using the V3Code Agent CLI.");
		case AgentSessionProviders.Cloud:
			return localize('chat.session.providerDescription.cloud', "Delegate tasks to the V3Code coding agent. The agent iterates via chat and works asynchronously in the cloud to implement changes and pull requests as needed.");
		case AgentSessionProviders.Claude:
			return localize('chat.session.providerDescription.claude', "Delegate tasks to the Claude Agent SDK using the Claude models included in your V3Code subscription. The agent iterates via chat and works interactively to implement changes on your main workspace.");
		case AgentSessionProviders.Codex:
			return localize('chat.session.providerDescription.codex', "Opens a new Codex session in the editor. Codex sessions can be managed from the chat sessions view.");
		case AgentSessionProviders.Growth:
			return localize('chat.session.providerDescription.growth', "Learn about V3Code features.");
		case AgentSessionProviders.AgentHostCopilot:
			return 'Run a V3Code agent in a dedicated process.';
		default:
			return '';
	}
}

export enum AgentSessionsViewerOrientation {
	Stacked = 1,
	SideBySide,
}

export enum AgentSessionsViewerPosition {
	Left = 1,
	Right,
}

export interface IAgentSessionsControl {

	readonly element: HTMLElement | undefined;

	refresh(): void;
	openFind(): void;

	reveal(sessionResource: URI): boolean;

	clearFocus(): void;
	hasFocusOrSelection(): boolean;

	resetSectionCollapseState(): void;
	collapseAllSections(): void;
}

export const agentSessionReadIndicatorForeground = registerColor(
	'agentSessionReadIndicator.foreground',
	{ dark: transparent(foreground, 0.2), light: transparent(foreground, 0.2), hcDark: null, hcLight: null },
	localize('agentSessionReadIndicatorForeground', "Foreground color for the read indicator in an agent session.")
);

export const agentSessionSelectedBadgeBorder = registerColor(
	'agentSessionSelectedBadge.border',
	{ dark: transparent(listActiveSelectionForeground, 0.3), light: transparent(listActiveSelectionForeground, 0.3), hcDark: foreground, hcLight: foreground },
	localize('agentSessionSelectedBadgeBorder', "Border color for the badges in selected agent session items.")
);

export const agentSessionSelectedUnfocusedBadgeBorder = registerColor(
	'agentSessionSelectedUnfocusedBadge.border',
	{ dark: transparent(foreground, 0.3), light: transparent(foreground, 0.3), hcDark: foreground, hcLight: foreground },
	localize('agentSessionSelectedUnfocusedBadgeBorder', "Border color for the badges in selected agent session items when the view is unfocused.")
);

export const AGENT_SESSION_RENAME_ACTION_ID = 'agentSession.rename';
export const AGENT_SESSION_DELETE_ACTION_ID = 'agentSession.delete';
