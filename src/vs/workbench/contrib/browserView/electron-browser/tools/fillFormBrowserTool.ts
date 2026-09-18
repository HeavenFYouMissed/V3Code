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
import { FILL_FORM_FUNCTION } from './browserAgentScripts.js';
import { errorResult, getSessionId, invokeFunctionResultToToolResult } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const FillFormBrowserToolData: IToolData = {
	id: 'fill_form',
	toolReferenceName: BrowserChatToolReferenceName.FillForm,
	displayName: localize('fillFormBrowserTool.displayName', 'Fill Form'),
	userDescription: localize('fillFormBrowserTool.userDescription', 'Fill multiple form fields in one call'),
	modelDescription: 'Fill many fields at once. fields = JSON array of {ref, value} or {label, value} or {selector, value}.',
	icon: Codicon.listOrdered,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			fields: { type: 'string', description: 'JSON array of field objects with value.' },
		},
		required: ['pageId', 'fields'],
	},
};

export class FillFormBrowserTool implements IToolImpl {
	constructor(@IPlaywrightService private readonly playwrightService: IPlaywrightService) { }

	async invoke(invocation: IToolInvocation, _c: CountTokensCallback, _p: ToolProgress, _t: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as { pageId: string; fields: string };
		if (!params.pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		let fields: unknown[];
		try {
			fields = JSON.parse(params.fields);
			if (!Array.isArray(fields)) {
				throw new Error('fields must be a JSON array');
			}
		} catch (e) {
			return errorResult(`Invalid fields JSON: ${e instanceof Error ? e.message : String(e)}`);
		}
		try {
			const result = await this.playwrightService.invokeFunction(
				getSessionId(invocation), params.pageId, FILL_FORM_FUNCTION, [{ fields }], 60_000,
			);
			return invokeFunctionResultToToolResult(result);
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
