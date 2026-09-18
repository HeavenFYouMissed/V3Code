/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Stage-2 automatic condensation, extracted from convertToLLMMessageService into a pure,
 * headlessly testable module.
 *
 * Repairs carried by this extraction (compaction/task-lock work):
 * - The old permanent bare pin of the session's FIRST user message is gone as the default:
 *   when a durable task block is supplied it becomes the pinned head instead — a fenced,
 *  labeled, current record of the real task, not a stale imperative.
 * - The digest of dropped history is now embedded in the wire notice itself, so a mid-turn
 *   drop never leaves the wire without its digest (the old note falsely promised it was
 *   "on the latest turn" — it only re-appeared at the next round start).
 * - The fact sheet always carries the NEWEST dropped user message explicitly, so the live
 *   request can never be dropped without a trace (it used to be cut by the oldest-first
 *   12-bullet cap).
 *
 * Durable-before-drop is unchanged in spirit: `onCondense` reports how much of the
 * requested boundary is durably persisted, and only that prefix leaves the wire.
 */

import { TOOL_RESULT_ELIDE_OVER_CHARS, TOOL_RESULT_KEEP_RECENT } from './contextBudget.js';

/** The condense/elide passes only ever read `role` and `content` — keep the accepted shape
 *  minimal so tests can drive the real code with plain fixtures. */
type CondensableMessage = { role: string; content: string };

export const CONDENSE_PRESERVE_END = 16;
const CONDENSE_WIRE_DIGEST_MAX_CHARS = 2_000;
const FACTS_BULLET_MAX = 12;
const FACTS_USER_CHARS = 80;
const FACTS_ASSISTANT_CHARS = 60;
const NEWEST_USER_FACT_CHARS = 200;

/** Strip per-turn injected tails from a user message before digesting. The tag list is the
 *  service's own EPHEMERAL_USER_TAIL_RE, extended with <durable_task> (the new pinned task
 *  block rides the same tail). */
export const EPHEMERAL_USER_TAIL_RE = /\n\n<(?:CURRENT_ENVIRONMENT|CURRENT_TIME|ACTIVE_SUBSYSTEM_SYMBOLS|AUTO_CODEBASE_CONTEXT|BROWSER_PAGES|workspace_memory|editorial_memory|active_plan|session_digest|active_skills|durable_task)>/;

export const stripEphemeralUserTail = (content: string): string =>
	content.split(EPHEMERAL_USER_TAIL_RE)[0].trim();

/** Tier dropped middle for the optional LLM fold: recent exchanges keep detail, older
 *  turns compress to fact bullets. */
export const tierMiddleTextForSummary = (middleMessages: { role: string; content: string }[]): string => {
	const strip = (c: string) => stripEphemeralUserTail(c);
	const recentN = 4;
	if (middleMessages.length <= recentN) {
		return middleMessages.map(m => `[${m.role}] ${strip(m.content).slice(0, 800)}`).join('\n\n');
	}
	const older = middleMessages.slice(0, -recentN);
	const recent = middleMessages.slice(-recentN);
	const olderBlock = older.map(m => `[${m.role}] ${strip(m.content).slice(0, 250)}`).join('\n');
	const recentBlock = recent.map(m => `[${m.role}] ${strip(m.content).slice(0, 600)}`).join('\n\n');
	return `=== RECENT (last ~2 exchanges) ===\n${recentBlock}\n\n=== OLDER (compress to flat fact bullets) ===\n${olderBlock}`;
};

export interface CondenseMiddleOptions {
	/** Rendered <durable_task> block. When present it REPLACES the legacy bare first-user
	 *  pin: the head becomes system + this fenced, freshly-rendered task record. */
	durableTaskBlock?: string;
	/** How many tail messages stay verbatim. */
	preserveEnd?: number;
	/** Durable-before-drop listener: returns how many of the requested middle messages are
	 *  already durably persisted and may leave the wire. */
	onCondense?: (digestText: string, droppedCount: number, middleText: string) => number;
}

export interface CondenseMiddleOutcome<T extends CondensableMessage> {
	messages: T[];
	/** True when a drop was applied to the wire. */
	acceptedDroppedCount: number;
	requestedDroppedCount: number;
	digestText: string;
	middleText: string;
}

function safeUserBoundaryBefore<T extends CondensableMessage>(messages: readonly T[], candidate: number, floor: number): number {
	for (let index = Math.min(candidate, messages.length - 1); index > floor; index--) {
		if (messages[index].role === 'user') return index;
	}
	return floor;
}

