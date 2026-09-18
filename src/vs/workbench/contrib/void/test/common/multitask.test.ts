/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	formatContractsBlock, formatReconcilePrompt, isContractStale, MAX_CONTRACT_VALUE_CHARS, MAX_INJECTED_CONTRACTS,
	shouldReconcileBatch, TEAM_CONTRACT_STALE_MS,
} from '../../common/subagentLifecycle.js';
import { isSubagentToolAllowed } from '../../common/toolsServiceTypes.js';
import { availableTools } from '../../common/prompt/prompts.js';
import { modeHasWorkspaceContext } from '../../common/voidSettingsTypes.js';

suite('multitask (coordinator) mode surface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const mcpTools = [{ name: 'lookup_symbol', description: 'x', params: {}, mcpServerName: 'ws' }];
	const names = () => new Set((availableTools('multitask', mcpTools) ?? []).map(t => t.name));

	test('the coordinator can plan, freeze contracts, and dispatch — but never edit or run terminals itself', () => {
		const n = names();
		for (const tool of ['update_plan', 'team_contract', 'team_board', 'team_checkin', 'launch_subagent', 'run_subagent', 'read_file', 'semantic_search', 'create_file_or_folder', 'rewrite_file', 'append_file', 'remember_editorial']) {
			assert.ok(n.has(tool), `${tool} must be available to the coordinator`);
		}
		for (const tool of ['edit_file', 'run_command', 'run_persistent_command', 'delete_file_or_folder', 'git_commit', 'open_project']) {
			assert.ok(!n.has(tool), `${tool} must be withheld from the coordinator`);
		}
		assert.ok(!n.has('lookup_symbol'), 'MCP tools stay with the workers, not the coordinator');
	});

	test('agent mode is byte-for-byte untouched by the new mode', () => {
		const agent = (availableTools('agent', mcpTools) ?? []).map(t => t.name);
		assert.ok(agent.includes('edit_file') && agent.includes('run_command') && agent.includes('lookup_symbol'));
	});

	test('the coordinator keeps workspace context', () => {
		assert.strictEqual(modeHasWorkspaceContext('multitask'), true);
	});
});

suite('team contracts (frozen shared decisions)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every child preamble carries the frozen contracts verbatim', () => {
		const block = formatContractsBlock([
			{ key: '--pub-sub', value: '#6e6a62', rationale: '5.25:1 on paper' },
			{ key: 'api-error-shape', value: '{ code, message }', rationale: null },
		]);
		assert.ok(block.startsWith('FROZEN TEAM CONTRACTS'));
		assert.ok(block.includes('- --pub-sub = #6e6a62 (5.25:1 on paper)'));
		assert.ok(block.includes('- api-error-shape = { code, message }'));
		assert.ok(block.includes('do not re-derive'));
	});

	test('no contracts → no block (children see nothing extra)', () => {
		assert.strictEqual(formatContractsBlock([]), '');
	});

	test('a runaway board is capped, never dumped whole into a child', () => {
		const many = Array.from({ length: MAX_INJECTED_CONTRACTS + 5 }, (_, i) => ({ key: `k${i}`, value: 'v', rationale: null }));
		const block = formatContractsBlock(many);
		assert.ok(block.includes(`(+5 more — read team_board)`));
		const long = formatContractsBlock([{ key: 'big', value: 'x'.repeat(MAX_CONTRACT_VALUE_CHARS + 50), rationale: null }]);
		assert.ok(long.includes('x'.repeat(MAX_CONTRACT_VALUE_CHARS) + '…'));
		assert.ok(!long.includes('x'.repeat(MAX_CONTRACT_VALUE_CHARS + 1)));
	});

	test('contracts go stale after 48h but are flagged, not dropped', () => {
		const now = Date.parse('2026-09-02T00:00:00Z');
		assert.strictEqual(isContractStale(new Date(now - 60_000).toISOString(), now), false);
		assert.strictEqual(isContractStale(new Date(now - TEAM_CONTRACT_STALE_MS - 1).toISOString(), now), true);
		assert.ok(formatContractsBlock([{ key: 'k', value: 'v', rationale: null, stale: true }]).includes('[stale]'));
	});

	test('contracts are the foreman\'s: denied to work AND research children', () => {
		assert.strictEqual(isSubagentToolAllowed('work', 'team_contract', true, { canDelegate: true }), false);
		assert.strictEqual(isSubagentToolAllowed('research', 'team_contract', true), false);
		assert.strictEqual(isSubagentToolAllowed('work', 'team_board', true), true, 'children still READ the board');
	});
});

suite('batch reconcile trigger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fires once the last of ≥2 workers lands and at least one completed', () => {
		assert.strictEqual(shouldReconcileBatch({ running: 0, terminal: 3, completed: 3 }), true);
		assert.strictEqual(shouldReconcileBatch({ running: 0, terminal: 2, completed: 1 }), true, 'one failed, one completed — still reconcile');
	});

	test('does not fire while workers still run, for a single worker, or for an all-cancelled batch', () => {
		assert.strictEqual(shouldReconcileBatch({ running: 1, terminal: 2, completed: 2 }), false);
		assert.strictEqual(shouldReconcileBatch({ running: 0, terminal: 1, completed: 1 }), false);
		assert.strictEqual(shouldReconcileBatch({ running: 0, terminal: 3, completed: 0 }), false, 'parent Stop cascade: nothing to reconcile');
	});

	test('the reconcile prompt names the contracts in force, or says none were frozen', () => {
		const withContracts = formatReconcilePrompt(3, [{ key: '--pub-sub', value: '#6e6a62', rationale: null }]);
		assert.ok(withContracts.startsWith('[All 3 background subagents have finished'));
		assert.ok(withContracts.includes('Contracts in force: --pub-sub = #6e6a62'));
		assert.ok(withContracts.includes('DIVERGE'));
		const without = formatReconcilePrompt(2, []);
		assert.ok(without.includes('No contracts were frozen'));
	});
});
