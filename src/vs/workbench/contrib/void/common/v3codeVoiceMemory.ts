/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Provider-independent, bounded durable memory for V Voice.
 *
 * The Realtime model is deliberately replaceable. Continuity belongs to V3Code, not
 * to a provider conversation id, so every completed voice session folds into this
 * small capsule and the next provider receives the same compact briefing.
 */

export const V3_VOICE_MEMORY_VERSION = 1 as const;
export const MAX_VOICE_MEMORY_TURNS = 24;
export const MAX_VOICE_MEMORY_TURN_CHARS = 900;

export type V3VoiceMemoryTurn = Readonly<{
	role: 'user' | 'assistant';
	text: string;
}>;

export type V3VoiceMemoryCapsule = Readonly<{
	version: typeof V3_VOICE_MEMORY_VERSION;
	summary: string;
	preferences: readonly string[];
	decisions: readonly string[];
	activeThreads: readonly string[];
	openLoops: readonly string[];
	topics: readonly string[];
	updatedAt: number;
	sourceTurnCount: number;
}>;

const MAX_SUMMARY_CHARS = 1400;
const MAX_ITEM_CHARS = 280;
const MAX_ITEMS = 10;
const SECRET_PATTERNS: readonly RegExp[] = [
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]{8,}/gi,
	/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi,
];

export function sanitizeVoiceMemoryText(value: string, maxChars: number): string {
	let clean = value.replace(/\s+/g, ' ').trim();
	for (const pattern of SECRET_PATTERNS) {
		clean = clean.replace(pattern, '[redacted secret]');
	}
	return clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 1))}…` : clean;
}

function uniqueItems(values: readonly unknown[], maxItems = MAX_ITEMS): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') { continue; }
		const clean = sanitizeVoiceMemoryText(value, MAX_ITEM_CHARS);
		const key = clean.toLowerCase();
		if (!clean || seen.has(key)) { continue; }
		seen.add(key);
		output.push(clean);
		if (output.length >= maxItems) { break; }
	}
	return output;
}

export function sanitizeVoiceMemoryTurns(turns: readonly V3VoiceMemoryTurn[]): V3VoiceMemoryTurn[] {
	return turns
		.filter(turn => turn?.role === 'user' || turn?.role === 'assistant')
		.map(turn => ({ role: turn.role, text: sanitizeVoiceMemoryText(turn.text, MAX_VOICE_MEMORY_TURN_CHARS) }))
		.filter(turn => !!turn.text)
		.slice(-MAX_VOICE_MEMORY_TURNS);
}

export function parseVoiceMemoryCapsule(value: unknown): V3VoiceMemoryCapsule | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const candidate = value as Partial<V3VoiceMemoryCapsule>;
	if (candidate.version !== V3_VOICE_MEMORY_VERSION || typeof candidate.summary !== 'string') { return undefined; }
	if (!Array.isArray(candidate.preferences) || !Array.isArray(candidate.decisions)
		|| !Array.isArray(candidate.activeThreads) || !Array.isArray(candidate.openLoops)
		|| !Array.isArray(candidate.topics)) {
		return undefined;
	}
	const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
		? Math.max(0, candidate.updatedAt)
		: Date.now();
	const sourceTurnCount = typeof candidate.sourceTurnCount === 'number' && Number.isFinite(candidate.sourceTurnCount)
		? Math.max(0, Math.min(MAX_VOICE_MEMORY_TURNS, Math.floor(candidate.sourceTurnCount)))
		: 0;
	return {
		version: V3_VOICE_MEMORY_VERSION,
		summary: sanitizeVoiceMemoryText(candidate.summary, MAX_SUMMARY_CHARS),
		preferences: uniqueItems(candidate.preferences),
		decisions: uniqueItems(candidate.decisions),
		activeThreads: uniqueItems(candidate.activeThreads),
		openLoops: uniqueItems(candidate.openLoops),
		topics: uniqueItems(candidate.topics, 14),
		updatedAt,
		sourceTurnCount,
	};
}

function mergeItems(previous: readonly string[] | undefined, next: readonly string[]): string[] {
	return uniqueItems([...next, ...(previous ?? [])]);
}

function fallbackSignals(turns: readonly V3VoiceMemoryTurn[], pattern: RegExp): string[] {
	return uniqueItems(turns
		.filter(turn => turn.role === 'user' && pattern.test(turn.text))
		.map(turn => turn.text));
}

/**
 * Conservative, no-model fallback. It preserves only explicit user wording and a
 * short session handoff; it never upgrades guesses into durable facts.
 */
export function fallbackVoiceMemoryCapsule(
	previous: V3VoiceMemoryCapsule | undefined,
	turns: readonly V3VoiceMemoryTurn[],
	now = Date.now(),
): V3VoiceMemoryCapsule | undefined {
	const cleanTurns = sanitizeVoiceMemoryTurns(turns);
	if (!cleanTurns.some(turn => turn.role === 'user')) { return previous; }
	const recent = cleanTurns.slice(-8);
	const sessionSummary = sanitizeVoiceMemoryText(
		recent.map(turn => `${turn.role === 'user' ? 'User' : 'V'}: ${turn.text}`).join(' '),
		MAX_SUMMARY_CHARS,
	);
	const preferences = fallbackSignals(cleanTurns, /\b(?:i prefer|i like|i want|i do not want|i don't want)\b/i);
	const decisions = fallbackSignals(cleanTurns, /\b(?:we decided|i decided|let's do|we will|we're going to|go ahead)\b/i);
	const openLoops = uniqueItems(cleanTurns
		.filter(turn => turn.role === 'user' && /\?$/.test(turn.text.trim()))
		.map(turn => turn.text), 6);
	const topicWords = [...new Set(cleanTurns
		.filter(turn => turn.role === 'user')
		.flatMap(turn => turn.text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []))]
		.filter(word => !['that', 'this', 'with', 'have', 'what', 'when', 'where', 'would', 'could', 'should', 'about', 'there', 'their', 'then', 'just', 'like'].includes(word))
		.slice(0, 14);
	return {
		version: V3_VOICE_MEMORY_VERSION,
		summary: sessionSummary || previous?.summary || '',
		preferences: mergeItems(previous?.preferences, preferences),
		decisions: mergeItems(previous?.decisions, decisions),
		activeThreads: previous?.activeThreads ?? [],
		openLoops: mergeItems(previous?.openLoops, openLoops),
		topics: uniqueItems([...topicWords, ...(previous?.topics ?? [])], 14),
		updatedAt: now,
		sourceTurnCount: cleanTurns.length,
	};
}

export function voiceMemoryCapsuleBriefing(capsule: V3VoiceMemoryCapsule): string {
	const lines = [`Continuity summary: ${capsule.summary}`];
	const append = (label: string, values: readonly string[]) => {
		if (values.length) { lines.push(`${label}:\n${values.map(value => `- ${value}`).join('\n')}`); }
	};
	append('Confirmed preferences', capsule.preferences);
	append('Confirmed decisions', capsule.decisions);
	append('Active threads', capsule.activeThreads);
	append('Open loops', capsule.openLoops);
	return lines.join('\n');
}

export function voiceMemoryCapsuleSearchText(capsule: V3VoiceMemoryCapsule): string {
	return [
		capsule.summary,
		...capsule.preferences,
		...capsule.decisions,
		...capsule.activeThreads,
		...capsule.openLoops,
		...capsule.topics,
	].join(' ');
}
