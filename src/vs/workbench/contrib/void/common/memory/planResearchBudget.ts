/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Plan-mode web research budget (see docs/V3CODE-MEMORY-CONTRACT.md + coffee-site repro).
 * Pure -> headless-testable. Enforced in v3codeChatAgent before tool dispatch.
 */

/** Max web_search calls per plan-mode chat session (existing codebase). */
export const PLAN_WEB_SEARCH_MAX = 8;

/** Max web_search calls in plan mode on a greenfield (empty) workspace. */
export const PLAN_WEB_SEARCH_MAX_GREENFIELD = 3;

export function planWebSearchLimit(greenfield: boolean): number {
	return greenfield ? PLAN_WEB_SEARCH_MAX_GREENFIELD : PLAN_WEB_SEARCH_MAX;
}

/** True when another plan-mode web_search should be blocked. */
export function shouldBlockPlanWebSearch(countSoFar: number, greenfield: boolean): boolean {
	return countSoFar >= planWebSearchLimit(greenfield);
}

export function planWebSearchBlockedMessage(greenfield: boolean): string {
	const cap = planWebSearchLimit(greenfield);
	return `Tool error: Plan-mode web research budget exhausted (${cap} searches). Stop searching — write PLAN.md now with the stack choice, phases, and agent task spine from what you already have. Offer to switch to Agent mode for implementation.`;
}

// Plan mode no longer blocks delegation outright: both delegation tools are exposed and
// every plan-mode subagent is coerced to the read-only research profile at dispatch
// (launchSubagent / v3codeChatAgent._subagentProfileForCall). The nested-research-loop
// regression this gate originally fixed is now bounded by the shared depth cap
// (SUBAGENT_MAX_NESTING_DEPTH) — research children cannot delegate at all.
