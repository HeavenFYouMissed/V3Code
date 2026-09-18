/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Adaptive-router ladder (S1 of the adaptive routing engine).
 *
 * Composes the full escalation ladder ON TOP of the shipped `V3_MODEL_TIERS`
 * (`modelTiers.ts`) — reusing V3Fast/V3Pro/OpusEasy/OpusHard verbatim (including their
 * `options.advisorEffort`, so the Opus Hybrid advisor tool attaches identically) and
 * adding two new rungs: a `Local` floor (a bundled local model — availability gated by
 * ILocalInferenceService in S7) and a `FullOpus` ceiling (a real `claude-opus-4-8`
 * executor with the advisor tool dropped).
 *
 * This module is PURE + headless-testable: data + rung math only. It does NOT touch the
 * agent loop — that wiring is S3, behind `v3code.router.enabled`.
 */

import { OPUS_HYBRID_MODEL_NAME } from '../modelCapabilities.js';
import { ModelSelection, ModelSelectionOptions, ProviderName } from '../voidSettingsTypes.js';
import { V3_MODEL_TIERS, V3ModelTier } from '../modelTiers.js';

export type RouterRungKind = 'local' | 'tier' | 'fullOpus';

export type RouterRungId = 'Local' | 'V3Fast' | 'V3Pro' | 'OpusEasy' | 'OpusHard' | 'FullOpus';

export interface RouterRung {
	readonly id: RouterRungId;
	readonly kind: RouterRungKind;
	readonly label: string;
	readonly description: string;
	/** The concrete model this rung runs. */
	readonly selection: ModelSelection;
	/** Carried verbatim from the shipped tier (e.g. advisorEffort) so the advisor tool attaches identically. */
	readonly options?: Partial<ModelSelectionOptions>;
	/** Local rung only — minimum system RAM (GB) to run the bundled model. */
	readonly hardwareFloorGB?: number;
	/** Paid/hosted tiers — greyed in the UI until the router paid entitlement is unlocked. */
	readonly paidOnly: boolean;
}

// Bottom rung — a bundled local model (Gemma/Qwen-Coder). The `selection` here is a
// placeholder until S7 wires the bundled local-inference runtime; callers must fall back
// to V3Fast until ILocalInferenceService reports the model is downloaded.
const LOCAL_RUNG: RouterRung = {
	id: 'Local',
	kind: 'local',
	label: 'Local',
	description: 'Bundled local model — free, offline, private',
	selection: { providerName: 'ollama' as ProviderName, modelName: 'gemma' },
	hardwareFloorGB: 8,
	paidOnly: false,
};

// Top rung — a real Opus 4.8 executor. The advisor tool is DROPPED here (the executor IS
// Opus, so a separate Opus advisor is redundant). This is the true ceiling.
const FULL_OPUS_RUNG: RouterRung = {
	id: 'FullOpus',
	kind: 'fullOpus',
	label: 'Full Opus',
	description: 'claude-opus-4-8 executor (advisor dropped) — ceiling',
	selection: { providerName: 'anthropic' as ProviderName, modelName: 'claude-opus-4-8' },
	paidOnly: true,
};

// V3Fast / V3Pro / OpusHard are hosted (paid); OpusEasy currently rides on the advisor.
const PAID_TIER_IDS = new Set(['V3Fast', 'V3Pro', 'OpusHard']);

/**
 * Picker tiers that are NOT escalation rungs. V4.5 Build is a direct paid
 * lane in the model picker; the router ladder's cost/capability ordering
 * (plan of record) stays Local → V3Fast → V3Pro → OpusEasy → OpusHard → FullOpus.
 */
const NON_LADDER_TIER_IDS = new Set<V3ModelTier['id']>(['Build45', 'Luna56', 'Terra56', 'Sol56']);

type LadderTier = V3ModelTier & { id: RouterRungId };

const isLadderTier = (tier: V3ModelTier): tier is LadderTier => !NON_LADDER_TIER_IDS.has(tier.id);

const tierToRung = (tier: LadderTier): RouterRung => ({
	id: tier.id,
	kind: 'tier',
	label: tier.label,
	description: tier.description,
	selection: tier.selection,
	options: tier.options,
	paidOnly: PAID_TIER_IDS.has(tier.id),
});

/**
 * The full escalation ladder, bottom → top:
 * `Local → V3Fast → V3Pro → OpusEasy → OpusHard → FullOpus`.
 * Built from `V3_MODEL_TIERS` (no duplication) plus the two new endpoints.
 */
export const ROUTER_LADDER: readonly RouterRung[] = [
	LOCAL_RUNG,
	...V3_MODEL_TIERS.filter(isLadderTier).map(tierToRung),
	FULL_OPUS_RUNG,
];

export function rungIndex(id: RouterRungId): number {
	return ROUTER_LADDER.findIndex(r => r.id === id);
}

export function rungById(id: RouterRungId): RouterRung | undefined {
	return ROUTER_LADDER.find(r => r.id === id);
}

/** Clamp a rung so it never exceeds the user's chosen ceiling. */
export function clampToCeiling(id: RouterRungId, ceiling: RouterRungId): RouterRungId {
	const i = rungIndex(id);
	const c = rungIndex(ceiling);
	return ROUTER_LADDER[Math.min(i, c)].id;
}

/**
 * The next rung UP, clamped to the ceiling. Never moves down (upward-only escalation) and
 * never past the ceiling — returns the same rung when already at/above the ceiling.
 */
export function nextRung(current: RouterRungId, ceiling: RouterRungId): RouterRungId {
	const i = rungIndex(current);
	const c = rungIndex(ceiling);
	const target = Math.max(i, Math.min(i + 1, c));
	return ROUTER_LADDER[target].id;
}

/**
 * Resolve a rung to the concrete `{ selection, options }` used to build a request. Carries
 * the shipped tier's `options.advisorEffort` verbatim so the Opus Hybrid advisor tool
 * attaches identically to how the picker tier would.
 */
export function resolveRung(id: RouterRungId): { selection: ModelSelection; options?: Partial<ModelSelectionOptions> } {
	const rung = rungById(id) ?? ROUTER_LADDER[1]; // fall back to V3Fast
	return { selection: rung.selection, options: rung.options };
}

/** Identify which rung a live selection+options corresponds to (Opus Hybrid disambiguated by advisorEffort). */
export function rungFromSelection(selection: ModelSelection | null | undefined, options?: Partial<ModelSelectionOptions> | undefined): RouterRung | undefined {
	if (!selection) {
		return undefined;
	}
	if (selection.providerName === 'anthropic' && selection.modelName === 'claude-opus-4-8') {
		return FULL_OPUS_RUNG;
	}
	if (selection.providerName === 'anthropic' && selection.modelName === OPUS_HYBRID_MODEL_NAME) {
		return rungById(options?.advisorEffort === 'easy' ? 'OpusEasy' : 'OpusHard');
	}
	return ROUTER_LADDER.find(r =>
		r.kind === 'tier' &&
		r.selection.providerName === selection.providerName &&
		r.selection.modelName === selection.modelName
	);
}
