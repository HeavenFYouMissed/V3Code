/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export function reviewDiffArgs(params: Record<string, unknown>): { base?: string; head?: string; path?: string } {
	const token = (key: string, pattern: RegExp): string | undefined => {
		const value = params[key];
		if (value === undefined || value === null || value === '') { return undefined; }
		if (typeof value !== 'string' || !pattern.test(value) || value.startsWith('-')) { throw new Error(`Invalid git diff ${key}`); }
		return value;
	};
	const base = token('base', /^[A-Za-z0-9_][A-Za-z0-9_./~-]*$/);
	const head = token('head', /^[A-Za-z0-9_][A-Za-z0-9_./~-]*$/);
	const path = token('path', /^[A-Za-z0-9_.][A-Za-z0-9_./ -]*$/);
	if (head && !base) { throw new Error('git diff head requires base'); }
	if (path?.split('/').includes('..')) { throw new Error('git diff path must stay inside the repository'); }
	return { base, head, path };
}

/** Bound structured output without returning invalid, sliced JSON. Preserve its newest tail. */
export function reviewChatTail<T extends { messages: unknown[]; partial: unknown }>(snapshot: T, maxChars: number, omitted: boolean): string {
	const result = { ...snapshot, messages: [...snapshot.messages], truncated: omitted };
	while (result.messages.length > 1 && JSON.stringify(result).length > maxChars) {
		result.messages.shift(); result.truncated = true;
	}
	if (JSON.stringify(result).length > maxChars) {
		// Keep a useful tail even when a single response or streaming partial is huge.
		const clip = (value: unknown, depth = 0): unknown => {
			if (depth > 6) { return '[Nested data omitted]'; }
			if (typeof value === 'string') { return value.length > 120 ? '[Earlier text omitted] ' + value.slice(-120) : value; }
			if (Array.isArray(value)) { return value.slice(-3).map(item => clip(item, depth + 1)); }
			if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).slice(0, 10).map(([key, item]) => [key, clip(item, depth + 1)])); }
			return value;
		};
		result.messages = result.messages.map(message => clip(message));
		result.partial = clip(result.partial);
		result.truncated = true;
	}
	if (JSON.stringify(result).length > maxChars) { result.partial = {}; }
	if (JSON.stringify(result).length > maxChars) { result.messages = []; }
	return JSON.stringify(result);
}

/** Deliberately does not await completion: a client RPC timeout cannot erase the job handle. */
export function acceptReviewJob(launch: { ok: false; error: string } | { ok: true; subagentThreadId: string; completion: Promise<unknown> }, onError: (error: unknown) => void): { job_id?: string; status: string; result: string } {
	if (!launch.ok) { return { status: 'failed', result: launch.error }; }
	void launch.completion.catch(onError);
	return { job_id: launch.subagentThreadId, status: 'accepted', result: 'Poll subagent_status/subagent_result with job_id. Acceptance is not completion.' };
}

export function reviewContextPreview(text: string | undefined): string { return (text ?? '').slice(0, 250); }
