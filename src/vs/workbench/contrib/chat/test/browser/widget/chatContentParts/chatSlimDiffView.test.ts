/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../../../editor/common/languages/language.js';
import { buildSlimDiffItems, renderSlimDiff } from '../../../../browser/widget/chatContentParts/chatSlimDiffView.js';
import { collapseContextRuns, parseUnifiedDiffLines, renderUnifiedDiff } from '../../../../browser/widget/chatContentParts/chatUnifiedDiffView.js';

suite('Chat slim diff preview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const languageService = {} as ILanguageService;

	test('marks only overflowing previews as truncated', () => {
		const oneRow = renderSlimDiff('', 'one', languageService, { maxItems: 40 });
		const fiveRows = renderSlimDiff('', 'one\ntwo\nthree\nfour\nfive', languageService, { maxItems: 40 });
		const sixRows = renderSlimDiff('', 'one\ntwo\nthree\nfour\nfive\nsix', languageService, { maxItems: 40 });

		assert.strictEqual(oneRow.dataset.truncated, 'false');
		assert.strictEqual(fiveRows.dataset.truncated, 'false');
		assert.strictEqual(sixRows.dataset.truncated, 'true');
	});

	test('marks maxItems-capped previews as truncated', () => {
		const capped = renderSlimDiff('', 'one\ntwo\nthree\nfour\nfive\nsix', languageService, { maxItems: 4 });
		assert.strictEqual(capped.dataset.truncated, 'true');
	});

	test('keeps real line numbers around a replacement', () => {
		const items = buildSlimDiffItems('one\ntwo\nthree', 'one\nchanged\nthree');
		assert.deepStrictEqual(items, [
			{ type: 'unchanged', content: 'one', originalLineNumber: 1, modifiedLineNumber: 1 },
			{ type: 'removed', content: 'two', originalLineNumber: 2 },
			{ type: 'added', content: 'changed', modifiedLineNumber: 2 },
			{ type: 'unchanged', content: 'three', originalLineNumber: 3, modifiedLineNumber: 3 },
		]);
	});

	test('collapses distant unchanged lines', () => {
		const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
		const modified = original.replace('line 10', 'changed');
		const items = buildSlimDiffItems(original, modified, 2);
		assert.ok(items.some(item => item.type === 'collapsed'));
		assert.ok(items.length < 20);
	});

	test('parses both sides of a unified patch', () => {
		const lines = parseUnifiedDiffLines([
			'diff --git a/file.ts b/file.ts',
			'--- a/file.ts',
			'+++ b/file.ts',
			'@@ -7,2 +7,2 @@',
			' keep',
			'-old',
			'+new',
		].join('\n'));
		assert.deepStrictEqual(lines.slice(-3), [
			{ kind: 'context', text: 'keep', oldNo: 7, newNo: 7 },
			{ kind: 'removed', text: 'old', oldNo: 8, newNo: null },
			{ kind: 'added', text: 'new', oldNo: null, newNo: 8 },
		]);
	});

	test('keeps patch cards bounded without a vertical scroller', () => {
		const context = Array.from({ length: 12 }, (_, index) => ` line ${index + 1}`);
		const diff = ['@@ -1,12 +1,12 @@', ...context].join('\n');
		assert.ok(collapseContextRuns(parseUnifiedDiffLines(diff)).some(item => item.kind === 'collapsed'));
		const rendered = renderUnifiedDiff(diff);
		assert.strictEqual(rendered.dataset.truncated, 'false');
		assert.strictEqual(rendered.style.overflowY, '');
	});
});
