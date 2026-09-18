/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * User-invoked `/compact` — a high-fidelity, resume-from-here handoff summary (see
 * docs/V3CODE-COMPACT-DESIGN.md). This is a DIFFERENT artifact from the automatic rolling
 * digest (DIGEST_LLM_SYSTEM in convertToLLMMessageService): the digest is a cheap, frequent,
 * bounded background fact-sheet; this is a rare, strong-model, structured handoff that truly
 * replaces the earlier turns on the wire when the user asks for it.
 *
 * Everything here is PURE so it can be unit-tested headlessly (mirrors contextBudget.ts): the
 * prompt, the thread serializer fed to the summary model, the safe tail-boundary calc, and the
 * message-array rewrite. The editor service (chatThreadService) does the LLM call + persistence.
 */

import type { ChatMessage } from '../chatThreadServiceTypes.js';

/**
 * System prompt for the `/compact` summary turn. Runs on the user's MAIN model (rare + high
 * stakes → fidelity over cost). The schema is the one a summarizer produces for itself: an
 * <analysis> chronological walk (measurably better recall) then a <summary> with fixed sections.
 * Only the <summary> is kept on the wire afterwards.
 */
export const COMPACT_LLM_SYSTEM = `You are compacting a long coding-assistant conversation into a single high-fidelity handoff summary. The summary REPLACES the earlier turns, so the agent must be able to continue the work from your summary alone, without re-reading what came before.

Respond with TEXT ONLY. Do NOT call tools — tool calls will be rejected.

First write an <analysis> block: walk the conversation chronologically and note, for each phase, what was asked, what was done, what broke, and what is still open. This scratchpad forces recall of early details — do not skip it.

Then write a <summary> block containing these numbered sections, in order:

1. Primary Request and Intent — every explicit user request, quoted where pivotal. Capture how intent evolved; do not re-litigate settled decisions.
2. Key Technical Concepts — frameworks, patterns, architecture in play.
3. Files and Code — absolute paths touched or discussed, WHY each matters, and key function/class signatures (prefer signatures over prose).
4. Errors and Fixes — as PAIRS (what broke → how it was fixed), verbatim where possible, including user corrections.
5. Problem Solving — what was solved and how; open questions.
6. User Messages — list the user's messages verbatim-ish, in order. This is the highest-value section; it anchors intent so the agent does not drift.
7. Pending Tasks — what is explicitly still to do.
8. Current Work — precisely what was in flight at the moment of compaction (file, function, command).
9. Next Step — ONLY if it directly continues the most recent explicit request; quote the request. If unclear, say so rather than invent one.

Hard rules:
- Preserve security-critical constraints VERBATIM (exposed secrets to rotate, "never do X", "don't commit Y", auth/permission boundaries). These MUST survive compaction.
- Quote the user; do not paraphrase intent — paraphrase drifts.
- Keep file paths absolute and exact; record environment state that lives in no file (what is deployed, which migrations ran, what is logged in).
- Record errors AND their fixes together so the mistake is not repeated.
- Be detailed, not vague. Over-compression is the failure mode: aim for a thorough summary, not a terse one.
- Output ONLY the <analysis> and <summary> blocks. No preamble, no closing remarks.`;

/** Build the summary-turn system prompt, appending the user's `/compact <focus>` as extra guidance. */
export function buildCompactSystemPrompt(focus?: string): string {
	const f = focus?.trim();
	if (!f) { return COMPACT_LLM_SYSTEM; }
	return `${COMPACT_LLM_SYSTEM}\n\nAdditional instructions from the user for THIS compaction (weight these heavily — keep the detail they ask for):\n${f}`;
}

/**
 * Pull the <summary> block out of the model's reply (the <analysis> scratchpad is dropped — it
 * did its job improving recall and does not need to ride on the wire). Falls back to the whole
 * trimmed text if the model omitted the fence.
 */
export function extractCompactSummary(raw: string): string {
	const text = (raw ?? '').trim();
	if (!text) { return ''; }
	const m = text.match(/<summary>([\s\S]*?)<\/summary>/i);
	if (m) { return m[1].trim(); }
	// No closing tag but an opening one (truncated output): keep everything after it.
	const open = text.match(/<summary>([\s\S]*)$/i);
	if (open) { return open[1].trim(); }
	// Otherwise strip a leading <analysis>…</analysis> if present, keep the rest.
	return text.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim() || text;
}

// --- serialize the thread for the summary model ---

