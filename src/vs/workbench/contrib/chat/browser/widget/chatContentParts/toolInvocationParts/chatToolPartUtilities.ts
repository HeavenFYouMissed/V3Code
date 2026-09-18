/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createMarkdownCommandLink, IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../../../nls.js';
import { CollapsedToolsDisplayMode } from '../../../../common/constants.js';
import { ConfirmedReason, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';

export function isMcpToolInvocation(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): boolean {
	return toolInvocation.source?.type === 'mcp' || toolInvocation.toolId.toLowerCase().includes('mcp');
}

/**
 * Rich MCP Apps own an interactive renderer and must remain standalone. Plain/headless MCP
 * calls can join V3Code's rolling work group only in the explicit compact-all-grouped mode;
 * the caller still applies the normal streaming and confirmation-state checks afterward.
 */
export function shouldKeepMcpToolStandalone(
	toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
	collapsedToolsMode: CollapsedToolsDisplayMode,
): boolean {
	if (!isMcpToolInvocation(toolInvocation)) {
		return false;
	}

	const toolSpecificData = toolInvocation.toolSpecificData;
	const isRichMcpApp = toolSpecificData?.kind === 'input' && !!toolSpecificData.mcpAppData;
	return collapsedToolsMode !== CollapsedToolsDisplayMode.Always || isRichMcpApp;
}

/**
 * Determines whether a tool invocation's progress text should shimmer.
 * Every actively running tool shimmers. Question tools are intentionally still because
 * they are waiting on the user, not working in the background.
 */
export function shouldShimmerForTool(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): boolean {
	if (toolInvocation.toolId === 'copilot_askQuestions' || toolInvocation.toolId === 'vscode_askQuestions') {
		return false;
	}
	return !IChatToolInvocation.isComplete(toolInvocation);
}

/**
 * Creates a markdown message explaining why a tool was auto-approved.
 * @param toolInvocation The tool invocation to get the approval message for
 * @returns A markdown string with the approval message, or undefined if no message should be shown
 */
export function getToolApprovalMessage(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): IMarkdownString | undefined {
	const reason = IChatToolInvocation.executionConfirmedOrDenied(toolInvocation);
	if (!reason || typeof reason === 'boolean') {
		return undefined;
	}

	return getApprovalMessageFromReason(reason);
}

/**
 * Creates a markdown message from a ConfirmedReason explaining why a tool was auto-approved.
 * @param reason The confirmation reason
 * @returns A markdown string with the approval message, or undefined if no message should be shown
 */
export function getApprovalMessageFromReason(reason: ConfirmedReason): IMarkdownString | undefined {
	let md: string;
	switch (reason.type) {
		case ToolConfirmKind.Setting:
			md = localize('chat.autoapprove.setting', 'Auto approved by {0}', createMarkdownCommandLink({ text: '`' + reason.id + '`', id: 'workbench.action.openSettings', arguments: [reason.id], tooltip: localize('openSettings.tooltip', 'Open settings') }, false));
			break;
		case ToolConfirmKind.LmServicePerTool:
			md = reason.scope === 'session'
				? localize('chat.autoapprove.lmServicePerTool.session', 'Auto approved for this session')
				: reason.scope === 'workspace'
					? localize('chat.autoapprove.lmServicePerTool.workspace', 'Auto approved for this workspace')
					: localize('chat.autoapprove.lmServicePerTool.profile', 'Auto approved for this profile');
			md += ' (' + createMarkdownCommandLink({ text: localize('edit', 'Edit'), id: 'workbench.action.chat.editToolApproval', arguments: [reason.scope], tooltip: localize('editToolApproval.tooltip', 'Edit tool approval settings') }) + ')';
			break;
		case ToolConfirmKind.ConfirmationNotNeeded:
			if (reason.reason) {
				return typeof reason.reason === 'string'
					? new MarkdownString(reason.reason, { isTrusted: true })
					: reason.reason;
			}
			return undefined;
		case ToolConfirmKind.UserAction:
		case ToolConfirmKind.Denied:
		default:
			return undefined;
	}

	return new MarkdownString(md, { isTrusted: true });
}
