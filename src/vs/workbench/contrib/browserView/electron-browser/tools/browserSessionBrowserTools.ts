/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IPlaywrightService, type IBrowserStorageState } from '../../../../../platform/browserView/common/playwrightService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ToolDataSource, type CountTokensCallback, type IToolData, type IToolImpl, type IToolInvocation, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { APPLY_STORAGE_STATE_FUNCTION, EXPORT_STORAGE_STATE_FUNCTION } from './browserAgentScripts.js';
import { errorResult, getSessionId } from './browserToolHelpers.js';
import { browserPageId, pickBrowserParam } from './browserToolParams.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

function hostnameFromPageUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_') || 'default';
	} catch {
		return 'default';
	}
}

function sessionFileUri(workspaceFolder: URI, sessionName: string): URI {
	const safe = sessionName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
	return URI.joinPath(workspaceFolder, '.v3code', 'browser-sessions', `${safe}.json`);
}

export const SaveBrowserSessionBrowserToolData: IToolData = {
	id: 'save_browser_session',
	toolReferenceName: BrowserChatToolReferenceName.SaveBrowserSession,
	displayName: localize('saveBrowserSessionBrowserTool.displayName', 'Save Browser Session'),
	userDescription: localize('saveBrowserSessionBrowserTool.userDescription', 'Persist cookies and localStorage'),
	modelDescription: 'Save cookies + localStorage to .v3code/browser-sessions/<name>.json after logging in.',
	icon: Codicon.save,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			sessionName: { type: 'string', description: 'Session file name (default: hostname).' },
		},
		required: ['pageId'],
	},
};

export class SaveBrowserSessionBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) { }

	async invoke(invocation: IToolInvocation, _c: CountTokensCallback, _p: ToolProgress, _t: CancellationToken): Promise<IToolResult> {
		const raw = invocation.parameters as Record<string, unknown>;
		const pageId = browserPageId(raw);
		if (!pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return errorResult('No workspace folder open.');
		}
		try {
			const sid = getSessionId(invocation);
			// Use EXPORT_STORAGE_STATE_FUNCTION — avoids CDP Storage.getCookies which is
			// blocked in Electron's sandboxed WebContentsView. Uses context().cookies() +
			// page.evaluate() for localStorage instead.
			const result = await this.playwrightService.invokeFunction(
				sid, pageId, EXPORT_STORAGE_STATE_FUNCTION, [], 15_000,
			);
			if (result.error) {
				return errorResult(result.error);
			}
			const state = result.result as IBrowserStorageState;
			const summary = await this.playwrightService.getSummary(sid, pageId);
			const urlMatch = summary.match(/^URL: (.+)$/m);
			const sessionName = pickBrowserParam<string>(raw, 'sessionName', 'session_name');
			const host = sessionName?.trim() || hostnameFromPageUrl(urlMatch?.[1] ?? 'default');
			const uri = sessionFileUri(folder.uri, host);
			await this.fileService.createFolder(URI.joinPath(folder.uri, '.v3code', 'browser-sessions'));
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(state, null, 2)));
			return {
				content: [{
					kind: 'text',
					value: `Saved browser session "${host}" (${state.cookies?.length ?? 0} cookies, ${state.origins?.length ?? 0} origins) → ${uri.fsPath}`,
				}],
			};
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}

export const RestoreBrowserSessionBrowserToolData: IToolData = {
	id: 'restore_browser_session',
	toolReferenceName: BrowserChatToolReferenceName.RestoreBrowserSession,
	displayName: localize('restoreBrowserSessionBrowserTool.displayName', 'Restore Browser Session'),
	userDescription: localize('restoreBrowserSessionBrowserTool.userDescription', 'Restore saved cookies and localStorage'),
	modelDescription: 'Load .v3code/browser-sessions/<name>.json onto the page. Reloads by default.',
	icon: Codicon.history,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'Browser page ID.' },
			sessionName: { type: 'string', description: 'Session file name (default: hostname).' },
			reload: { type: 'boolean', description: 'Reload page after restore (default true).' },
		},
		required: ['pageId'],
	},
};

export class RestoreBrowserSessionBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) { }

	async invoke(invocation: IToolInvocation, _c: CountTokensCallback, _p: ToolProgress, _t: CancellationToken): Promise<IToolResult> {
		const raw = invocation.parameters as Record<string, unknown>;
		const pageId = browserPageId(raw);
		if (!pageId) {
			return errorResult(`Use '${OpenPageToolId}' first.`);
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return errorResult('No workspace folder open.');
		}
		try {
			const sid = getSessionId(invocation);
			const summary = await this.playwrightService.getSummary(sid, pageId);
			const urlMatch = summary.match(/^URL: (.+)$/m);
			const sessionName = pickBrowserParam<string>(raw, 'sessionName', 'session_name');
			const host = sessionName?.trim() || hostnameFromPageUrl(urlMatch?.[1] ?? 'default');
			const uri = sessionFileUri(folder.uri, host);
			if (!(await this.fileService.exists(uri))) {
				return errorResult(`No saved session at ${uri.fsPath}. Call save_browser_session after logging in.`);
			}
			const buf = await this.fileService.readFile(uri);
			const state = JSON.parse(buf.value.toString()) as IBrowserStorageState;
			try {
				await this.playwrightService.importStorageState(sid, pageId, state);
			} catch {
				await this.playwrightService.invokeFunction(sid, pageId, APPLY_STORAGE_STATE_FUNCTION, [state]);
			}
			const reloadParam = pickBrowserParam<boolean | string>(raw, 'reload');
			const shouldReload = reloadParam !== false && reloadParam !== 'false';
			if (shouldReload) {
				await this.playwrightService.invokeFunctionRaw(sid, pageId, 'async (page) => { await page.reload({ waitUntil: "domcontentloaded" }); }');
			}
			return {
				content: [{
					kind: 'text',
					value: `Restored browser session "${host}" from ${uri.fsPath}${shouldReload ? ' and reloaded the page.' : '.'}`,
				}],
			};
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
}
