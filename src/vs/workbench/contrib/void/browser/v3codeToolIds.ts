/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { builtinTools } from '../common/prompt/prompts.js';
import { InternalToolInfo } from '../common/prompt/prompts.js';
import { isSubagentToolAllowed, SubagentProfile } from '../common/toolsServiceTypes.js';

export const V3CODE_TOOL_ID_PREFIX = 'v3code_';
export const V3CODE_MCP_TOOL_ID_PREFIX = 'v3code_mcp_';

const NATIVE_TOOL_ID_OVERRIDES: Record<string, string> = {
	'run_subagent': 'runSubagent',
	'rename_symbol': 'vscode_renameSymbol',
	'list_code_usages': 'vscode_listCodeUsages',
	'run_tests': 'runTests',
	// Playwright-backed integrated browser tools (browserView/)
	'open_browser_page': 'open_browser_page',
	'read_page': 'read_page',
	'click_element': 'click_element',
	'type_in_page': 'type_in_page',
	'screenshot_page': 'screenshot_page',
	'navigate_page': 'navigate_page',
	'hover_element': 'hover_element',
	'drag_element': 'drag_element',
	'handle_dialog': 'handle_dialog',
	'run_playwright_code': 'run_playwright_code',
	'extract_page_data': 'extract_page_data',
	'get_browser_console_logs': 'get_browser_console_logs',
	'reconstruct_page_sources': 'reconstruct_page_sources',
	'get_computed_styles': 'get_computed_styles',
	'watch_page': 'watch_page',
	'save_browser_session': 'save_browser_session',
	'restore_browser_session': 'restore_browser_session',
	'fill_form': 'fill_form',
	'intercept_network': 'intercept_network',
	'get_browser_network_log': 'get_browser_network_log',
	// OS-level computer use (computerUse/). Identity: the native IToolData already uses these ids.
	'computer_read_screen': 'computer_read_screen',
	'computer_read_screen_changes': 'computer_read_screen_changes',
	'computer_screenshot': 'computer_screenshot',
	'computer_click': 'computer_click',
	'computer_type': 'computer_type',
	'computer_key': 'computer_key',
	'computer_scroll': 'computer_scroll',
	'computer_cursor': 'computer_cursor',
	'computer_wait_for_stable': 'computer_wait_for_stable',
	'computer_list_apps': 'computer_list_apps',
	'computer_drag': 'computer_drag',
	'computer_hover': 'computer_hover',
	'computer_clipboard_read': 'computer_clipboard_read',
	'computer_clipboard_write': 'computer_clipboard_write',
	'computer_open_app': 'computer_open_app',
};

/**
 * Model-facing schemas that are executable only through the native tool registry. These
 * must be removed from a request when their runtime contribution is absent (for example,
 * a dev build without the computer-use helper). Advertising a schema that can only fail
 * is worse than honestly making the optional feature unavailable.
 */
export function modelToolNamesMissingNativeRegistration(hasNativeTool: (nativeId: string) => boolean): string[] {
	return Object.entries(NATIVE_TOOL_ID_OVERRIDES)
		.filter(([, nativeId]) => !hasNativeTool(nativeId))
		.map(([modelName]) => modelName)
		.sort();
}

const NATIVE_ID_TO_MODEL_NAME: Record<string, string> = {
	'runSubagent': 'run_subagent',
	'vscode_renameSymbol': 'rename_symbol',
	'vscode_listCodeUsages': 'list_code_usages',
	'runTests': 'run_tests',
	'open_browser_page': 'open_browser_page',
	'read_page': 'read_page',
	'click_element': 'click_element',
	'type_in_page': 'type_in_page',
	'screenshot_page': 'screenshot_page',
	'navigate_page': 'navigate_page',
	'hover_element': 'hover_element',
	'drag_element': 'drag_element',
	'handle_dialog': 'handle_dialog',
	'run_playwright_code': 'run_playwright_code',
	'extract_page_data': 'extract_page_data',
	'get_browser_console_logs': 'get_browser_console_logs',
	'reconstruct_page_sources': 'reconstruct_page_sources',
	'get_computed_styles': 'get_computed_styles',
	'watch_page': 'watch_page',
	'save_browser_session': 'save_browser_session',
	'restore_browser_session': 'restore_browser_session',
	'fill_form': 'fill_form',
	'intercept_network': 'intercept_network',
	'get_browser_network_log': 'get_browser_network_log',
	// OS-level computer use (computerUse/). Identity: the native IToolData already uses these ids.
	'computer_read_screen': 'computer_read_screen',
	'computer_read_screen_changes': 'computer_read_screen_changes',
	'computer_screenshot': 'computer_screenshot',
	'computer_click': 'computer_click',
	'computer_type': 'computer_type',
	'computer_key': 'computer_key',
	'computer_scroll': 'computer_scroll',
	'computer_cursor': 'computer_cursor',
	'computer_wait_for_stable': 'computer_wait_for_stable',
	'computer_list_apps': 'computer_list_apps',
	'computer_drag': 'computer_drag',
	'computer_hover': 'computer_hover',
	'computer_clipboard_read': 'computer_clipboard_read',
	'computer_clipboard_write': 'computer_clipboard_write',
	'computer_open_app': 'computer_open_app',
};

