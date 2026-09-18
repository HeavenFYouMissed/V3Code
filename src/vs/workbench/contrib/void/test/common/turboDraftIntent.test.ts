/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveTurboIntent } from '../../common/turboDraftIntent.js';

const FILE = [
	'export function upload() {',
	'\t// TODO: retry on 429 with backoff',
	'\t// keep the existing timeout',
	'\treturn post();',
	'}',
].join('\n');

suite('turboDraftIntent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('selection wins over everything', () => {
		const r = deriveTurboIntent({
			selectionText: 'make this async',
			fileText: FILE,
			cursorLine: 2,
			planDocs: [{ path: '/w/plan.md', text: '# Plan\n- do the thing' }],
		});
		assert.strictEqual(r.source, 'selection');
		assert.strictEqual(r.text, 'make this async');
		assert.strictEqual(r.label, 'From your selection');
	});

	test('TODO wins over a plan doc and pulls the comment block', () => {
		const r = deriveTurboIntent({
			fileText: FILE,
			cursorLine: 4,
			planDocs: [{ path: '/w/plan.md', text: '# Plan\n- do the thing' }],
		});
		assert.strictEqual(r.source, 'todo');
		assert.ok(r.text.includes('retry on 429 with backoff'));
		assert.ok(r.text.includes('keep the existing timeout'), 'continuation lines are included');
		assert.strictEqual(r.label, 'From TODO on line 2');
	});

	test('nearest TODO to the cursor wins', () => {
		const text = [
			'// TODO: first thing',
			'a',
			'b',
			'c',
			'// FIXME: second thing',
			'd',
		].join('\n');
		const r = deriveTurboIntent({ fileText: text, cursorLine: 6 });
		assert.ok(r.text.includes('second thing'), `expected the nearer FIXME, got: ${r.text}`);
	});

	test('TODO further than the search radius is ignored', () => {
		const text = ['// TODO: far away', ...Array.from({ length: 80 }, (_, i) => `line ${i}`)].join('\n');
		const r = deriveTurboIntent({ fileText: text, cursorLine: 80 });
		assert.strictEqual(r.source, 'none');
	});

	test('plan.md is preferred over other open markdown', () => {
		const r = deriveTurboIntent({
			fileText: 'const a = 1',
			cursorLine: 1,
			planDocs: [
				{ path: '/w/notes.md', text: '# Notes\n- unrelated' },
				{ path: '/w/plan.md', text: '# Ship upload retries\n- add backoff\n- cap at 3 tries' },
			],
		});
		assert.strictEqual(r.source, 'plan-file');
		assert.strictEqual(r.label, 'From plan.md');
		assert.ok(r.text.includes('Ship upload retries'));
		assert.ok(r.text.includes('cap at 3 tries'));
	});

	test('a comment-only scratch file reads as a brief', () => {
		const r = deriveTurboIntent({ fileText: '#create events.py', cursorLine: 1 });
		assert.strictEqual(r.source, 'file-brief');
		assert.strictEqual(r.text, 'create events.py');
		assert.strictEqual(r.label, 'From your note at the top');
	});

	test('a multi-line brief is joined', () => {
		const text = [
			'// an OpenTelemetry event recorder',
			'// wraps named events as spans',
			'',
			'// callers set attributes on the span',
		].join('\n');
		const r = deriveTurboIntent({ fileText: text, cursorLine: 1 });
		assert.strictEqual(r.source, 'file-brief');
		assert.ok(r.text.includes('OpenTelemetry event recorder'));
		assert.ok(r.text.includes('callers set attributes'));
	});

	test('a brief does not hijack a file that has real code', () => {
		const r = deriveTurboIntent({ fileText: '// a note\nconst a = 1', cursorLine: 2 });
		assert.strictEqual(r.source, 'none');
	});

	test('a long comment header is not a brief', () => {
		const text = Array.from({ length: 12 }, (_, i) => `// header line ${i}`).join('\n');
		const r = deriveTurboIntent({ fileText: text, cursorLine: 1 });
		assert.strictEqual(r.source, 'none');
	});

	test('a TODO inside a scratch file still wins over the brief', () => {
		const r = deriveTurboIntent({ fileText: '// TODO: write the recorder', cursorLine: 1 });
		assert.strictEqual(r.source, 'todo');
	});

	test('a brief beats a plan file, because it is about this file', () => {
		const r = deriveTurboIntent({
			fileText: '#create events.py',
			cursorLine: 1,
			planDocs: [{ path: '/w/plan.md', text: '# Plan\n- something else entirely' }],
		});
		assert.strictEqual(r.source, 'file-brief');
	});

	test('no signal returns a whole-file pass', () => {
		const r = deriveTurboIntent({ fileText: 'const a = 1', cursorLine: 1 });
		assert.strictEqual(r.source, 'none');
		assert.strictEqual(r.text, '');
		assert.strictEqual(r.label, 'Whole-file pass');
	});

	test('empty selection falls through instead of winning', () => {
		const r = deriveTurboIntent({ selectionText: '   \n  ', fileText: FILE, cursorLine: 2 });
		assert.strictEqual(r.source, 'todo');
	});
});
