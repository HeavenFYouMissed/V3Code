/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { getModelCapabilities } from '../modelCapabilities.js';
import { selectionForRouterTier, type V3ModelTier, type V3RouterRung } from '../modelTiers.js';
import { localProviderNames, modelSelectionsEqual, type ModelSelection, type OverridesOfModel, type ProviderName } from '../voidSettingsTypes.js';

/**
 * Billing/authentication boundaries are part of a model route, not incidental metadata.
 * Auto may choose a different model inside one boundary, but it must never consume a
 * different subscription or API key unless the user explicitly opts into that behavior.
 */
export type RouterBillingLane = 'free' | 'local' | 'subscription' | 'hosted' | 'byok';

const subscriptionProviderNames = new Set<ProviderName>([
	'claudePlan',
	'grokPlan',
	'geminiPlan',
	'copilot',
	'cursorLocal',
	'openaiPlan',
]);

const localRouterProviderNames = new Set<ProviderName>([
	...localProviderNames,
	'v3code-local',
]);

export interface RouterCandidatePolicy {
	/** Deliberately false in the product UI until a user-facing opt-in exists. */
	readonly allowCrossProviderByok?: boolean;
	/** A paid hosted rung selected by the user may move a non-hosted origin onto V3Code hosting. */
	readonly allowHostedUpgrade?: boolean;
}

export interface ResolvedRouterSelection {
	readonly selection: ModelSelection;
	readonly usedTarget: boolean;
}

export type RouterCapabilityBand = 'fast' | 'balanced' | 'strong';

export interface AutoRouterChoice {
	readonly selection: ModelSelection;
	readonly band: RouterCapabilityBand;
	readonly budget: V3RouterRung;
	readonly budgetMode: 'api-price' | 'model-power';
	/** True when the task appears to need a stronger model than the selected budget permits. */
	readonly wasCapped: boolean;
	/** A transparent 0..1 heuristic until V3Code has enough opt-in outcome data to calibrate a learned router. */
	readonly estimatedComplexity: number;
}

export function routerBillingLaneOfSelection(selection: ModelSelection): RouterBillingLane {
	if (selection.hostedTierId) {
		return 'hosted';
	}
	if (selection.providerName === 'v3code-free') {
		return 'free';
	}
	if (localRouterProviderNames.has(selection.providerName)) {
		return 'local';
	}
	if (subscriptionProviderNames.has(selection.providerName)) {
		return 'subscription';
	}
	return 'byok';
}

function selectionKey(selection: ModelSelection): string {
	return `${selection.providerName}\0${selection.modelName}\0${selection.hostedTierId ?? ''}`;
}

function isCandidateAllowedForOrigin(candidate: ModelSelection, origin: ModelSelection, policy: RouterCandidatePolicy): boolean {
	if (modelSelectionsEqual(candidate, origin)) {
		return true;
	}

	const originLane = routerBillingLaneOfSelection(origin);
	const candidateLane = routerBillingLaneOfSelection(candidate);

	if (candidateLane === 'hosted' && policy.allowHostedUpgrade) {
		return true;
	}
	if (originLane !== candidateLane) {
		return false;
	}

	if (originLane === 'hosted') {
		return true;
	}
	if (originLane === 'byok' && policy.allowCrossProviderByok) {
		return true;
	}

	// Subscription, local, free, and default BYOK routes remain inside the exact
	// provider. Sharing a lane does not prove that another account/key is usable.
	return candidate.providerName === origin.providerName;
}

/**
 * Build the set Auto is allowed to consider from the models that are actually visible
 * and configured in Settings. The origin is retained so a temporarily unavailable
 * catalog refresh never forces an unrelated fallback.
 */
export function routerCandidatesForOrigin(
	availableSelections: readonly ModelSelection[],
	origin: ModelSelection,
	policy: RouterCandidatePolicy = {},
): readonly ModelSelection[] {
	const deduped = new Map<string, ModelSelection>();
	for (const selection of [origin, ...availableSelections]) {
		if (!isCandidateAllowedForOrigin(selection, origin, policy)) {
			continue;
		}
		deduped.set(selectionKey(selection), selection);
	}
	return [...deduped.values()];
}

const strongModelPattern = /(?:opus|fable|mythos|\bsol\b|\bpro\b|ultra|max|reasoning|multi-agent|\bo3\b|grok-4\.5|(?:^|[-_])r1(?:[-_]|$))/i;
const fastModelPattern = /(?:haiku|flash|luna|mini|nano|small|light|lightning|instant|turbo)/i;
const balancedModelPattern = /(?:sonnet|terra|build|coder|devstral|\bk3\b)/i;

/**
 * Coarse, inspectable model profiling. Unknown models stay balanced instead of being
 * promoted to the strongest lane based on a made-up benchmark score.
 */
