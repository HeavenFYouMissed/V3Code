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
import { GET_COMPUTED_STYLES_FUNCTION } from './browserAgentScripts.js';
import { createBrowserPageLink, errorResult, getSessionId, invokeFunctionResultToToolResult } from './browserToolHelpers.js';
import { browserPageId, pickBrowserParam } from './browserToolParams.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const GetComputedStylesBrowserToolData: IToolData = {
	id: 'get_computed_styles',
	toolReferenceName: BrowserChatToolReferenceName.GetComputedStyles,
	displayName: localize('getComputedStylesBrowserTool.displayName', 'Get Computed Styles'),
	userDescription: localize('getComputedStylesBrowserTool.userDescription', 'Get resolved CSS on a specific element'),
	modelDescription: 'Get fully resolved computed CSS on a specific DOM node (by ref from read_page or selector). May include reactComponent hint from React fiber when available.',
	icon: Codicon.symbolColor,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			ref: { type: 'string', description: 'Element ref from read_page.' },
			selector: { type: 'string', description: 'Playwright selector when ref unavailable.' },
			element: { type: 'string', description: 'Human description of the element.' },
		},
		required: ['pageId'],
	},
};

export class GetComputedStylesBrowserTool implements IToolImpl {
	constructor(@IPlaywrightService private readonly playwrightService: IPlaywrightService) { }

	async prepareToolInvocation(ctx: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: new MarkdownString(localize('browser.getComputedStyles.invocation', 'Reading computed styles on {0}', createBrowserPageLink((ctx.parameters as { pageId: string }).pageId))),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const raw = invocation.parameters as Record<string, unknown>;
		const pageId = browserPageId(raw);
		const ref = pickBrowserParam<string>(raw, 'ref');
		const selector = pickBrowserParam<string>(raw, 'selector');
		if (!pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		if (!ref && !selector) {
			return errorResult('Provide ref (from read_page) or selector.');
		}
		try {
			const result = await this.playwrightService.invokeFunction(
				getSessionId(invocation), pageId, GET_COMPUTED_STYLES_FUNCTION,
				[{ ref, selector }], 15_000,
			);
			return invokeFunctionResultToToolResult(result);
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
