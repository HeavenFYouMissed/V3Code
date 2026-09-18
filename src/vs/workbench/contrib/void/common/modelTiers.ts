/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { OPUS_HYBRID_MODEL_NAME } from './modelCapabilities.js';
import { ModelSelection, ModelSelectionOptions, ProviderName } from './voidSettingsTypes.js';

export type V3ModelTierId = 'V3Fast' | 'V3Pro' | 'Luna56' | 'Terra56' | 'Build45' | 'OpusEasy' | 'OpusHard' | 'Sol56';

export interface V3ModelTier {
	id: V3ModelTierId;
	label: string;
	description: string;
	selection: ModelSelection;
	options?: Partial<ModelSelectionOptions>;
}

/** Branded picker tiers — V3Fast/V3Pro map to DeepSeek flash/pro. */
export const V3_MODEL_TIERS: readonly V3ModelTier[] = [
	{
		id: 'V3Fast',
		label: 'V3Fast',
		description: 'DeepSeek v4 Flash — fast, high-volume',
		selection: { providerName: 'deepseek' as ProviderName, modelName: 'deepseek-v4-flash', hostedTierId: 'V3Fast' },
	},
	{
		id: 'V3Pro',
		label: 'V3Pro',
		description: 'DeepSeek v4 Pro — frontier coding & agents',
		selection: { providerName: 'deepseek' as ProviderName, modelName: 'deepseek-v4-pro', hostedTierId: 'V3Pro' },
	},
	{
		id: 'Luna56',
		label: 'V3Luna 5.6',
		description: 'GPT-5.6 Luna — fast frontier coding, high-volume',
		selection: { providerName: 'openAI' as ProviderName, modelName: 'gpt-5.6-luna', hostedTierId: 'Luna56' },
	},
	{
		id: 'Terra56',
		label: 'V3Terra 5.6',
		description: 'GPT-5.6 Terra — balanced frontier intelligence',
		selection: { providerName: 'openAI' as ProviderName, modelName: 'gpt-5.6-terra', hostedTierId: 'Terra56' },
	},
	{
		id: 'Build45',
		label: 'V4.5 Build',
		description: 'Frontier build lane — tools, refactors, long agent runs',
		selection: { providerName: 'xAI' as ProviderName, modelName: 'grok-4.5', hostedTierId: 'Build45' },
	},
	{
		id: 'OpusEasy',
		label: 'Opus Easy',
		description: 'Opus Hybrid · easy — Haiku executor, Opus 4.8 advisor',
		selection: { providerName: 'anthropic' as ProviderName, modelName: OPUS_HYBRID_MODEL_NAME },
		options: { advisorEffort: 'easy' },
	},
	{
		id: 'OpusHard',
		label: 'Opus Hard',
		description: 'Opus Hybrid · hard — Sonnet 5 executor, Opus 4.8 advisor',
		selection: { providerName: 'anthropic' as ProviderName, modelName: OPUS_HYBRID_MODEL_NAME },
		options: { advisorEffort: 'hard' },
	},
	{
		id: 'Sol56',
		label: 'V3Sol 5.6',
		description: 'GPT-5.6 Sol — OpenAI frontier flagship, top tier',
		selection: { providerName: 'openAI' as ProviderName, modelName: 'gpt-5.6-sol', hostedTierId: 'Sol56' },
	},
];

// Tier selections are shared references that now carry the hosted-origin tag —
// freeze them so an accidental in-place mutation throws instead of silently
// re-routing every consumer of the tier (strict-mode ESM).
V3_MODEL_TIERS.forEach(t => { Object.freeze(t.selection); if (t.options) { Object.freeze(t.options); } Object.freeze(t); });
Object.freeze(V3_MODEL_TIERS);

/** Power rating (1-6) per tier: the locked strength ladder. Sol tops at 6 (reserved for the
 *  flagship); V3Pro/Build/OpusHard sit at 5; the fast/balanced lanes at 4. Shown as 6 bubbles
 *  (N filled) in the picker. */
export const TIER_POWER: Record<V3ModelTierId, number> = {
	V3Fast: 4,
	V3Pro: 5,
	Luna56: 4,
	Terra56: 4,
	Build45: 5,
	OpusEasy: 4,
	OpusHard: 5,
	Sol56: 6,
};

export type TierBurn = 'cheap' | 'mid' | 'heavy';

/** Burn class per tier (the 3 cost lanes) — matches the meter binning. NO price is ever shown;
 *  this is a relative "how fast it drains the plan" hint only. V3Fast/V3Pro are the sip-heroes. */
export const TIER_BURN: Record<V3ModelTierId, TierBurn> = {
	V3Fast: 'cheap',
	V3Pro: 'cheap',
	Luna56: 'mid',
	Terra56: 'mid',
	Build45: 'mid',
	OpusEasy: 'mid',
	OpusHard: 'mid',
	Sol56: 'heavy',
};

