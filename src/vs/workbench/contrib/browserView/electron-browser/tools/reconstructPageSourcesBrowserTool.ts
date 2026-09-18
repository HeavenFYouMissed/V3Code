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
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IBundleReconstructService } from '../../../void/browser/bundleReconstructProxy.js';
import { WEBCRACK_UNAVAILABLE_HINT } from '../../../void/common/bundleReconstructTypes.js';
import { errorResult } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';

export const ReconstructPageSourcesToolId = 'reconstruct_page_sources';

export const ReconstructPageSourcesBrowserToolData: IToolData = {
	id: ReconstructPageSourcesToolId,
	toolReferenceName: BrowserChatToolReferenceName.ReconstructPageSources,
	displayName: localize('reconstructPageSourcesBrowserTool.displayName', 'Reconstruct Page Sources'),
	userDescription: localize('reconstructPageSourcesBrowserTool.userDescription', 'Reconstruct readable source from a minified JS bundle'),
	modelDescription: `Download a production JS bundle URL (from extract_page_data scripts) and reconstruct readable source into the workspace. Path 1: source maps — runs in renderer, no relaunch needed. Path 2: webcrack — currently unavailable on Electron 39 (isolated-vm native build); use method=sourcemap. Default output: .v3code/recon/<hostname>/.`,
	icon: Codicon.fileSymlinkDirectory,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			scriptUrl: {
				type: 'string',
				description: 'Absolute URL of the JS bundle (from extract_page_data scripts[].url).',
			},
			outputDir: {
				type: 'string',
				description: 'Workspace-relative output folder. Default: .v3code/recon/<hostname>/',
			},
			method: {
				type: 'string',
				enum: ['auto', 'sourcemap', 'webcrack'],
				description: 'auto (default): try source map first, then webcrack. sourcemap: map only. webcrack: force webcrack.',
			},
		},
		required: ['scriptUrl'],
	},
};

interface IReconstructPageSourcesParams {
	scriptUrl: string;
	outputDir?: string;
	method?: 'auto' | 'sourcemap' | 'webcrack';
}

function hostnameFromUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_') || 'unknown';
	} catch {
		return 'unknown';
	}
}

export class ReconstructPageSourcesBrowserTool implements IToolImpl {
	constructor(
		@IBundleReconstructService private readonly bundleReconstructService: IBundleReconstructService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IReconstructPageSourcesParams;
		const host = hostnameFromUrl(params.scriptUrl ?? '');
		return {
			invocationMessage: new MarkdownString(localize('browser.reconstructPageSources.invocation', 'Reconstructing sources from {0} into `.v3code/recon/{1}/`', params.scriptUrl ?? 'bundle', host)),
			pastTenseMessage: new MarkdownString(localize('browser.reconstructPageSources.past', 'Reconstructed page sources')),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IReconstructPageSourcesParams;

		if (!params.scriptUrl?.trim()) {
			return errorResult('script_url is required. Run extract_page_data (focus assets) first to get bundle URLs.');
		}

		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return errorResult('No workspace folder open.');
		}

		const host = hostnameFromUrl(params.scriptUrl);
		const outputDirRel = (params.outputDir?.trim() || `.v3code/recon/${host}`).replace(/^[/\\]+/, '');
		const method = params.method ?? 'auto';

		try {
			const result = await this.bundleReconstructService.reconstruct({
				bundleUrl: params.scriptUrl.trim(),
				workspaceRootAbs: folder.uri.fsPath,
				outputDirRel,
				method,
			});

			const lines: string[] = [];
			if (result.ok) {
				lines.push(`Reconstruction: **${result.method}**`);
				lines.push(`Output: \`${result.outputDirAbs}\``);
				lines.push(`Bundle: ${(result.bundleBytes / 1024).toFixed(1)} KB → ${result.filesWritten} files (${(result.bytesWritten / 1024).toFixed(1)} KB written)`);
				if (result.sourceMapUrl) {
					lines.push(`Source map: ${result.sourceMapUrl}`);
				}
				if (result.bundleType) {
					lines.push(`Bundle type: ${result.bundleType}`);
				}
				if (result.samplePaths.length > 0) {
					lines.push('', 'Sample files:', ...result.samplePaths.map(p => `- ${p}`));
				}
				lines.push('', 'Open the output folder in the explorer and use read_file / semantic_search on the reconstructed tree.');
			} else {
				lines.push(`Reconstruction failed: ${result.error ?? 'unknown error'}`);
				lines.push(`Node ${result.nodeVersion}; webcrack available: ${result.webcrackAvailable}`);
				if (!result.webcrackAvailable) {
					lines.push('', WEBCRACK_UNAVAILABLE_HINT);
				}
			}

			return {
				content: [{ kind: 'text', value: lines.join('\n') }],
			};
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
