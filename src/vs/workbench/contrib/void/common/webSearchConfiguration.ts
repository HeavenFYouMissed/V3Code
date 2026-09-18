/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export const V3CODE_WEB_SEARCH_ENABLED_KEY = 'v3code.webSearch.enabled';
export const V3CODE_WEB_SEARCH_ENDPOINT_KEY = 'v3code.webSearch.endpoint';

/**
 * V3Code's managed metasearch endpoint. Keep this public product decision in one
 * place: normal GUI launches do not inherit shell environment variables, so an
 * env-only default silently disables search for virtually every packaged user.
 */
export const V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT = 'https://searxng-production-8888.up.railway.app';

export type WebSearchSettings = {
	enabled: boolean;
	endpoint: string;
};

function normalizeEndpoint(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

/**
 * Read the live product settings for the electron-main search channel.
 *
 * A process-level endpoint remains the highest-priority enterprise/developer
 * override for backwards compatibility. Otherwise the visible Settings value
 * wins and resets to the managed V3Code endpoint. Changes take effect on the
 * next search; restarting a Dock-launched app is not required.
 */
export function readWebSearchSettings(
	configurationService: IConfigurationService,
	environmentEndpoint = '',
): WebSearchSettings {
	const enabled = configurationService.getValue<boolean>(V3CODE_WEB_SEARCH_ENABLED_KEY) !== false;
	const configuredEndpoint = configurationService.getValue<string>(V3CODE_WEB_SEARCH_ENDPOINT_KEY) ?? V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT;
	const endpoint = normalizeEndpoint(environmentEndpoint || configuredEndpoint || V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT);
	return { enabled, endpoint };
}
