/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyCacheClockEvent, cacheCountdownRemainingMs, formatCacheCountdown, providerHasPromptCacheWindow, publishV3CacheClockEvent, subscribeV3CacheClock, V3_CACHE_WINDOW_MS } from '../../common/v3CacheClock.js';

suite('prompt-cache countdown clock', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turn-end arms, turn-start clears, other sessions are ignored', () => {
		const mine = 'vscode-chat://a';
		let endedAt: number | null = null;
		endedAt = applyCacheClockEvent(endedAt, { kind: 'turn-end', sessionKey: 'vscode-chat://other', at: 10 }, mine);
		assert.strictEqual(endedAt, null, 'another session must not arm my countdown');
		endedAt = applyCacheClockEvent(endedAt, { kind: 'turn-end', sessionKey: mine, at: 1000 }, mine);
		assert.strictEqual(endedAt, 1000);
		endedAt = applyCacheClockEvent(endedAt, { kind: 'turn-start', sessionKey: 'vscode-chat://other', at: 2000 }, mine);
		assert.strictEqual(endedAt, 1000, 'another session sending must not clear mine');
		endedAt = applyCacheClockEvent(endedAt, { kind: 'turn-start', sessionKey: mine, at: 3000 }, mine);
		assert.strictEqual(endedAt, null, 'sending a prompt resets the countdown');
		endedAt = applyCacheClockEvent(endedAt, { kind: 'turn-end', sessionKey: mine, at: 4000 }, mine);
		assert.strictEqual(endedAt, 4000, 'the reply ending re-arms it');
	});

	test('remaining time counts the 5-minute window from turn end and never goes negative', () => {
		assert.strictEqual(cacheCountdownRemainingMs(1000, 1000), V3_CACHE_WINDOW_MS);
		assert.strictEqual(cacheCountdownRemainingMs(1000, 1000 + 61_000), V3_CACHE_WINDOW_MS - 61_000);
		assert.strictEqual(cacheCountdownRemainingMs(1000, 1000 + V3_CACHE_WINDOW_MS + 5), 0);
	});

	test('formats m:ss, starting at 5:00 and ending at 0:00', () => {
		assert.strictEqual(formatCacheCountdown(V3_CACHE_WINDOW_MS), '5:00');
		assert.strictEqual(formatCacheCountdown(V3_CACHE_WINDOW_MS - 1000), '4:59');
		assert.strictEqual(formatCacheCountdown(V3_CACHE_WINDOW_MS - 1500), '4:59', 'partial seconds round up');
		assert.strictEqual(formatCacheCountdown(9_000), '0:09');
		assert.strictEqual(formatCacheCountdown(0), '0:00');
		assert.strictEqual(formatCacheCountdown(-50), '0:00');
	});

	test('only providers with a documented ~5-minute cache window get a countdown', () => {
		for (const p of ['anthropic', 'claudePlan', 'openAI', 'openaiPlan']) { assert.strictEqual(providerHasPromptCacheWindow(p), true, p); }
		for (const p of ['lmStudio', 'liteLLM', 'deepseek', 'gemini', 'xAI', 'mistral', 'cursorLocal', '']) { assert.strictEqual(providerHasPromptCacheWindow(p), false, p); }
	});

	test('bus delivers to subscribers, survives a throwing subscriber, and unsubscribes on dispose', () => {
		const seen: string[] = [];
		const bad = subscribeV3CacheClock(() => { throw new Error('boom'); });
		const good = subscribeV3CacheClock(e => seen.push(`${e.kind}:${e.sessionKey}`));
		publishV3CacheClockEvent({ kind: 'turn-end', sessionKey: 's', at: 1 });
		assert.deepStrictEqual(seen, ['turn-end:s']);
		good.dispose();
		bad.dispose();
		publishV3CacheClockEvent({ kind: 'turn-start', sessionKey: 's', at: 2 });
		assert.deepStrictEqual(seen, ['turn-end:s'], 'disposed subscriber receives nothing');
	});
});
