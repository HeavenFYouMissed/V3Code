/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	fallbackVoiceMemoryCapsule,
	parseVoiceMemoryCapsule,
	sanitizeVoiceMemoryTurns,
	voiceMemoryCapsuleBriefing,
} from '../../common/v3codeVoiceMemory.js';

suite('V3 Voice memory', () => {
	test('writes an immediate bounded local fallback with conservative signals', () => {
		const capsule = fallbackVoiceMemoryCapsule(undefined, [
			{ role: 'user', text: 'I prefer local-first memory. Let\'s do the managed compactor with a fallback.' },
			{ role: 'assistant', text: 'Got it. I will keep that as a confirmed design choice.' },
			{ role: 'user', text: 'Will it remember after I reopen voice?' },
		], 1234);
		assert.ok(capsule);
		assert.strictEqual(capsule.updatedAt, 1234);
		assert.strictEqual(capsule.sourceTurnCount, 3);
		assert.ok(capsule.preferences.some(item => item.includes('local-first')));
		assert.ok(capsule.decisions.some(item => item.includes('managed compactor')));
		assert.ok(capsule.openLoops.some(item => item.includes('reopen voice')));
	});

	test('next-session briefing carries summary, decisions, preferences, and open loops', () => {
		const capsule = parseVoiceMemoryCapsule({
			version: 1,
			summary: 'Daniel and V designed durable voice continuity.',
			preferences: ['Keep memory local-first.'],
			decisions: ['Use a structured capsule.'],
			activeThreads: ['V Voice memory'],
			openLoops: ['Smoke close and reopen.'],
			topics: ['voice', 'memory'],
			updatedAt: 55,
			sourceTurnCount: 4,
		});
		assert.ok(capsule);
		const briefing = voiceMemoryCapsuleBriefing(capsule);
		assert.match(briefing, /durable voice continuity/);
		assert.match(briefing, /Keep memory local-first/);
		assert.match(briefing, /Use a structured capsule/);
		assert.match(briefing, /Smoke close and reopen/);
	});

	test('malformed managed output is rejected so the local fallback wins', () => {
		assert.strictEqual(parseVoiceMemoryCapsule({ version: 1, summary: 'missing arrays' }), undefined);
		assert.strictEqual(parseVoiceMemoryCapsule({
			version: 2,
			summary: 'wrong version',
			preferences: [], decisions: [], activeThreads: [], openLoops: [], topics: [],
		}), undefined);
	});

	test('transcript sanitization removes obvious credentials before cloud compaction', () => {
		const turns = sanitizeVoiceMemoryTurns([{
			role: 'user',
			text: `Do not remember sk-proj-${'x'.repeat(40)} ${'a'.repeat(2000)}`,
		}]);
		assert.strictEqual(turns.length, 1);
		assert.match(turns[0].text, /\[redacted secret\]/);
		assert.doesNotMatch(turns[0].text, /sk-proj-/);
		assert.ok(turns[0].text.length <= 900);
	});
});
