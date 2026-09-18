/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Explicit authenticated browser surface; never widen to arbitrary editor tools. */
export const MCP_BROWSER_TOOLS: ReadonlySet<string> = new Set([
	'open_browser_page', 'read_page', 'screenshot_page', 'get_browser_console_logs',
	'click_element', 'type_in_page', 'navigate_page', 'hover_element', 'drag_element',
	'fill_form', 'handle_dialog', 'run_playwright_code', 'extract_page_data',
	'get_computed_styles', 'get_browser_network_log', 'intercept_network', 'list_pages', 'close_page',
]);
