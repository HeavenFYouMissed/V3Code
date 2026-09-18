/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IToolData, type IToolImpl, type IToolInvocation, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { ENABLE_NETWORK_CAPTURE_FUNCTION, GET_NETWORK_LOG_FUNCTION } from './browserAgentScripts.js';
import { errorResult, getSessionId } from './browserToolHelpers.js';
import { browserPageId, pickBrowserParam } from './browserToolParams.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

interface INetworkCaptureEntry {
	time: number;
	method: string;
	url: string;
	status?: number;
	resourceType: string;
	requestBody?: string;
	responseBody?: string;
}

function formatNetworkEntries(entries: readonly INetworkCaptureEntry[]): string {
	const lines = entries.map(e => {
		const head = `[${new Date(e.time).toISOString()}] ${e.method} ${e.status ?? '?'} ${e.resourceType} ${e.url}`;
		const body = [
			e.requestBody ? `  req: ${e.requestBody.slice(0, 500)}` : '',
			e.responseBody ? `  res: ${e.responseBody.slice(0, 800)}` : '',
		].filter(Boolean).join('\n');
		return body ? `${head}\n${body}` : head;
	});
	return `${entries.length} entries:\n\n${lines.join('\n\n')}`;
}

export const InterceptNetworkBrowserToolData: IToolData = {
	id: 'intercept_network',
	toolReferenceName: BrowserChatToolReferenceName.InterceptNetwork,
	displayName: localize('interceptNetworkBrowserTool.displayName', 'Intercept Network'),
	userDescription: localize('interceptNetworkBrowserTool.userDescription', 'Capture matching network requests'),
	modelDescription: 'Capture requests matching a URL regex. Enable BEFORE navigate_page for full capture from first paint. Optionally include bodies. Read with get_browser_network_log.',
	icon: Codicon.radioTower,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			urlPattern: { type: 'string', description: 'Regex for request URLs.' },
			includeBodies: { type: 'boolean', description: 'Capture request/response bodies.' },
		},
		required: ['pageId', 'urlPattern'],
	},
};

export class InterceptNetworkBrowserTool implements IToolImpl {
	constructor(@IPlaywrightService private readonly playwrightService: IPlaywrightService) { }

	async invoke(invocation: IToolInvocation, _c: CountTokensCallback, _p: ToolProgress, _t: CancellationToken): Promise<IToolResult> {
		const raw = invocation.parameters as Record<string, unknown>;
		const pageId = browserPageId(raw);
		const urlPattern = pickBrowserParam<string>(raw, 'urlPattern', 'url_pattern');
		const includeBodies = !!pickBrowserParam<boolean | string>(raw, 'includeBodies', 'include_bodies');
		if (!pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		if (!urlPattern) {
			return errorResult('urlPattern is required (regex for request URLs).');
		}
		try {
			// Playwright page event listeners — no shared-process enableNetworkCapture IPC needed.
			const result = await this.playwrightService.invokeFunction(
				getSessionId(invocation), pageId, ENABLE_NETWORK_CAPTURE_FUNCTION,
				[{ urlPattern, includeBodies }], 15_000,
			);
			if (result.error) {
				return errorResult(result.error);
			}
			return {
				content: [{
					kind: 'text',
					value: `Network capture enabled for /${urlPattern}/ (bodies: ${includeBodies}). Call get_browser_network_log after triggering requests.`,
				}],
			};
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}

export const GetBrowserNetworkLogBrowserToolData: IToolData = {
	id: 'get_browser_network_log',
	toolReferenceName: BrowserChatToolReferenceName.GetBrowserNetworkLog,
	displayName: localize('getBrowserNetworkLogBrowserTool.displayName', 'Get Network Log'),
	userDescription: localize('getBrowserNetworkLogBrowserTool.userDescription', 'Read captured network requests'),
	modelDescription: 'Return entries captured since intercept_network. Use clear=true to reset.',
	icon: Codicon.output,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			clear: { type: 'boolean', description: 'Clear log after reading.' },
		},
		required: ['pageId'],
	},
};

export class GetBrowserNetworkLogBrowserTool implements IToolImpl {
	constructor(@IPlaywrightService private readonly playwrightService: IPlaywrightService) { }

	async invoke(invocation: IToolInvocation, _c: CountTokensCallback, _p: ToolProgress, _t: CancellationToken): Promise<IToolResult> {
		const pageId = browserPageId(invocation.parameters as Record<string, unknown>);
		if (!pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		try {
			const clear = !!pickBrowserParam<boolean | string>(invocation.parameters as Record<string, unknown>, 'clear');
			const result = await this.playwrightService.invokeFunction(
				getSessionId(invocation), pageId, GET_NETWORK_LOG_FUNCTION, [{ clear }], 15_000,
			);
			if (result.error) {
				return errorResult(result.error);
			}
			const entries = (result.result ?? []) as INetworkCaptureEntry[];
			if (!Array.isArray(entries) || entries.length === 0) {
				return { content: [{ kind: 'text', value: 'No captured network entries. Call intercept_network first.' }] };
			}
			return { content: [{ kind: 'text', value: formatNetworkEntries(entries) }] };
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
