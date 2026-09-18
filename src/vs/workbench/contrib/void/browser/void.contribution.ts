/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */


// register inline diffs
import './editCodeService.js'

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js'
// The old V3Code React sidebar chat (sidebarPane), the [v]-panel agent editor
// (voidChatEditorInput + agentPanelService/agentPanelActions), and the "V companion"
// panel are DELETED — the native VS Code chat agent replaces them. VIBE layout mode
// stays disabled; its files remain only because the React service bridge still imports
// IVibeModeService.
// import './vibeModeService.js'
// import './vibeModeActions.js'

// Cursor-faithful Agents layout machine (unified sidebar + ⌥⌘U / ⌥⌘E)
import './agentLayoutService.js'
import './agentLayoutActions.js'
import './unifiedSidebarAgentsContribution.js'

// V3 Agent Mode (pill toggle + slide-over agent layout)
import './v3AgentMode.js'

// V3 SOLO surface tabs (Flow / Editor / Browser / Terminal) shown in V3 mode
import './v3SoloTabs.js'
// Browser editors stay open after a turn; the user or an explicit close action owns their lifetime.
import './repoHygieneService.js'
import './repoHygieneActions.js'

// V3 ship-prep titlebar chrome: repo/branch pill + search pill (always visible),
// profile avatar dropdown (top-right), and the Report Issue / Feedback commands
import './v3RepoButton.js'
import './v3SearchButton.js'
import './v3ProfileButton.js'
import './v3ReportIssue.js'

// Editor <-> v3code.dev auth loop: handle the v3code://auth/callback sign-in return deep-link
import './v3codeAuthUrlHandler.js'

// V3 chrome: hide native accounts + Copilot sign-in; gear opens V3Code settings
import './v3ChromeStartup.js'
import './v3TitlebarGear.js'
import './v3RemoteService.js'
import './v3RemoteButton.js'

// Built-in Web Speech STT + press-to-talk mic in chat composer
import './v3codeWebSpeechProvider.js'
import './v3codeVoiceInputActionViewItem.js'

// register quick edit (Ctrl+K)
import './quickEditActions.js'


// register the built-in local inference proxy + first-run model download
import './localInferenceProxy.js'
import './localModelStartup.js'

// register the recent-edits journal (keystone for next-edit prediction) — BEFORE its consumers
import './recentEditsService.js'
import './turboDraftService.js'
import './turboDraftActions.js'
import './turboDraftDock.js'

// register Autocomplete
import './autocompleteService.js'

// register Next-edit prediction (rename-pattern Tab completion)
import './nextEditPredictionService.js'

// register the LLM-backed Next-Edit engine (speculative "tab to fix this")
import './nextEditService.js'

// V Go - Explorer panel that makes next-edit suggestions discoverable.
import './v3GoPane.js'

// register Context services
// import './contextGatheringService.js'
// import './contextUserChangesService.js'

// settings pane
import './voidSettingsPane.js'

// register css
import './media/void.css'

// The bundled v3.css (~1.3MB) is injected via <link> in v3codeGreyChromeContribution — NOT an ESM
// import here. A side-effect `import './media/v3.css'` breaks dev boot (grey screen:
// "Failed to fetch dynamically imported module: workbench.desktop.main.js").

// update (frontend part, also see platform/)
import './voidUpdateActions.js'

import './convertToLLMMessageWorkbenchContrib.js'

// tools
import './toolsService.js'
import './terminalToolService.js'

// register Thread History
import './chatThreadService.js'

// ping
import './metricsPollService.js'

// helper services
import './helperServices/consistentItemService.js'

// register selection helper
import './voidSelectionHelperWidget.js'

// register tooltip service
import './tooltipService.js'

// register onboarding service
import './voidOnboardingService.js'

// Context Bridge tools are built into V3Code natively (toolsService.ts + lspBridgeAdapter,
// using VS Code's in-process language features — faster + no approval prompts). They are also
// exposed to the embedded Claude Agent SDK session as the in-process `v3code` MCP server (see the
// copilot extension's chatSessions/claude/vscode-node/mcpServers/v3codeNativeToolsMcpServer.ts,
// bridged via the _v3code.contextBridge.invokeNativeTool command in v3codeToolAdapters.ts).
// Legacy context-bridge stdio MCP cleanup (removes the old auto-registered entry from ~/.v3code/mcp.json).
import './contextBridgeStartup.js'

// register Context Bridge native service (symbol-attached notes)
import '../common/contextBridge/contextBridgeService.js'
import '../common/contextBridge/contextBridgeScopeService.js'

// register the account stub service (guest-only seam for future hosted auth) —
// consumed by the titlebar profile button + the Settings Account tab
import '../common/v3codeAccountService.js'

