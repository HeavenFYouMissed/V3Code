/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isAllowedV3CodeActionUrl, isAllowedV3CodeBroadcastImageUrl, parseV3CodeBroadcastFeed } from '../../common/v3codeBroadcast.js';

suite('V3Code broadcast feed safety', () => {
	test('accepts bounded plain-text items and V3Code-owned HTTPS actions', () => {
		const feed = parseV3CodeBroadcastFeed({
			notifications: [{
				id: '2026-08-25-provider-outage',
				severity: 'warning',
				sender: 'Daniel — V3Code',
				display: 'banner',
				title: 'Provider notice',
				body: 'Use another model while this provider recovers.',
				actions: [{ label: 'V3Code status', href: 'https://status.v3code.dev/providers' }],
			}],
		});
		assert.strictEqual(feed.length, 1);
		assert.strictEqual(feed[0].id, '2026-08-25-provider-outage');
		assert.strictEqual(feed[0].sender, 'Daniel — V3Code');
		assert.strictEqual(feed[0].display, 'banner');
	});

	test('rejects commands, foreign hosts, credentials, ports, and non-HTTPS actions', () => {
		for (const href of [
			'command:workbench.action.openSettings',
			'https://example.com/phish',
			'https://evil.example@status.v3code.dev/phish',
			'https://status.v3code.dev:8443/phish',
			'http://status.v3code.dev/phish',
		]) {
			assert.strictEqual(isAllowedV3CodeActionUrl(href), false, href);
		}
	});

	test('allows images only from the fixed broadcast asset path', () => {
		assert.strictEqual(isAllowedV3CodeBroadcastImageUrl('https://update.v3code.dev/api/notifications/asset/v0094.png'), true);
		assert.strictEqual(isAllowedV3CodeBroadcastImageUrl('https://app.v3code.dev/image.png'), false);
		assert.strictEqual(isAllowedV3CodeBroadcastImageUrl('https://update.v3code.dev/download/stable/darwin/file.zip'), false);
		assert.strictEqual(isAllowedV3CodeBroadcastImageUrl('https://update.v3code.dev/api/notifications/asset/v0094.png?token=secret'), false);
	});

	test('drops malformed items instead of rendering remote markdown or unknown fields', () => {
		const feed = parseV3CodeBroadcastFeed({
			notifications: [
				{ id: 'good', body: 'Plain text only.' },
				{ id: 'bad markdown', body: '[click](command:evil)' },
				{ id: 'bad-action', body: 'No.', actions: [{ label: 'Open', href: 'command:evil' }] },
				{ id: 'unknown-field', body: 'No.', html: '<script />' },
			],
		});
		assert.deepStrictEqual(feed.map(item => item.id), ['good']);
	});

	test('rejects oversized roots and fields', () => {
		assert.deepStrictEqual(parseV3CodeBroadcastFeed({ notifications: new Array(101).fill({ id: 'same', body: 'x' }) }), []);
		assert.deepStrictEqual(parseV3CodeBroadcastFeed({ notifications: [{ id: 'too-long', body: 'x'.repeat(1_001) }] }), []);
	});
});
