/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { URI } from '../../../../base/common/uri.js';
import { VoidFileSnapshot } from './editCodeServiceTypes.js';
import { AnthropicReasoning, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';

export type ImageAttachment = {
	data: string; // base64-encoded image data
	mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
	name?: string;
	/** Pre-computed text description (manual Describe button or prior run). */
	description?: string;
	/** Last describe attempt error for UI display. */
	describeError?: string;
};

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	mcpServerName: string | undefined; // the server name at the time of the call
	/** Vision payloads from tools such as screenshot_page (forwarded to the model on the next turn). */
	images?: ImageAttachment[];
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, }

		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, }  // params were validated, awaiting user

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
	) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };

	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };
	};
}


// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
export type ChatMessage =
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		images?: ImageAttachment[]; // attached images for vision models
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
			/** True while the agent is still running - message is queued (VS Code-style). */
			isQueued?: boolean;
		}
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
		geminiParts?: import('./sendLLMMessageTypes.js').GeminiResponsePart[];
		geminiCallIds?: string[];
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry
	| SystemNotification
	| CompactionMarker


// system notification — injected automatically when background work completes
export type SystemNotification = {
	role: 'system_notification';
	content: string;
	source: 'subagent' | 'terminal' | 'system';
	timestamp: number;
}


// conversation compaction marker — written by /compact. Replaces the earlier turns on the
// live wire with one high-fidelity structured summary (see docs/V3CODE-COMPACT-DESIGN.md). The
// summarized turns stay in the shadow archive (recoverable via deep_recall / get_shadow_record);
// only the wire is compacted. `content` is fed to the model as prior-conversation context.
export type CompactionMarker = {
	role: 'compaction';
	content: string; // the structured summary given to the LLM as continuity
	droppedCount: number; // number of earlier messages summarized away
	timestamp: number;
	focus?: string; // optional focus instruction the user passed to /compact
}


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
}


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null
