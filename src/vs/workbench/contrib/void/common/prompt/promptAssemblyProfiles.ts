/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ChatMode, localProviderNames, PromptAssemblyPresetSetting } from '../voidSettingsTypes.js';
import { localModelParameterBillions } from '../localAgentRuntime.js';

/**
 * Prompt assembly presets (docs/V3CODE-PROMPT-PRESETS-HANDOFF.md).
 *
 * A preset changes WHAT gets pushed into the static system prefix and the per-turn
 * ephemeral tail — never the tool set, chat modes, or agent capabilities. `full` is
 * today's harness byte-for-byte; `lean`/`minimal` move encyclopedic text to pull
 * (read_skill, get_project_briefing, list_notes) so small-context and local models
 * don't burn half their window on the prefix.
 */
export type PromptAssemblyPresetId = 'full' | 'lean' | 'minimal';

/**
 * Which OS prompt constant chat_systemMessage uses as the prompt header.
 * Kept as names (not the strings themselves) so profiles stay declarative and
 * prompts.ts owns the actual text.
 */
export type PromptAssemblyOsPromptName = 'V3CODE_AGENT_OS_PROMPT' | 'V3CODE_LEAN_AGENT_OS_PROMPT' | 'V3CODE_MINIMAL_AGENT_OS_PROMPT'
	// Prompt bakeoff variants — swap the cloud (full) OS prompt via globalSettings.promptVariant.
	| 'V3CODE_AGENT_CHERRYPICK_PROMPT' | 'V3CODE_AGENT_OVERWRITE_PROMPT' | 'V3CODE_AGENT_V3_PROMPT' | 'V3CODE_AGENT_FLAT_PROMPT';

/**
 * Single source of truth for one assembly preset — resolved once per turn and passed
 * through chat_systemMessage + convertToLLMMessageService. Do not scatter `if (lean)`
 * branches; gate on the profile fields.
 */
export interface PromptAssemblyProfile {
	id: PromptAssemblyPresetId;
	/** Which OS constant chat_systemMessage uses. */
	osPrompt: PromptAssemblyOsPromptName;
	/** Append the full skills catalog to the cached aiInstructions prefix. When false the OS prompt carries a one-line read_skill pointer instead. */
	injectSkillsCatalog: boolean;
	/** Inject the <AVAILABLE_MODELS> roster into the cached prefix. */
	injectModelRoster: boolean;
	/** Workspace instruction files (AGENTS.md, .voidrules, …): true = inject bodies, 'briefing_pointer_only' = one-line get_project_briefing pointer, false = nothing. */
	injectWorkspaceInstructions: boolean | 'briefing_pointer_only';
	/**
	 * XML tool definitions for non-native-tool models. 'auto' = today's heuristic
	 * (compact when contextWindow <= 20k), 'compact' = always one-line defs,
	 * 'full' = always full prose. Native-tool models never receive XML defs at all,
	 * regardless of this field (includeXMLToolDefinitions gates upstream).
	 */
	toolDefMode: 'auto' | 'full' | 'compact';
	/**
	 * List only the core tool subset in the XML tool defs (7B-14B models lose tool-selection
	 * accuracy over a 75-tool surface, and the full def list alone busts the minimal token
		 * budget). The compact local preset retains a focused coding toolbelt; Configure
		 * Tools or a custom agent can explicitly replace that surface.
	 */
	coreToolsOnly?: boolean;
	/** Per-turn ephemeral tail blocks attached to the live user message (see fitContextBlocks in convertToLLMMessageService). */
	ephemeral: {
		/** false = off; 'name_only' = workspace folder name; 'full' = project brief + About + quirks. */
		projectBrief: false | 'name_only' | 'full';
		workspaceMemory: boolean;
		activePlan: boolean;
		sessionDigest: boolean;
		taskKernel: boolean;
		symbolSkeleton: boolean;
		/** Semantic-index grounding + workspace tree overview (autoContext + filesOverview blocks). */
		autoCodebaseContext: boolean;
		/** Live editor state (<CURRENT_ENVIRONMENT>: active file, cursor, recently viewed). */
		currentEnvironment: boolean;
		/** Per-turn <CURRENT_TIME> block. */
		temporal: boolean;
		/** Inject design-rag/.selection.json when the user picked a gallery plugin (D3). */
		designActive: boolean;
	};
	/** Char-cap overrides; undefined = today's defaults (aiInstructions 12k, ephemeralTail 10k). */
	caps?: Partial<{ aiInstructions: number; ephemeralTail: number }>;
}

/**
 * The preset registry. Every preset follows the same pull-first context contract:
 * project knowledge is discovered with tools, never pushed into an unrelated turn.
 */
