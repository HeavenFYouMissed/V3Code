/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canSubagentDelegate, isReadOnlySubagentToolAllowed, isSubagentToolAllowed, SUBAGENT_MAX_NESTING_DEPTH } from '../../common/toolsServiceTypes.js';
import { MAX_BACKGROUND_SUBAGENTS_PER_PARENT, MAX_BACKGROUND_SUBAGENTS_TOTAL, overlappingClaims, subagentAdmission, teamClaimsOverlap } from '../../common/subagentLifecycle.js';
import { subagentExcludedToolNames } from '../../common/prompt/prompts.js';

suite('background subagent containment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows read-only workspace investigation', () => {
		assert.strictEqual(isReadOnlySubagentToolAllowed('read_file', true), true);
		assert.strictEqual(isReadOnlySubagentToolAllowed('semantic_search', true), true);
		assert.strictEqual(isReadOnlySubagentToolAllowed('git_status', true), true);
	});

	test('denies edits, terminal, memory mutation, recursion, and MCP tools', () => {
		for (const tool of [
			'edit_file', 'run_command', 'remember', 'forget', 'team_checkin', 'update_plan',
			'launch_subagent', 'run_subagent', 'open_project', 'reload_window', 'computer_list_apps', 'open_browser_page', 'read_terminal_output',
		]) {
			assert.strictEqual(isReadOnlySubagentToolAllowed(tool, true), false, tool);
		}
		assert.strictEqual(isReadOnlySubagentToolAllowed('third_party_mcp_tool', false), false);
	});

	test('research profile resolves identically through the shared policy', () => {
		for (const tool of ['read_file', 'edit_file', 'run_command', 'team_checkin', 'launch_subagent']) {
			assert.strictEqual(
				isSubagentToolAllowed('research', tool, true, { canDelegate: true }),
				isReadOnlySubagentToolAllowed(tool, true),
				tool,
			);
		}
		// research children never delegate, even when the caller claims depth allows it
		assert.strictEqual(isSubagentToolAllowed('research', 'run_subagent', true, { canDelegate: true }), false);
		assert.strictEqual(isSubagentToolAllowed('research', 'third_party_mcp_tool', false), false);
	});
});

suite('work subagent capability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('work children get real worker tools', () => {
		for (const tool of [
			'read_file', 'edit_file', 'rewrite_file', 'create_file_or_folder', 'delete_file_or_folder',
			'run_command', 'run_persistent_command', 'run_tests', 'git_status', 'git_commit',
			'remember', 'forget', 'team_checkin', 'team_board', 'read_terminal_output', 'semantic_search',
		]) {
			assert.strictEqual(isSubagentToolAllowed('work', tool, true), true, tool);
		}
		assert.strictEqual(isSubagentToolAllowed('work', 'third_party_mcp_tool', false), true, 'parent-enabled MCP tools are allowed');
	});

	test('work children never get parent-conversation or workspace-swap tools', () => {
		for (const tool of ['ask_user', 'update_plan', 'open_project', 'close_project', 'reload_window', 'recover_session_anchors', 'team_contract']) {
			assert.strictEqual(isSubagentToolAllowed('work', tool, true), false, tool);
		}
	});

	test('delegation is gated by nesting depth for work children only', () => {
		assert.strictEqual(isSubagentToolAllowed('work', 'launch_subagent', true, { canDelegate: true }), true);
		assert.strictEqual(isSubagentToolAllowed('work', 'run_subagent', true, { canDelegate: true }), true);
		assert.strictEqual(isSubagentToolAllowed('work', 'launch_subagent', true, { canDelegate: false }), false);
		assert.strictEqual(isSubagentToolAllowed('work', 'run_subagent', true, { canDelegate: false }), false);
		assert.strictEqual(isSubagentToolAllowed('work', 'launch_subagent', true), false, 'no delegation unless the caller resolved depth');

		assert.strictEqual(canSubagentDelegate(0), true, 'root threads delegate');
		assert.strictEqual(canSubagentDelegate(SUBAGENT_MAX_NESTING_DEPTH - 1), true, 'the last allowed level delegates');
		assert.strictEqual(canSubagentDelegate(SUBAGENT_MAX_NESTING_DEPTH), false, 'the deepest child does not');
	});
});

