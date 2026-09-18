/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

export type V3VoicePlanTodo = Readonly<{
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}>;

export type V3VoiceAgentEvent =
	| Readonly<{
		kind: 'plan';
		sessionResource: string;
		todos: readonly V3VoicePlanTodo[];
		merge: boolean;
	}>
	| Readonly<{
		kind: 'question';
		sessionResource: string;
		question: string;
		options: readonly string[];
	}>
	| Readonly<{
		kind: 'final';
		sessionResource: string;
		text: string;
		outcome: 'completed' | 'blocked' | 'question';
	}>;

type V3VoiceAgentEventSink = (event: V3VoiceAgentEvent) => void;
export type V3VoiceQuestionAnswerSource = 'voice' | 'click' | 'unknown';
export type V3VoiceQuestionAnswerResult = Readonly<{ accepted: boolean; message: string; source: V3VoiceQuestionAnswerSource }>;
type V3VoiceQuestionAnswerHandler = (choice: string, source: V3VoiceQuestionAnswerSource) => Omit<V3VoiceQuestionAnswerResult, 'source'>;

const STRUCTURED_OUTCOME_RES = [
	/<!--\s*V3VOICE_OUTCOME:\s*(completed|blocked|question)(?:\s*(?:[-:\u2014]\s*)?([^\n]*?))?\s*-->/i,
	/(?:^|\n)\s*OUTCOME:\s*(completed|blocked|question)(?:\s*(?:[-:\u2014]\s*)?([^\n]*))?\s*(?=\n|$)/i,
] as const;

function findStructuredOutcome(text: string): RegExpExecArray | undefined {
	for (const pattern of STRUCTURED_OUTCOME_RES) {
		const marker = pattern.exec(text);
		if (marker) {
			return marker;
		}
	}
	return undefined;
}

export type V3VoiceFinalResult = Readonly<{
	text: string;
	outcome: 'completed' | 'blocked' | 'question';
	structured: boolean;
}>;

/**
 * Prefer the agent's explicit control line and remove it from anything shown or
 * spoken to the user. Prose classification remains a compatibility fallback for
 * providers that fail to follow the relay contract.
 */
export function parseV3VoiceFinalResult(text: string, awaitingUserDecision = false): V3VoiceFinalResult {
	const marker = findStructuredOutcome(text);
	if (marker) {
		const outcome = marker[1].toLocaleLowerCase() as V3VoiceFinalResult['outcome'];
		const markerDetail = (marker[2] ?? '').replace(/\s+/g, ' ').trim();
		const visible = `${text.slice(0, marker.index)}\n${text.slice(marker.index + marker[0].length)}`.trim();
		return {
			text: visible || markerDetail || (outcome === 'completed' ? 'The work is complete.' : outcome === 'blocked' ? 'The agent is blocked.' : 'The agent needs your answer.'),
			outcome,
			structured: true,
		};
	}
	return { text: text.trim(), outcome: classifyV3VoiceFinalOutcome(text, awaitingUserDecision), structured: false };
}

export function classifyV3VoiceFinalOutcome(text: string, awaitingUserDecision = false): 'completed' | 'blocked' | 'question' {
	if (awaitingUserDecision) {
		return 'question';
	}
	const clean = text.replace(/\s+/g, ' ').trim();
	const marker = findStructuredOutcome(text);
	if (marker) {
		return marker[1].toLocaleLowerCase() as 'completed' | 'blocked' | 'question';
	}
	// A completed handoff often ends with "waiting on you" because the browser or
	// preview is ready for inspection. Completion stated up front wins over that
	// passive handoff language; genuine blockers still classify below.
	if (/^.{0,100}\b(?:i(?:'m| am) done|build (?:is )?complete|work (?:is )?complete|completed successfully|finished successfully)\b/i.test(clean)) {
		return 'completed';
	}
	return /\b(?:blocked|cannot continue|can(?:not|'t) proceed|need(?:s)? (?:your|a) (?:decision|approval|credential|access)|waiting (?:for|on) you)\b/i.test(clean)
		? 'blocked'
		: 'completed';
}

/** Match spoken A/B and ordinal answers without guessing when fuzzy labels collide. */
export function matchV3VoiceQuestionOption(rawChoice: string, labels: readonly string[]): number | undefined {
	const normalized = rawChoice.trim().toLocaleLowerCase().replace(/[.!?]+$/g, '');
	if (!normalized || labels.length === 0) {
		return undefined;
	}
	const aliases = [
		/^(?:a|option a|first|the first|one|option one|1)$/,
		/^(?:b|option b|second|the second|two|option two|2)$/,
	];
	for (let index = 0; index < Math.min(labels.length, aliases.length); index++) {
		if (aliases[index].test(normalized)) {
			return index;
		}
	}
	const exactIndex = labels.findIndex(label => label.trim().toLocaleLowerCase() === normalized);
	if (exactIndex >= 0) {
		return exactIndex;
	}
	if (normalized.length < 3) {
		return undefined;
	}
	const fuzzyMatches = labels
		.map((label, index) => ({ index, label: label.trim().toLocaleLowerCase() }))
		.filter(candidate => normalized.includes(candidate.label) || candidate.label.includes(normalized));
	return fuzzyMatches.length === 1 ? fuzzyMatches[0].index : undefined;
}

const sinks = new Map<string, Set<V3VoiceAgentEventSink>>();
const questionAnswerHandlers = new Map<string, V3VoiceQuestionAnswerHandler>();

/**
 * Bind one visible V surface to one native chat session. The binding exists only
 * while the overlay is open, so background chats and other windows cannot leak
 * their task events into the selected voice conversation.
 */
export function registerV3VoiceAgentEventSink(sessionResource: string, sink: V3VoiceAgentEventSink): IDisposable {
	let sessionSinks = sinks.get(sessionResource);
	if (!sessionSinks) {
		sessionSinks = new Set();
		sinks.set(sessionResource, sessionSinks);
	}
	sessionSinks.add(sink);
	return toDisposable(() => {
		sessionSinks?.delete(sink);
		if (sessionSinks?.size === 0) {
			sinks.delete(sessionResource);
		}
	});
}

/** Publish a bounded, user-facing milestone. Raw tool calls never enter this bus. */
export function publishV3VoiceAgentEvent(event: V3VoiceAgentEvent): void {
	for (const sink of sinks.get(event.sessionResource) ?? []) {
		sink(event);
	}
}

/** Register the single native ask_user confirmation currently blocking a chat. */
export function registerV3VoiceQuestionAnswerHandler(sessionResource: string, handler: V3VoiceQuestionAnswerHandler): IDisposable {
	questionAnswerHandlers.set(sessionResource, handler);
	return toDisposable(() => {
		if (questionAnswerHandlers.get(sessionResource) === handler) {
			questionAnswerHandlers.delete(sessionResource);
		}
	});
}

/** Route a spoken answer into the exact native confirmation that asked it. */
export function answerV3VoiceAgentQuestion(sessionResource: string, choice: string, source: V3VoiceQuestionAnswerSource = 'unknown'): V3VoiceQuestionAnswerResult {
	const handler = questionAnswerHandlers.get(sessionResource);
	const result = handler
		? handler(choice, source)
		: { accepted: false, message: 'The main agent is not waiting for a decision.' };
	return { ...result, source };
}
