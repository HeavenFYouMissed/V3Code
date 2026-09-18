/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Per-turn adaptive routing — turn-outcome tracker (Phase 1 of adaptive_routing_v3).
 *
 * Each turn is born on ONE provider; escalation happens BETWEEN turns from the last
 * turn's evidence (no mid-turn swaps, no transcript conversion, no cache loss). This
 * module is the pure state machine: record how a turn went, then decide the NEXT turn's
 * starting rung — escalate when troubled, decay back toward the base when things are
 * quiet again (Daniel's escalate / de-escalate loop, turn-granular).
 *
 * PURE + headless-testable. Wiring into v3codeChatAgent (feeding outcomes from the
 * failure gate / spiral guard / self-escalation tool, and consuming startingRungFor at
 * _resolveModelSelection) is the Phase-1 integration slice, behind `v3code.router.adaptive`.
 */

import { RouterRungId, clampToCeiling, nextRung, rungIndex, ROUTER_LADDER } from './routerLadder.js';
import { decideAction, applyAction } from './routeDecision.js';

export interface TurnOutcome {
	/** Failure-gate hits (3-strike `failuresByKey`) during the turn. */
	readonly failures: number;
	/** The spiral guard (repeated identical tool calls) fired. */
	readonly spiraled: boolean;
	/** A test/verify step ran and failed. */
	readonly testsFailed: boolean;
	/** The model itself called the escalate_model tool (Phase 1.5). */
	readonly selfEscalated: boolean;
}

export const CLEAN_TURN: TurnOutcome = { failures: 0, spiraled: false, testsFailed: false, selfEscalated: false };

const isTroubled = (o: TurnOutcome): boolean => o.failures > 0 || o.spiraled || o.testsFailed || o.selfEscalated;

interface SessionRouteState {
	/** Rung the session is currently pinned to (undefined = base). */
	rung: RouterRungId | undefined;
	/** Consecutive troubled turns (drives the OpusEasy jump). */
	troubledStreak: number;
	/** Consecutive clean turns at the current rung (drives decay back down). */
	cleanStreak: number;
}

/** Clean turns required at an escalated rung before de-escalating one rung. */
const DECAY_AFTER_CLEAN_TURNS = 2;
/** Troubled streak at which we stop crawling and jump straight to the advisor (OpusEasy). */
const JUMP_TO_ADVISOR_AT = 2;

/**
 * Tracks per-session turn outcomes and picks the next turn's starting rung.
 * Escalation is between-turns and upward-only within a streak; de-escalation only ever
 * changes the NEXT turn's starting rung (never a live turn), and decays one rung per
 * `DECAY_AFTER_CLEAN_TURNS` clean turns until back at base.
 */
export class TurnOutcomeTracker {
	private readonly _sessions = new Map<string, SessionRouteState>();

	private _state(sessionId: string): SessionRouteState {
		let s = this._sessions.get(sessionId);
		if (!s) {
			s = { rung: undefined, troubledStreak: 0, cleanStreak: 0 };
			this._sessions.set(sessionId, s);
		}
		return s;
	}

	/** Record how the turn that just finished went. */
	recordTurnOutcome(sessionId: string, outcome: TurnOutcome): void {
		const s = this._state(sessionId);
		if (isTroubled(outcome)) {
			s.troubledStreak += 1;
			s.cleanStreak = 0;
		} else {
			s.troubledStreak = 0;
			s.cleanStreak += 1;
		}
	}

	/**
	 * The starting rung for the session's NEXT turn. `base` is where quiet sessions run
	 * (the router's cheap default); `ceiling` is the user's slider cap.
	 */
	startingRungFor(sessionId: string, base: RouterRungId, ceiling: RouterRungId): RouterRungId {
		const s = this._state(sessionId);
		const current = s.rung ?? base;

		let next: RouterRungId;
		if (s.troubledStreak >= JUMP_TO_ADVISOR_AT) {
			// Repeatedly failing — stop crawling, buy Opus-grade judgment (advisor on).
			const jump = clampToCeiling('OpusEasy', ceiling);
			next = rungIndex(jump) > rungIndex(current) ? jump : nextRung(current, ceiling);
		} else if (s.troubledStreak === 1) {
			// One troubled turn — cheapest capability-increasing step via the decision map.
			const action = decideAction({ kind: 'needsStrongerExecutor', rule: 'troubled-turn' }, current, ceiling);
			next = applyAction(action, current).rung;
		} else if (s.cleanStreak >= DECAY_AFTER_CLEAN_TURNS && s.rung !== undefined && rungIndex(current) > rungIndex(base)) {
			// Quiet again — decay ONE rung back toward base, and restart the clean count.
			next = ROUTER_LADDER[Math.max(rungIndex(base), rungIndex(current) - 1)].id;
			s.cleanStreak = 0;
		} else {
			next = clampToCeiling(current, ceiling);
		}

		s.rung = next;
		return next;
	}

	/** Drop a session's routing state (thread closed / reset). */
	resetSession(sessionId: string): void {
		this._sessions.delete(sessionId);
	}
}
