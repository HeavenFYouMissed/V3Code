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
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { createBrowserPageLink, errorResult, getSessionId, resolveBrowserPageId } from './browserToolHelpers.js';
import { browserPageId } from './browserToolParams.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';

export const ReadBrowserToolData: IToolData = {
	id: 'read_page',
	toolReferenceName: BrowserChatToolReferenceName.ReadPage,
	displayName: localize('readBrowserTool.displayName', 'Read Page'),
	userDescription: localize('readBrowserTool.userDescription', 'Read the content of a browser page'),
	modelDescription: 'Get a snapshot of the current browser page state. This is better than screenshot.',
	icon: Codicon.fileText,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: `The browser page ID to read, acquired from context or the open tool.`
			},
		},
		required: ['pageId'],
	},
};

interface IReadBrowserToolParams {
	pageId: string;
}

export class ReadBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@IEditorService private readonly editorService: IEditorService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const link = createBrowserPageLink(_context.parameters.pageId);
		return {
			invocationMessage: new MarkdownString(localize('browser.read.invocation', "Reading {0}", link)),
			pastTenseMessage: new MarkdownString(localize('browser.read.past', "Read {0}", link)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IReadBrowserToolParams;
		const sessionId = getSessionId(invocation);
		const rawPageId = browserPageId(invocation.parameters as Record<string, unknown>) ?? params.pageId;
		const resolved = resolveBrowserPageId(rawPageId, this.browserViewService, this.editorService);
		if (hasKey(resolved, { error: true })) {
			return errorResult(resolved.error);
		}

		const summary = await this.playwrightService.getSummary(sessionId, resolved.pageId);
		if (!summary) {
			return errorResult('No page summary available.');
		}

		return {
			content: [{
				kind: 'text',
				value: summary,
			}],
		};
	}
}
