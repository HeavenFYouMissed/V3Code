/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure loop-breaker predicates (see docs/V3CODE-MEMORY-FAILURE-ANALYSIS.md).
 *
 * The agent loop used to classify only a fixed set of tool NAMES as read-only, so a read-only shell
 * command run through `run_command` (e.g. `ls -la`) looked like real work and reset the anti-spiral
 * streak — letting the agent alternate `ls_dir` with `ls -la` forever. These helpers classify the
 * actual shell command text, and normalize near-identical inspections to one dedup signature, so the
 * spiral guards in v3codeChatAgent actually bite. Pure -> headless-testable.
 */

/** Terminal tools whose `command` param we inspect. */
export const TERMINAL_TOOL_NAMES = ['run_command', 'run_persistent_command'] as const;

/** Workspace-listing/tree tools (a subset of read-only) that yield nothing new when repeated. */
export const INSPECTION_TOOL_NAMES = ['ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files'] as const;

/** Read-only shell commands: never mutate state, so they count as read-only for the streak. */
const READONLY_SHELL_RE = /^(?:cd\s+[^&|;]+&&\s*)?(?:ls|pwd|cat|find|tree|head|tail|wc|stat|file|which|echo|du|df|git\s+(?:status|log|diff|branch|show))\b/i;

/** Read-only shell commands that are specifically WORKSPACE INSPECTION (listing/walking). */
const INSPECTION_SHELL_RE = /^(?:cd\s+[^&|;]+&&\s*)?(?:ls|tree|find)\b/i;

export function isReadOnlyShellCommand(command: string): boolean {
	return READONLY_SHELL_RE.test((command ?? '').trim());
}

export function isInspectionShellCommand(command: string): boolean {
	return INSPECTION_SHELL_RE.test((command ?? '').trim());
}

export function isTerminalTool(toolName: string): boolean {
	return (TERMINAL_TOOL_NAMES as readonly string[]).includes(toolName);
}

/** True if this tool call is read-only (read-only tool name, OR a read-only shell command). */
export function isReadOnlyCall(toolName: string, isReadOnlyToolName: boolean, command: string): boolean {
	return isReadOnlyToolName || (isTerminalTool(toolName) && isReadOnlyShellCommand(command));
}

/** True if this tool call is a workspace inspection (listing/tree of the same workspace). */
export function isInspectionCall(toolName: string, command: string): boolean {
	return (INSPECTION_TOOL_NAMES as readonly string[]).includes(toolName)
		|| (isTerminalTool(toolName) && isInspectionShellCommand(command));
}

/**
 * Collapse near-identical inspections to ONE dedup key so the repeat guard catches them — WITHOUT
 * collapsing genuinely different targets. We strip pipes, redirects, and flags from a shell command
 * (so `ls -la` and `ls -la | head -30` coalesce) but KEEP the positional path, and we key non-shell
 * inspection tools by tool name + their params (the path/query). Previously non-shell tools were keyed
 * by tool name alone, so `get_dir_tree(root)` and `get_dir_tree(.v3code)` looked "equivalent" and the
 * repeat guard nagged on a legitimate second listing of a DIFFERENT directory (false positive). Now
 * the same path twice is caught; two different paths are not. (The aggregate per-turn inspection CAP is
 * what bounds "too much listing overall" — that is intentionally path-agnostic and separate from this.)
 */
export function normalizedInspectionSignature(toolName: string, command: string, fallbackParamsJson: string): string {
	if (isInspectionCall(toolName, command)) {
		if (isTerminalTool(toolName)) {
			// keep the path (positional args); drop only flags + anything piped/redirected
			const head = (command ?? '').split(/[|>]/)[0].replace(/\s+-{1,2}[\w-]+/g, '').replace(/\s+/g, ' ').trim();
			return `inspect:${head}`;
		}
		// non-shell inspection tool: distinguish by its target (path/query) so different dirs differ
		return `inspect:${toolName}:${(fallbackParamsJson ?? '').trim()}`;
	}
	return `${toolName}:${fallbackParamsJson}`;
}

/**
 * Tools whose result depends on the world outside the transcript, so repeating one is not a spiral.
 *
 * The repeat guard's premise is that an identical call with identical arguments returns nothing new.
 * That holds for `read_file` and `ls_dir`. It does not hold for computer use: the screen, the
 * frontmost application, the pointer, and the clipboard all change without V3Code touching them, and
 * `computer_read_screen_changes` compares against a baseline that ADVANCES on every call — so
 * identical arguments are supposed to produce a different answer each time.
 *
 * Two calls with no `pid` are byte-identical on the wire even when a different application was in
 * front for each, which is how a legitimate observation loop got flagged. And the guard fires on the
 * SECOND call, while `.v3code/skills/computer-use/SKILL.md` tells the agent to wait for slow work by
 * polling — re-reading until something arrives. Warning the agent off the loop its own instructions
 * prescribe is worse than not guarding at all, because the agent believes the warning and stops
 * looking.
 *
 * Scoped to computer use because that is the case actually observed. The browser tools plausibly have
 * the same property — `screenshot_page` twice while a page loads is legitimate — but that has not been
 * seen misfire, so it is deliberately left alone rather than widened on a guess.
 */
export function isExternalObservationTool(toolName: string): boolean {
	return (toolName ?? '').startsWith('computer_');
}

/**
 * Hard cap on workspace listings per turn before further inspection is blocked outright.
 *
 * Raised from 5: the cap counts DISTINCT targets, not repeats (see normalizedInspectionSignature),
 * so a legitimate multi-directory investigation in a large repo — checking browser/, common/, test/,
 * electron-main/, then a build dir — exhausted the budget while every listing returned NEW
 * information. The repeat guard already catches the actual spiral (the SAME target twice), which is
 * the failure this cap was added for; this number only needs to stop unbounded walking.
 */
export const MAX_WORKSPACE_INSPECTIONS = 12;
