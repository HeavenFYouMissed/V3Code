/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { V3CodeVoiceSessionChannel } from '../../electron-main/v3codeVoiceSessionChannel.js';

suite('V3 Voice BYOK session channel', () => {
	const originalFetch = globalThis.fetch;

	teardown(() => {
		globalThis.fetch = originalFetch;
	});

	test('rejects invalid input before making a provider request', async () => {
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return new Response('', { status: 200 });
		};

		const channel = new V3CodeVoiceSessionChannel();
		await assert.rejects(
			channel.call(undefined, 'createByokSession', { apiKey: 'short', offerSdp: 'v=0' }),
			/valid OpenAI API key/,
		);
		assert.strictEqual(called, false);
	});

	test('sends the key only to OpenAI in the authorization header', async () => {
		const apiKey = 'sk-proj-test-only-not-a-real-secret-123456789';
		let capturedUrl = '';
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return new Response('v=0\r\no=answer\r\n', { status: 200 });
		};

		const channel = new V3CodeVoiceSessionChannel();
		const result = await channel.call(undefined, 'createByokSession', {
			apiKey,
			offerSdp: 'v=0\r\no=offer\r\n',
		});

		assert.strictEqual(capturedUrl, 'https://api.openai.com/v1/realtime/calls');
		assert.strictEqual(capturedInit?.method, 'POST');
		const headers = capturedInit?.headers as Record<string, string>;
		assert.strictEqual(headers.Authorization, `Bearer ${apiKey}`);
		assert.match(headers['Content-Type'], /^multipart\/form-data; boundary=/);
		const body = String(capturedInit?.body ?? '');
		assert.doesNotMatch(body, new RegExp(apiKey));
		assert.match(body, /Content-Type: application\/sdp/);
		assert.match(body, /gpt-realtime-2\.1-mini/);
		assert.deepStrictEqual(result, { answerSdp: 'v=0\r\no=answer\r\n' });
	});

	test('maps provider rejection without exposing the upstream body', async () => {
		globalThis.fetch = async () => new Response('echoed request metadata', { status: 401 });
		const channel = new V3CodeVoiceSessionChannel();
		await assert.rejects(
			channel.call(undefined, 'createByokSession', {
				apiKey: 'sk-proj-test-only-not-a-real-secret-123456789',
				offerSdp: 'v=0\r\no=offer\r\n',
			}),
			(error: Error) => {
				assert.match(error.message, /rejected that API key/);
				assert.doesNotMatch(error.message, /echoed request metadata/);
				return true;
			},
		);
	});
});
