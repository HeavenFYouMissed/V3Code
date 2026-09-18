/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure route-decision core (part of S2 of the adaptive routing engine).
 *
 * Given an escalation SIGNAL, the current rung, and the ceiling, decide the CHEAPEST
 * action that increases capability — implementing the plan's decision map:
 *
 *   - below Anthropic (Local/V3Fast/V3Pro) → swap the executor one rung up
 *   - crossing into Anthropic (→ OpusEasy)  → swap to Opus Hybrid + advisor 'easy'
 *   - on OpusEasy, "needs better judgment"  → bump the advisor easy→hard WITHOUT swapping
 *                                             the Haiku executor (options-only, cheapest)
 *   - OpusHard → FullOpus                   → swap to a real claude-opus-4-8, drop advisor
 *   - a `danger` signal short-circuits straight to OpusEasy (advisor on immediately)
 *
 * Invariants: UPWARD ONLY (never lowers the rung) and clamped to the ceiling.
 *
 * This module is PURE + headless-testable. The memory-backed `classifyDanger` (structural
 * signals) and the agent-loop wiring live in later slices; this is just the math.
 */

import { RouterRungId, clampToCeiling, nextRung, rungIndex } from './routerLadder.js';

/** Why the router wants to escalate. Structural memory signals map onto these kinds in S2. */
export type RouteSignalKind = 'needsStrongerExecutor' | 'needsBetterJudgment' | 'danger';

export interface RouteSignal {
	readonly kind: RouteSignalKind;
	/** The rule that fired (e.g. '3-strike', 'spiral-guard', 'run_tests-failed', 'danger-preflight'). */
	readonly rule: string;
}

export type RouteAction =
	| { readonly type: 'hold' }
	| { readonly type: 'swapExecutor'; readonly toRung: RouterRungId }
	| { readonly type: 'bumpAdvisor'; readonly from: 'easy'; readonly to: 'hard' } // options-only, same executor
	| { readonly type: 'toFullOpus' };

/**
 * Decide the cheapest capability-increasing action for a signal. Pure; always upward and
 * clamped to `ceiling`. Returns `{ type: 'hold' }` when nothing cheaper-yet-stronger exists.
 */
export function decideAction(signal: RouteSignal, current: RouterRungId, ceiling: RouterRungId): RouteAction {
	// Danger short-circuit: jump straight to at least OpusEasy (advisor on), clamped to ceiling.
	if (signal.kind === 'danger') {
		const dangerFloor = clampToCeiling('OpusEasy', ceiling);
		if (rungIndex(dangerFloor) > rungIndex(current)) {
			return dangerFloor === 'FullOpus' ? { type: 'toFullOpus' } : { type: 'swapExecutor', toRung: dangerFloor };
		}
	}

	// Cheapest judgment bump: on OpusEasy, raise the advisor easy→hard WITHOUT swapping the
	// Haiku executor. Only when the ceiling actually permits OpusHard-grade judgment.
	if (signal.kind === 'needsBetterJudgment' && current === 'OpusEasy' && rungIndex(ceiling) >= rungIndex('OpusHard')) {
		return { type: 'bumpAdvisor', from: 'easy', to: 'hard' };
	}

	const target = nextRung(current, ceiling); // upward-only, ceiling-capped
	if (target === current) {
		return { type: 'hold' }; // already at the ceiling / cannot go higher
	}
	if (target === 'FullOpus') {
		return { type: 'toFullOpus' }; // real Opus executor, advisor dropped
	}
	return { type: 'swapExecutor', toRung: target };
}

/**
 * Resolve an action into the rung the turn should now run at, plus any options-only override
 * (the advisor bump keeps the current rung but forces advisorEffort 'hard'). The caller passes
 * `rung` through `resolveRung()` and applies `advisorEffortOverride` on top.
 */
export function applyAction(action: RouteAction, current: RouterRungId): { rung: RouterRungId; advisorEffortOverride?: 'hard' } {
	switch (action.type) {
		case 'hold': return { rung: current };
		case 'swapExecutor': return { rung: action.toRung };
		case 'toFullOpus': return { rung: 'FullOpus' };
		case 'bumpAdvisor': return { rung: current, advisorEffortOverride: 'hard' };
	}
}

/**
 * Pick the STARTING rung for a fresh turn from a 0..1 difficulty estimate, clamped to the
 * ceiling. Falls back off `Local` to `V3Fast` until the bundled model is downloaded (no
 * cold-start on an absent local model).
 */
export function pickStartingTier(difficulty: number, ceiling: RouterRungId, localReady: boolean): RouterRungId {
	const d = Math.max(0, Math.min(1, difficulty));
	const start: RouterRungId = d >= 0.66 ? 'V3Pro'
		: d >= 0.33 ? 'V3Fast'
			: (localReady ? 'Local' : 'V3Fast');
	return clampToCeiling(start, ceiling);
}