suite('subagent advertised set == enforced set', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const mcpTools = [
		{ name: 'lookup_symbol', description: 'Looks up a symbol.', params: {}, mcpServerName: 'workspace_index' },
	];

	test('every excluded tool is exactly a tool the runtime gate denies', () => {
		for (const profile of ['work', 'research'] as const) {
			for (const canDelegate of [true, false]) {
				const excluded = new Set(subagentExcludedToolNames(profile, mcpTools, { canDelegate }));
				// a tool is excluded from the child's advertised set IFF the runtime gate denies it
				for (const name of excluded) {
					const isBuiltin = name !== 'lookup_symbol';
					assert.strictEqual(isSubagentToolAllowed(profile, name, isBuiltin, { canDelegate }), false, `${profile}: excluded ${name} must be denied at runtime`);
				}
				// converse: whatever stays advertised must pass the runtime gate
				for (const name of ['read_file', 'edit_file', 'run_command', 'team_checkin', 'launch_subagent', 'lookup_symbol']) {
					if (excluded.has(name)) { continue; }
					const isBuiltin = name !== 'lookup_symbol';
					assert.strictEqual(isSubagentToolAllowed(profile, name, isBuiltin, { canDelegate }), true, `${profile}: advertised ${name} must be allowed at runtime`);
				}
				assert.strictEqual(excluded.has('read_file'), false, `${profile}: read tools stay advertised`);
			}
		}
	});

	test('research excludes MCP and mutation; work keeps them', () => {
		const research = new Set(subagentExcludedToolNames('research', mcpTools, { canDelegate: false }));
		assert.ok(research.has('edit_file'));
		assert.ok(research.has('run_command'));
		assert.ok(research.has('lookup_symbol'), 'MCP tools are stripped from a research child');
		const work = new Set(subagentExcludedToolNames('work', mcpTools, { canDelegate: true }));
		assert.strictEqual(work.has('edit_file'), false);
		assert.strictEqual(work.has('run_command'), false);
		assert.strictEqual(work.has('lookup_symbol'), false);
		assert.ok(work.has('ask_user'));
	});
});

suite('subagent admission and concurrency caps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('admits parallel workers up to the per-parent cap, then queues', () => {
		for (let running = 0; running < MAX_BACKGROUND_SUBAGENTS_PER_PARENT; running++) {
			const result = subagentAdmission({ depth: 1, runningForParent: running, runningTotal: running });
			assert.strictEqual(result.ok, true, `worker #${running + 1} must start`);
			if (result.ok) assert.strictEqual(result.queued, false, `worker #${running + 1} must not be queued`);
		}
		// Fourth is QUEUED, not rejected.
		const queued = subagentAdmission({ depth: 1, runningForParent: MAX_BACKGROUND_SUBAGENTS_PER_PARENT, runningTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT, queuedForParent: 0, activeTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT });
		assert.strictEqual(queued.ok, true, 'fourth must be admitted (queued)');
		if (queued.ok) assert.strictEqual(queued.queued, true, 'fourth must be queued');
	});

	test('enforces the window-wide total cap (running + queued)', () => {
		const refused = subagentAdmission({ depth: 1, runningForParent: 0, runningTotal: 0, queuedForParent: 0, activeTotal: MAX_BACKGROUND_SUBAGENTS_TOTAL });
		assert.strictEqual(refused.ok, false);
	});

	test('admits nesting within the cap and refuses beyond it', () => {
		assert.strictEqual(subagentAdmission({ depth: 1, runningForParent: 0, runningTotal: 0 }).ok, true);
		assert.strictEqual(subagentAdmission({ depth: SUBAGENT_MAX_NESTING_DEPTH, runningForParent: 0, runningTotal: 0 }).ok, true);
		assert.strictEqual(subagentAdmission({ depth: SUBAGENT_MAX_NESTING_DEPTH + 1, runningForParent: 0, runningTotal: 0 }).ok, false);
	});
});

suite('team board claim overlap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('flags overlapping path claims in either direction', () => {
		assert.strictEqual(teamClaimsOverlap('src/auth/', 'src/auth/login.ts'), true);
		assert.strictEqual(teamClaimsOverlap('src/auth/login.ts', 'src/auth/'), true);
		assert.strictEqual(teamClaimsOverlap('src/auth, src/session', 'src/session/store.ts'), true);
	});

	test('does not flag disjoint claims or empty ones', () => {
		assert.strictEqual(teamClaimsOverlap('src/auth/', 'docs/readme.md'), false);
		assert.strictEqual(teamClaimsOverlap(null, 'src/auth/'), false);
		assert.strictEqual(teamClaimsOverlap('src/auth/', undefined), false);
	});

	test('overlappingClaims skips the claimant itself', () => {
		const entries = [
			{ agentId: 'sub:aaaa', where: 'src/auth/' },
			{ agentId: 'sub:bbbb', where: 'src/auth/tokens.ts' },
		];
		const overlaps = overlappingClaims('src/auth/', entries, 'sub:aaaa');
		assert.deepStrictEqual(overlaps.map(o => o.agentId), ['sub:bbbb']);
	});
});