// register LSP Bridge Adapter (in-process VS Code language feature wrapper used by CB tools)
import './contextBridge/lspBridgeAdapter.js'

// register Workspace Rules Service (.v3code/rules/*.mdc + .v3coderules)
import './workspaceRulesService.js'

// register Skills Service (bundled .v3code/skills + ~/.v3code/skills + workspace overrides)
import './skillsService.js'

// register Memory Service (3-layer memory store proxy -> electron-main void-channel-memory)
import './memoryService.js'
import './shadowWorkspaceService.js'
import './memoryCaptureService.js'
import './memoryStartup.js'
import './memoryIndexScheduler.js'
import './memoryLedgerPane.js'
import '../common/tokenUsageService.js'
import './tokenUsageStatusBar.js'

// register Resource Monitor (status bar CPU/RAM/V3 glance + full panel)
import './resourceMonitorService.js'
import './resourceMonitorStatusBar.js'
import './resourceMonitorPane.js'

// register Semantic Index (codebase indexing + retrieval)
// Full pipeline: tree-sitter chunker → @xenova/transformers embedder → sqlite-vec + FTS5 →
// RRF hybrid retrieval. Falls back to lexical-only if native deps aren't available at runtime.
// NOTE: The full common/semanticIndex/semanticIndexService.ts imports Node builtins (path/fs/os/crypto)
// which crash the renderer ESM loader. Until it's behind an IPC boundary, use the browser impl
// which does the same work via IFileService + Web Crypto (no Node deps).
import '../common/semanticIndex/semanticIndexConfiguration.js'
import './semanticEmbedProxy.js'
import './beastService.js'
import './semanticIndexNodeProxy.js'
import './bundleReconstructProxy.js'
import './semanticIndexBrowserImpl.js'

// register Security Scan Service (browser ScanHost for the security_scan tool)
import './securityScanService.js'
import './semanticIndexAutoStart.js'
import './semanticIndexActions.js'
import './yoloModeActions.js'
import './grokSignInActions.js'
import './subscriptionSignInActions.js'
import './semanticIndexStatusBar.js'
import './beastStatusBar.js'

// Exposes V3Code's built-in intelligence tools to external agents (Claude Code,
// etc.) over a local MCP/HTTP endpoint. Registers the renderer-side toolHost
// channel + announces the window to the main-process MCP server.
import './mcpExposeContribution.js'
// The live IMCPService: routes MCP through upstream's registry so OAuth servers (GitHub,
// Linear, …) can actually sign in, and local servers spawn with a real shell PATH. The
// legacy in-house host (common/mcpService.ts) is deliberately unregistered.
import './mcpUpstreamFacade.js'
import '../common/cloudIndex/cloudIndexConfiguration.js'
import './cloudIndexProxy.js'
import './cloudIndexSyncService.js'
import './cloudIndexActions.js'
import './cloudIndexSyncContribution.js'
import './cloudIndexStatusBar.js'

// register V3Code agentic feature services. These register their DI singletons so they
// are injectable. Full UI/agent-loop wiring is incremental; registration here makes the
// services live and available for consumers.
// NOTE: agentModeService (use existing ChatMode normal/gather/agent), rollbackService
// (use existing checkpoint system), and diffPreviewService (use existing editCodeService
// diff zones) were removed as redundant with capabilities V3Code already has.
import './autoContextService.js'        // auto-attach relevant files to a prompt
import './backgroundAgentService.js'    // background task state management
import './slashCommandService.js'       // /fix /explain /test /commit /refactor /doc

import './v3codeLanguageModelProvider.js'
// register V3Code as the native default chat agent (sidebar, inline, terminal, quick chat)
import './v3codeChatAgent.js'
import './v3codeToolAdapters.js'
import './v3codeSlashCommands.js'
import './v3codeMarketplacePane.js'
import './v3codeChatBrandingContribution.js'
import './v3codeProductSettings.js'
import './v3codeGreyChromeContribution.js'
import './v3codeVenomChromeContribution.js'
import './v3codeNotificationsContribution.js'
import './v3codeBroadcastService.js'
import './v3codeDefaultSettings.js'
import './v3codeChatInputContribution.js'
import './v3codeReasoningConfigBridge.js'
import './v3NativeNoticeHintContribution.js'
import './externalAgentsContribution.js'

// register misc service
import './miscWokrbenchContrib.js'

// register file service (for explorer context menu)
import './fileService.js'

// register source control management
import './voidSCMService.js'

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js'

// voidSettings
import '../common/voidSettingsService.js'

// refreshModel
import '../common/refreshModelService.js'

// metrics
import '../common/metricsService.js'

// updates
import '../common/voidUpdateService.js'

// model service
import '../common/voidModelService.js'
