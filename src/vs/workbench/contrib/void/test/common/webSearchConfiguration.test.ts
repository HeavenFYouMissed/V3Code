/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	readWebSearchSettings,
	V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT,
	V3CODE_WEB_SEARCH_ENABLED_KEY,
	V3CODE_WEB_SEARCH_ENDPOINT_KEY,
} from '../../common/webSearchConfiguration.js';

function configuration(values: Record<string, unknown>): IConfigurationService {
	return {
		getValue<T>(key?: string): T {
			return values[key ?? ''] as T;
		},
	} as IConfigurationService;
}

suite('V3Code web search configuration', () => {
	test('is on by default with the managed endpoint', () => {
		const settings = readWebSearchSettings(configuration({}));
		assert.deepStrictEqual(settings, {
			enabled: true,
			endpoint: V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT,
		});
	});

	test('honors the visible off switch', () => {
		const settings = readWebSearchSettings(configuration({
			[V3CODE_WEB_SEARCH_ENABLED_KEY]: false,
		}));
		assert.strictEqual(settings.enabled, false);
	});

	test('uses and normalizes the visible endpoint override', () => {
		const settings = readWebSearchSettings(configuration({
			[V3CODE_WEB_SEARCH_ENDPOINT_KEY]: '  https://search.example.test///  ',
		}));
		assert.strictEqual(settings.endpoint, 'https://search.example.test');
	});

	test('keeps the environment endpoint as the highest-priority deployment override', () => {
		const settings = readWebSearchSettings(
			configuration({ [V3CODE_WEB_SEARCH_ENDPOINT_KEY]: 'https://settings.example.test' }),
			'https://environment.example.test/',
		);
		assert.strictEqual(settings.endpoint, 'https://environment.example.test');
	});
});
