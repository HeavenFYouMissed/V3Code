/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code product default settings - applied for EVERY user out of the box (and still
 * overridable in their own settings.json).
 *
 * Why in code instead of product.json `configurationDefaults`: that product.json field
 * is only consumed on web/embedder builds (via environmentService.options.configurationDefaults
 * in services/configuration/browser/configuration.ts). The DESKTOP app never reads it, so
 * keys there do nothing on Windows/macOS/Linux. Registering through the configuration
 * registry works on every platform and ships inside the build.
 *
 * Curated V3Code product defaults (reviewed Jun 2026).
 */

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { McpAutoStartValue } from '../../../../platform/mcp/common/mcpManagement.js';
import { mcpAutoStartConfig } from '../../../../platform/mcp/common/mcpManagement.js';
import { V3CODE_LOCAL_SESSION_ONLY_KEY } from './v3codeProductSettings.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		// --- Window / chrome (V3Code product) ---
		'window.titleBarStyle': 'custom',
		'window.menuBarVisibility': 'compact',
		// V3Code agent chrome: hide the titlebar quick-access pill by default.
		'window.commandCenter': false,
		'workbench.colorTheme': 'Dark 2026',
		'workbench.browser.showInTitleBar': true,
		'workbench.startupEditor': 'none',
		'workbench.welcomePage.experimentalOnboarding': false,
		'workbench.editor.showTabs': 'multiple',
		// product.json promised these; V3Code keeps product intent
		'workbench.editor.wrapTabs': true,
		'workbench.editor.highlightModifiedTabs': true,

		// Workbench feel
		'workbench.hover.delay': 250,

		// Diff editor
		'diffEditor.codeLens': false,
		'diffEditor.diffAlgorithm': 'advanced',
		'diffEditor.experimental.showEmptyDecorations': true,
		'diffEditor.experimental.showMoves': false,
		'diffEditor.experimental.useTrueInlineView': false,
		'diffEditor.hideUnchangedRegions.contextLineCount': 3,
		'diffEditor.hideUnchangedRegions.enabled': false,
		'diffEditor.hideUnchangedRegions.minimumLineCount': 3,
		'diffEditor.hideUnchangedRegions.revealLineCount': 20,
		'diffEditor.ignoreTrimWhitespace': true,
		'diffEditor.maxComputationTime': 5000,
		'diffEditor.maxFileSize': 50,
		'diffEditor.renderGutterMenu': true,
		'diffEditor.renderIndicators': true,
		'diffEditor.renderMarginRevertIcon': true,
		'diffEditor.renderSideBySide': true,
		'diffEditor.renderSideBySideInlineBreakpoint': 900,
		'diffEditor.useInlineViewWhenSpaceIsLimited': true,
		'diffEditor.wordWrap': 'inherit',

		// Editor perf / feel — film-rail minimap on by default (product.json keys are web-only)
		'editor.minimap.enabled': true,
		'editor.minimap.renderCharacters': false,
		'editor.minimap.showSlider': 'always',
		'editor.minimap.maxColumn': 120,
		'editor.minimap.size': 'proportional',
		'editor.hover.delay': 300,
		'editor.hover.hidingDelay': 300,
		'editor.stickyScroll.enabled': true,
		'editor.stickyScroll.defaultModel': 'outlineModel',
		'editor.stickyScroll.maxLineCount': 5,
		'editor.stickyScroll.scrollWithEditor': true,
		'editor.smoothScrolling': false,
		'editor.quickSuggestionsDelay': 10,
		'editor.largeFileOptimizations': true,
		'editor.maxTokenizationLineLength': 20000,
		'editor.pasteAs.enabled': false,
		'mergeEditor.diffAlgorithm': 'advanced',

		// Telemetry
		'telemetry.feedback.enabled': false,

		// Agent / chat (product.json + v3code.* defaults)
		[V3CODE_LOCAL_SESSION_ONLY_KEY]: true,
		// V3Code ships Context Bridge + tools natively — don't block every chat turn on
		// extension MCP activation ("Activating MCP extensions…"). Users start MCP servers
		// on demand from the MCP panel when they need external tools.
		[mcpAutoStartConfig]: McpAutoStartValue.Never,
		'chat.contextUsage.enabled': true,
		'chat.tools.todos.showWidget': true,
		'chat.generalPurposeAgent.enabled': true,
		'chat.subagents.allowInvocationsFromSubagents': true,
		'chat.autopilot.enabled': true,
		'chat.titleBar.signIn.enabled': false,
		// Agent timeline. One active tool/thinking phase stays in a fixed-height,
		// auto-scrolling viewport for the whole response, then collapses when the response
		// completes. Assistant narration remains clean prose beside that working stream.
		// Tool-card density is driven by v3code.agent.conversationDensity*.
		'chat.agent.thinkingStyle': 'fixedScrolling',
		// Legacy upstream key — native list renderer reads v3 density keys instead.
		'chat.agent.thinking.collapsedTools': 'off',
		'chat.agent.thinking.terminalTools': true,
		'chat.tools.terminal.simpleCollapsible': true,
		'v3code.agent.autoRouter': false,
		'v3code.agent.routerRung': 0,
		'v3code.agent.routerPaidUnlocked': false,

		// --- V3Code feature unlocks: upstream ships these OFF (or off on `stable` builds);
		// V3Code ships them ON so the editor's real capabilities are available out of the box.
		// Anything here is still overridable in the user's own settings.json. ---
		// Integrated browser + agentic browser tools (agent can open / read / click / screenshot
		// pages). `enableChatTools` is the master gate; `agentHostChatToolsEnabled` additionally
		// requires `chat.agentHost.enabled` (also enabled just below).
		'workbench.browser.enableChatTools': true,
		'workbench.browser.openLocalhostLinks': true,
		'workbench.browser.agentHostChatToolsEnabled': true,
		'workbench.browser.agentVisuals': true,
		// Run agents in the dedicated agent-host process. Upstream defaults this off on `stable`
		// builds; required for agent-host browser tools + the Sessions window.
		'chat.agentHost.enabled': true,
		// Agent transcript / progress UX
		'chat.persistentProgress.enabled': true,
		'chat.viewProgressBadge.enabled': true,
		'chat.tools.confirmationCarousel.enabled': true,
		'chat.experimental.incrementalRendering.enabled': true,
		// Codex/Cursor-like live prose: reveal each streamed block with a temporary
		// soft edge. Completed text remains fully crisp and reduced-motion is honored.
		'chat.experimental.incrementalRendering.animationStyle': 'reveal',
		// Token efficiency: compress noisy tool stdout (git diff, ls, …) before sending to model.
		'chat.tools.compressOutput.enabled': true,
		// Instructions / customizations / skills — fits V3Code's AGENTS.md + memory model.
		'chat.useNestedAgentsMdFiles': true,
		'chat.includeReferencedInstructions': true,
		'chat.customizations.structuredPreview.enabled': true,
		// Element-to-chat screenshot (already upstream-true; pinned so it can't regress).
		'chat.sendElementsToChat.attachImages': true,
		// MCP marketplace browsing (off on `stable` upstream).
		'chat.mcp.gallery.enabled': true,
		// Native MCP tool-invocation UI off — V3Code ships its own MCP stack
		// (~/.v3code/mcp.json). Replaces the broken updateValue write of the
		// pre-1.122 'chat.mcp.ui.enabled' key used by the retired startup-default contribution.
		'chat.mcp.apps.enabled': false,
		// Inline chat affordance at the cursor when text is selected.
		'inlineChat.affordance': 'editor',
		// Completion UX: Tab accepts the suggestion, locality-ranked + previewed suggest list.
		'editor.tabCompletion': 'on',
		'editor.suggest.localityBonus': true,
		'editor.suggest.preview': true,

		// v3code.* schema in v3codeProductSettings.ts; defaults mirrored here for desktop
		'v3code.cmdk.useThemedDiffBackground2': true,
		'v3code.inlineDiff.enablePerformanceProtection': true,
		'v3code.tab.disabledLanguages': [],
		'v3code.tab.enablePartialAccepts': false,
		'v3code.terminal.enableAiChecks': true,
		'v3code.terminal.usePreviewBox': false,
		'v3code.chat.maxWidth': 840,
		'v3code.voice.enabled': true,
		'v3code.agent.conversationDensity': 'compact-all-grouped',
		'v3code.agent.editorConversationDensity': 'detailed',
		'v3code.agent.queueMessageDefaultBehavior': 'queue',
		'v3code.agent.shouldAutoSaveNonAgent': true,
		'v3code.agent.shouldChimeAfterChatFinishes': false,
		'v3code.agent.showEmptyStateTips': true,
		'v3code.agent.suggestNextPrompt': false,
		'v3code.agent.textSizeScale': 1,
		'v3code.agent.usageSummaryDisplay': 'auto',
		'v3code.agent.cmdPFilePicker': false,
		'v3code.agent.showMarkdownHoverActions': false,
		'v3code.agent.customChimeSoundPath': '',
		'v3code.agent.planTextSizeScale': 'default',
		'v3code.general.disableHttp1SSE': false,
		'v3code.general.disableHttp2': false,
		'v3code.general.fontSmoothingAntialiased': true,
		'v3code.general.gitGraphIndexing': 'default',
		'v3code.general.globalIgnoreList': [],
		'v3code.general.pinnedTitleActions': [],
		'v3code.general.reduceTransparency': false,
		'v3code.preferNotificationsSameAsChat': false,
		'v3code.worktree.cleanupIntervalHours': 6,
		'v3code.worktree.maxCount': 25,
		'v3code.worktree.globalMaxSizeGb': 50,
		'v3code.localTraceMode': false,
		'v3code.debug.timeoutPrevention': 'local_only',
		'v3code.rpcFileLogger.enabled': false,
		'v3code.rpcFileLogger.folder': '',
		'v3code.semanticSearch.includeCommitsWithFiles': false,
		'v3code.windowSwitcher.sidebarHoverCollapsed': false,

		// V3Code-only product keys (registered elsewhere; desktop defaults here)
		'v3code.notifications.showToasts': false,
		'v3code.semanticIndex.autoRebuildOnStartup': true,

		// Terminal (V3Code product defaults)
		'terminal.integrated.shellIntegration.enabled': true,
		'terminal.integrated.enablePersistentSessions': true,
		'terminal.integrated.defaultProfile.windows': 'PowerShell',
		'terminal.integrated.defaultProfile.osx': 'zsh',
		'terminal.integrated.defaultProfile.linux': 'bash',
		'terminal.integrated.stickyScroll.enabled': true,
		'terminal.integrated.suggest.enabled': true,

		// Files (V3Code live autosave)
		'files.autoSave': 'afterDelay',
		'files.autoSaveDelay': 800,
		'files.autoSaveWhenNoErrors': false,

		// Theme tokens — contrast floor; grey-chrome contribution merges the full set per dark theme.
		'workbench.colorCustomizations': {
			'foreground': '#EDEBE6',
			'editor.foreground': '#EDEBE6',
			'editor.background': '#141416',
			'sideBar.background': '#141416',
			'sideBar.foreground': '#EDEBE6BD',
			'input.foreground': '#EDEBE6',
			'input.background': '#222226',
			'input.placeholderForeground': '#EDEBE66A',
			'descriptionForeground': '#8E8E96',
			'activityBar.activeBorder': '#3A3A42',
			'activityBarBadge.background': '#3A3A42',
			'activityBarBadge.foreground': '#EDEBE6',
			'button.background': '#2A2A30',
			'button.foreground': '#EDEBE6',
			'button.hoverBackground': '#3A3A42',
			'button.secondaryBackground': '#1A1A1E',
			'button.secondaryForeground': '#EDEBE6',
			'button.secondaryHoverBackground': '#222227',
			'chat.slashCommandBackground': '#2A2A3066',
			'chat.slashCommandForeground': '#8E8E96',
			'editorGutter.modifiedBackground': '#6B6B73',
			'focusBorder': '#3A3A42',
			'inputOption.activeBackground': '#3A3A4266',
			'inputOption.activeBorder': '#3A3A42',
			'list.focusAndSelectionOutline': '#3A3A42',
			'list.focusOutline': '#3A3A42',
			'menu.selectionBackground': '#2A2A30',
			'panelTitle.activeBorder': '#3A3A42',
			'problemsInfoIcon.foreground': '#8E8E96',
			'problemsWarningIcon.foreground': '#8E8E96',
			'progressBar.background': '#3A3A42',
			'statusBar.debuggingBackground': '#1c1c20',
			'statusBar.debuggingForeground': '#EDEBE6',
			'statusBar.focusBorder': '#3A3A42',
			'statusBarItem.focusBorder': '#3A3A42',
			'statusBarItem.remoteBackground': '#3A3A42',
			'statusBarItem.remoteForeground': '#EDEBE6',
			'tab.activeBorderTop': '#3A3A42',
			'tab.selectedBorderTop': '#3A3A42',
			'terminal.tab.activeBorder': '#3A3A42',
			'textLink.activeForeground': '#B8B8C0',
			'textLink.foreground': '#B8B8C0',
			'welcomePage.progress.foreground': '#3A3A42',
		},
	},
}]);

// Re-export for consumers that imported from this module historically
export { V3CODE_LOCAL_SESSION_ONLY_KEY } from './v3codeProductSettings.js';