export const PROMPT_ASSEMBLY_PROFILES: Record<PromptAssemblyPresetId, PromptAssemblyProfile> = {
	full: {
		id: 'full',
		osPrompt: 'V3CODE_AGENT_OS_PROMPT',
		injectSkillsCatalog: true,
		injectModelRoster: false,
		injectWorkspaceInstructions: true,
		toolDefMode: 'auto',
		ephemeral: {
			projectBrief: false,
			workspaceMemory: false,
			// ON in full only: the plan is now task-residue with structured authority — it is
			// written under the durable task's taskId (superseded-task checklists never inject)
			// and full replaces from side turns are rejected. Still rendered as reference that
			// <durable_task>/<task_kernel>/<current_turn> outrank.
			activePlan: true,
			sessionDigest: true,
			taskKernel: true,
			symbolSkeleton: false,
			autoCodebaseContext: false,
			currentEnvironment: true,
			temporal: true,
			designActive: true,
		},
	},
	lean: {
		id: 'lean',
		osPrompt: 'V3CODE_LEAN_AGENT_OS_PROMPT',
		injectSkillsCatalog: false,
		injectModelRoster: false,
		injectWorkspaceInstructions: 'briefing_pointer_only',
		toolDefMode: 'compact',
		ephemeral: {
			projectBrief: false,
			workspaceMemory: false,
			activePlan: false,
			sessionDigest: true,
			taskKernel: true,
			symbolSkeleton: false,
			autoCodebaseContext: false,
			currentEnvironment: true,
			temporal: true,
			designActive: true,
		},
		// Keep the complete cached prefix below the documented 6k-token ceiling. The
		// lean OS + compact tool surface consumes most of the 6k-token ceiling. The OS
		// already carries its progress rule, leaving a bounded slice for instructions.
		caps: { aiInstructions: 990, ephemeralTail: 6_000 },
	},
	minimal: {
		id: 'minimal',
		osPrompt: 'V3CODE_MINIMAL_AGENT_OS_PROMPT',
		injectSkillsCatalog: false,
		injectModelRoster: false,
		injectWorkspaceInstructions: false,
		toolDefMode: 'compact',
		coreToolsOnly: true,
		ephemeral: {
			projectBrief: false,
			workspaceMemory: false,
			activePlan: false,
			// A condensed thread must survive an editor restart on every model size. The digest is
			// bounded and competes inside the existing 3k tail cap, so this restores continuity
			// without growing the Compact Local prompt.
			sessionDigest: true,
			taskKernel: true,
			symbolSkeleton: false,
			autoCodebaseContext: false,
			currentEnvironment: false,
			temporal: false,
			designActive: false,
		},
		// The compact coding schema sits below the 3k-token static ceiling;
		// reserve the remaining prefix room for a concise user/project instruction block.
		caps: { aiInstructions: 2_800, ephemeralTail: 3_000 },
	},
};

/**
 * The full profile carries the explicit visible-progress reinforcement. Lean/minimal profiles
 * already contain the same rule in their OS prompt, so injecting it again wastes scarce context.
 * This follows prompt capacity, not provider wire format.
 */
export function shouldInjectPhaseProgress(profile: Pick<PromptAssemblyProfile, 'id'>, chatMode: ChatMode): boolean {
	return profile.id === 'full' && chatMode !== 'chat';
}

/**
 * Below/at this resolved context window the auto rule picks `lean` for recognized **cloud**
 * small-context models (matches docs/V3CODE-LOCAL-MODEL-STRATEGY.md). Local providers are
 * classified separately below. 33k, not 32k: the capability table
 * records 32k-class models as both 32_000 and 32_768 — same class, same preset.
 */
export const LEAN_AUTO_CONTEXT_WINDOW_MAX = 33_000;

/** Providers whose models use adaptive local prompt routing under `auto`. */
const localAutoProviders = new Set<string>([...localProviderNames, 'v3code-local']);

/** A local model at or above this advertised size gets Lean under `auto`. */
export const LEAN_AUTO_LOCAL_PARAMETER_BILLIONS_MIN = 20;

/**
 * Resolves the user's preset setting + the selected model into a profile.
 * A manual setting always wins, including for large local models. Under `auto`, small local
 * models get the compact fully-tooled profile; advertised 20B+ local models get Lean. When
 * a local alias has no size marker, a recognized >33k context window is the conservative
 * signal for Lean. Cloud auto keeps Full for frontier models and Lean for recognized
 * small-context models.
 */
export function resolvePromptAssemblyProfile(opts: {
	setting: PromptAssemblyPresetSetting | undefined;
	providerName: string | undefined;
	modelName?: string;
	contextWindow: number | undefined;
	/** From getModelCapabilities: true when the capability table had to guess. */
	isUnrecognizedModel?: boolean;
}): PromptAssemblyProfile {
	const { setting, providerName, modelName, contextWindow, isUnrecognizedModel } = opts;
	if (setting && setting !== 'auto') {
		// Storage-sourced value (settings import bypasses migrations, future renames):
		// an unknown preset must degrade to full, never crash the turn on undefined.
		return PROMPT_ASSEMBLY_PROFILES[setting] ?? PROMPT_ASSEMBLY_PROFILES.full;
	}
	const isLocalProvider = !!providerName && localAutoProviders.has(providerName);
	if (isLocalProvider) {
		const parameterBillions = localModelParameterBillions(modelName);
		const isAdvertisedLargeModel = parameterBillions !== undefined
			? parameterBillions >= LEAN_AUTO_LOCAL_PARAMETER_BILLIONS_MIN
			: !isUnrecognizedModel && contextWindow !== undefined && contextWindow > LEAN_AUTO_CONTEXT_WINDOW_MAX;
		return isAdvertisedLargeModel ? PROMPT_ASSEMBLY_PROFILES.lean : PROMPT_ASSEMBLY_PROFILES.minimal;
	}
	// The capability table reports a guessed 4,096 window for every model it doesn't
	// recognize (all Azure/Vertex/Bedrock deployments, unmatched aggregator ids). A guess
	// must not downgrade a cloud model to lean — trust small windows only when the model
	// is recognized.
	const isSmallContext = !isUnrecognizedModel && contextWindow !== undefined && contextWindow <= LEAN_AUTO_CONTEXT_WINDOW_MAX;
	if (isSmallContext) {
		return PROMPT_ASSEMBLY_PROFILES.lean;
	}
	return PROMPT_ASSEMBLY_PROFILES.full;
}
