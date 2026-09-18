/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { BrowserViewUri } from '../../../../../platform/browserView/common/browserViewUri.js';
import { IInvokeFunctionResult, IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IToolInvocation, IToolResult } from '../../../chat/common/tools/languageModelToolsService.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../common/browserView.js';

// eslint-disable-next-line local/code-import-patterns
import type { Page } from 'playwright-core';

export const DEFAULT_ELEMENT_LABEL = localize('browser.element', 'element');

/** Model mis-reads: sharing *state* is `shared`, but page_id must be the bracketed editor id. */
const PAGE_ID_MISALIAS = new Set(['shared', 'notshared', 'not_shared', 'browser', 'page', 'active', 'visible']);

/**
 * Normalize page id input: trim, strip `[uuid]` wrappers from context listings.
 */
export function normalizeBrowserPageIdInput(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	let s = raw.trim();
	const bracketed = s.match(/^\[([^\]]+)\]$/);
	if (bracketed) {
		s = bracketed[1].trim();
	}
	return s || undefined;
}

/**
 * Resolve a tool pageId/page_id to a real {@link BrowserEditorInput.id}.
 * Maps the common LLM mistake of passing `"shared"` (sharing state) to the actual shared tab.
 */
export function resolveBrowserPageId(
	rawPageId: string | undefined,
	browserViewService: IBrowserViewWorkbenchService,
	editorService: IEditorService,
): { pageId: string } | { error: string } {
	const normalized = normalizeBrowserPageIdInput(rawPageId);
	const editors = [...browserViewService.getKnownBrowserViews().values()];
	const byId = new Map(editors.map(e => [e.id, e]));

	if (normalized && byId.has(normalized)) {
		return { pageId: normalized };
	}

	const shared = editors.filter(e => e.model?.sharingState === BrowserViewSharingState.Shared);
	const treatAsAlias = !normalized || PAGE_ID_MISALIAS.has(normalized.toLowerCase());
	// An explicit stale id must never redirect a read or mutation to another tab.
	if (normalized && !treatAsAlias) {
		return { error: `Page "${normalized}" not found. Use open_browser_page or select an existing shared page ID.` };
	}

	if (treatAsAlias) {
		if (shared.length === 1) {
			return { pageId: shared[0].id };
		}
		const active = editorService.activeEditor;
		if (active instanceof BrowserEditorInput && shared.some(s => s.id === active.id)) {
			return { pageId: active.id };
		}
		if (shared.length > 1) {
			const list = formatBrowserEditorList(editorService, shared, { numbered: true });
			const hint = rawPageId ? `Invalid page_id "${rawPageId}". ` : '';
			return { error: `${hint}Multiple browser tabs are shared — pass the exact page_id from:\n${list}` };
		}
		return { error: 'No browser pages are shared with the agent. Click "Share with Agent" on a browser tab or call open_browser_page with a URL.' };
	}

	return { error: 'No page_id provided. Use open_browser_page first or share an existing tab.' };
}

/**
 * Extracts the session ID from a tool invocation context.
 * Falls back to a default string when no session context is available.
 */
export function getSessionId(invocation: IToolInvocation): string {
	return invocation.context?.sessionResource?.toString() ?? '<default>';
}

export interface FormatBrowserEditorLinesOptions {
	indent?: string;
	numbered?: boolean;
	excludeIds?: boolean;
	agentNetworkFilterService?: IAgentNetworkFilterService;
}

/**
 * Formats a list of browser editors as summary lines such as
 * `- [pageId] Title (url) (active)`. Active/visible hints are
 * derived from the editor service automatically.
 *
 * When {@link FormatBrowserEditorLinesOptions.agentNetworkFilterService} is
 * provided, pages whose URL is blocked by network policy are masked to avoid
 * leaking title or URL to the model.
 */
export function formatBrowserEditorList(editorService: IEditorService, editors: readonly BrowserEditorInput[], options?: FormatBrowserEditorLinesOptions): string {
	const activeEditor = editorService.activeEditor;
	const visibleEditors = new Set(editorService.visibleEditors);
	const indent = options?.indent ?? '';
	const filterService = options?.agentNetworkFilterService;
	return editors.map((editor, index) => {
		const url = editor.url || 'about:blank';

		// If the page URL is blocked by network policy, mask its details.
		let blocked = false;
		if (filterService && url !== 'about:blank') {
			try { blocked = !filterService.isUriAllowed(URI.parse(url)); } catch { }
		}

		const title = blocked ? localize('browser.blockedByPolicy', "Blocked by network domain policy") : (editor.title || 'Untitled');
		const displayUrl = blocked ? '' : ` (${url})`;
		const hint = editor === activeEditor ? ' (active)' : visibleEditors.has(editor) ? ' (visible)' : ' (not visible)';
		const id = options?.excludeIds ? '' : `[${editor.id}] `;

		// By default, use numbers only if we're excluding IDs, so models don't get confused about which ID to use.
		const bullet = (options?.numbered ?? options?.excludeIds) ? `${index + 1}. ` : '- ';
		return `${indent}${bullet}${id}${title}${displayUrl}${hint}`;
	}).join('\n');
}

/**
 * Creates a markdown link to a browser page.
 */
