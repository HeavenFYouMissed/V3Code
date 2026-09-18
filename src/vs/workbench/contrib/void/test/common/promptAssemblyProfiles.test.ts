/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { PROMPT_ASSEMBLY_PROFILES, PromptAssemblyProfile, resolvePromptAssemblyProfile, shouldInjectPhaseProgress } from '../../common/prompt/promptAssemblyProfiles.js';
import {
	builtinTools,
	chat_systemMessage,
	filterExcludedTools,
	filterToCoreAgentTools,
	InternalToolInfo,
	V3CODE_AGENT_CHERRYPICK_PROMPT,
	V3CODE_AGENT_FLAT_PROMPT,
	V3CODE_AGENT_OS_PROMPT,
	V3CODE_AGENT_OVERWRITE_PROMPT,
	V3CODE_AGENT_V3_PROMPT,
	V3CODE_LEAN_AGENT_OS_PROMPT,
	V3CODE_MINIMAL_AGENT_OS_PROMPT,
	V3CODE_PHASE_PROGRESS_PROMPT,
} from '../../common/prompt/prompts.js';
import { DESIGN_MODE_INJECT } from '../../common/designActiveContext.js';

// Static-prefix fixture: staticOnly avoids the per-turn date so output is deterministic.
const staticSystemMessage = (profile?: PromptAssemblyProfile) => chat_systemMessage({
	workspaceFolders: ['/home/user/project'],
	openedURIs: [],
	activeURI: undefined,
	persistentTerminalIDs: [],
	directoryStr: 'project/\n  src/\n    index.ts',
	chatMode: 'agent',
	mcpTools: undefined,
	includeXMLToolDefinitions: true,
	staticOnly: true,
	...(profile ? { profile, compactToolDefs: profile.toolDefMode === 'compact' } : {}),
});

