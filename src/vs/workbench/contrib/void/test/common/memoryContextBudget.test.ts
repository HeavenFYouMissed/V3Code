/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { historyTokenCap, historyCharCap, shouldElideToolResults, shouldCondense, workspaceMemoryBudgetTokens, autoContextTokenCap, autoContextCharCap, fitAutoContextItems, wireCharLimit, conservativeTokenBound, enforceWireTokenBudget, wireTokenBudget, TIGHT_BOUND_TRIGGER_FRACTION, WIRE_BOUND_MAX_PASSES, WireTrimHooks, historyBudgetWithTestCap, DEFAULT_HISTORY_BUDGET } from '../../common/memory/contextBudget.js';

suite('memory context budget (contract §3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('history token cap: floored small, headroom-scaled mid, ceiling-capped huge', () => {
		// [contextWindow, reservedOutputTokens] -> tokens of raw history allowed before condensing
		const caps = [
			historyTokenCap(8_000, 4_096),      // tiny model -> floor (6k)
			historyTokenCap(32_000, 4_096),     // 32k -> headroom-scaled
			historyTokenCap(200_000, 8_192),    // 200k -> headroom-scaled (~134k, near Anthropic's 150k)
			historyTokenCap(1_000_000, 32_000), // 1M -> 70% of its real input budget (~678k)
		];
		assert.deepStrictEqual(caps, [6_000, 19_533, 134_266, 677_600]);
	});

	test('cap is monotonic up to the ceiling', () => {
		assert.ok(historyTokenCap(64_000, 4_096) < historyTokenCap(256_000, 8_192));
		assert.ok(historyTokenCap(256_000, 8_192) <= historyTokenCap(2_000_000, 64_000)); // both hit/approach ceiling
	});

	test('char cap = token cap x chars/token', () => {
		assert.strictEqual(historyCharCap(200_000, 8_192, 4), 134_266 * 4);
	});

	test('stage gates: elide tool noise only at 92% (last resort), condense only when still over', () => {
		// Elision is a LAST RESORT now (0.92), not routine (was 0.6) — a normal working loop at 90% must
		// NOT trip it; only genuinely near-compaction (>92%) sheds tool bodies.
		assert.deepStrictEqual(
			[shouldElideToolResults(900, 1_000), shouldElideToolResults(950, 1_000)],
			[false, true]
		);
		assert.deepStrictEqual(
			[
				shouldCondense(2_000, 50, 1_000),    // over char budget, enough messages -> condense
				shouldCondense(500, 50, 1_000),      // under budget, few messages -> no
				shouldCondense(2_000, 5, 1_000),     // over budget but too few messages -> no
				shouldCondense(100, 1_300, 1_000),   // pathological message count backstop (>1200) -> condense
			],
			[true, false, false, true]
		);
	});

	test('compaction test cap: >0 lowers the trigger ceiling so a short conversation condenses; 0/undefined is byte-identical to production', () => {
		// TESTING override (v3code.chat.compaction.testCapTokens): at 4000 on a 200k model the
		// trigger math must fire on a ~16k-char history; off must return the very same config
		// object so production thresholds cannot drift.
		const capped = historyBudgetWithTestCap(4_000);
		const cappedCharCap = historyCharCap(200_000, 8_192, 4, capped);
		assert.deepStrictEqual(
			{
				cappedTokenCap: historyTokenCap(200_000, 8_192, capped),
				cappedCharCap,
				elideFiresOnShortChat: shouldElideToolResults(15_000, cappedCharCap),
				condenseFiresOnShortChat: shouldCondense(17_000, 12, cappedCharCap),
				offIsSameObject: historyBudgetWithTestCap(0) === DEFAULT_HISTORY_BUDGET,
				undefinedIsSameObject: historyBudgetWithTestCap(undefined) === DEFAULT_HISTORY_BUDGET,
				offCapIdentical: historyTokenCap(200_000, 8_192, historyBudgetWithTestCap(0)) === historyTokenCap(200_000, 8_192),
			},
			{
				cappedTokenCap: 4_000,
				cappedCharCap: 16_000,
				elideFiresOnShortChat: true,
				condenseFiresOnShortChat: true,
				offIsSameObject: true,
				undefinedIsSameObject: true,
				offCapIdentical: true,
			}
		);
	});

	test('workspace-memory (T2) budget scales up with the window, floored and capped', () => {
		const got = [8_000, 32_000, 200_000, 400_000, 1_000_000].map(w => workspaceMemoryBudgetTokens(w));
		assert.deepStrictEqual(got, [450, 450, 792, 1_200, 1_200]);
	});

	test('auto-context cap: headroom-bounded on small windows and never grows with huge model windows', () => {
		assert.deepStrictEqual(
			{
				tokens: [
					autoContextTokenCap(8_000, 4_096),      // tiny window -> half its 1.8k-token headroom
					autoContextTokenCap(32_000, 4_096),     // absolute 2.5k cap
					autoContextTokenCap(200_000, 8_192),    // absolute 2.5k cap
					autoContextTokenCap(1_000_000, 32_000), // still 2.5k: larger history must not enlarge ambient injection
				],
				chars: autoContextCharCap(200_000, 8_192, 4),
			},
			{ tokens: [900, 2_500, 2_500, 2_500], chars: 10_000 }
		);
	});

	test('wire char LIMIT is conservative: the 1,289,064-token incident payload now gets trimmed', () => {
		// Incident (2026-07): on a 1,048,576-token model the old final-trim allowance,
		// (window - reserved) x 4 = 4,177,920 chars, passed a payload the API measured at
		// 1,289,064 tokens (~3.24 chars/token on code) — a hard over-limit failure the trim
		// pass could never prevent. That exact payload must now be over the limit, and the
		// new allowance must fit the real window at the incident's measured density.
		const window = 1_048_576, reserved = 4_096;
		const oldAllowance = (window - reserved) * 4;   // 4,177,920 chars — sailed through untouched
		const incidentPayloadChars = oldAllowance;      // what actually went to the API
		const limit = wireCharLimit(window, reserved);
		const measuredCharsPerToken = oldAllowance / 1_289_064; // ~3.24
		assert.deepStrictEqual(
			{
				limit,
				previouslyPassed: incidentPayloadChars <= oldAllowance,
				nowTrimmed: incidentPayloadChars > limit,
				charsToTrim: incidentPayloadChars - limit,
				realTokensOfNewLimitFitWindow: Math.ceil(limit / measuredCharsPerToken) <= window,
				floorWhenInputBudgetIsZeroOrNegative: wireCharLimit(0, 4_096),
			},
			{
				limit: 3_342_336,                       // (window - reserved) x 3.2
				previouslyPassed: true,
				nowTrimmed: true,
				charsToTrim: 835_584,
				realTokensOfNewLimitFitWindow: true,    // ~1.03M real tokens < 1,048,576
				floorWhenInputBudgetIsZeroOrNegative: 5_000,
			}
		);
	});

	/** A one-string wire whose trim slices from the end — the pure stand-in for trimByWeight. */
	const makeFakeWire = (payload: string) => {
		let s = payload;
		let trimCalls = 0;
		const wire: WireTrimHooks = {
			totalChars: () => s.length,
			tokenBound: () => conservativeTokenBound(s),
			trim: charsToTrim => {
				trimCalls++;
				const cut = Math.min(Math.max(0, charsToTrim), s.length);
				if (cut === 0) { return false; }
				s = s.slice(0, s.length - cut);
				return true;
			},
		};
		return { wire, chars: () => s.length, calls: () => trimCalls };
	};

	test('conservative token bound: per-class densities (composition-aware, single scan)', () => {
		assert.deepStrictEqual(
			{
				empty: conservativeTokenBound(''),
				prose: conservativeTokenBound('The quick brown fox jumps over the lazy dog. '.repeat(100)),   // 4.5k chars: ws 900, letters 3500, punct 100
				cjk: conservativeTokenBound('好'.repeat(900)),                                                 // 0.9 chars/token floor + safety
				base64Blob: conservativeTokenBound('Zm9v'.repeat(1_000)),                                      // one 4k unbroken alnum run -> blob (2.0)
				digitsShortRuns: conservativeTokenBound('123 '.repeat(250)),                                   // digit chunking floor (2.0), ws merges
				punctSoupNotBlob: conservativeTokenBound('+/'.repeat(50)),                                     // long run but punct-dominated -> punct (1.4), NOT blob
				nonAsciiLatin: conservativeTokenBound('é'.repeat(90)),                                         // otherNonAscii 1.0
			},
			{
				empty: 0,
				prose: 1_776,             // ~2.5 chars/token effective — conservative vs real prose ~4.3
				cjk: 1_112,               // ceil(900 / 0.9 / 0.9)
				base64Blob: 2_223,        // ceil(4000 / 2.0 / 0.9)
				digitsShortRuns: 528,
				punctSoupNotBlob: 80,     // ceil(100 / 1.4 / 0.9) — stricter than blob's 2.0 would be
				nonAsciiLatin: 100,
			}
		);
	});

	test('final gate loop: CJK payload that PASSES the 3.2 check but exceeds the real window is trimmed to fit', () => {
		// 100k-token input budget. The 3.2 coarse allowance admits 320k chars; 200k CJK chars sail
		// through it — but tokenize at ~1/char, i.e. ~2x the window. The bound sees the composition
		// and the loop trims until it provably fits.
		const window = 104_096, reserved = 4_096;
		const budget = wireTokenBudget(window, reserved);                       // 100,000
		const coarseAllowance = wireCharLimit(window, reserved);                // 320,000 chars
		const payload = '界'.repeat(200_000);
		const { wire, chars, calls } = makeFakeWire(payload);
		const finalBound = enforceWireTokenBudget(wire, budget);
		assert.deepStrictEqual(
			{
				passedOldCoarseCheck: payload.length <= coarseAllowance,        // the old gate shipped this
				engagedBand: payload.length > coarseAllowance * TIGHT_BOUND_TRIGGER_FRACTION,
				finalBound,
				finalChars: chars(),
				fitsWindow: finalBound <= budget,
				trimPasses: calls(),
			},
			{
				passedOldCoarseCheck: true,
				engagedBand: true,
				finalBound: 99_999,
				finalChars: 80_999,       // even at a dense real ~1 token/char this now fits 100k
				fitsWindow: true,
				trimPasses: 1,
			}
		);
	});

	test('final gate loop: base64 blob that PASSES the 3.2 check but exceeds the real window is trimmed to fit', () => {
		// 250k chars of unbroken base64 pass the 320k coarse allowance but tokenize at ~2.5 chars/token
		// (~100k real tokens is only reached at ~250k chars IF prose — base64 hits it far earlier).
		const window = 104_096, reserved = 4_096;
		const budget = wireTokenBudget(window, reserved);
		const payload = 'Zm9v'.repeat(62_500); // 250,000 chars, one alnum run
		const { wire, chars, calls } = makeFakeWire(payload);
		const finalBound = enforceWireTokenBudget(wire, budget);
		assert.deepStrictEqual(
			{
				passedOldCoarseCheck: payload.length <= wireCharLimit(window, reserved),
				finalBound,
				finalChars: chars(),
				fitsWindow: finalBound <= budget,
				realTokensAtMeasuredDensityFit: Math.ceil(chars() / 2.5) <= budget, // ~72k real tokens
				trimPasses: calls(),
			},
			{
				passedOldCoarseCheck: true,
				finalBound: 100_000,
				finalChars: 179_999,
				fitsWindow: true,
				realTokensAtMeasuredDensityFit: true,
				trimPasses: 1,
			}
		);
	});

	test('final gate loop: normal prose inside the band is left untouched (bound fits, zero trims)', () => {
		// 193.5k chars of prose: above the 60% engage band (192k) but the composition-aware bound
		// (~76k tokens) fits the 100k window — the loop must not trim what actually fits.
		const window = 104_096, reserved = 4_096;
		const payload = 'The quick brown fox jumps over the lazy dog. '.repeat(4_300);
		const { wire, chars, calls } = makeFakeWire(payload);
		const finalBound = enforceWireTokenBudget(wire, wireTokenBudget(window, reserved));
		assert.deepStrictEqual(
			{
				engagedBand: payload.length > wireCharLimit(window, reserved) * TIGHT_BOUND_TRIGGER_FRACTION,
				oldCoarseCheckWouldTrim: payload.length > wireCharLimit(window, reserved),
				finalBound,
				untouchedChars: chars(),
				trimPasses: calls(),
			},
			{
				engagedBand: true,
				oldCoarseCheckWouldTrim: false,
				finalBound: 76_354,
				untouchedChars: 193_500,
				trimPasses: 0,
			}
		);
	});

	test('final gate loop terminates on pathological input (untrimmable wire; 1-char-per-pass progress)', () => {
		// (a) trim machinery that cannot remove anything: one attempt, then ship best effort.
		let stubbornCalls = 0;
		const stubbornBound = enforceWireTokenBudget({
			totalChars: () => 100,
			tokenBound: () => 1_000_000,
			trim: () => { stubbornCalls++; return false; },
		}, 1_000);
		// (b) adversarial machinery that only sheds 1 char per pass while staying over budget:
		// the pass cap bounds the loop.
		let len = 1_000_000;
		let slowCalls = 0;
		const slowBound = enforceWireTokenBudget({
			totalChars: () => len,
			tokenBound: () => len, // 1 token/char — stays far over budget
			trim: () => { slowCalls++; len -= 1; return true; },
		}, 1_000);
		assert.deepStrictEqual(
			{ stubbornBound, stubbornCalls, slowCallsCapped: slowCalls === WIRE_BOUND_MAX_PASSES, slowStillOver: slowBound > 1_000 },
			{ stubbornBound: 1_000_000, stubbornCalls: 1, slowCallsCapped: true, slowStillOver: true }
		);
	});

	test('auto-context fit: over-budget items dropped WHOLE in rank order, drop count reported (never silent)', () => {
		// 4k fits (2k left), 5k does not (dropped whole, never truncated), 900 still fits after it.
		const { kept, droppedCount } = fitAutoContextItems(['a'.repeat(4_000), 'b'.repeat(5_000), 'c'.repeat(900)], 6_000);
		assert.deepStrictEqual(
			{ keptLens: kept.map(s => s.length), droppedCount },
			{ keptLens: [4_000, 900], droppedCount: 1 }
		);
	});
});
