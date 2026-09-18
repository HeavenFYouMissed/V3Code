/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IChatRequestViewModel, IChatResponseViewModel } from '../../../common/model/chatViewModel.js';
import { findV3ActiveStickyRequest, getV3LastResponseMinHeight, getV3StickyRequestHandoff, isV3StickyRequestActive, V3StickyRequestItem } from '../../../common/widget/v3codeStickyRequest.js';

function request(id: string, isComplete: boolean = true): IChatRequestViewModel {
	return { id, message: {}, isComplete } as unknown as IChatRequestViewModel;
}

function response(requestId: string, isComplete: boolean, isCanceled: boolean = false): IChatResponseViewModel {
	return { requestId, isComplete, isCanceled, setVote() { } } as unknown as IChatResponseViewModel;
}

function find(items: readonly V3StickyRequestItem[], scrollTop: number, requestInProgress: boolean = true): IChatRequestViewModel | undefined {
	return findV3ActiveStickyRequest(items, requestInProgress, scrollTop, item => item.currentRenderedHeight ?? 100)?.item;
}

suite('V3Code active sticky request', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pins only the request whose response is currently running', () => {
		const oldRequest = request('old');
		const currentRequest = request('current', false);
		const items = [oldRequest, response('old', true), currentRequest, response('current', false)];

		assert.strictEqual(find(items, 201), currentRequest);
	});

	test('hands off as soon as the active request top crosses the viewport', () => {
		const currentRequest = request('current', false);
		const items = [request('old'), response('old', true), currentRequest, response('current', false)];

		assert.strictEqual(find(items, 200), undefined);
		assert.strictEqual(find(items, 201), currentRequest);
	});

	test('returns the row geometry needed for the moving capsule handoff', () => {
		const currentRequest = request('current', false);
		currentRequest.currentRenderedHeight = 80;
		const items = [request('old'), response('old', true), currentRequest, response('current', false)];

		const found = findV3ActiveStickyRequest(items, true, 230, item => item.currentRenderedHeight ?? 100);
		assert.strictEqual(found?.item, currentRequest);
		assert.strictEqual(found?.rowHeight, 80);
		assert.strictEqual(found?.rowBottomRel, 50);
	});

	test('rides a short request and hides a partially visible tall source', () => {
		const shortRequest = request('short', false);
		const shortMatch = { item: shortRequest, rowBottomRel: 90, rowHeight: 80 };
		assert.deepStrictEqual(getV3StickyRequestHandoff(shortMatch, 60), { offsetY: 30, hideSource: false });

		const tallRequest = request('tall', false);
		const tallMatch = { item: tallRequest, rowBottomRel: 240, rowHeight: 400 };
		assert.deepStrictEqual(getV3StickyRequestHandoff(tallMatch, 100), { offsetY: 0, hideSource: true });
		assert.deepStrictEqual(getV3StickyRequestHandoff({ ...tallMatch, rowBottomRel: 0 }, 100), { offsetY: 0, hideSource: false });
	});

	test('aligns the latest response with the measured sticky capsule', () => {
		assert.strictEqual(getV3LastResponseMinHeight(1000, 400), 790);
		assert.strictEqual(getV3LastResponseMinHeight(1000, 400, 120), 870);
		assert.strictEqual(getV3LastResponseMinHeight(1000, 80, 120), 910);
		assert.strictEqual(getV3LastResponseMinHeight(100, 400, 120), 0);
	});

	test('stays active through a tool or input gap', () => {
		assert.strictEqual(isV3StickyRequestActive(true, false, false), true);
		assert.strictEqual(isV3StickyRequestActive(false, false, true), true);
		assert.strictEqual(isV3StickyRequestActive(false, false, false), false);
	});

	test('ignores queued requests appended after the active response', () => {
		const currentRequest = request('current', false);
		const queuedRequest = { ...request('queued', false), pendingKind: 'queued' } as unknown as IChatRequestViewModel;
		const items = [currentRequest, response('current', false), queuedRequest];

		assert.strictEqual(find(items, 100), currentRequest);
	});

	test('hides immediately when the run is no longer active', () => {
		const currentRequest = request('current', false);
		const items = [currentRequest, response('current', false)];

		assert.strictEqual(find(items, 100, false), undefined);
	});

	test('refuses invalid layout measurements instead of selecting the wrong turn', () => {
		const oldRequest = request('old');
		oldRequest.currentRenderedHeight = 0;
		const currentRequest = request('current', false);
		const items = [oldRequest, response('old', true), currentRequest, response('current', false)];

		assert.strictEqual(find(items, 300), undefined);
	});
});
