/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildNextEditPrompt, buildNextEditPromptInstinct, parseNextEdit, nextEditSuppressionReason,
	NextEditInput, NES_CURSOR_MARKER, INSTINCT_SYSTEM_PROMPT,
} from '../../common/nextEditPrompt.js';
import { EditEntry } from '../../common/recentEditsTypes.js';

const edit = (over: Partial<EditEntry> = {}): EditEntry => ({
	id: 'e1',
	fileUri: '/w/src/a.ts',
	relativePath: 'src/a.ts',
	timestamp: 1,
	range: { startLine: 10, endLine: 10 },
	oldText: 'const oldName = 1',
	newText: 'const newName = 1',
	summary: 'src/a.ts:10 — const newName = 1',
	...over,
});

const input = (over: Partial<NextEditInput> = {}): NextEditInput => ({
	editHistory: [edit()],
	contextSnippets: [{ path: 'src/b.ts', content: 'export function helper() { return 1 }' }],
	filePath: '/w/src/a.ts',
	beforeRegion: 'import { helper } from "./b.js"',
	editableRegion: `const x = ${NES_CURSOR_MARKER}helper()`,
	afterRegion: 'export { x }',
	...over,
});

suite('nextEditPrompt', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ---- zeta format ----

	test('zeta prompt carries history, context snippets, region markers + cursor', () => {
		const p = buildNextEditPrompt(input());
		assert.ok(p.includes('<<<<<<< CURRENT'));
		assert.ok(p.includes('>>>>>>> UPDATED'));
		assert.ok(p.includes(NES_CURSOR_MARKER));
		assert.ok(p.includes('src/a.ts:10 — const newName = 1')); // history summary
		assert.ok(p.includes('--- src/b.ts')); // context snippet labeled with its path
		assert.ok(p.includes('export function helper()'));
	});

	test('zeta prompt renders (none) when context/history are empty', () => {
		const p = buildNextEditPrompt(input({ editHistory: [], contextSnippets: [] }));
		assert.ok(p.includes('### Recent edits (oldest to newest)\n(none)'));
		assert.ok(p.includes('### Related context\n(none)'));
	});

	// ---- instinct format ----

	test('instinct prompt uses native tokens and transposes the cursor marker', () => {
		const p = buildNextEditPromptInstinct(input());
		assert.ok(p.includes('<|editable_region_start|>'));
		assert.ok(p.includes('<|editable_region_end|>'));
		assert.ok(p.includes('<|user_cursor_is_here|>'));
		assert.ok(!p.includes(NES_CURSOR_MARKER)); // zeta marker must not leak into instinct prompts
		assert.ok(!p.includes('<<<<<<< CURRENT'));
		assert.ok(p.includes('<|context_file|>: src/b.ts'));
		assert.ok(p.includes('<|snippet|>'));
		assert.ok(p.includes('User edited file "src/a.ts"'));
		assert.ok(p.includes('-const oldName = 1'));
		assert.ok(p.includes('+const newName = 1'));
		assert.ok(p.trimEnd().endsWith('### Response:'));
	});

	test('instinct edit history is newest-first', () => {
		const older = edit({ id: 'e1', relativePath: 'src/older.ts' });
		const newer = edit({ id: 'e2', relativePath: 'src/newer.ts' });
		const p = buildNextEditPromptInstinct(input({ editHistory: [older, newer] })); // input is oldest -> newest
		assert.ok(p.indexOf('src/newer.ts') < p.indexOf('src/older.ts'));
	});

	test('instinct system prompt names the region tokens it was trained on', () => {
		assert.ok(INSTINCT_SYSTEM_PROMPT.includes('<|editable_region_start|>'));
		assert.ok(INSTINCT_SYSTEM_PROMPT.includes('<|user_cursor_is_here|>'));
	});

	// ---- parsing ----

	test('parse: NO_EDITS and empty outputs mean no suggestion', () => {
		assert.strictEqual(parseNextEdit('NO_EDITS').updated, null);
		assert.strictEqual(parseNextEdit('  no_edits  ').updated, null);
		assert.strictEqual(parseNextEdit('').updated, null);
		assert.strictEqual(parseNextEdit('```\nNO_EDITS\n```').updated, null);
	});

	test('parse: strips fences and echoed zeta markers', () => {
		assert.strictEqual(parseNextEdit('```ts\nconst x = 1\n```').updated, 'const x = 1');
		const echoed = '<<<<<<< CURRENT\nold\n=======\nconst y = 2\n>>>>>>> UPDATED';
		assert.strictEqual(parseNextEdit(echoed).updated, 'const y = 2');
	});

	test('parse: strips echoed instinct region tokens + cursor', () => {
		const out = '<|editable_region_start|>\nconst z = <|user_cursor_is_here|>3\n<|editable_region_end|>';
		assert.strictEqual(parseNextEdit(out).updated, 'const z = 3');
	});

	// ---- suppression gate ----

	const gate = (updated: string, current: string, over: Partial<Parameters<typeof nextEditSuppressionReason>[0]> = {}) =>
		nextEditSuppressionReason({ updated, currentRegion: current, beforeRegion: '', afterRegion: '', recentEdits: [], ...over });

	test('gate: a real local edit passes', () => {
		assert.strictEqual(gate('const x = helper()\nconst y = helper2()', 'const x = helper()'), null);
	});

	test('gate: no-op and whitespace-only churn suppressed', () => {
		assert.strictEqual(gate('const x = 1', '  const x = 1  '), 'no-op');
		assert.strictEqual(gate('const x=1', 'const x = 1'), 'whitespace-only');
	});

	test('gate: leftover markers suppressed', () => {
		assert.strictEqual(gate('const x = 1\n<|editable_region_end|> junk', 'const x = 1'), 'marker-echo');
	});

	test('gate: emptying a substantial region suppressed, small deletions allowed', () => {
		const big = 'function f() {\n\treturn someLongExpression + anotherLongExpression + yetAnotherOne;\n}\nconst keep = f();\nconst alsoKeep = f();';
		assert.strictEqual(gate('', big), 'mass-delete');
		assert.strictEqual(gate('', 'const tiny = 1;'), null); // real deletion of a small region is fine
	});

	test('gate: runaway growth suppressed', () => {
		assert.strictEqual(gate('x'.repeat(1000), 'const x = 1'), 'runaway-growth');
	});

	test('gate: duplicating the neighbor line below suppressed', () => {
		const r = gate('const x = 1\nexport const neighbor = 2', 'const x = 1', { afterRegion: 'export const neighbor = 2' });
		assert.strictEqual(r, 'echoes-after-context');
	});

	test('gate: reverting the user\'s latest edit suppressed', () => {
		const latest = edit({ oldText: 'const oldName = 1', newText: 'const newName = 1' });
		const r = gate('const oldName = 1', 'const newName = 1', { recentEdits: [latest] });
		assert.strictEqual(r, 'reverts-user-edit');
		// re-adding text the user deleted (newText === '') is also a revert
		const deletion = edit({ oldText: 'const gone = 1', newText: '' });
		assert.strictEqual(gate('const kept = 2\nconst gone = 1', 'const kept = 2', { recentEdits: [deletion] }), 'reverts-user-edit');
	});

	test('gate: wholesale rewrite of a large region suppressed', () => {
		const current = 'function alpha() {\n\treturn 1;\n}\n'.repeat(8); // > 200 chars
		const updated = 'class TotallyDifferent {\n\tconstructor() { this.q = 9 }\n}\n'.repeat(4);
		assert.strictEqual(gate(updated, current), 'wholesale-rewrite');
	});

	test('gate: a local change inside a large region still passes', () => {
		const current = `function alpha() {\n\treturn valueOne + valueTwo;\n}\nfunction beta() {\n\treturn valueThree + valueFour;\n}\nfunction gamma() {\n\treturn valueFive + valueSix;\n}\nfunction delta() {\n\treturn valueSeven + valueEight;\n}`;
		assert.ok(current.length > 200); // must exercise the wholesale-rewrite branch
		const updated = current.replace('valueFive + valueSix', 'valueFive * valueSix');
		assert.strictEqual(gate(updated, current), null);
	});
});
