/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { builtinTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import {
	builtinNativeToolId,
	mcpNativeToolId,
	modelToolNameFromNativeId,
	modelToolNamesDisabledBySelection,
	modelToolNamesMissingNativeRegistration,
	readOnlySubagentNativeToolSelection,
	resolveNativeToolId,
	subagentNativeToolSelection,
} from '../../browser/v3codeToolIds.js';
import { isSubagentToolAllowed, SubagentProfile } from '../../common/toolsServiceTypes.js';

suite('V3Code tool ids', () => {
	test('maps disabled custom-agent tools to model schema names', () => {
		const mcpTools: InternalToolInfo[] = [{
			name: 'lookup_symbol',
			description: 'Looks up a symbol.',
			params: {},
			mcpServerName: 'workspace_index',
		}];
		const selected = {
			[builtinNativeToolId('read_file')]: true,
			[builtinNativeToolId('edit_file')]: false,
			runTests: false,
			[mcpNativeToolId('workspace_index', 'lookup_symbol')]: false,
			unrelatedExtensionTool: false,
		};

		assert.deepStrictEqual(modelToolNamesDisabledBySelection(selected, mcpTools), [
			'edit_file',
			'lookup_symbol',
			'run_tests',
		]);
	});

	test('reverses MCP ids exactly when the server name contains underscores', () => {
		const mcpTools: InternalToolInfo[] = [{
			name: 'lookup_symbol',
			description: 'Looks up a symbol.',
			params: {},
			mcpServerName: 'workspace_index',
		}];
		assert.strictEqual(
			modelToolNameFromNativeId(mcpNativeToolId('workspace_index', 'lookup_symbol'), mcpTools),
			'lookup_symbol',
		);
	});

	test('does not advertise native-only tools that are missing from this runtime', () => {
		const registered = new Set(['computer_read_screen', 'computer_screenshot', 'runSubagent']);
		const missing = modelToolNamesMissingNativeRegistration(id => registered.has(id));

		assert.ok(!missing.includes('computer_read_screen'));
		assert.ok(!missing.includes('computer_screenshot'));
		assert.ok(!missing.includes('run_subagent'));
		assert.ok(missing.includes('computer_click'));
		assert.ok(missing.includes('computer_list_apps'));
		assert.ok(missing.includes('open_browser_page'));
	});

	test('blocking subagent selection preserves reads and fails closed for mutations', () => {
		const mcpTools: InternalToolInfo[] = [{
			name: 'lookup_symbol',
			description: 'Looks up a symbol.',
			params: {},
			mcpServerName: 'workspace_index',
		}];
		const selected = readOnlySubagentNativeToolSelection({
			[builtinNativeToolId('read_file')]: true,
			[builtinNativeToolId('edit_file')]: true,
			[builtinNativeToolId('run_command')]: true,
			[mcpNativeToolId('workspace_index', 'lookup_symbol')]: true,
			unrelatedExtensionTool: true,
		}, mcpTools);

		assert.strictEqual(selected[builtinNativeToolId('read_file')], true);
		assert.strictEqual(selected[builtinNativeToolId('semantic_search')], true);
		assert.strictEqual(selected[builtinNativeToolId('edit_file')], false);
		assert.strictEqual(selected[builtinNativeToolId('run_command')], false);
		assert.strictEqual(selected.runSubagent, false);
		assert.strictEqual(selected[mcpNativeToolId('workspace_index', 'lookup_symbol')], false);
		assert.strictEqual(selected.unrelatedExtensionTool, false);
	});

	test('work subagent selection allows edits, terminal, and parent-enabled MCP tools', () => {
		const mcpTools: InternalToolInfo[] = [
			{ name: 'lookup_symbol', description: 'Looks up a symbol.', params: {}, mcpServerName: 'workspace_index' },
			{ name: 'send_message', description: 'Sends a message.', params: {}, mcpServerName: 'slack' },
		];
		const selected = subagentNativeToolSelection('work', {
			[builtinNativeToolId('read_file')]: true,
			[builtinNativeToolId('edit_file')]: true,
			[builtinNativeToolId('run_command')]: true,
			[mcpNativeToolId('workspace_index', 'lookup_symbol')]: true,
			[mcpNativeToolId('slack', 'send_message')]: false, // parent disabled this one
		}, mcpTools);

		assert.strictEqual(selected[builtinNativeToolId('read_file')], true);
		assert.strictEqual(selected[builtinNativeToolId('edit_file')], true, 'work children can edit');
		assert.strictEqual(selected[builtinNativeToolId('run_command')], true, 'work children can use the terminal');
		assert.strictEqual(selected['runTests'], true, 'work children can run tests');
		assert.strictEqual(selected[mcpNativeToolId('workspace_index', 'lookup_symbol')], true, 'parent-enabled MCP stays available');
		assert.strictEqual(selected[mcpNativeToolId('slack', 'send_message')], false, 'parent-disabled MCP stays disabled');
		assert.strictEqual(selected[builtinNativeToolId('ask_user')], false, 'no user-question UI in a background child');
		assert.strictEqual(selected[builtinNativeToolId('open_project')], false, 'children never swap the live workspace');
		assert.strictEqual(selected[builtinNativeToolId('reload_window')], false);
		assert.strictEqual(selected[builtinNativeToolId('launch_subagent')], false, 'native children delegate via run_subagent only');
	});

	test('work subagent selection never exceeds the parent-enabled surface', () => {
		const selected = subagentNativeToolSelection('work', {
			[builtinNativeToolId('edit_file')]: false, // parent disabled edits
		}, []);
		assert.strictEqual(selected[builtinNativeToolId('edit_file')], false, 'a tool the parent disabled stays disabled for the child');
	});

	test('both engines resolve the same capability profile (native selection == shared policy)', () => {
		const mcpTools: InternalToolInfo[] = [
			{ name: 'lookup_symbol', description: 'Looks up a symbol.', params: {}, mcpServerName: 'workspace_index' },
		];
		const allEnabled: Record<string, boolean> = {};
		for (const modelName of Object.keys(builtinTools)) {
			const nativeId = resolveNativeToolId(modelName, mcpTools);
			if (nativeId) { allEnabled[nativeId] = true; }
		}
		allEnabled[mcpNativeToolId('workspace_index', 'lookup_symbol')] = true;

		for (const profile of ['work', 'research'] as SubagentProfile[]) {
			const selection = subagentNativeToolSelection(profile, allEnabled, mcpTools);
			for (const modelName of Object.keys(builtinTools)) {
				// launch_subagent needs a sidebar thread context the native path lacks, and
				// run_subagent's enablement belongs to the native runner's depth machinery —
				// both are engine-mechanics, not capability-policy, so skip them here.
				if (modelName === 'launch_subagent' || modelName === 'run_subagent') { continue; }
				const nativeId = resolveNativeToolId(modelName, mcpTools);
				if (!nativeId) { continue; }
				assert.strictEqual(
					selection[nativeId],
					isSubagentToolAllowed(profile, modelName, true, { canDelegate: profile === 'work' }),
					`${profile}/${modelName}: native selection must equal the shared policy`,
				);
			}
			assert.strictEqual(
				selection[mcpNativeToolId('workspace_index', 'lookup_symbol')],
				isSubagentToolAllowed(profile, 'lookup_symbol', false),
				`${profile}/mcp: native selection must equal the shared policy`,
			);
		}
	});
});
