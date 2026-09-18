/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * LLM stream stall watchdog — one place for renderer-side stall detection.
 *
 * Upstream reference (microsoft/vscode main, researched 2026-06):
 * - `chatStreamStats.ts` — UI rendering-rate estimate only; does NOT abort LLM requests.
 * - `chatServiceImpl.cancelCurrentRequestForSession` — 1s race when user hits Stop.
 * - Copilot `networking.ts` — 30s HTTP fetch timeout + CancellationToken → abort; no browser
 *   inactivity timer on streaming chat.
 *
 * V3Code still needs stall detection (RC-2): a hung provider can leave sendLLMMessage silent
 * forever. This watchdog fires only on true silence (no streamed deltas for STALL_MS).
 * Reset via `touch()` on every sendLLMMessage `onText` (text, reasoning, and tool-arg deltas).
 * No absolute wall-clock cap here — Copilot does not kill long streams at the chat layer;
 * user Stop + per-tool timeouts in the agent loop cover wedged tools.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isLocalAgentProvider, localAgentRuntimeLimits } from '../common/localAgentRuntime.js';

/** Silence budget before aborting a stalled stream (resets on every onText delta). */
export const LLM_STREAM_STALL_MS = 120_000;

/**
 * Some lanes legitimately spend longer than the default silence budget before their first
 * streamed delta. Local runtimes can spend several minutes ingesting a cold prompt, while the
 * subscription CLI proxies may wait behind an upstream queue. Treating that work as a dead stream
 * is worse than waiting: the provider is healthy, but V3Code aborts it immediately before output.
 */
export const LLM_SLOW_FIRST_TOKEN_STALL_MS = 300_000;
export const LLM_COMPACT_LOCAL_STALL_MS = 90_000;
export const LLM_STANDARD_LOCAL_STALL_MS = 180_000;

const SLOW_FIRST_TOKEN_PROVIDERS = new Set([
	'claudePlan',
	'grokPlan',
	'geminiPlan',
	'copilot',
	'cursorLocal',
	'openaiPlan',
]);

export function llmStreamStallMs(providerName: string | undefined, modelName?: string): number {
	if (isLocalAgentProvider(providerName)) {
		const profile = localAgentRuntimeLimits(modelName).profile;
		if (profile === 'compact') { return LLM_COMPACT_LOCAL_STALL_MS; }
		if (profile === 'standard') { return LLM_STANDARD_LOCAL_STALL_MS; }
		return LLM_SLOW_FIRST_TOKEN_STALL_MS;
	}
	return providerName && SLOW_FIRST_TOKEN_PROVIDERS.has(providerName)
		? LLM_SLOW_FIRST_TOKEN_STALL_MS
		: LLM_STREAM_STALL_MS;
}

export class LlmStreamWatchdog extends Disposable {

	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	private _fired = false;

	constructor(
		private readonly onStall: () => void,
		private readonly stallMs = LLM_STREAM_STALL_MS,
	) {
		super();
	}

	/** (Re)arm the stall timer — call on every streamed delta. No-op once disposed or fired
	 *  so a late delta after the watchdog has already aborted doesn't create an orphan timer
	 *  (which would leak past the request's lifetime). */
	touch(): void {
		if (this._disposed || this._fired) { return; }
		if (this._timer) {
			clearTimeout(this._timer);
		}
		this._timer = setTimeout(() => {
			this._timer = undefined;
			if (this._disposed || this._fired) { return; }
			this._fired = true;
			this.onStall();
		}, this.stallMs);
	}

	/** First arm when the HTTP request is live. */
	arm(): void {
		this.touch();
	}

	override dispose(): void {
		this._disposed = true;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		super.dispose();
	}
}