function digestForRange<T extends CondensableMessage>(messages: readonly T[], middleStart: number, middleEnd: number, durableTaskBlock: string): { digestText: string; middleText: string } {
	const taskId = /\btask (dt_[a-z0-9]+)\b/i.exec(durableTaskBlock)?.[1];
	let statusBlockSummary: string | null = null;
	for (let si = middleEnd - 1; si >= middleStart; si--) {
		const content = messages[si].content;
		if (content.includes('## Status') && content.includes('**Task:**') && taskId && content.includes(taskId)) {
			statusBlockSummary = content;
			break;
		}
	}

	const droppedCount = middleEnd - middleStart;
	const summaryParts: string[] = [
		`[Conversation condensed: ${droppedCount} messages — fact sheet below]`,
	];
	if (statusBlockSummary) {
		summaryParts.push(`Last known state:\n${statusBlockSummary.slice(0, 1000)}`);
	} else {
		const keyPoints: string[] = [];
		for (let si = middleStart; si < middleEnd; si++) {
			const m = messages[si];
			if (m.role === 'user' && m.content.length > 10) {
				const t = stripEphemeralUserTail(m.content);
				keyPoints.push(`- [user] ${t.slice(0, FACTS_USER_CHARS)}${t.length > FACTS_USER_CHARS ? '...' : ''}`);
			} else if (m.role === 'assistant' && m.content.length > 20) {
				keyPoints.push(`- [assistant] ${m.content.slice(0, FACTS_ASSISTANT_CHARS)}...`);
			}
		}
		if (keyPoints.length > 0) {
			summaryParts.push(`Dropped turns (facts only):\n${keyPoints.slice(0, FACTS_BULLET_MAX).join('\n')}`);
		}
		// The live request must never vanish tracelessly: when the newest dropped user
		// message isn't among the printed (oldest-first) bullets, carry it explicitly.
		for (let si = middleEnd - 1; si >= middleStart; si--) {
			const m = messages[si];
			if (m.role === 'user' && m.content.length > 10) {
				const t = stripEphemeralUserTail(m.content);
				const printed = `- [user] ${t.slice(0, FACTS_USER_CHARS)}`;
				if (!keyPoints.slice(0, FACTS_BULLET_MAX).some(bullet => bullet === printed || bullet === `${printed}...`)) {
					summaryParts.push(`Most recent dropped user message (do not lose it): "${t.slice(0, NEWEST_USER_FACT_CHARS)}${t.length > NEWEST_USER_FACT_CHARS ? '…' : ''}"`);
				}
				break;
			}
		}
	}

	return {
		digestText: summaryParts.join('\n\n'),
		middleText: tierMiddleTextForSummary(messages.slice(middleStart, middleEnd)),
	};
}

const DURABLE_TASK_BLOCK_RE = /\n*<durable_task>[\s\S]*?<\/durable_task>\n*/g;

function ensureOneDurableTaskBlock<T extends CondensableMessage>(messages: T[], durableTaskBlock: string): T[] {
	if (!durableTaskBlock) return messages;
	const next = messages.map(message => ({ ...message, content: message.content.replace(DURABLE_TASK_BLOCK_RE, '\n\n').trimEnd() })) as T[];
	for (let index = next.length - 1; index >= 0; index--) {
		if (next[index].role !== 'user') continue;
		const marker = next[index].content.indexOf('<task_kernel>');
		const turnMarker = next[index].content.indexOf('<current_turn>');
		const insertAt = marker >= 0 ? marker : (turnMarker >= 0 ? turnMarker : 0);
		next[index] = {
			...next[index],
			content: `${next[index].content.slice(0, insertAt)}${durableTaskBlock.trim()}\n\n${next[index].content.slice(insertAt)}`,
		};
		break;
	}
	return next;
}

