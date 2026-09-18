/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { hasKey } from '../../../../../base/common/types.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { createBrowserPageLink, DEFAULT_ELEMENT_LABEL, errorResult, getSessionId, playwrightInvoke, resolveBrowserPageId } from './browserToolHelpers.js';
import { browserPageId, pickBrowserParam } from './browserToolParams.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IBrowserAgentVisualsService } from '../features/browserEditorAgentVisualsService.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';

export const HoverElementToolData: IToolData = {
	id: 'hover_element',
	toolReferenceName: BrowserChatToolReferenceName.HoverElement,
	displayName: localize('hoverElementTool.displayName', 'Hover Element'),
	userDescription: localize('hoverElementTool.userDescription', 'Hover over an element in a browser page'),
	modelDescription: 'Hover over an element in a browser page. Provide either a Playwright selector or an element reference.',
	icon: Codicon.cursor,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: `The browser page ID, acquired from context or the open tool.`
			},
			ref: {
				type: 'string',
				description: 'Element reference to hover over.'
			},
			selector: {
				type: 'string',
				description: 'Playwright selector of the element to hover over when "ref" is not available.'
			},
			element: {
				type: 'string',
				description: 'Human-readable description of the element to hover over (e.g., "navigation menu", "tooltip trigger").'
			},
			settleMs: {
				type: 'number',
				description: 'Ms to wait after hover for menus/tooltips to appear (default 400).'
			},
			waitForSelector: {
				type: 'string',
				description: 'Optional selector to wait for visible after hover (e.g. dropdown menu).'
			},
		},
		required: ['pageId', 'element'],
		$comment: 'One of "ref" or "selector" is required.',
	},
};

interface IHoverElementToolParams {
	pageId?: string;
	page_id?: string;
	ref?: string;
	selector?: string;
	element?: string;
	settleMs?: number;
	settle_ms?: number;
	waitForSelector?: string;
	wait_for_selector?: string;
}

export class HoverElementTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IBrowserAgentVisualsService private readonly agentVisuals: IBrowserAgentVisualsService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@IEditorService private readonly editorService: IEditorService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = _context.parameters as IHoverElementToolParams;
		const pageId = browserPageId(params as Record<string, unknown>) ?? params.pageId ?? 'browser';
		const link = createBrowserPageLink(pageId);
		const element = escapeMarkdownSyntaxTokens(params.element ?? DEFAULT_ELEMENT_LABEL);
		return {
			invocationMessage: new MarkdownString(localize('browser.hover.invocation', "Hovering over {0} in {1}", element, link)),
			pastTenseMessage: new MarkdownString(localize('browser.hover.past', "Hovered over {0} in {1}", element, link)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IHoverElementToolParams;
		const sessionId = getSessionId(invocation);
		const rawPageId = browserPageId(params as Record<string, unknown>);
		const resolved = resolveBrowserPageId(rawPageId, this.browserViewService, this.editorService);
		if (hasKey(resolved, { error: true })) {
			return errorResult(resolved.error);
		}
		const pageId = resolved.pageId;

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		if (!selector) {
			return errorResult('Either a "ref" or "selector" parameter is required.');
		}

		await this.agentVisuals.prepareForAction(
			pageId,
			invocation.context?.sessionResource,
			sessionId,
			this.playwrightService,
			selector,
			params.element,
		);

		const settleMs = pickBrowserParam<number>(params as Record<string, unknown>, 'settleMs', 'settle_ms') ?? 400;
		const waitSel = pickBrowserParam<string>(params as Record<string, unknown>, 'waitForSelector', 'wait_for_selector');
		return playwrightInvoke(
			this.playwrightService,
			sessionId,
			pageId,
			async (page, sel, settle, waitFor) => {
				await page.locator(sel).hover();
				if (settle > 0) {
					await page.waitForTimeout(settle);
				}
				if (waitFor) {
					await page.locator(waitFor).waitFor({ state: 'visible', timeout: 8000 });
				}
			},
			selector,
			settleMs,
			waitSel ?? '',
		);
	}
}
