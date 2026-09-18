/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ExposedToolDescriptor } from './mcpExposeTypes.js';
import { ToolJSONSchema } from '../prompt/toolContract.js';

export interface CollaborationRecord {
	id: string;
	project: string;
	actor: string;
	kind: 'memory' | 'task' | 'message';
	visibility: 'private' | 'project';
	revision: number;
	updated: number;
	payload: Record<string, unknown>;
}

export interface CollaborationSession {
	actor: string;
	project: string;
	label: string;
}

const text: ToolJSONSchema = { type: 'string' };
const integer: ToolJSONSchema = { type: 'integer', minimum: 0 };
function tool(name: string, description: string, properties: Record<string, ToolJSONSchema>, required: string[]): ExposedToolDescriptor {
	return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

// These are explicit operations, not instructions to treat historical content as authority.
export const LOCAL_COLLABORATION_TOOLS: ExposedToolDescriptor[] = [
	tool('list_projects', 'List connected editor windows and exact roots. Select a window before starting outside-agent work.', {}, []),
	tool('agent_session', 'Open an independent project notebook with window_id and label, or resume/revoke using session_token. Resume returns shared tasks, unread messages and recent notes. Keep the returned token private; it is a local notebook credential, not an editor chat ID.', {
		action: { enum: ['open', 'resume', 'revoke'] }, window_id: text, label: text, session_token: text,
	}, ['action']),
	tool('agent_memory', 'Save, search, read, delete or export outside-agent memory. Notes default to private; visibility=project shares with other agents and the editor. Save corrections using id and expected_revision. Writes require a unique request_id for safe retry. Search is local lexical retrieval, not proof a missing fact never existed.', {
		action: { enum: ['save', 'search', 'read', 'delete', 'export'] }, session_token: text, request_id: text,
		id: text, expected_revision: integer, revision: integer, query: text, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: integer,
		title: text, body: text, category: { enum: ['decision', 'discovery', 'failed-approach', 'checkpoint', 'verification'] },
		visibility: { enum: ['private', 'project'] }, evidence: text,
	}, ['action', 'session_token']),
	tool('agent_board', 'Shared project task board. Claim a task_id before editing; update with expected_revision to renew a lease, report a blocker or finish with evidence. Claims are atomic but file edits outside this board are NOT locked. Completion history persists. Read the board before overlapping work.', {
		action: { enum: ['list', 'claim', 'update'] }, session_token: text, request_id: text, task_id: text,
		expected_revision: integer, doing: text, where: text, evidence: text,
		status: { enum: ['running', 'blocked', 'waiting-approval', 'done', 'failed'] }, cursor: integer,
	}, ['action', 'session_token']),
	tool('agent_message', 'Send an addressed project message, read inbox, or acknowledge receipt. to is an actor ID from the board/session, not a display name. Messages persist across reconnects; delivery does not wake a stopped agent or grant authority. Writes require request_id.', {
		action: { enum: ['send', 'inbox', 'ack'] }, session_token: text, request_id: text, to: text, body: text,
		reply_to: text, id: text, cursor: integer,
	}, ['action', 'session_token']),
	tool('select_project', 'Switch the session-bound editor to an absolute folder (or add it). Shows a local confirmation and refuses dirty/busy windows. Requires session_token, path, mode and request_id. Does not discard work. Reopen a notebook for the new project after confirmed switching; index readiness is separate.', {
		session_token: text, path: text, mode: { enum: ['replace', 'add'] }, request_id: text,
	}, ['session_token', 'path', 'mode', 'request_id']),
	tool('project_operation', 'Read a durable workspace-switch receipt after reconnect or reload. Unconfirmed is not success: check list_projects and do not blindly repeat a switch.', { session_token: text, request_id: text }, ['session_token', 'request_id']),
];

export const LOCAL_COLLABORATION_NAMES = new Set(LOCAL_COLLABORATION_TOOLS.map(t => t.name));

export function boundedInteger(value: unknown, fallback: number, max: number): number {
	if (value === undefined) { return fallback; }
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) { throw new Error('Invalid integer argument'); }
	return value;
}

export function requiredText(args: Record<string, unknown>, key: string, max = 4000): string {
	const value = args[key];
	if (typeof value !== 'string' || !value.trim() || value.length > max) { throw new Error(`${key} must be non-empty text (at most ${max} characters)`); }
	return value.trim();
}

export function memoryTerms(query: string, maxTerms = 24): string[] {
	const stop = new Set(['the', 'a', 'an', 'is', 'it', 'to', 'of', 'and', 'or', 'we', 'was', 'what', 'where', 'how', 'why', 'for', 'in', 'on', 'with', 'did', 'this', 'that']);
	return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(t => t.length > 1 && !stop.has(t)))].slice(0, maxTerms);
}

/** A visible character budget, not a claim about a provider's exact tokenization. */
export function boundMcpText(value: string, maxChars: number): string {
	const cap = Math.max(256, Math.floor(maxChars));
	if (value.length <= cap) { return value; }
	const footer = '\n[TRUNCATED to response budget. Request a smaller symbol, precise file range, or next page; omitted text is not evidence of absence.]';
	const head = value.slice(0, cap - footer.length);
	const lastLine = head.lastIndexOf('\n');
	return (lastLine > head.length * 0.8 ? head.slice(0, lastLine) : head) + footer;
}
