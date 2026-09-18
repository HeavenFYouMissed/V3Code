/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Native notice queue — the "board" a native chat session picks its messages up from.
 *
 * Background subagents (launch_subagent), the team board, and Multitask reconcile all
 * report back by injecting a system_notification into the PARENT thread of the legacy
 * thread store. A native chat parent (IChatService session, keyed by its sessionResource
 * URI) has no thread there, so those injections used to be dropped on the floor and the
 * parent never learned its workers had finished.
 *
 * This queue is the fallback: notices addressed to an unknown thread id are parked here
 * under that id, and the native agent drains them for its session key at two points -
 * right after each tool result while a turn is running (so a worker that finishes mid-turn
 * is seen immediately) and at the start of the next turn (so results that arrive while
 * the user is idle wait at the board, exactly like Multitask describes).
 *
 * Pure and synchronous so it can be tested without a workbench. Bounded so a key that is
 * never drained (a legacy thread that was deleted) cannot grow forever.
 */

export const MAX_NOTICES_PER_KEY = 20;
export const MAX_NOTICE_KEYS = 200;
export const MAX_NOTICE_CHARS = 8000;

export interface NativeNotice {
	readonly content: string;
	readonly source: 'subagent' | 'terminal' | 'system';
	readonly timestamp: number;
}

export class NativeNoticeQueue {
	private readonly _byKey = new Map<string, NativeNotice[]>();

	/** Number of notices waiting under `key`. */
	pending(key: string): number {
		return this._byKey.get(key)?.length ?? 0;
	}

	/** Park a notice for `key`. Oldest notices are dropped past MAX_NOTICES_PER_KEY; the
	 *  oldest KEY is dropped past MAX_NOTICE_KEYS (a key that is never drained is a thread
	 *  that no longer exists). Content is clipped to MAX_NOTICE_CHARS. */
	push(key: string, content: string, source: NativeNotice['source'], timestamp = Date.now()): void {
		let list = this._byKey.get(key);
		if (!list) {
			if (this._byKey.size >= MAX_NOTICE_KEYS) {
				const oldest = this._byKey.keys().next().value;
				if (oldest !== undefined) { this._byKey.delete(oldest); }
			}
			list = [];
			this._byKey.set(key, list);
		}
		const clipped = content.length > MAX_NOTICE_CHARS
			? `${content.slice(0, MAX_NOTICE_CHARS)}\n[notice clipped at ${MAX_NOTICE_CHARS} chars]`
			: content;
		list.push({ content: clipped, source, timestamp });
		if (list.length > MAX_NOTICES_PER_KEY) { list.splice(0, list.length - MAX_NOTICES_PER_KEY); }
	}

	/** Remove and return everything waiting under `key`, oldest first. */
	drain(key: string): NativeNotice[] {
		const list = this._byKey.get(key);
		if (!list || list.length === 0) { return []; }
		this._byKey.delete(key);
		return list;
	}

	/** Forget everything under `key` without delivering it (session closed). */
	clear(key: string): void {
		this._byKey.delete(key);
	}
}

/**
 * Render drained notices as one clearly delimited block. The delimiter matters: when the
 * block is appended to a tool result mid-turn, the model must not attribute a subagent's
 * report to whatever tool it just called.
 */
export function formatNativeNotices(notices: readonly NativeNotice[]): string {
	if (notices.length === 0) { return ''; }
	const body = notices.map(n => `- ${n.content}`).join('\n');
	const label = notices.length === 1 ? '1 background notice' : `${notices.length} background notices`;
	return `[AUTOMATED-SYSTEM-NOTICE: ${label} arrived (subagent results, team board, reconcile). These are NOT output of the tool above.]\n${body}\n[END-SYSTEM-NOTICE]`;
}