export function createBrowserPageLink(pageId: string | URI): string {
	if (typeof pageId === 'string') {
		pageId = BrowserViewUri.forId(pageId);
	}
	return `[${BrowserEditorInput.DEFAULT_LABEL}](${pageId.toString()}?vscodeLinkType=browser)`;
}

/**
 * Shared helper for running a Playwright function against a page and returning its result.
 */
export async function playwrightInvokeRaw<TArgs extends unknown[], TReturn>(
	playwrightService: IPlaywrightService,
	sessionId: string,
	pageId: string,
	fn: (page: Page, ...args: TArgs) => Promise<TReturn>,
	...args: TArgs
): Promise<TReturn> {
	return playwrightService.invokeFunctionRaw(sessionId, pageId, fn.toString(), ...args);
}

/**
 * Shared helper for running a Playwright function against a page and returning
 * a tool result. Handles success/error formatting.
 *
 * Calls {@link IPlaywrightService.invokeFunction} without a timeout so the
 * action runs to completion — no deferred results are ever produced.
 */
export async function playwrightInvoke<TArgs extends unknown[], TReturn>(
	playwrightService: IPlaywrightService,
	sessionId: string,
	pageId: string,
	fn: (page: Page, ...args: TArgs) => Promise<TReturn>,
	...args: TArgs
): Promise<IToolResult> {
	try {
		const result = await playwrightService.invokeFunction(sessionId, pageId, fn.toString(), args);
		return invokeFunctionResultToToolResult(result);
	} catch (e) {
		return errorResult(e instanceof Error ? e.message : String(e));
	}
}

/**
 * Convert an {@link IInvokeFunctionResult} to an {@link IToolResult},
 * including any {@link IInvokeFunctionResult.deferredResultId}.
 */
export function invokeFunctionResultToToolResult(result: IInvokeFunctionResult, code?: string): IToolResult {
	const content: IToolResult['content'] = [];
	if (result.result !== undefined) {
		content.push({ kind: 'text', value: `Result: ${JSON.stringify(result.result)}` });
	}
	if (result.error) {
		content.push({ kind: 'text', value: `Error: ${result.error}` });
	}
	if (result.deferredResultId) {
		content.push({ kind: 'text', value: `Timed out before completion. Pass deferredResultId="${result.deferredResultId}" with the same page_id (no code) to keep waiting, or increase timeout_ms.` });
	}
	content.push({ kind: 'text', value: result.summary });
	return {
		content,
		...(code ? {
			toolResultDetails: {
				input: code,
				inputLanguage: 'javascript',
				output: result.result || result.error
					? [{ type: 'embed' as const, isText: true, value: JSON.stringify(result.result ?? result.error, null, 2) }]
					: [],
				isError: !!result.error,
			},
		} : {}),
	};
}

export function errorResult(message: string): IToolResult {
	return {
		content: [{ kind: 'text', value: message }],
		toolResultError: message,
	};
}

/**
 * Checks whether a browser editor with the same host (hostname + port) already exists.
 *
 * @returns All matching {@link BrowserEditorInput}s.
 */
export function findExistingPagesByHost(
	browserViewService: IBrowserViewWorkbenchService,
	url: string,
	options?: {
		includeBlank?: boolean;
		sharingState?: BrowserViewSharingState;
	}
): BrowserEditorInput[] {
	const parsed = URL.parse(url);
	if (!parsed || (parsed.protocol !== 'file:' && !parsed.host)) {
		return [];
	}

	const results: BrowserEditorInput[] = [];
	for (const editor of browserViewService.getKnownBrowserViews().values()) {
		if (!(editor instanceof BrowserEditorInput)) {
			continue;
		}
		if (options?.sharingState && editor.model?.sharingState !== options.sharingState) {
			continue;
		}
		const editorUrl = URL.parse(editor.url || '');
		if (
			options?.includeBlank && (!editor.url || editor.url === 'about:blank') ||
			editorUrl?.host === parsed.host ||
			(parsed.protocol === 'file:' && editorUrl?.protocol === 'file:') ||
			(editorUrl?.host && parsed.host && (
				editorUrl.host.endsWith('.' + parsed.host) ||
				parsed.host.endsWith('.' + editorUrl.host)
			))
		) {
			results.push(editor);
		}
	}
	return results;
}

/**
 * Builds the "already open" tool result returned when an existing page with the
 * same host is found by {@link findExistingPagesByHost}.
 */
export async function getExistingPagesResult(
	editorService: IEditorService,
	existing: BrowserEditorInput[],
	formatOptions?: FormatBrowserEditorLinesOptions
): Promise<IToolResult | undefined> {
	if (existing.length === 0) {
		return undefined;
	}

	const list = formatBrowserEditorList(editorService, existing, { indent: '  ', ...formatOptions });
	const links = existing.map(e => createBrowserPageLink(e.id));
	return {
		content: [{
			kind: 'text',
			value: `At least one similar page is already open:\n${list}\n\nUse an existing page or pass \`forceNew: true\` to open a new one.`
		}],
		toolResultMessage: new MarkdownString(localize('browser.open.alreadyOpen', "Already open: {0}", links.join(', '))),
	};
}