const clip = (s: string, n: number): string => {
	const t = (s ?? '').trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

const clipEnd = (s: string, n: number): string => {
	const t = (s ?? '').trim();
	if (t.length <= n) { return t; }
	return n <= 1 ? '…'.slice(0, n) : `…${t.slice(-(n - 1))}`;
};

const clipStart = (s: string, n: number): string => {
	const t = (s ?? '').trim();
	if (t.length <= n) { return t; }
	return n <= 1 ? '…'.slice(0, n) : `${t.slice(0, n - 1)}…`;
};

/** Bound the one-shot /compact input below a conservative large-model window. Per-message
 * clipping alone is not a total bound: thousands of small turns can still produce a provider
 * 400 or timeout. The bounded form always keeps the beginning and the newest exchanges, then
 * spends the remaining budget on evenly sampled middle evidence. */
export const COMPACT_INPUT_MAX_CHARS = 96_000;

/** One message → a compact labelled line for the summary model. Returns '' for non-content roles. */
function messageToText(m: ChatMessage, charCap: number): string {
	switch (m.role) {
		case 'user':
			return `[user] ${clip(m.content || m.displayContent, charCap)}`;
		case 'assistant': {
			const body = clip(m.displayContent, charCap);
			return body ? `[assistant] ${body}` : '';
		}
		case 'tool': {
			const result = typeof m.content === 'string' ? m.content : '';
			return `[tool:${m.name}] ${clip(result, Math.min(charCap, 400))}`;
		}
		case 'system_notification':
			return `[system] ${clip(m.content, charCap)}`;
		case 'compaction':
			// A prior compaction: fold its summary in so re-compacting stays cumulative.
			return `[earlier summary]\n${clip(m.content, 4_000)}`;
		default:
			// checkpoint, interrupted_streaming_tool — no textual content for the summary.
			return '';
	}
}

/**
 * Render the whole thread as tiered text: recent messages get a larger char budget than older
 * ones (the summary should be sharpest about what happened last). Pure.
 */
export function serializeThreadForCompaction(
	messages: ChatMessage[],
	opts: { recentCount?: number; recentCap?: number; olderCap?: number; maxChars?: number } = {},
): string {
	const recentCount = opts.recentCount ?? 12;
	const recentCap = opts.recentCap ?? 1_500;
	const olderCap = opts.olderCap ?? 500;
	const olderEnd = Math.max(0, messages.length - recentCount);
	const lines: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const cap = i < olderEnd ? olderCap : recentCap;
		const line = messageToText(messages[i], cap);
		if (line) { lines.push(line); }
	}
	const full = lines.join('\n\n');
	const maxChars = Math.max(1_000, Math.floor(opts.maxChars ?? COMPACT_INPUT_MAX_CHARS));
	if (full.length <= maxChars) { return full; }

	const headCount = Math.min(8, lines.length);
	const tailStart = Math.max(headCount, lines.length - Math.max(recentCount, 12));
	const headRaw = lines.slice(0, headCount).join('\n\n');
	const tailRaw = lines.slice(tailStart).join('\n\n');
	const middle = lines.slice(headCount, tailStart);
	const sampledMiddle: string[] = [];
	const sampleTarget = 40;
	const stride = Math.max(1, Math.ceil(middle.length / sampleTarget));
	for (let index = 0; index < middle.length; index += stride) {
		sampledMiddle.push(clip(middle[index], 300));
	}
	const middleRaw = sampledMiddle.join('\n\n');

	const headLabel = '=== CONVERSATION BEGINNING (preserved) ===\n';
	const middleLabel = `\n\n=== SAMPLED MIDDLE (${middle.length} messages; evenly sampled because /compact input was oversized) ===\n`;
	const tailLabel = '\n\n=== MOST RECENT EXCHANGES (preserved) ===\n';
	const labelChars = headLabel.length + middleLabel.length + tailLabel.length;
	const available = Math.max(1, maxChars - labelChars);
	const headBudget = Math.floor(available * 0.25);
	const middleBudget = Math.floor(available * 0.20);
	const tailBudget = available - headBudget - middleBudget;
	return `${headLabel}${clipStart(headRaw, headBudget)}${middleLabel}${clipStart(middleRaw, middleBudget)}${tailLabel}${clipEnd(tailRaw, tailBudget)}`;
}

// --- choose the raw tail to keep, then rewrite ---

/**
 * Where the preserved raw tail should begin. Targets the last `targetTail` messages but snaps the
 * boundary back to the nearest preceding `user` message so the tail starts at a clean exchange
 * boundary — never on an orphan tool result whose tool call was summarized away (which providers
 * reject). Pure; bounded search so it can't walk the whole thread.
 */
export function findCompactionTailStart(messages: ChatMessage[], targetTail: number): number {
	const n = messages.length;
	if (n === 0) { return 0; }
	let start = Math.max(0, n - targetTail);
	const floor = Math.max(0, start - targetTail); // don't walk back more than another tail's worth
	for (let i = start; i >= floor; i--) {
		if (messages[i].role === 'user') { return i; }
	}
	return start;
}

/**
 * Replace the summarized head of the thread with a single compaction marker, keeping the raw tail.
 * Returns the rewritten message array plus how many messages were dropped. If nothing can be
 * dropped (thread too short / tail covers everything) returns the input unchanged with droppedCount 0.
 * Pure — the caller persists the result and records the dropped turns to shadow/memory.
 */
export function buildCompactedMessages(
	messages: ChatMessage[],
	summary: string,
	opts: { focus?: string; timestamp: number; targetTail?: number },
): { messages: ChatMessage[]; droppedCount: number } {
	const targetTail = opts.targetTail ?? 6;
	const tailStart = findCompactionTailStart(messages, targetTail);
	if (tailStart <= 0 || !summary.trim()) {
		return { messages, droppedCount: 0 };
	}
	const marker: ChatMessage = {
		role: 'compaction',
		content: summary.trim(),
		droppedCount: tailStart,
		timestamp: opts.timestamp,
		...(opts.focus?.trim() ? { focus: opts.focus.trim() } : {}),
	};
	return {
		messages: [marker, ...messages.slice(tailStart)],
		droppedCount: tailStart,
	};
}
