/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildPromptPolishRequest, promptExpansionNeedsRetry, sanitizePromptPolishOutput } from '../../../../browser/widget/input/promptPolish.js';

suite('PromptPolish', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('request preserves the exact idea and asks for a substantive build brief', () => {
		const draft = 'Fix @src/app.ts #auth /tests -- keep API names unchanged.';
		const request = buildPromptPolishRequest(draft);
		assert.ok(request.includes('<source_idea>\n' + draft + '\n</source_idea>'));
		assert.ok(request.includes('Expand the idea substantially'));
		assert.ok(request.includes('acceptance criteria'));
		assert.ok(request.includes('Return only the finished downstream prompt'));
	});

	test('sanitizer removes common wrappers but preserves prompt content', () => {
		assert.strictEqual(
			sanitizePromptPolishOutput('```text\nFix src/app.ts and keep "Auth" unchanged.\n```'),
			'Fix src/app.ts and keep "Auth" unchanged.'
		);
		assert.strictEqual(
			sanitizePromptPolishOutput('Build brief: Keep /build and @agent exactly as written.'),
			'Keep /build and @agent exactly as written.'
		);
	});

	test('short ideas must expand beyond a light rewrite', () => {
		assert.strictEqual(promptExpansionNeedsRetry('Build a cool SaaS.', 'Build a polished, cool SaaS application.'), true);
		assert.strictEqual(promptExpansionNeedsRetry(
			'Build a cool SaaS.',
			'Act as the product engineer for a focused SaaS build. Define the target customer and primary outcome, inspect the repository before choosing the stack, implement the complete signup-to-value workflow, create a responsive and accessible interface, handle loading and failure states, and verify the result with focused automated tests plus a manual end-to-end pass. Treat unspecified visual choices as reversible assumptions and record them in the final handoff.',
		), false);
	});
});
