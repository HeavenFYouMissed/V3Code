/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatNativeNotices, MAX_NOTICE_CHARS, MAX_NOTICE_KEYS, MAX_NOTICES_PER_KEY, NativeNoticeQueue } from '../../common/nativeNoticeQueue.js';

suite('native notice queue (subagent results for native chat parents)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('push then drain returns notices oldest-first and empties the key', () => {
		const q = new NativeNoticeQueue();
		q.push('vscode-chat://s1', 'first', 'subagent', 1);
		q.push('vscode-chat://s1', 'second', 'system', 2);
		assert.strictEqual(q.pending('vscode-chat://s1'), 2);
		const drained = q.drain('vscode-chat://s1');
		assert.deepStrictEqual(drained.map(n => n.content), ['first', 'second']);
		assert.strictEqual(q.pending('vscode-chat://s1'), 0);
		assert.deepStrictEqual(q.drain('vscode-chat://s1'), []);
	});

	test('keys are isolated: draining one session never delivers another session\'s notices', () => {
		const q = new NativeNoticeQueue();
		q.push('a', 'for a', 'subagent');
		q.push('b', 'for b', 'subagent');
		assert.deepStrictEqual(q.drain('a').map(n => n.content), ['for a']);
		assert.strictEqual(q.pending('b'), 1);
	});

	test('per-key bound keeps the newest notices', () => {
		const q = new NativeNoticeQueue();
		for (let i = 0; i < MAX_NOTICES_PER_KEY + 5; i++) { q.push('k', `n${i}`, 'subagent'); }
		const drained = q.drain('k');
		assert.strictEqual(drained.length, MAX_NOTICES_PER_KEY);
		assert.strictEqual(drained[0].content, 'n5');
		assert.strictEqual(drained[drained.length - 1].content, `n${MAX_NOTICES_PER_KEY + 4}`);
	});

	test('key bound evicts the oldest never-drained key', () => {
		const q = new NativeNoticeQueue();
		for (let i = 0; i < MAX_NOTICE_KEYS; i++) { q.push(`k${i}`, 'x', 'subagent'); }
		q.push('fresh', 'y', 'subagent');
		assert.strictEqual(q.pending('k0'), 0, 'oldest key evicted');
		assert.strictEqual(q.pending('k1'), 1);
		assert.strictEqual(q.pending('fresh'), 1);
	});

	test('oversized content is clipped with a marker', () => {
		const q = new NativeNoticeQueue();
		q.push('k', 'x'.repeat(MAX_NOTICE_CHARS + 100), 'subagent');
		const [n] = q.drain('k');
		assert.ok(n.content.length < MAX_NOTICE_CHARS + 100);
		assert.ok(n.content.endsWith(`[notice clipped at ${MAX_NOTICE_CHARS} chars]`));
	});

	test('clear forgets without delivering', () => {
		const q = new NativeNoticeQueue();
		q.push('k', 'gone', 'subagent');
		q.clear('k');
		assert.deepStrictEqual(q.drain('k'), []);
	});

	test('formatNativeNotices delimits the block so it is not read as tool output', () => {
		assert.strictEqual(formatNativeNotices([]), '');
		const one = formatNativeNotices([{ content: 'Subagent done', source: 'subagent', timestamp: 1 }]);
		assert.ok(one.startsWith('[AUTOMATED-SYSTEM-NOTICE: 1 background notice'));
		assert.ok(one.includes('NOT output of the tool above'));
		assert.ok(one.includes('- Subagent done'));
		assert.ok(one.endsWith('[END-SYSTEM-NOTICE]'));
		const two = formatNativeNotices([{ content: 'a', source: 'subagent', timestamp: 1 }, { content: 'b', source: 'system', timestamp: 2 }]);
		assert.ok(two.includes('2 background notices'));
	});
});
