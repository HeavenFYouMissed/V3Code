/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { V3CODE_WEB_SEARCH_ENABLED_KEY, V3CODE_WEB_SEARCH_ENDPOINT_KEY } from '../../common/webSearchConfiguration.js';
import { WebSearchChannel } from '../../electron-main/webSearchChannel.js';

function mutableConfiguration(values: Record<string, unknown>): IConfigurationService {
	return {
		getValue<T>(key?: string): T {
			return values[key ?? ''] as T;
		},
	} as IConfigurationService;
}

suite('V3Code web search channel', () => {
	test('the off switch wins over L1 and endpoint changes do not reuse another provider cache', async () => {
		const values: Record<string, unknown> = {
			[V3CODE_WEB_SEARCH_ENABLED_KEY]: true,
			[V3CODE_WEB_SEARCH_ENDPOINT_KEY]: 'https://first.example.test',
		};
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			calls.push(url);
			const host = new URL(url).host;
			return {
				status: 200,
				json: async () => ({
					results: [{ title: host, url: `https://${host}/result`, content: 'verified' }],
				}),
			} as Response;
		}) as typeof fetch;

		try {
			const channel = new WebSearchChannel(mutableConfiguration(values), '');
			const first = await channel.call(undefined, 'search', { query: 'cache isolation proof', maxResults: 5 });
			assert.strictEqual(first.results[0].title, 'first.example.test');
			assert.strictEqual(calls.length, 1);

			values[V3CODE_WEB_SEARCH_ENABLED_KEY] = false;
			const disabled = await channel.call(undefined, 'search', { query: 'cache isolation proof', maxResults: 5 });
			assert.strictEqual(disabled.results.length, 0);
			assert.match(disabled.error, /turned off/i);
			assert.strictEqual(calls.length, 1, 'disabled search must not read through the existing cache or touch the network');

			values[V3CODE_WEB_SEARCH_ENABLED_KEY] = true;
			values[V3CODE_WEB_SEARCH_ENDPOINT_KEY] = 'https://second.example.test';
			const second = await channel.call(undefined, 'search', { query: 'cache isolation proof', maxResults: 5 });
			assert.strictEqual(second.results[0].title, 'second.example.test');
			assert.strictEqual(calls.length, 2, 'changing endpoint must not reuse another provider\'s cached result');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('an unreachable service points the user to V3Code Settings', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;

		try {
			const channel = new WebSearchChannel(mutableConfiguration({
				[V3CODE_WEB_SEARCH_ENABLED_KEY]: true,
				[V3CODE_WEB_SEARCH_ENDPOINT_KEY]: 'https://offline.example.test',
			}), '');
			const response = await channel.call(undefined, 'search', { query: 'unreachable service proof', maxResults: 5 });
			assert.deepStrictEqual(response.results, []);
			assert.match(response.error, /V3Code Settings/i);
			assert.match(response.error, /enable/i);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
