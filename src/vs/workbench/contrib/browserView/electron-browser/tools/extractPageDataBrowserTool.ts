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
import { EXTRACT_PAGE_DATA_FUNCTION } from './browserPageExtractScript.js';
import { createBrowserPageLink, errorResult, getSessionId, invokeFunctionResultToToolResult } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const ExtractPageDataToolId = 'extract_page_data';

export const ExtractPageDataBrowserToolData: IToolData = {
	id: ExtractPageDataToolId,
	toolReferenceName: BrowserChatToolReferenceName.ExtractPageData,
	displayName: localize('extractPageDataBrowserTool.displayName', 'Extract Page Data'),
	userDescription: localize('extractPageDataBrowserTool.userDescription', 'Extract structured page data for replication or analysis'),
	modelDescription: `Extract structured JSON from a live browser page: assets (scripts, CSS, images, network resources), DOM structure (headings, forms, meta, JSON-LD), computed styles (CSS variables, sample element styles), and framework hints (Next.js, React, Nuxt). Use for site replication, UI cloning, security recon, or understanding how a page is built. Prefer this over read_page when you need packages, stylesheets, or style tokens — read_page is for interaction refs.`,
	icon: Codicon.json,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: 'The browser page ID from open_browser_page.',
			},
			focus: {
				type: 'string',
				enum: ['full', 'assets', 'structure', 'styles', 'network'],
				description: 'What to extract. Default full. assets=scripts/CSS/images/resources; structure=headings/meta/forms; styles=CSS variables + sample computed styles; network=performance resource entries only.',
			},
		},
		required: ['pageId'],
	},
};

interface IExtractPageDataParams {
	pageId: string;
	focus?: 'full' | 'assets' | 'structure' | 'styles' | 'network';
}

export class ExtractPageDataBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const link = createBrowserPageLink(context.parameters.pageId);
		return {
			invocationMessage: new MarkdownString(localize('browser.extractPageData.invocation', "Extracting structured data from {0}", link)),
			pastTenseMessage: new MarkdownString(localize('browser.extractPageData.past', "Extracted structured data from {0}", link)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IExtractPageDataParams;
		const sessionId = getSessionId(invocation);

		if (!params.pageId) {
			return errorResult(`No page ID provided. Use '${OpenPageToolId}' first.`);
		}

		const focus = params.focus ?? 'full';
		try {
			const result = await this.playwrightService.invokeFunction(
				sessionId,
				params.pageId,
				EXTRACT_PAGE_DATA_FUNCTION,
				[{ focus }],
				15_000,
			);
			return invokeFunctionResultToToolResult(result);
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