export function routerCapabilityBandOfSelection(selection: ModelSelection): RouterCapabilityBand {
	const name = selection.modelName.toLowerCase();
	if (name === 'opus hybrid' || strongModelPattern.test(name)) {
		return 'strong';
	}
	if (fastModelPattern.test(name)) {
		return 'fast';
	}
	if (balancedModelPattern.test(name)) {
		return 'balanced';
	}

	const parameterCount = name.match(/(?:^|[-_])([0-9]+(?:\.[0-9]+)?)b(?:[-_]|$)/i)?.[1];
	if (parameterCount) {
		const billions = Number(parameterCount);
		return billions <= 3 ? 'fast' : billions >= 70 ? 'strong' : 'balanced';
	}
	return 'balanced';
}

/**
 * Local, deterministic first-pass complexity estimator. It intentionally does not call
 * another model, leak the prompt to a routing service, or claim learned accuracy. The
 * returned seam mirrors learned routers: replace this estimator later while keeping
 * candidate containment and selection unchanged.
 */
export function estimateRouterPromptComplexity(prompt: string): number {
	const normalized = prompt.trim().toLowerCase();
	if (!normalized) {
		return 0.2;
	}

	let score = 0.34;
	if (/(?:security|authentication|authorization|billing|migration|architecture|concurren|race condition|performance|root cause|investigat|notari[sz]|sign(?:ing)?|release|production|data loss|privacy|sandbox|multi[- ]agent)/i.test(normalized)) {
		score += 0.32;
	}
	if (/(?:implement|build|refactor|debug|diagnos|integrat|across files|worktree|dependency|test suite|tool call|memory|router)/i.test(normalized)) {
		score += 0.17;
	}
	if (/(?:rename|typo|format|summari[sz]e|list|explain|quick question|simple|one line)/i.test(normalized)) {
		score -= 0.16;
	}
	if (normalized.length > 600) {
		score += 0.12;
	}
	if (normalized.length > 1_500) {
		score += 0.08;
	}
	if ((normalized.match(/\n/g)?.length ?? 0) >= 5 || normalized.includes('```')) {
		score += 0.08;
	}
	if ((normalized.match(/\b(?:and|then|also|after|before)\b/g)?.length ?? 0) >= 4) {
		score += 0.07;
	}
	return Math.max(0, Math.min(1, score));
}

const bandRank: Record<RouterCapabilityBand, number> = { fast: 0, balanced: 1, strong: 2 };

function relativeCostRank(selection: ModelSelection, band: RouterCapabilityBand): number {
	const name = selection.modelName.toLowerCase();
	// Hybrid earns strong capability from an inexpensive executor plus an advisor call;
	// prefer it over running a full Opus executor for the entire turn when both are offered.
	if (name === 'opus hybrid') {
		return 0;
	}
	if (band === 'fast') {
		return 0;
	}
	if (band === 'balanced') {
		return 1;
	}
	return /(?:opus|fable|mythos|\bsol\b|ultra|max)/i.test(name) ? 3 : 2;
}

function apiPriceScore(selection: ModelSelection, overridesOfModel: OverridesOfModel | undefined): number | undefined {
	try {
		const capabilities = getModelCapabilities(selection.providerName, selection.modelName, overridesOfModel);
		if (capabilities.cost.unpriced) {
			return undefined;
		}
		return Math.max(0, capabilities.cost.input) + Math.max(0, capabilities.cost.output);
	} catch {
		return undefined;
	}
}

/**
 * Keep BYOK/API Auto inside a price slice based on the actual model price table.
 * The budget is relative to the models configured on that exact API key: Economy
 * keeps the cheapest quartile, Value the cheapest half, Balanced the cheapest
 * three quarters, and Premium permits the full priced catalog. Unknown/unpriced
 * models are Premium-only unless the entire provider catalog is unpriced.
 */
function candidatesInsideApiBudget(
	candidates: readonly ModelSelection[],
	budget: V3RouterRung,
	overridesOfModel: OverridesOfModel | undefined,
): readonly ModelSelection[] {
	if (budget >= 4 || candidates.length <= 1) {
		return candidates;
	}
	const priced = candidates
		.map((selection, index) => ({ selection, index, price: apiPriceScore(selection, overridesOfModel) }))
		.filter((candidate): candidate is { selection: ModelSelection; index: number; price: number } => candidate.price !== undefined)
		.sort((a, b) => a.price - b.price || a.index - b.index);
	if (priced.length === 0) {
		return candidates;
	}
	const fraction = budget === 1 ? 0.25 : budget === 2 ? 0.5 : 0.75;
	const cutoffIndex = Math.max(0, Math.ceil(priced.length * fraction) - 1);
	const cutoffPrice = priced[cutoffIndex].price;
	return priced.filter(candidate => candidate.price <= cutoffPrice).map(candidate => candidate.selection);
}

