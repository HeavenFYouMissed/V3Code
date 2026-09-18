/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildTurboDraftFixPrompt,
	diffTurboProblems,
	problemKey,
	TurboVerifyProblem,
} from '../../common/turboDraftVerify.js';

const err = (message: string, line = 1, code = 'TS2322'): TurboVerifyProblem =>
	({ code, message: `(error) ${message}`, startLineNumber: line });
const warn = (message: string, line = 1, code = 'lint'): TurboVerifyProblem =>
	({ code, message: `(warning) ${message}`, startLineNumber: line });

suite('turboDraftVerify', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a clean draft reports nothing', () => {
		const r = diffTurboProblems([err('already broken')], [err('already broken')]);
		assert.strictEqual(r.clean, true);
		assert.strictEqual(r.newErrors.length, 0);
	});

	test('pre-existing errors are not blamed on the draft even when they move', () => {
		const r = diffTurboProblems([err('already broken', 10)], [err('already broken', 84)]);
		assert.strictEqual(r.clean, true, 'identity must ignore line numbers');
	});

	test('an error the draft introduced is reported', () => {
		const r = diffTurboProblems([err('already broken')], [err('already broken'), err('cannot find name foo', 12)]);
		assert.strictEqual(r.clean, false);
		assert.deepStrictEqual(r.newErrors.map(e => e.startLineNumber), [12]);
	});

	test('duplicate copies of a known error still count as new', () => {
		const r = diffTurboProblems([err('dup')], [err('dup', 1), err('dup', 2), err('dup', 3)]);
		assert.strictEqual(r.newErrors.length, 2, 'one is pre-existing, two are new');
	});

	test('new warnings are not worth a round trip', () => {
		const r = diffTurboProblems([], [warn('unused variable')]);
		assert.strictEqual(r.clean, true);
	});

	test('fixing a pre-existing error is not a regression', () => {
		const r = diffTurboProblems([err('a'), err('b')], [err('a')]);
		assert.strictEqual(r.clean, true);
	});

	test('missing baseline treats every error as new', () => {
		const r = diffTurboProblems(null, [err('boom')]);
		assert.strictEqual(r.newErrors.length, 1);
	});

	test('empty after-set is always clean', () => {
		assert.strictEqual(diffTurboProblems([err('x')], null).clean, true);
	});

	test('problem identity is code plus normalized message', () => {
		assert.strictEqual(problemKey(err('a  b\n c')), problemKey(err('a b c')));
		assert.notStrictEqual(problemKey(err('a', 1, 'TS1')), problemKey(err('a', 1, 'TS2')));
	});

	test('fix prompt names the errors and forbids drive-by refactors', () => {
		const p = buildTurboDraftFixPrompt({
			filePath: '/w/src/a.ts',
			fileContents: 'const a = 1\n',
			newErrors: [err('cannot find name foo', 12)],
		});
		assert.ok(p.includes('line 12: (error) cannot find name foo'));
		assert.ok(p.includes('Fix exactly these errors and nothing else'));
		assert.ok(p.includes('const a = 1'));
	});

	test('fix prompt caps the error list', () => {
		const many = Array.from({ length: 30 }, (_, i) => err(`e${i}`, i + 1));
		const p = buildTurboDraftFixPrompt({ filePath: '/w/a.ts', fileContents: '', newErrors: many });
		assert.ok(!p.includes('e8:'), 'list must be capped');
		assert.ok(p.includes('e0'));
	});
});
