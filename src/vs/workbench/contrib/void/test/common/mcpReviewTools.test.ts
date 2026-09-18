/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { acceptReviewJob, reviewChatTail, reviewContextPreview, reviewDiffArgs } from '../../common/mcpExpose/reviewTools.js';

suite('MCP review tools', () => {
	test('worker handle returns while completion is still pending', () => {
		const result = acceptReviewJob({ ok: true, subagentThreadId: 'worker-123', completion: new Promise(() => {}) }, () => {});
		assert.strictEqual(result.job_id, 'worker-123');
		assert.strictEqual(result.status, 'accepted');
	});
	test('admission failure does not invent a job', () => {
		assert.deepStrictEqual(acceptReviewJob({ ok: false, error: 'full' }, () => {}), { status: 'failed', result: 'full' });
	});
	test('completion rejection is observed without rejecting the launch receipt', async () => {
		let observed: unknown;
		const result = acceptReviewJob({ ok: true, subagentThreadId: 'worker', completion: Promise.reject('failed') }, error => { observed = error; });
		await Promise.resolve();
		assert.strictEqual(result.job_id, 'worker');
		assert.strictEqual(observed, 'failed');
	});
	test('revision pair and path survive validation', () => {
		assert.deepStrictEqual(reviewDiffArgs({ base: 'e29e938', head: 'HEAD', path: 'cloud/v3cloud' }), { base: 'e29e938', head: 'HEAD', path: 'cloud/v3cloud' });
	});
	test('relative paths with spaces and dot directories are accepted', () => {
		assert.strictEqual(reviewDiffArgs({ path: './my project/.github/workflows' }).path, './my project/.github/workflows');
	});
	for (const input of [{ base: '--output=x' }, { base: 'HEAD;touch' }, { base: '$(id)' }, { head: 'HEAD' }, { path: '../secrets' }, { path: 'a/../../secrets' }, { path: 'a\nb' }]) {
		test(`reject unsafe diff arguments ${JSON.stringify(input)}`, () => assert.throws(() => reviewDiffArgs(input)));
	}
	test('blank and missing search context do not crash', () => {
		assert.strictEqual(reviewContextPreview(undefined), '');
		assert.strictEqual(reviewContextPreview(''), '');
		assert.strictEqual(reviewContextPreview('x'.repeat(300)).length, 250);
	});
	test('large history stays valid JSON and keeps latest small reply', () => {
		const text = reviewChatTail({ threadId: 't', running: null, messages: [{ content: 'x'.repeat(1000000) }, { content: 'latest' }], partial: {} }, 1000, false);
		assert.ok(text.length <= 1000);
		assert.strictEqual(JSON.parse(text).messages.at(-1).content, 'latest');
		assert.strictEqual(JSON.parse(text).truncated, true);
	});
	test('oversized streaming partial is bounded', () => {
		const text = reviewChatTail({ messages: [], partial: { content: 'x'.repeat(1000000) } }, 1000, false);
		assert.ok(text.length <= 1000);
		assert.strictEqual(JSON.parse(text).truncated, true);
		assert.ok(JSON.parse(text).partial.content.endsWith('xxx'));
	});
});
