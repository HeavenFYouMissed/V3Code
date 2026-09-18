/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export const enum MarshalledId {
	Uri = 1,
	Regexp,
	ScmResource,
	ScmResourceGroup,
	ScmProvider,
	CommentController,
	CommentThread,
	CommentThreadInstance,
	CommentThreadReply,
	CommentNode,
	CommentThreadNode,
	TimelineActionContext,
	NotebookCellActionContext,
	NotebookActionContext,
	TerminalContext,
	TestItemContext,
	Date,
	TestMessageMenuArgs,
	ChatViewContext,
	LanguageModelToolResult,
	LanguageModelTextPart,
	LanguageModelThinkingPart,
	LanguageModelPromptTsxPart,
	LanguageModelDataPart,
	AgentSessionContext,
	ChatResponsePullRequestPart,
}
