/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { explicitlyRequestsCurrentResearch } from '../../common/prompt/researchPreflight.js';

suite('Agent research preflight', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes direct current-research instructions', () => {
		assert.strictEqual(explicitlyRequestsCurrentResearch('Research the current state of Rapier WASM as of today.'), true);
		assert.strictEqual(explicitlyRequestsCurrentResearch('Search the web and use the latest documentation.'), true);
		assert.strictEqual(explicitlyRequestsCurrentResearch('Look this up before choosing the library.'), true);
	});

	test('does not gate ordinary implementation or repository investigation', () => {
		assert.strictEqual(explicitlyRequestsCurrentResearch('Inspect the repository and fix the calculator.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('Check the current file for type errors.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('Inspect the current state of this repository and summarize the chat renderer.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('Check the current state of the local model integration.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('Build a small browser game from this specification.'), false);
	});

	test('research as a NOUN never gates ordinary work', () => {
		// Regression: a bare \bresearch\b refused every mutating tool for users who merely
		// mentioned research as a subject, until they ran an unrelated web search.
		assert.strictEqual(explicitlyRequestsCurrentResearch('I do anti-cheat research, can you fix this bug in the parser.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('The research team wants this endpoint faster.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('My research paper build is broken, fix the makefile.'), false);
		assert.strictEqual(explicitlyRequestsCurrentResearch('His research was wrong.'), false);
		// "latest status" is a local question, not a dated external claim.
		assert.strictEqual(explicitlyRequestsCurrentResearch('Check the latest status of the build.'), false);
	});

	test('research as an INSTRUCTION still gates', () => {
		assert.strictEqual(explicitlyRequestsCurrentResearch('Research everything and make the edits.'), true);
		assert.strictEqual(explicitlyRequestsCurrentResearch('research the best charting libs'), true);
		assert.strictEqual(explicitlyRequestsCurrentResearch('research how oauth pkce works'), true);
		assert.strictEqual(explicitlyRequestsCurrentResearch('What is the latest version of vite?'), true);
	});
});
