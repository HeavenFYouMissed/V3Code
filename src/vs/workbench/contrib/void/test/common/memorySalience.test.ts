/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { salience, matchesActive, SalienceFact } from '../../common/memory/salience.js';

suite('memory salience ranker (catalog C5)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DAY = 24 * 60 * 60 * 1000;
	const NOW = 1_000_000_000_000;
	const base: SalienceFact = {
		subject: 'src/a.ts', tsLast: NOW, confidence: 0.5,
		source: 'ai_inferred', verifiedByTest: false, lastUsedAt: NOW, useCount: 1,
	};

	test('matchesActive: exact + loose containment', () => {
		assert.ok(matchesActive('src/a.ts', { files: ['src/a.ts'] }));
		assert.ok(matchesActive('src/a.ts::Foo', { symbols: ['Foo'] }));
		assert.ok(matchesActive('src/a.ts', { files: ['a.ts'] })); // loose
		assert.ok(!matchesActive('src/a.ts', { files: ['other.ts'] }));
		assert.ok(!matchesActive('src/a.ts', undefined));
	});

	test('active-task match boosts salience', () => {
		const off = salience(base, undefined, NOW);
		const on = salience(base, { files: ['src/a.ts'] }, NOW);
		assert.ok(on > off, 'a fact about an active file ranks higher');
	});

	test('verified / human bonus raises salience above plain AI', () => {
		const ai = salience({ ...base, source: 'ai_inferred', verifiedByTest: false }, undefined, NOW);
		const verified = salience({ ...base, verifiedByTest: true }, undefined, NOW);
		const human = salience({ ...base, source: 'human' }, undefined, NOW);
		assert.ok(verified > ai);
		assert.ok(human > ai);
	});

	test('evergreen (human) does not decay with age; AI does', () => {
		const old = NOW - 365 * DAY;
		const aiOld = salience({ ...base, tsLast: old, source: 'ai_inferred' }, undefined, NOW);
		const humanOld = salience({ ...base, tsLast: old, source: 'human' }, undefined, NOW);
		assert.ok(humanOld > aiOld, 'a year-old human fact still beats a year-old AI fact');
	});

	test('staleness: long-unused ranks below recently-used (else equal)', () => {
		const fresh = salience({ ...base, lastUsedAt: NOW, useCount: 1 }, undefined, NOW);
		const stale = salience({ ...base, lastUsedAt: NOW - 60 * DAY, useCount: 1 }, undefined, NOW);
		assert.ok(fresh > stale);
	});

	test('brand-new never-surfaced fact is not unfairly buried vs just-surfaced', () => {
		const neverUsed = salience({ ...base, lastUsedAt: 0, useCount: 0, tsLast: NOW }, undefined, NOW);
		const usedNow = salience({ ...base, lastUsedAt: NOW, useCount: 0, tsLast: NOW }, undefined, NOW);
		assert.ok(Math.abs(neverUsed - usedNow) < 1e-9);
	});

	test('never-surfaced old fact ranks below recently-surfaced', () => {
		const neverSurfacedOld = salience({ ...base, lastUsedAt: 0, tsLast: NOW - 60 * DAY }, undefined, NOW);
		const surfacedOnce = salience({ ...base, lastUsedAt: NOW - 2 * DAY, tsLast: NOW - 60 * DAY, useCount: 1 }, undefined, NOW);
		assert.ok(surfacedOnce > neverSurfacedOld);
	});

	test('off-topic evergreen fact ranks below an in-context fact (active gates the whole score)', () => {
		// A high-confidence verified fact about a file we are NOT touching must not crowd the
		// budget against an ordinary fact about the file we ARE working on. Before active gated
		// the whole relevance term these tied; now the in-context fact wins ("push minimum").
		const ctx = { files: ['src/a.ts'] };
		const inContext = salience({ ...base, subject: 'src/a.ts', confidence: 0.5, source: 'ai_inferred', verifiedByTest: false }, ctx, NOW);
		const offTopicEvergreen = salience({ ...base, subject: 'src/z.ts', confidence: 0.9, source: 'human', verifiedByTest: true }, ctx, NOW);
		assert.ok(inContext > offTopicEvergreen, 'the fact about the active file outranks an off-topic evergreen fact');
	});

	test('combined: active verified-human beats stale low-confidence AI', () => {
		const star = salience({ subject: 'src/a.ts', tsLast: NOW, confidence: 0.9, source: 'human', verifiedByTest: true, lastUsedAt: NOW, useCount: 5 }, { files: ['src/a.ts'] }, NOW);
		const noise = salience({ subject: 'src/z.ts', tsLast: NOW - 90 * DAY, confidence: 0.3, source: 'ai_inferred', verifiedByTest: false, lastUsedAt: NOW - 90 * DAY, useCount: 0 }, { files: ['src/a.ts'] }, NOW);
		assert.ok(star > noise);
	});
});