export function mcpNativeToolId(mcpServerName: string, toolName: string): string {
	return `${V3CODE_MCP_TOOL_ID_PREFIX}${mcpServerName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function builtinNativeToolId(toolName: string): string {
	return V3CODE_TOOL_ID_PREFIX + toolName;
}

export function resolveNativeToolId(toolName: string, mcpTools: InternalToolInfo[] | undefined): string | undefined {
	if (toolName in NATIVE_TOOL_ID_OVERRIDES) {
		return NATIVE_TOOL_ID_OVERRIDES[toolName];
	}
	if (toolName in builtinTools) {
		return builtinNativeToolId(toolName);
	}
	const mcpTool = mcpTools?.find(t => t.name === toolName);
	if (mcpTool?.mcpServerName) {
		return mcpNativeToolId(mcpTool.mcpServerName, toolName);
	}
	return undefined;
}

export function modelToolNameFromNativeId(nativeId: string, mcpTools?: readonly InternalToolInfo[]): string | undefined {
	if (nativeId in NATIVE_ID_TO_MODEL_NAME) {
		return NATIVE_ID_TO_MODEL_NAME[nativeId];
	}
	if (nativeId.startsWith(V3CODE_MCP_TOOL_ID_PREFIX)) {
		// Server names may contain underscores, so reversing the encoded id by splitting on
		// the first underscore is ambiguous. Prefer an exact match against the live MCP tools.
		const matchedTool = mcpTools?.find(tool => tool.mcpServerName && mcpNativeToolId(tool.mcpServerName, tool.name) === nativeId);
		if (matchedTool) {
			return matchedTool.name;
		}
		const rest = nativeId.slice(V3CODE_MCP_TOOL_ID_PREFIX.length);
		const idx = rest.indexOf('_');
		if (idx === -1) {
			return rest;
		}
		return rest.slice(idx + 1);
	}
	if (nativeId.startsWith(V3CODE_TOOL_ID_PREFIX)) {
		return nativeId.slice(V3CODE_TOOL_ID_PREFIX.length);
	}
	return undefined;
}

/**
 * Translate VS Code's per-session/per-agent tool enablement snapshot into the names
 * advertised to the model. This is the missing bridge between `.agent.md` `tools:` /
 * Configure Tools and V3Code's own native/XML tool payloads.
 */
export function modelToolNamesDisabledBySelection(
	userSelectedTools: Readonly<Record<string, boolean>> | undefined,
	mcpTools?: readonly InternalToolInfo[],
): string[] {
	if (!userSelectedTools) {
		return [];
	}
	const disabled = new Set<string>();
	for (const [nativeId, enabled] of Object.entries(userSelectedTools)) {
		if (enabled !== false) {
			continue;
		}
		const modelName = modelToolNameFromNativeId(nativeId, mcpTools);
		if (modelName) {
			disabled.add(modelName);
		}
	}
	return [...disabled].sort();
}

/**
 * Build the native tool-selection map handed to VS Code's blocking subagent runner,
 * resolved through the same isSubagentToolAllowed policy the background engine enforces
 * — the two engines answer capability questions identically by construction.
 * The runner otherwise inherits the parent's full Agent-mode surface, including edits,
 * terminal, project switching and MCP tools. Unknown native ids fail closed: a newly
 * registered tool cannot silently escape the subagent boundary. A child never gets a
 * tool the parent disabled (`userSelectedTools[...] === false`).
 *
 * Nested delegation for native children goes through run_subagent only (the native
 * runner owns its own depth accounting); launch_subagent needs a sidebar thread context
 * the native path does not have, so it stays disabled here for both profiles.
 */
export function subagentNativeToolSelection(
	profile: SubagentProfile,
	userSelectedTools: Readonly<Record<string, boolean>> | undefined,
	mcpTools?: InternalToolInfo[],
): Record<string, boolean> {
	const allowed = (modelName: string, isBuiltin: boolean): boolean => {
		if (modelName === 'launch_subagent') return false;
		// run_subagent's own enablement is decided inside the native runner from its depth
		// machinery (and forced off for read-only children); don't pre-disable it here.
		return isSubagentToolAllowed(profile, modelName, isBuiltin, { canDelegate: profile === 'work' });
	};

	const selection: Record<string, boolean> = {};

	for (const [nativeId, enabled] of Object.entries(userSelectedTools ?? {})) {
		const modelName = modelToolNameFromNativeId(nativeId, mcpTools);
		selection[nativeId] = enabled !== false
			&& !!modelName
			&& allowed(modelName, !nativeId.startsWith(V3CODE_MCP_TOOL_ID_PREFIX));
	}

	// Explicitly enumerate every V3Code builtin so an absent key cannot fall back to
	// the native runner's default-enabled behavior.
	for (const modelName of Object.keys(builtinTools)) {
		const nativeId = resolveNativeToolId(modelName, mcpTools);
		if (!nativeId) {
			continue;
		}
		selection[nativeId] = (userSelectedTools?.[nativeId] !== false)
			&& allowed(modelName, true);
	}

	// MCP tools: available to work children when the parent has them enabled; never
	// available to research children.
	for (const tool of mcpTools ?? []) {
		if (tool.mcpServerName) {
			const nativeId = mcpNativeToolId(tool.mcpServerName, tool.name);
			selection[nativeId] = profile === 'work'
				? (userSelectedTools?.[nativeId] !== false)
				: false;
		}
	}

	return selection;
}

/** Read-only (research) native selection — kept as a named entry point for existing
 *  callers/tests; delegates to the shared profile-resolved selection. */
export function readOnlySubagentNativeToolSelection(
	userSelectedTools: Readonly<Record<string, boolean>> | undefined,
	mcpTools?: InternalToolInfo[],
): Record<string, boolean> {
	return subagentNativeToolSelection('research', userSelectedTools, mcpTools);
}
