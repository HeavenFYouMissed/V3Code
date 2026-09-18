/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Prompt-cache clock.
 *
 * Every Anthropic request in a turn refreshes the 5-minute prompt cache, so the window
 * that matters to the user starts when the LAST request of a turn returns: from that
 * moment they have five minutes to send the next prompt and reuse the cached prefix
 * (tools + system prompt + history) at roughly a tenth of the input price. The agent
 * publishes turn-start / turn-end here; the native composer subscribes and renders a
 * countdown ("4:59") as grey ghost text in its top-right corner, clearing it the moment a
 * prompt is sent and re-arming it when the reply ends.
 *
 * A tiny module-level bus (not a service) so the chat contrib's composer can listen
 * without a dependency on the V3Code agent's instantiation; the pure helpers below are
 * what the tests cover.
 */

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** Anthropic's default ephemeral cache TTL; sendLLMMessage.impl.ts marks every breakpoint with it. */

/**
 * Providers whose prompt cache has a documented ~5-minute inactivity window, so the
 * countdown means something: Anthropic (explicit ephemeral breakpoints, 5m) and the Claude
 * subscription route that reuses the Anthropic sender; OpenAI's automatic prompt cache and
 * the ChatGPT subscription route (5-10 minutes of inactivity). Local and other providers
 * either have no cache or an undocumented window; showing "4:59" there would be noise.
 */
export function providerHasPromptCacheWindow(providerName: string): boolean {
	return providerName === 'anthropic' || providerName === 'claudePlan' || providerName === 'openAI' || providerName === 'openaiPlan';
}
export const V3_CACHE_WINDOW_MS = 5 * 60_000;

export interface V3CacheClockEvent {
	readonly kind: 'turn-start' | 'turn-end';
	/** `sessionResource.toString()` of the native chat session the turn belongs to. */
	readonly sessionKey: string;
	readonly at: number;
}

type Listener = (event: V3CacheClockEvent) => void;
const listeners = new Set<Listener>();

export function publishV3CacheClockEvent(event: V3CacheClockEvent): void {
	for (const listener of [...listeners]) {
		try { listener(event); } catch { /* a bad subscriber must not break the agent loop */ }
	}
}

export function subscribeV3CacheClock(listener: Listener): IDisposable {
	listeners.add(listener);
	return toDisposable(() => listeners.delete(listener));
}

/**
 * Fold one event into the countdown's armed-at timestamp for a given session:
 * turn-end for this session arms it, turn-start for this session clears it, other
 * sessions leave it untouched.
 */
export function applyCacheClockEvent(endedAt: number | null, event: V3CacheClockEvent, sessionKey: string): number | null {
	if (event.sessionKey !== sessionKey) { return endedAt; }
	return event.kind === 'turn-end' ? event.at : null;
}

/** Milliseconds of cache window left, never negative. */
export function cacheCountdownRemainingMs(endedAt: number, now: number, windowMs: number = V3_CACHE_WINDOW_MS): number {
	return Math.max(0, endedAt + windowMs - now);
}

/** "4:59" style, seconds rounded UP so the display starts at "5:00" and ends at "0:00". */
export function formatCacheCountdown(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}
