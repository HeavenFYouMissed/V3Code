/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { WATCH_PAGE_FUNCTION } from './browserAgentScripts.js';
import { createBrowserPageLink, errorResult, getSessionId, invokeFunctionResultToToolResult } from './browserToolHelpers.js';
import { browserPageId, pickBrowserParam } from './browserToolParams.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const WatchPageBrowserToolData: IToolData = {
	id: 'watch_page',
	toolReferenceName: BrowserChatToolReferenceName.WatchPage,
	displayName: localize('watchPageBrowserTool.displayName', 'Watch Page'),
	userDescription: localize('watchPageBrowserTool.userDescription', 'Wait until a selector or text appears'),
	modelDescription: 'Poll until a selector is visible or text appears (CI run finished, deploy done). Use instead of manual read_page loops.',
	icon: Codicon.watch,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			ref: { type: 'string', description: 'Wait for this element ref.' },
			selector: { type: 'string', description: 'Wait for this selector.' },
			textContains: { type: 'string', description: 'Wait until page body contains this text.' },
			timeoutMs: { type: 'number', description: 'Max wait ms (default 60000).' },
			intervalMs: { type: 'number', description: 'Poll interval ms (default 1000).' },
		},
		required: ['pageId'],
	},
};

export class WatchPageBrowserTool implements IToolImpl {
	constructor(@IPlaywrightService private readonly playwrightService: IPlaywrightService) { }

	async prepareToolInvocation(ctx: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: new MarkdownString(localize('browser.watchPage.invocation', 'Watching {0} for changes', createBrowserPageLink((ctx.parameters as { pageId: string }).pageId))),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const raw = invocation.parameters as Record<string, unknown>;
		const pageId = browserPageId(raw);
		const ref = pickBrowserParam<string>(raw, 'ref');
		const selector = pickBrowserParam<string>(raw, 'selector');
		const textContains = pickBrowserParam<string>(raw, 'textContains', 'text_contains');
		if (!pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		if (!ref && !selector && !textContains) {
			return errorResult('Provide ref, selector, or textContains.');
		}
		const timeoutMs = pickBrowserParam<number>(raw, 'timeoutMs', 'timeout_ms');
		const intervalMs = pickBrowserParam<number>(raw, 'intervalMs', 'interval_ms');
		const timeout = timeoutMs ? timeoutMs + 5000 : 65_000;
		try {
			const result = await this.playwrightService.invokeFunction(
				getSessionId(invocation), pageId, WATCH_PAGE_FUNCTION,
				[{ ref, selector, textContains, timeoutMs, intervalMs }],
				timeout,
			);
			return invokeFunctionResultToToolResult(result);
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