function candidatesInsidePowerBudget(candidates: readonly ModelSelection[], budget: V3RouterRung): readonly ModelSelection[] {
	const maximumBandRank = budget === 1 ? bandRank.fast : budget === 2 ? bandRank.balanced : bandRank.strong;
	let allowed = candidates.filter(selection => bandRank[routerCapabilityBandOfSelection(selection)] <= maximumBandRank);
	if (budget === 3) {
		// Balanced can use an efficient strong route (for example Opus Hybrid), while
		// full-time premium frontier executors remain reserved for Premium.
		const withoutPremiumStrong = allowed.filter(selection => {
			const band = routerCapabilityBandOfSelection(selection);
			return band !== 'strong' || relativeCostRank(selection, band) <= 2;
		});
		if (withoutPremiumStrong.length > 0) {
			allowed = withoutPremiumStrong;
		}
	}
	if (allowed.length > 0) {
		return allowed;
	}
	// Some providers expose only one capability band. Use their least powerful
	// available option rather than crossing to another key or subscription.
	const minimumRank = Math.min(...candidates.map(selection => bandRank[routerCapabilityBandOfSelection(selection)]));
	return candidates.filter(selection => bandRank[routerCapabilityBandOfSelection(selection)] === minimumRank);
}

/** Pick the smallest adequate model inside both the billing boundary and budget ceiling. */
export function selectAutoRouterCandidate(
	candidates: readonly ModelSelection[],
	prompt: string,
	budget: V3RouterRung = 2,
	overridesOfModel?: OverridesOfModel,
): AutoRouterChoice | undefined {
	if (candidates.length === 0 || budget === 0) {
		return undefined;
	}
	const estimatedComplexity = estimateRouterPromptComplexity(prompt);
	const requiredBand: RouterCapabilityBand = estimatedComplexity >= 0.65 ? 'strong'
		: estimatedComplexity >= 0.34 ? 'balanced'
			: 'fast';
	const requiredRank = bandRank[requiredBand];

	const billingLane = routerBillingLaneOfSelection(candidates[0]);
	const budgetMode: AutoRouterChoice['budgetMode'] = billingLane === 'byok' ? 'api-price' : 'model-power';
	const priceContained = budgetMode === 'api-price'
		? candidatesInsideApiBudget(candidates, budget, overridesOfModel)
		: candidates;
	const budgetContained = candidatesInsidePowerBudget(priceContained, budget);
	const profiled = budgetContained.map((selection, index) => ({
		selection,
		index,
		band: routerCapabilityBandOfSelection(selection),
	})).map(candidate => ({
		...candidate,
		costRank: relativeCostRank(candidate.selection, candidate.band),
		apiPrice: budgetMode === 'api-price' ? apiPriceScore(candidate.selection, overridesOfModel) : undefined,
	}));
	const adequate = profiled
		.filter(candidate => bandRank[candidate.band] >= requiredRank)
		.sort((a, b) => bandRank[a.band] - bandRank[b.band] || a.costRank - b.costRank || a.index - b.index);
	const premiumFrontier = budget === 4 && estimatedComplexity >= 0.84
		? profiled.filter(candidate => candidate.band === 'strong').sort((a, b) =>
			(b.apiPrice ?? -1) - (a.apiPrice ?? -1) || b.costRank - a.costRank || a.index - b.index)[0]
		: undefined;
	const chosen = premiumFrontier ?? adequate[0] ?? profiled.sort((a, b) => bandRank[b.band] - bandRank[a.band] || a.costRank - b.costRank || a.index - b.index)[0];
	if (!chosen) {
		return undefined;
	}
	return {
		selection: chosen.selection,
		band: chosen.band,
		budget,
		budgetMode,
		wasCapped: bandRank[chosen.band] < requiredRank,
		estimatedComplexity,
	};
}

/**
 * Resolve today's tier ladder through the provider-agnostic candidate boundary.
 * This is intentionally conservative: unsupported providers hold their current model
 * instead of silently jumping to somebody else's key or plan. Future scoring can select
 * any candidate returned by routerCandidatesForOrigin without weakening that invariant.
 */
export function resolveRouterTierForOrigin(
	tier: V3ModelTier,
	origin: ModelSelection | null,
	availableSelections: readonly ModelSelection[],
	policy: RouterCandidatePolicy = {},
): ResolvedRouterSelection {
	const target = selectionForRouterTier(tier, origin?.providerName);
	if (!origin) {
		return { selection: target, usedTarget: true };
	}

	const candidates = routerCandidatesForOrigin(availableSelections, origin, policy);
	const offeredTarget = candidates.find(candidate => modelSelectionsEqual(candidate, target));
	if (offeredTarget) {
		return { selection: target, usedTarget: true };
	}

	// Hosted tiers are authenticated by the V3Code entitlement rather than appearing
	// in the provider model catalog. An explicit paid rung is the user's opt-in.
	if (target.hostedTierId && policy.allowHostedUpgrade) {
		return { selection: target, usedTarget: true };
	}

	return { selection: origin, usedTarget: false };
}
