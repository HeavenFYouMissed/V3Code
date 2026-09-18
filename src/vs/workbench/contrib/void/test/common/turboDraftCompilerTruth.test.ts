/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	extractHoverSignature,
	pickDiagnostics,
	pickNearbySymbols,
	renderDiagnostic,
} from '../../common/turboDraftCompilerTruth.js';
import { renderCompilerTruth } from '../../common/turboDraftPrompt.js';
import { DiagnosticEntry, SymbolEntry } from '../../common/contextBridge/contextBridgeTypes.js';

const diag = (over: Partial<DiagnosticEntry> = {}): DiagnosticEntry => ({
	filePath: 'src/a.ts', line: 0, severity: 'error', message: 'boom', ...over,
});

const sym = (over: Partial<SymbolEntry> = {}): SymbolEntry => ({
	name: 's', kind: 'function', filePath: 'src/a.ts', line: 0, character: 0, ...over,
});

suite('turboDraftCompilerTruth', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('errors outrank warnings regardless of line order', () => {
		const picked = pickDiagnostics([
			diag({ line: 5, severity: 'warning', message: 'unused' }),
			diag({ line: 90, severity: 'error', message: 'not assignable' }),
			diag({ line: 2, severity: 'warning', message: 'shadowed' }),
		]);
		assert.deepStrictEqual(picked.map(d => d.message), ['not assignable', 'shadowed', 'unused']);
	});

	test('info and hint noise is dropped', () => {
		const picked = pickDiagnostics([diag({ severity: 'info' }), diag({ severity: 'hint' })]);
		assert.strictEqual(picked.length, 0);
	});

	test('diagnostic count is capped', () => {
		const many = Array.from({ length: 50 }, (_, i) => diag({ line: i }));
		assert.strictEqual(pickDiagnostics(many).length, 12);
	});

	test('diagnostics render as 1-based lines', () => {
		assert.strictEqual(
			renderDiagnostic(diag({ line: 41, severity: 'error', source: 'ts', message: 'bad\n  thing' })),
			'line 42 [error] (ts) bad thing',
		);
	});

	test('symbols nearest the cursor win', () => {
		const picked = pickNearbySymbols([
			sym({ name: 'far', line: 50 }),
			sym({ name: 'near', line: 101 }),
			sym({ name: 'exact', line: 100 }),
		], 100);
		assert.deepStrictEqual(picked.map(s => s.name), ['exact', 'near', 'far']);
	});

	test('symbols outside the radius are ignored', () => {
		const picked = pickNearbySymbols([sym({ name: 'other-file-far', line: 5000 })], 10);
		assert.strictEqual(picked.length, 0);
	});

	test('hover signature keeps the code fence, not the prose', () => {
		const sig = extractHoverSignature([
			'```typescript\nfunction upload(file: File): Promise<Result>\n```\n\nUploads a file to the bucket.',
		]);
		assert.strictEqual(sig, 'function upload(file: File): Promise<Result>');
	});

	test('hover signature falls back to prose when there is no fence', () => {
		assert.strictEqual(extractHoverSignature(['just some docs']), 'just some docs');
	});

	test('hover signature is capped', () => {
		const long = '```ts\n' + 'x'.repeat(900) + '\n```';
		const sig = extractHoverSignature([long], 50);
		assert.ok(sig.length <= 53, `expected cap + ellipsis, got ${sig.length}`);
		assert.ok(sig.endsWith('...'), 'truncation must be visible');
	});

	test('empty hover yields empty string', () => {
		assert.strictEqual(extractHoverSignature([]), '');
	});

	test('compiler truth section is omitted entirely when there is nothing true to say', () => {
		assert.strictEqual(renderCompilerTruth(undefined), '');
		assert.strictEqual(renderCompilerTruth({ diagnostics: [], signatures: [], callSites: [] }), '');
	});

	test('compiler truth section is marked authoritative and lists what it has', () => {
		const out = renderCompilerTruth({
			diagnostics: ['line 3 [error] nope'],
			signatures: ['upload: function upload(f: File): Promise<void>'],
			callSites: ['handler -> upload (src/api.ts:12)'],
			partial: true,
		});
		assert.ok(out.includes('authoritative'));
		assert.ok(out.includes('line 3 [error] nope'));
		assert.ok(out.includes('upload: function upload'));
		assert.ok(out.includes('handler -> upload'));
		assert.ok(out.includes('Partial:'), 'a partial answer must say so');
	});
});