export function condenseMiddle<T extends CondensableMessage>(messages: T[], options: CondenseMiddleOptions): CondenseMiddleOutcome<T> {
	const preserveEnd = options.preserveEnd ?? CONDENSE_PRESERVE_END;
	const durableTaskBlock = (options.durableTaskBlock ?? '').trim();
	// A durable task replaces the old permanent first-user pin. Before one exists, retain
	// that first user message as the last-resort authority instead of dropping every trace
	// of the conversation's origin.
	const middleStart = durableTaskBlock ? 1 : Math.min(2, messages.length);
	const requestedBoundary = safeUserBoundaryBefore(messages, messages.length - preserveEnd, middleStart);
	const requestedDroppedCount = requestedBoundary - middleStart;
	const empty: CondenseMiddleOutcome<T> = { messages, acceptedDroppedCount: 0, requestedDroppedCount: 0, digestText: '', middleText: '' };
	if (requestedDroppedCount <= 2) return empty;

	const requestedDigest = digestForRange(messages, middleStart, requestedBoundary, durableTaskBlock);
	// Durable-before-drop: the listener returns how much of this boundary already has a
	// persisted checkpoint. Newly-arrived history stays on the wire until a later pass.
	const reportedDurableCount = options.onCondense
		? Math.max(0, Math.min(requestedDroppedCount, Math.floor(options.onCondense(requestedDigest.digestText, requestedDroppedCount, requestedDigest.middleText))))
		: requestedDroppedCount;
	// A prior shorter checkpoint can land in the middle of a tool group. Round BACK to the
	// nearest user boundary; never claim or drop the larger raw prefix.
	const acceptedBoundary = safeUserBoundaryBefore(messages, middleStart + reportedDurableCount, middleStart);
	const acceptedDroppedCount = acceptedBoundary - middleStart;
	if (acceptedDroppedCount <= 0) {
		return { messages, acceptedDroppedCount: 0, requestedDroppedCount, digestText: requestedDigest.digestText, middleText: requestedDigest.middleText };
	}
	const acceptedDigest = acceptedDroppedCount === requestedDroppedCount
		? requestedDigest
		: digestForRange(messages, middleStart, acceptedBoundary, durableTaskBlock);

	// Anthropic mid-conversation system messages must immediately follow a user turn AND be
	// followed by assistant or end the array — so the notice rides on the first preserved
	// tail message. The digest now travels WITH the drop (bounded): the old text promised
	// "<session_digest> on the latest turn", which was false for the rest of the turn.
	const wireDigest = acceptedDigest.digestText.length > CONDENSE_WIRE_DIGEST_MAX_CHARS
		? `${acceptedDigest.digestText.slice(0, CONDENSE_WIRE_DIGEST_MAX_CHARS)}\n[...digest truncated — full text in workspace memory]`
		: acceptedDigest.digestText;
	const wireNote = `[Conversation condensed: ${acceptedDroppedCount} middle messages dropped from the live wire. The digest of the dropped turns follows — treat it as continuity of work already done, never as a new task list.]\n\n<session_digest>\n${wireDigest}\n</session_digest>`;
	const tail = messages.slice(acceptedBoundary);
	if (tail.length > 0) {
		tail[0] = { ...tail[0], content: `${wireNote}\n\n${tail[0].content}` };
	}
	const preservedHead = messages.slice(0, middleStart);
	const condensed = ensureOneDurableTaskBlock([...preservedHead, ...tail], durableTaskBlock);
	return {
		messages: condensed,
		acceptedDroppedCount,
		requestedDroppedCount,
		digestText: acceptedDigest.digestText,
		middleText: acceptedDigest.middleText,
	};
}

/**
 * Stage-1 elision, extracted verbatim from the service so the boundary arithmetic is
 * headlessly testable: the `keepRecent` NEWEST tool results always stay verbatim (the
 * active turn's data is never blanked); older tool results over `overChars` are replaced
 * by a bounded head plus a recovery pointer. Returns the same message count, always.
 */
export function elideOldToolResults<T extends CondensableMessage>(
	messages: T[],
	options?: { keepRecent?: number; overChars?: number; headChars?: number },
): { messages: T[]; elidedCount: number } {
	const keepRecent = options?.keepRecent ?? TOOL_RESULT_KEEP_RECENT;
	const overChars = options?.overChars ?? TOOL_RESULT_ELIDE_OVER_CHARS;
	const headChars = options?.headChars ?? 240;
	const next = [...messages];
	let toolSeen = 0;
	let elidedCount = 0;
	for (let i = next.length - 1; i >= 0; i--) {
		const m = next[i];
		if (m.role !== 'tool') { continue; }
		toolSeen++;
		if (toolSeen <= keepRecent || m.content.length <= overChars) { continue; }
		const head = m.content.slice(0, headChars).trimEnd();
		next[i] = { ...m, content: `${head}\n[tool output elided to protect live context — ${m.content.length} chars; recover full via deep_recall / get_shadow_record]` } as T;
		elidedCount++;
	}
	return { messages: next, elidedCount };
}
