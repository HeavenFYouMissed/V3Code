/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Identity of a V3Code chat response, in two widths.
 *
 * `isV3TranscriptResponse` is the BROAD answer and the gate for the shared transcript craft —
 * step grouping, the live status line, per-card lifecycle state and the sheen. Every V3Code
 * mode renders through it, so Agent, Plan, Multitask and Debug all look like the same product
 * instead of Debug being the only polished one.
 *
 * `isV3DebugResponse` (sibling module) stays the NARROW answer for behaviour that is genuinely
 * Debug-only — the evidence sink, the suppress-the-native-working-indicator rule, and the
 * failure receipts.
 */

/**
 * Every mode name this editor's own picker owns: the four `ChatModeKind` values plus the two
 * named built-ins. This is the whole mode list — V3Code replaced the upstream picker outright —
 * so a response carrying one of these came from this editor.
 */
export const V3_TRANSCRIPT_MODE_NAMES: readonly string[] = ['ask', 'edit', 'agent', 'plan', 'multitask', 'debug'];

/** DOM hook the chat list renderer sets on a V3Code agent row; the transcript CSS scopes to it. */
export const V3_TRANSCRIPT_RESPONSE_CLASS = 'v3-transcript-response';

export interface IV3AgentIdentityLike {
	readonly id?: string;
	readonly extensionPublisherId?: string;
	readonly name?: string;
	readonly fullName?: string;
}

interface ITranscriptResponseLike {
	readonly model?: { readonly request?: { readonly modeInfo?: { readonly modeName?: string } } };
}

/**
 * True when an agent descriptor belongs to V3Code. This is the single source of truth: the chat
 * list renderer's own `isV3CodeAgent` delegates here, so the voice surface and the transcript
 * can never disagree about which rows are ours.
 */
export function isV3CodeAgentIdentity(agent: IV3AgentIdentityLike | undefined): boolean {
	if (!agent) {
		return false;
	}
	const id = agent.id ?? '';
	const publisher = agent.extensionPublisherId ?? '';
	const name = (agent.fullName || agent.name || '').toLowerCase();
	return id === 'v3code.agent'
		|| id.startsWith('v3code.')
		|| publisher === 'v3code'
		|| name.includes('v3code')
		|| name === 'v';
}

/** True when a persisted request mode name is one this editor owns. */
export function isV3TranscriptModeName(modeName: string | undefined): boolean {
	const lower = modeName?.toLowerCase();
	return !!lower && V3_TRANSCRIPT_MODE_NAMES.includes(lower);
}

const positiveCache = new WeakMap<object, true>();

/**
 * True for a response this editor rendered to one of its own modes — the gate for the shared
 * transcript craft.
 *
 * Two independent signals are accepted deliberately. The persisted `modeName` is proven (the
 * Debug predicate already resolves through it) and is what makes a reopened chat render
 * correctly, but it can be absent on a response that is still attaching. The agent identity is
 * the more robust signal but is likewise undefined until the request attaches. A row counts as
 * ours when EITHER says so, which is what keeps a live row from silently losing the craft
 * because one signal happened to be unavailable at that instant.
 *
 * Only positives are cached: a negative must stay re-evaluated, because "not yet attached" and
 * "not ours" are indistinguishable the first time and have opposite meanings the second.
 */
export function isV3TranscriptResponse(element: unknown): boolean {
	if (!element || typeof element !== 'object') {
		return false;
	}
	if (positiveCache.get(element)) {
		return true;
	}
	const like = element as ITranscriptResponseLike;
	const modeName = like.model?.request?.modeInfo?.modeName;
	const agent = (element as { agent?: IV3AgentIdentityLike }).agent;
	if (isV3TranscriptModeName(modeName) || isV3CodeAgentIdentity(agent)) {
		positiveCache.set(element, true);
		return true;
	}
	return false;
}