suite('promptAssemblyProfiles', () => {

	test('full preset is byte-identical to the pre-preset assembly (regression gate)', () => {
		assert.strictEqual(staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.full), staticSystemMessage(undefined));
	});

	// Budgets from docs/V3CODE-PROMPT-PRESETS-HANDOFF.md, tokens ~ chars/4. The production
	// static prefix also carries aiInstructions (capped per profile), so budget against
	// prompt + that cap, not the prompt alone.
	test('lean static prefix (incl. aiInstructions cap) stays under 6.1k tokens', () => {
		const len = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.lean).length
			+ (PROMPT_ASSEMBLY_PROFILES.lean.caps?.aiInstructions ?? 0)
			+ (shouldInjectPhaseProgress(PROMPT_ASSEMBLY_PROFILES.lean, 'agent') ? V3CODE_PHASE_PROGRESS_PROMPT.length + 2 : 0);
		// Deliberate integration raise 6k -> 6.1k tokens (2026-09-03): the repo-hygiene
		// tool contract and semantic-search-first guidance add 302 measured characters.
		// Deliberate raise 6.1k -> 6.125k tokens (2026-09-04, subagent-observability lane):
		// launch_subagent now states the queueing limit and the worker task shape that makes
		// delegation actually land (one output, inlined context, owned paths, expected
		// evidence). Measured at 24,479 chars — 79 over the old ceiling. The copy was
		// compressed to facts-only first; what remains is the honest cost of describing
		// behavior the lane implements.
		assert.ok(len < 6_125 * 4, `lean static prefix budget: ${len} chars`);
	});

	// The full preset had no ceiling at all, so nothing pushed back as sections accumulated.
	// This is a ratchet, not a target: it fails loud when the prompt grows, forcing the question
	// "does this section earn its slice of instruction-following?" every time. Compliance
	// degrades as instruction count rises, so growth has to be a decision, not a drift.
	test('full static prefix stays under its ceiling (ratchet — raise deliberately, never casually)', () => {
		const len = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.full).length
			+ (PROMPT_ASSEMBLY_PROFILES.full.caps?.aiInstructions ?? 0);
		// Tool additions since the original 112,205-char measurement are deliberate and covered
		// by the native schema budget. Deliberate raise 30k -> 30.5k tokens (2026-09-01,
		// subagents-full-power lane): subagents gained real work/research capability profiles,
		// and the tool descriptions + delegation guidance must describe them honestly — the
		// copy was tightened first, and the residual growth is this documented decision.
		// Deliberate integration raise 30.5k -> 30.75k tokens (2026-09-03): the
		// repo-hygiene contract and bundled Multitask foreman loop add 742 measured
		// characters on top of the full-power subagent lane.
		// Deliberate raise 30.75k -> 31.1k tokens (2026-09-04, subagent-observability lane):
		// two genuinely new tools are registered — message_subagent (bounded parent->worker
		// course-correction) and report_progress (worker milestones) — plus the worker task
		// shape on launch_subagent. A registered tool the model is never told how to use is
		// a dead tool, so this growth buys real capability rather than more advice. Measured
		// at 124,251 chars — 1,251 over the old ceiling, after the descriptions were
		// tightened from bulleted prose to single fact-dense paragraphs.
		// Keep the XML fallback below this ceiling rather than silently accepting drift.
		assert.ok(len < 31_100 * 4, `full static prefix budget: ${len} chars`);
	});

	test('minimal static prefix (incl. aiInstructions cap) stays under 3k tokens', () => {
		const len = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.minimal).length + (PROMPT_ASSEMBLY_PROFILES.minimal.caps?.aiInstructions ?? 0);
		assert.ok(len < 3_000 * 4, `minimal static prefix budget: ${len} chars`);
	});

	test('minimal keeps design autonomous unless explicit Design mode is injected', () => {
		const lean = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.lean);
		const minimal = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.minimal);
		assert.ok(lean.includes('v3code-design-rag'), 'lean retains the full design workflow');
		assert.ok(lean.includes('OFFER the design gallery'), 'lean retains the design offer');
		assert.ok(!minimal.includes('`ask_user` to OFFER the design gallery'), 'minimal does not force a gallery question');
		assert.ok(minimal.includes('Only offer the design gallery when the injected <design_mode> block explicitly says Design mode is ON.'));
		assert.ok(DESIGN_MODE_INJECT.includes('Design mode is ON'));
		assert.ok(DESIGN_MODE_INJECT.includes('call `ask_user`'));
		for (const msg of [lean, minimal]) {
			assert.ok(msg.includes("Never edit a file you haven't read this turn"), 'read-before-edit');
			assert.ok(msg.includes('fork'), 'research-first');
		}
	});

	test('every preset rehydrates a durable session digest after restart', () => {
		for (const profile of Object.values(PROMPT_ASSEMBLY_PROFILES)) {
			assert.strictEqual(profile.ephemeral.sessionDigest, true, `${profile.id} must preserve condensed-session continuity`);
		}
	});

	test('every preset keeps project knowledge pull-first', () => {
		for (const profile of Object.values(PROMPT_ASSEMBLY_PROFILES)) {
			assert.strictEqual(profile.ephemeral.projectBrief, false, `${profile.id} project brief`);
			assert.strictEqual(profile.ephemeral.workspaceMemory, false, `${profile.id} workspace memory`);
			assert.strictEqual(profile.ephemeral.symbolSkeleton, false, `${profile.id} symbol skeleton`);
			assert.strictEqual(profile.ephemeral.autoCodebaseContext, false, `${profile.id} semantic auto-context`);
		}
		// The active plan is task residue with structured authority (durable-task taskId
		// linkage + side-turn replace guard), so the FULL profile shows it; smaller
		// profiles keep it pull-only.
		assert.strictEqual(PROMPT_ASSEMBLY_PROFILES.full.ephemeral.activePlan, true, 'full active plan');
		for (const profile of Object.values(PROMPT_ASSEMBLY_PROFILES)) {
			if (profile.id === 'full') continue;
			assert.strictEqual(profile.ephemeral.activePlan, false, `${profile.id} active plan stays pull-only`);
		}
		assert.strictEqual(PROMPT_ASSEMBLY_PROFILES.full.injectModelRoster, false, 'configured model roster is pulled only when needed');
	});

	test('every agent prompt describes project memory as pull-first', () => {
		const prompts = {
			full: V3CODE_AGENT_OS_PROMPT,
			cherrypick: V3CODE_AGENT_CHERRYPICK_PROMPT,
			lean: V3CODE_LEAN_AGENT_OS_PROMPT,
			minimal: V3CODE_MINIMAL_AGENT_OS_PROMPT,
			overwrite: V3CODE_AGENT_OVERWRITE_PROMPT,
			v3: V3CODE_AGENT_V3_PROMPT,
			flat: V3CODE_AGENT_FLAT_PROMPT,
		};
		const staleInjectionClaims = [
			'auto-injected each turn',
			'<background_facts>',
			'<project_brief>',
			'<active_plan>',
			'injected directory tree',
			'injected context + your notes',
		];
		for (const [name, prompt] of Object.entries(prompts)) {
			assert.ok(prompt.toLowerCase().includes('pull'), `${name} must tell the agent to pull context`);
			assert.ok(prompt.includes('get_project_briefing'), `${name} must name the project-orientation path`);
			for (const staleClaim of staleInjectionClaims) {
				assert.ok(!prompt.includes(staleClaim), `${name} still claims "${staleClaim}" is injected`);
			}
		}
	});

	test('every actionable preset teaches safe project switching and LSP recovery', () => {
		for (const profile of Object.values(PROMPT_ASSEMBLY_PROFILES)) {
			const prompt = staticSystemMessage(profile);
			assert.ok(prompt.includes('replace') && prompt.includes('multi-root'), `${profile.id} project replacement rule`);
			assert.ok(prompt.includes('LSP recovery:') && (prompt.includes('not missing code') || prompt.includes('not proof the code is absent')), `${profile.id} LSP recovery rule`);
			assert.ok(prompt.includes('trusted') && prompt.includes('extension') && (prompt.includes('ask before') || prompt.includes('approve')), `${profile.id} extension approval rule`);
			assert.ok(prompt.includes('`reload_window`') && prompt.includes('final'), `${profile.id} reload rule`);
		}
	});

	test('every preset translates final answers for a non-specialist', () => {
		for (const profile of Object.values(PROMPT_ASSEMBLY_PROFILES)) {
			const prompt = staticSystemMessage(profile);
			assert.ok(prompt.includes('smart eighth grader'), `${profile.id} plain-language level`);
			assert.ok(prompt.includes('Lead with the answer, then explain why'), `${profile.id} answer-first rule`);
			assert.ok(prompt.includes('what changed, what you checked, and what remains'), `${profile.id} final-response order`);
		}
	});

	test('compact defs carry the edit_file block format and minimal advertises the core surface only', () => {
		const lean = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.lean);
		const minimal = staticSystemMessage(PROMPT_ASSEMBLY_PROFILES.minimal);
		assert.deepStrictEqual({
			leanHasEditFormat: lean.includes('<<<<<<< ORIGINAL'),
			minimalHasEditFormat: minimal.includes('<<<<<<< ORIGINAL'),
			minimalHasCore: ['read_file(', 'edit_file(', 'append_file(', 'pack_context(', 'semantic_search(', 'read_skill(', 'web_search(', 'ask_user(', 'get_build_errors('].every(s => minimal.includes(s)),
			minimalHidesNonCore: !minimal.includes('open_browser_page(') && !minimal.includes('run_subagent('),
			leanKeepsFullSurface: lean.includes('open_browser_page(') && lean.includes('pack_context('),
		}, {
			leanHasEditFormat: true,
			minimalHasEditFormat: true,
			minimalHasCore: true,
			minimalHidesNonCore: true,
			leanKeepsFullSurface: true,
		});
	});

	test('minimal native surface stays focused while covering a complete coding loop', () => {
		const names = filterToCoreAgentTools(Object.values(builtinTools) as InternalToolInfo[], undefined).map(tool => tool.name).sort();
		assert.deepStrictEqual(names, [
			'read_file', 'ls_dir', 'find_text', 'pack_context', 'semantic_search',
			'create_file_or_folder', 'edit_file', 'rewrite_file', 'append_file', 'run_command',
			'get_build_errors', 'web_search', 'read_skill', 'open_project', 'close_project', 'reload_window', 'ask_user',
		].sort());
	});

	test('phase progress follows prompt capacity instead of provider tool format', () => {
		for (const mode of ['agent', 'read', 'plan', 'debug'] as const) {
			assert.strictEqual(shouldInjectPhaseProgress(PROMPT_ASSEMBLY_PROFILES.full, mode), true, `full ${mode}`);
			assert.strictEqual(shouldInjectPhaseProgress(PROMPT_ASSEMBLY_PROFILES.lean, mode), false, `lean ${mode}`);
			assert.strictEqual(shouldInjectPhaseProgress(PROMPT_ASSEMBLY_PROFILES.minimal, mode), false, `minimal ${mode}`);
		}
		assert.strictEqual(shouldInjectPhaseProgress(PROMPT_ASSEMBLY_PROFILES.full, 'chat'), false, 'full chat');
		assert.strictEqual(shouldInjectPhaseProgress(PROMPT_ASSEMBLY_PROFILES.lean, 'chat'), false, 'lean chat');
		assert.ok(V3CODE_PHASE_PROGRESS_PROMPT.length < 900, 'phase-progress reinforcement stays compact');
		assert.ok(V3CODE_PHASE_PROGRESS_PROMPT.includes('meaningful phases'));
	});

	test('turn-level ask_user exclusion removes its schema from the compact tool surface', () => {
		const core = filterToCoreAgentTools(Object.values(builtinTools) as InternalToolInfo[], undefined);
		const names = filterExcludedTools(core, ['ask_user']).map(tool => tool.name);
		assert.ok(!names.includes('ask_user'));
		assert.ok(names.includes('edit_file'));
	});

	test('resolver: manual wins; local auto adapts by model size; cloud auto adapts by context', () => {
		const resolvedIds = [
			resolvePromptAssemblyProfile({ setting: 'minimal', providerName: 'anthropic', contextWindow: 200_000 }),
			resolvePromptAssemblyProfile({ setting: 'full', providerName: 'ollama', modelName: 'gemma4:e4b', contextWindow: 8_000 }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'ollama', modelName: 'gemma4:e4b', contextWindow: 32_000 }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'ollama', modelName: 'qwen3-coder:30b-a3b', contextWindow: 32_000 }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'lmStudio', modelName: 'llama3.1:70b', contextWindow: 32_000 }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'vLLM', modelName: 'local-alias', contextWindow: 128_000, isUnrecognizedModel: false }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'v3code-local', modelName: 'custom', contextWindow: 128_000, isUnrecognizedModel: true }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'openAI', contextWindow: 32_000 }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'openRouter', contextWindow: 32_768 }),
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'anthropic', contextWindow: 200_000 }),
			// capability-table guess (4,096) for an unrecognized cloud deployment must NOT downgrade to lean
			resolvePromptAssemblyProfile({ setting: 'auto', providerName: 'microsoftAzure', contextWindow: 4_096, isUnrecognizedModel: true }),
			// invalid persisted value (settings import) must degrade to full, never crash
			resolvePromptAssemblyProfile({ setting: 'bogus' as never, providerName: 'anthropic', contextWindow: 200_000 }),
			resolvePromptAssemblyProfile({ setting: undefined, providerName: undefined, contextWindow: undefined }),
		].map(p => p.id);
		assert.deepStrictEqual(resolvedIds, ['minimal', 'full', 'minimal', 'lean', 'lean', 'lean', 'minimal', 'lean', 'lean', 'full', 'full', 'full', 'full']);
	});

});
