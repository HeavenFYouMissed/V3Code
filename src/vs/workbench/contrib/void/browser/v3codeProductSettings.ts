/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code product-specific settings (schema + defaults).
 * The `v3code.*` keys are wired incrementally; registering them now lets the
 * Settings UI + defaultSettings.jsonc stay honest.
 */

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry, IConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';
import { V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT, V3CODE_WEB_SEARCH_ENABLED_KEY, V3CODE_WEB_SEARCH_ENDPOINT_KEY } from '../common/webSearchConfiguration.js';

export const V3CODE_LOCAL_SESSION_ONLY_KEY = 'v3code.chat.localSessionOnly';
export const V3CODE_CHROME_VENOM_ANIMATIONS_KEY = 'v3code.chrome.venomAnimations';
export const V3CODE_AGENT_DESIGN_MODE_KEY = 'v3code.agent.designMode';
export const V3CODE_AGENT_SECURITY_MODE_KEY = 'v3code.agent.securityMode';
export const V3CODE_AGENT_PROMPT_VARIANT_KEY = 'v3code.agent.promptVariant';
export const V3CODE_COMPACTION_TEST_CAP_TOKENS_KEY = 'v3code.chat.compaction.testCapTokens';

const v3codeProperties = {
	// --- Inline diff / Cmd-K (from cursor.cmdk + cursor.inlineDiff) ---
	'v3code.cmdk.useThemedDiffBackground2': {
		type: 'boolean',
		default: true,
		description: localize('v3code.cmdk.useThemedDiffBackground2', 'Use themed background colors for inline diffs.'),
	},
	'v3code.inlineDiff.enablePerformanceProtection': {
		type: 'boolean',
		default: true,
		description: localize('v3code.inlineDiff.enablePerformanceProtection', 'Suppress inline diff decorations when there are too many changes to prevent editor unresponsiveness.'),
	},

	// --- Tab completion (from cursor.cpp) ---
	'v3code.tab.disabledLanguages': {
		type: 'array',
		items: { type: 'string' },
		default: [] as string[],
		description: localize('v3code.tab.disabledLanguages', 'Disable V3Code Tab for these languages.'),
	},
	'v3code.tab.enablePartialAccepts': {
		type: 'boolean',
		default: false,
		description: localize('v3code.tab.enablePartialAccepts', 'Enable partial accepts for V3Code Tab (accept next word).'),
	},

	// --- Terminal agent UX ---
	'v3code.terminal.enableAiChecks': {
		type: 'boolean',
		default: true,
		description: localize('v3code.terminal.enableAiChecks', 'AI-based terminal completion detection.'),
	},
	'v3code.terminal.usePreviewBox': {
		type: 'boolean',
		default: false,
		description: localize('v3code.terminal.usePreviewBox', 'Use preview box for terminal inline-edit; when off, stream into the shell.'),
	},

	// --- Chat / agent chrome (from cursor.composer + cursor.chatMaxWidth) ---
	[V3CODE_LOCAL_SESSION_ONLY_KEY]: {
		type: 'boolean',
		default: true,
		description: localize('v3code.chat.localSessionOnly', 'Only offer the native V3Code agent in chat (hide external Copilot/CLI sessions).'),
	},
	'v3code.chat.maxWidth': {
		type: 'number',
		default: 840,
		description: localize('v3code.chat.maxWidth', 'Maximum width in pixels of chat content.'),
	},
	[V3CODE_COMPACTION_TEST_CAP_TOKENS_KEY]: {
		type: 'number',
		default: 0,
		minimum: 0,
		tags: ['experimental'],
		description: localize('v3code.chat.compaction.testCapTokens', 'TESTING override: when greater than 0 (e.g. 4000), chat compaction treats the history token ceiling as roughly this value so automatic condensation can be observed on a short conversation. 0 (the default) keeps production thresholds completely unchanged.'),
	},
	'v3code.voice.enabled': {
		type: 'boolean',
		default: true,
		description: localize('v3code.voice.enabled', 'Enable built-in voice input (microphone) in chat using the Web Speech API.'),
	},
	[V3CODE_AGENT_PROMPT_VARIANT_KEY]: {
		type: 'string',
		enum: ['default', 'v3', 'flat', 'original', 'cherrypick', 'overwrite'],
		default: 'default',
		enumDescriptions: [
			localize('v3code.agent.promptVariant.default', 'Use the built-in default (V3).'),
			localize('v3code.agent.promptVariant.v3', 'The shipped V3 prompt — warm identity, full guidance.'),
			localize('v3code.agent.promptVariant.flat', 'Mechanics-register prompt: full tool roster, failure playbook, flat rules. Try this for models that over-deliberate.'),
			localize('v3code.agent.promptVariant.original', 'The retired numbered Agent OS prompt (bakeoff control).'),
			localize('v3code.agent.promptVariant.cherrypick', 'Bakeoff variant: tested body with warm identity swapped in.'),
			localize('v3code.agent.promptVariant.overwrite', 'Bakeoff variant: the lean warm rewrite V3 was built from.'),
		],
		description: localize('v3code.agent.promptVariant', 'Which cloud system prompt the V3Code agent runs with. Lets prompts be A/B tested per model; local/small models keep their own tuned prompts regardless.'),
	},
	'v3code.agent.conversationDensity': {
		type: 'string',
		enum: ['compact-all-grouped', 'detailed', 'default'],
		default: 'compact-all-grouped',
		description: localize('v3code.agent.conversationDensity', 'How shell and edit tool calls are grouped in agent chat.'),
	},
	'v3code.agent.editorConversationDensity': {
		type: 'string',
		enum: ['compact-all-grouped', 'detailed', 'default'],
		default: 'detailed',
		description: localize('v3code.agent.editorConversationDensity', 'Tool call density when agent runs in the editor surface.'),
	},
	'v3code.chat.transcriptDensity': {
		type: 'string',
		enum: ['verbose', 'standard', 'compact', 'minimal'],
		enumDescriptions: [
			localize('v3code.chat.transcriptDensity.verbose', 'Every operation stays on its own card; nothing is grouped.'),
			localize('v3code.chat.transcriptDensity.standard', 'Group adjacent successful operations of the same category (read, edit, command), minimum two.'),
			localize('v3code.chat.transcriptDensity.compact', 'Group adjacent successful operations across categories, minimum two.'),
			localize('v3code.chat.transcriptDensity.minimal', 'Compact grouping, and single completed cards start collapsed too.'),
		],
		default: 'standard',
		description: localize('v3code.chat.transcriptDensity', 'How completed operations are grouped in Debug mode transcripts. Active operations, approvals, questions and failures always stay individually visible. Other modes are not affected.'),
	},
	'v3code.agent.autoRouter': {
		type: 'boolean',
		default: false,
		description: localize('v3code.agent.autoRouter', 'When on, the composer shows Auto and chooses the cheapest capable model inside the current provider and billing lane. It never switches API keys or subscriptions.'),
	},
		[V3CODE_AGENT_DESIGN_MODE_KEY]: {
			type: 'boolean',
			default: false,
			description: localize('v3code.agent.designMode', 'Design mode: agent uses ask_user + the design gallery workflow for UI work (toggle in the model picker).'),
		},
		[V3CODE_AGENT_SECURITY_MODE_KEY]: {
			type: 'boolean',
			default: false,
			description: localize('v3code.agent.securityMode', 'Cyber Protection mode: agent runs the Sentinel security scanner (CPG + taint analysis) to hunt vulnerabilities and defend the project (toggle in the model picker).'),
		},
	'v3code.agent.routerRung': {
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 4,
		description: localize('v3code.agent.routerRung', 'Auto model budget (0=Manual, 1=Economy, 2=Value, 3=Balanced, 4=Premium). API keys use actual catalog price ordering; plans and local models use capability. Value is the recommended Auto default.'),
	},
	'v3code.agent.routerPaidUnlocked': {
		type: 'boolean',
		default: false,
		description: localize('v3code.agent.routerPaidUnlocked', 'Legacy hosted-router developer override. Budget positions themselves are not paywalled; each provider still enforces its own entitlement.'),
	},
	'v3code.agent.queueMessageDefaultBehavior': {
		type: 'string',
		enum: ['queue', 'stop-and-send'],
		default: 'queue',
		description: localize('v3code.agent.queueMessageDefaultBehavior', 'Default when sending a message while the agent is streaming.'),
	},
	'v3code.agent.shouldAutoSaveNonAgent': {
		type: 'boolean',
		default: true,
		description: localize('v3code.agent.shouldAutoSaveNonAgent', 'Automatically save files in non-agent composers.'),
	},
	'v3code.agent.shouldChimeAfterChatFinishes': {
		type: 'boolean',
		default: false,
		description: localize('v3code.agent.shouldChimeAfterChatFinishes', 'Play a sound when a chat response completes.'),
	},
	'v3code.agent.showEmptyStateTips': {
		type: 'boolean',
		default: true,
		description: localize('v3code.agent.showEmptyStateTips', 'Show rotating tips on the empty chat screen.'),
	},
	'v3code.agent.suggestNextPrompt': {
		type: 'boolean',
		default: false,
		description: localize('v3code.agent.suggestNextPrompt', 'Suggest a follow-up after each turn.'),
	},
	'v3code.agent.textSizeScale': {
		type: 'number',
		default: 1,
		minimum: 0.85,
		maximum: 1.3,
		description: localize('v3code.agent.textSizeScale', 'Text size scale for AI chat messages (relative to 12px base).'),
	},
	'v3code.agent.usageSummaryDisplay': {
		type: 'string',
		enum: ['auto', 'always', 'never'],
		default: 'auto',
		description: localize('v3code.agent.usageSummaryDisplay', 'When to show token usage summary at the bottom of chat.'),
	},
	'v3code.agent.cmdPFilePicker': {
		type: 'boolean',
		default: false,
		description: localize('v3code.agent.cmdPFilePicker', 'Enable Ctrl+P file picker shortcut in agent input.'),
	},
	'v3code.agent.showMarkdownHoverActions': {
		type: 'boolean',
		default: false,
		description: localize('v3code.agent.showMarkdownHoverActions', 'Show markdown hover participant actions in agent chat.'),
	},
	'v3code.agent.customChimeSoundPath': {
		type: 'string',
		default: '',
		description: localize('v3code.agent.customChimeSoundPath', 'Custom sound file when agent finishes (mp3/wav/ogg). Empty = default.'),
	},
	'v3code.agent.planTextSizeScale': {
		type: 'string',
		enum: ['default', '0.85', '1', '1.15', '1.3'],
		default: 'default',
		description: localize('v3code.agent.planTextSizeScale', 'Text size scale for markdown plan preview.'),
	},

	// --- General / network / privacy ---
	'v3code.general.disableHttp1SSE': {
		type: 'boolean',
		default: false,
		description: localize('v3code.general.disableHttp1SSE', 'Disable HTTP/1.1 SSE for agent chat (for restrictive proxies).'),
	},
	'v3code.general.disableHttp2': {
		type: 'boolean',
		default: false,
		description: localize('v3code.general.disableHttp2', 'Force HTTP/1.1 for all requests (for proxies that block HTTP/2).'),
	},
	'v3code.general.fontSmoothingAntialiased': {
		type: 'boolean',
		default: true,
		description: localize('v3code.general.fontSmoothingAntialiased', 'Grayscale antialiasing for thinner, crisper UI text on macOS.'),
	},
	'v3code.general.gitGraphIndexing': {
		type: 'string',
		enum: ['default', 'off', 'on'],
		default: 'default',
		description: localize('v3code.general.gitGraphIndexing', 'Index git history for related-file retrieval.'),
	},
	'v3code.general.globalIgnoreList': {
		type: 'array',
		items: { type: 'string' },
		default: [] as string[],
		description: localize('v3code.general.globalIgnoreList', 'Global glob patterns ignored by V3Code features (like .v3codeignore everywhere).'),
	},
	'v3code.general.pinnedTitleActions': {
		type: 'array',
		items: { type: 'string' },
		default: [] as string[],
		description: localize('v3code.general.pinnedTitleActions', 'Editor title bar action IDs to always show.'),
	},
	'v3code.general.reduceTransparency': {
		type: 'boolean',
		default: false,
		description: localize('v3code.general.reduceTransparency', 'Replace translucent/vibrancy surfaces with opaque backgrounds.'),
	},
	'v3code.preferNotificationsSameAsChat': {
		type: 'boolean',
		default: false,
		description: localize('v3code.preferNotificationsSameAsChat', 'Show notification toasts in the same region as chat.'),
	},

	// --- Shadow workspace / worktrees ---
	'v3code.worktree.cleanupIntervalHours': {
		type: 'number',
		default: 6,
		description: localize('v3code.worktree.cleanupIntervalHours', 'Hours between automatic agent worktree cleanup.'),
	},
	'v3code.worktree.maxCount': {
		type: 'number',
		default: 25,
		description: localize('v3code.worktree.maxCount', 'Max V3Code-managed worktrees across workspaces.'),
	},
	'v3code.worktree.globalMaxSizeGb': {
		type: 'number',
		default: 50,
		description: localize('v3code.worktree.globalMaxSizeGb', 'Max total GB for worktrees directory (0 = unlimited).'),
	},

	// --- Debug / diagnostics ---
	'v3code.localTraceMode': {
		type: 'boolean',
		default: false,
		description: localize('v3code.localTraceMode', 'Record performance marks and mirror extension-host RPCs to DevTools.'),
	},
	'v3code.debug.timeoutPrevention': {
		type: 'string',
		enum: ['local_only', 'always', 'never'],
		default: 'local_only',
		description: localize('v3code.debug.timeoutPrevention', 'Prevent connection timeouts when paused at breakpoints.'),
	},
	'v3code.rpcFileLogger.enabled': {
		type: 'boolean',
		default: false,
		description: localize('v3code.rpcFileLogger.enabled', 'Log extension-host RPC to JSON for Perfetto.'),
	},
	'v3code.rpcFileLogger.folder': {
		type: 'string',
		default: '',
		description: localize('v3code.rpcFileLogger.folder', 'Folder for RPC trace files (default: logs/exthost).'),
	},

	// --- Search ---
	'v3code.semanticSearch.includeCommitsWithFiles': {
		type: 'boolean',
		default: false,
		description: localize('v3code.semanticSearch.includeCommitsWithFiles', 'Include git commits in semantic file search results.'),
	},

	// --- UI chrome ---
	'v3code.chrome.venomAnimations': {
		type: 'boolean',
		default: true,
		description: localize(
			'v3code.chrome.venomAnimations',
			'Show venom-green motion while the agent works (composer border beam, sticky capsule snake, explorer indent guides). Turn off for calm grey-only chrome.',
		),
	},
	'v3code.windowSwitcher.sidebarHoverCollapsed': {
		type: 'boolean',
		default: false,
		description: localize('v3code.windowSwitcher.sidebarHoverCollapsed', 'Expand collapsed agent sessions rail on hover.'),
	},

	// --- Resource monitor ---
	'v3code.resourceMonitor.enabled': {
		type: 'boolean',
		default: true,
		description: localize('v3code.resourceMonitor.enabled', 'Poll system and V3Code resource usage (powers the status bar widget and the Resource Monitor panel).'),
	},
	'v3code.resourceMonitor.updateIntervalMs': {
		type: 'number',
		default: 2500,
		minimum: 1000,
		description: localize('v3code.resourceMonitor.updateIntervalMs', 'How often the resource monitor samples CPU, memory, and V3Code processes, in milliseconds.'),
	},
	'v3code.resourceMonitor.showInStatusBar': {
		type: 'boolean',
		default: true,
		description: localize('v3code.resourceMonitor.showInStatusBar', 'Show the compact CPU / RAM / V3Code footprint widget in the status bar.'),
	},

	// --- Built-in web research ---
	[V3CODE_WEB_SEARCH_ENABLED_KEY]: {
		type: 'boolean',
		default: true,
		scope: ConfigurationScope.APPLICATION,
		description: localize('v3code.webSearch.enabled', 'Free and optional: let web_search send a search request to the configured V3Code-hosted SearXNG service and return public results. The request contains your search phrase; workspace files, editor contents, and chat history are not attached. V3Code does not use search queries for advertising or model training. web_fetch for direct URLs is unaffected.'),
	},
	[V3CODE_WEB_SEARCH_ENDPOINT_KEY]: {
		type: 'string',
		default: V3CODE_WEB_SEARCH_DEFAULT_ENDPOINT,
		scope: ConfigurationScope.APPLICATION,
		description: localize('v3code.webSearch.endpoint', 'SearXNG endpoint used by web_search. The default is V3Code\'s hosted metasearch service; replace it with an instance you run or trust.'),
	},
};

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'v3code',
	title: localize('v3codeSettings', 'V3Code'),
	type: 'object',
	properties: v3codeProperties as Record<string, IConfigurationPropertySchema>,
});
