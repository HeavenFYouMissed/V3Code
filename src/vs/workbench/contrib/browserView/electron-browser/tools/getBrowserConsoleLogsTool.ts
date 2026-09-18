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
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { createBrowserPageLink, errorResult } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const GetBrowserConsoleLogsToolId = 'get_browser_console_logs';

export const GetBrowserConsoleLogsBrowserToolData: IToolData = {
	id: GetBrowserConsoleLogsToolId,
	toolReferenceName: BrowserChatToolReferenceName.GetBrowserConsoleLogs,
	displayName: localize('getBrowserConsoleLogsTool.displayName', 'Get Browser Console Logs'),
	userDescription: localize('getBrowserConsoleLogsTool.userDescription', 'Read DevTools console output from a browser page'),
	modelDescription: `Read captured browser console logs (all levels: log, warn, error) from the integrated browser DevTools pipeline. Use for debugging JS errors, React hydration issues, failed fetches, and runtime warnings on a page you are testing. Complements read_page (which includes recent warnings/errors in its summary).`,
	icon: Codicon.output,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: 'The browser page ID from open_browser_page.',
			},
			max_lines: {
				type: 'number',
				description: 'Maximum log lines to return (default 200, max 500). Most recent lines are kept.',
			},
		},
		required: ['pageId'],
	},
};

interface IGetBrowserConsoleLogsParams {
	pageId: string;
	max_lines?: number;
}

export class GetBrowserConsoleLogsBrowserTool implements IToolImpl {
	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const link = createBrowserPageLink(context.parameters.pageId);
		return {
			invocationMessage: new MarkdownString(localize('browser.consoleLogs.invocation', "Reading console logs from {0}", link)),
			pastTenseMessage: new MarkdownString(localize('browser.consoleLogs.past', "Read console logs from {0}", link)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IGetBrowserConsoleLogsParams;
		const maxLines = Math.min(Math.max(params.max_lines ?? 200, 1), 500);

		if (!params.pageId) {
			return errorResult(`No page ID provided. Use '${OpenPageToolId}' first.`);
		}

		const editor = this.browserViewService.getKnownBrowserViews().get(params.pageId);
		if (!editor) {
			return errorResult(`No browser page found with ID ${params.pageId}.`);
		}

		try {
			const model = await editor.resolve();
			const raw = await model.getConsoleLogs();
			const lines = raw.split('\n').filter(l => l.length > 0);
			const tail = lines.slice(-maxLines);
			const value = tail.length > 0
				? tail.join('\n')
				: '(no console logs captured for this page yet — interact with the page or reload to generate output)';

			return {
				content: [{ kind: 'text', value }],
			};
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