/** A playful glyph for the flagship (a devil face on Sol). Empty otherwise. */
export function tierGlyph(id: V3ModelTierId): string {
	// allow-any-unicode-next-line
	return id === 'Sol56' ? '\u{1F608}' : '';
}

export function tierFromModelSelection(selection: ModelSelection | null, options?: ModelSelectionOptions | undefined): V3ModelTier | undefined {
	if (!selection) {
		return undefined;
	}
	if ((selection.providerName === 'anthropic' || selection.providerName === 'claudePlan') && selection.modelName === OPUS_HYBRID_MODEL_NAME) {
		return V3_MODEL_TIERS.find(t => t.id === (options?.advisorEffort === 'easy' ? 'OpusEasy' : 'OpusHard'));
	}
	// C1: hosted tiers are recognized ONLY by the origin tag — a BYOK selection
	// that shares the wire model name must never read as a tier (and so never
	// gets refused or rerouted through the hub).
	if (!selection.hostedTierId) {
		return undefined;
	}
	const tier = V3_MODEL_TIERS.find(t => t.id === selection.hostedTierId);
	// Safety: a stale/forged tag must never route an arbitrary model through the
	// hub — the tag only counts when provider+model still match the tier.
	if (!tier || tier.selection.providerName !== selection.providerName || tier.selection.modelName !== selection.modelName) {
		return undefined;
	}
	return tier;
}

/**
 * Keep the Opus Hybrid orchestration on the user's Claude subscription when Auto starts
 * from a Claude Plan pick. Other tiers keep their canonical provider (hosted DeepSeek,
 * OpenAI, xAI, or Anthropic BYOK), so choosing a subscription never rewrites unrelated
 * routes or steals an explicit API-key selection.
 */
export function selectionForRouterTier(tier: V3ModelTier, preferredProvider: ProviderName | undefined): ModelSelection {
	if ((tier.id === 'OpusEasy' || tier.id === 'OpusHard') && preferredProvider === 'claudePlan') {
		return { ...tier.selection, providerName: 'claudePlan' };
	}
	return tier.selection;
}

export function tierLanguageModelId(tier: V3ModelTier): string {
	return `v3code/tier/${tier.id}`;
}

/** The six single-model hosted lanes the hub runs on our platform keys. The two
 *  Opus-Hybrid tiers (OpusEasy/OpusHard) are multi-model orchestration and are NOT
 *  hosted yet — they stay BYOK until their fast-follow. Keep in lockstep with the
 *  backend's HOSTED_MODELS allowlist (inference.ts). */
const HOSTED_TIER_IDS: ReadonlySet<V3ModelTierId> = new Set<V3ModelTierId>([
	'V3Fast', 'V3Pro', 'Luna56', 'Terra56', 'Build45', 'Sol56',
]);

/**
 * Canonical hosted wire model ("provider/model", lowercase provider) for a selection,
 * or undefined when the selection is not a hosted plan lane (BYOK model, or the not-yet-
 * hosted Opus Hybrid tiers). This is exactly the string the hub allowlists, so the editor
 * must normalize the provider casing (openAI → openai, xAI → xai) here.
 */
export function hostedWireModelForSelection(selection: ModelSelection | null, options?: ModelSelectionOptions | undefined): string | undefined {
	const tier = tierFromModelSelection(selection, options);
	if (!tier || !HOSTED_TIER_IDS.has(tier.id)) {
		return undefined;
	}
	return `${tier.selection.providerName.toLowerCase()}/${tier.selection.modelName}`;
}

export function isHostedTierId(id: V3ModelTierId): boolean {
	return HOSTED_TIER_IDS.has(id);
}

/** Name-based hosted-tier lookup — for the ONE-TIME upgrade migration only
 *  (pre-tag installs persisted hosted picks as plain {provider, model}). All
 *  other code must go through the tag-strict {@link tierFromModelSelection}. */
export function hostedTierByWireName(providerName: string, modelName: string): V3ModelTier | undefined {
	return V3_MODEL_TIERS.find(t => HOSTED_TIER_IDS.has(t.id) && t.selection.providerName === providerName && t.selection.modelName === modelName);
}

/** 0 = manual, 1 = economy, 2 = value, 3 = balanced, 4 = premium. */
export type V3RouterRung = 0 | 1 | 2 | 3 | 4;

export const V3_ROUTER_RUNG_LABELS = ['Manual', 'Economy', 'Value', 'Balanced', 'Premium'] as const;

export function clampRouterRung(value: number): V3RouterRung {
	const n = Math.round(value);
	if (n <= 0) {
		return 0;
	}
	if (n >= 4) {
		return 4;
	}
	return n as V3RouterRung;
}

export function routerRungForAutoRouter(autoRouter: boolean, rung: V3RouterRung): V3RouterRung {
	if (!autoRouter) {
		return 0;
	}
	// Migrate older installs where Auto was enabled while the old tier slider was Off.
	return rung > 0 ? rung : 2;
}
