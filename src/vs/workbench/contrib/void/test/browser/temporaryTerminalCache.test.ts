/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isReusableTemporaryTerminal, TemporaryTerminalCache } from '../../browser/temporaryTerminalCache.js';

suite('TemporaryTerminalCache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses only live terminals whose cwd is known and unchanged', () => {
		const base = {
			isDisposed: false,
			hasExited: false,
			expectedCwdKey: 'file:///workspace',
			actualCwdKey: 'file:///workspace' as string | undefined,
		};
		assert.strictEqual(isReusableTemporaryTerminal(base), true);
		assert.strictEqual(isReusableTemporaryTerminal({ ...base, isDisposed: true }), false);
		assert.strictEqual(isReusableTemporaryTerminal({ ...base, hasExited: true }), false);
		assert.strictEqual(isReusableTemporaryTerminal({ ...base, actualCwdKey: undefined }), false);
		assert.strictEqual(isReusableTemporaryTerminal({ ...base, actualCwdKey: 'file:///other' }), false);
	});

	test('acquires an idle session-and-cwd entry only once', () => {
		const cache = new TemporaryTerminalCache<object>();
		const terminal = {};
		const entry = cache.addBusy('session-a|cwd-a', 'session-a', 'cwd-a', terminal)!;
		assert.strictEqual(cache.release(entry).length, 0);
		assert.strictEqual(cache.tryAcquire(entry), true);
		assert.strictEqual(cache.tryAcquire(entry), false);
		assert.strictEqual(cache.get('session-a|cwd-a')?.value, terminal);
	});

	test('keeps different session and cwd keys isolated', () => {
		const cache = new TemporaryTerminalCache<string>();
		const a = cache.addBusy('session-a|cwd-a', 'session-a', 'cwd-a', 'a')!;
		const b = cache.addBusy('session-a|cwd-b', 'session-a', 'cwd-b', 'b')!;
		const c = cache.addBusy('session-b|cwd-a', 'session-b', 'cwd-a', 'c')!;
		cache.release(a);
		cache.release(b);
		cache.release(c);
		assert.deepStrictEqual([
			cache.get('session-a|cwd-a')?.value,
			cache.get('session-a|cwd-b')?.value,
			cache.get('session-b|cwd-a')?.value,
		], ['a', 'b', 'c']);
	});

	test('evicts the least-recently-used idle entry at the cap', () => {
		const cache = new TemporaryTerminalCache<string>(2);
		const a = cache.addBusy('a', 'session', 'a', 'terminal-a')!;
		const b = cache.addBusy('b', 'session', 'b', 'terminal-b')!;
		cache.release(a);
		cache.release(b);

		assert.strictEqual(cache.tryAcquire(a), true);
		cache.release(a); // Touch A, making B the oldest idle entry.

		const c = cache.addBusy('c', 'session', 'c', 'terminal-c')!;
		assert.deepStrictEqual(cache.release(c), ['terminal-b']);
		assert.strictEqual(cache.get('a')?.value, 'terminal-a');
		assert.strictEqual(cache.get('b'), undefined);
		assert.strictEqual(cache.get('c')?.value, 'terminal-c');
	});

	test('never evicts busy entries and trims overflow when they settle', () => {
		const cache = new TemporaryTerminalCache<string>(2);
		const a = cache.addBusy('a', 'session', 'a', 'terminal-a')!;
		const b = cache.addBusy('b', 'session', 'b', 'terminal-b')!;
		cache.release(a);
		const c = cache.addBusy('c', 'session', 'c', 'terminal-c')!;
		assert.deepStrictEqual(cache.release(c), []);
		assert.strictEqual(cache.size, 3);
		assert.strictEqual(cache.get('b')?.busy, true);

		assert.deepStrictEqual(cache.release(b), ['terminal-a']);
		assert.strictEqual(cache.get('b')?.value, 'terminal-b');
		assert.strictEqual(cache.get('c')?.value, 'terminal-c');
	});

	test('discard and clear transfer ownership back to the caller', () => {
		const cache = new TemporaryTerminalCache<string>();
		const a = cache.addBusy('a', 'session', 'a', 'terminal-a')!;
		const b = cache.addBusy('b', 'session', 'b', 'terminal-b')!;
		assert.strictEqual(cache.discard(a), 'terminal-a');
		assert.strictEqual(cache.discard(a), undefined);
		assert.deepStrictEqual(cache.clear(), ['terminal-b']);
		assert.strictEqual(cache.size, 0);
		assert.strictEqual(cache.release(b).length, 0);
	});
});
