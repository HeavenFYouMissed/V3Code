/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { V3_MULTITASK_MODE_NAME } from './v3MultitaskMode.js';

/** Stable id/name for V3Code's permanent built-in Debug mode (display label is `Debug`). */
export const V3_DEBUG_MODE_NAME = 'debug';

/**
 * Both V3Code built-ins that travel over the Agent wire kind, resolved from the persisted
 * request `modeName` (case-insensitive). Shared by the native chat agent so a saved Debug
 * or Multitask chat reopens in the mode it was written in instead of falling back to Agent.
 */
export function resolveV3BuiltinModeName(modeName: string | undefined): 'multitask' | 'debug' | undefined {
	const lower = modeName?.toLowerCase();
	if (lower === V3_MULTITASK_MODE_NAME.toLowerCase()) { return 'multitask'; }
	if (lower === V3_DEBUG_MODE_NAME) { return 'debug'; }
	return undefined;
}

/**
 * Debug mode's bounded fix surface on top of the read-only tools. Every one of these is an
 * approval-gated builtin (edits or terminal) — no delete, git write, browser mutation or MCP.
 */
export const V3_DEBUG_FIX_TOOL_NAMES = Object.freeze([
	'create_file_or_folder', 'rewrite_file', 'append_file', 'edit_file', 'run_command', 'run_tests',
] as const);

/** Exact `ask_user` option labels the doctrine tells the model to use (kept verbatim for tests). */
export const V3_DEBUG_ASK_OPTIONS = Object.freeze({
	reproduced: 'Reproduced — continue to root cause',
	notReproduced: 'Could not reproduce — re-check my instrumentation',
	fixVerified: 'Fix verified — clean up instrumentation',
	stillBroken: 'Still broken — keep instrumentation and re-analyse',
} as const);

/** Report headings the Debug doctrine requires, in order. */
export const V3_DEBUG_REPORT_HEADINGS = Object.freeze([
	'What the user saw', 'Reproduction', 'First point of divergence', 'Hypotheses and verdicts',
	'Root cause', 'The fix', 'Guard added', 'Verification',
] as const);
