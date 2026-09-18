/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PROMPT_ASSEMBLY_PROFILES, PromptAssemblyProfile } from '../../common/prompt/promptAssemblyProfiles.js';
import { availableTools, chat_systemMessage } from '../../common/prompt/prompts.js';
import { approvalTypeOfBuiltinToolName } from '../../common/toolsServiceTypes.js';
import { ChatMode, modeHasWorkspaceContext } from '../../common/voidSettingsTypes.js';
import {
	resolveV3BuiltinModeName, V3_DEBUG_ASK_OPTIONS, V3_DEBUG_FIX_TOOL_NAMES, V3_DEBUG_MODE_NAME, V3_DEBUG_REPORT_HEADINGS,
} from '../../common/v3DebugMode.js';

const mcpTools = [{ name: 'lookup_symbol', description: 'x', params: {}, mcpServerName: 'ws' }];
const names = (mode: ChatMode) => (availableTools(mode, mcpTools) ?? []).map(t => t.name);

const staticSystemMessage = (chatMode: ChatMode, profile?: PromptAssemblyProfile) => chat_systemMessage({
	workspaceFolders: ['/home/user/project'],
	openedURIs: [],
	activeURI: undefined,
	persistentTerminalIDs: [],
	directoryStr: 'project/\n  src/\n    index.ts',
	chatMode,
	mcpTools: undefined,
	includeXMLToolDefinitions: true,
	staticOnly: true,
	...(profile ? { profile, compactToolDefs: profile.toolDefMode === 'compact' } : {}),
});

suite('debug mode tool surface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('debug = the read-only tools plus exactly the six registered fix tools', () => {
		const debug = names('debug');
		const read = new Set(names('read'));
		for (const tool of read) {
			assert.ok(debug.includes(tool), `${tool} (read-only) must stay available in Debug`);
		}
		const extra = debug.filter(tool => !read.has(tool)).sort();
		assert.deepStrictEqual(extra, [...V3_DEBUG_FIX_TOOL_NAMES].sort(), 'nothing beyond the six fix tools is granted');
	});

	test('every fix tool is a registered builtin behind an edits or terminal approval', () => {
		for (const tool of V3_DEBUG_FIX_TOOL_NAMES) {
			const approval = approvalTypeOfBuiltinToolName[tool];
			assert.ok(approval === 'edits' || approval === 'terminal', `${tool} approval: ${approval}`);
		}
	});

	test('strict scope: no delete, git write, persistent terminal, browser mutation, projects or MCP', () => {
		const debug = new Set(names('debug'));
		for (const tool of ['delete_file_or_folder', 'run_persistent_command', 'git_commit', 'rename_symbol', 'generate_image',
			'open_project', 'click_element', 'navigate_page', 'type_in_page', 'lookup_symbol']) {
			assert.ok(!debug.has(tool), `${tool} must be withheld from Debug`);
		}
		assert.ok(debug.has('ask_user') && debug.has('update_plan'), 'the doctrine needs ask_user and update_plan');
	});

	test('the advertised list is deduplicated (a repeated name is a provider 400)', () => {
		const debug = names('debug');
		assert.strictEqual(new Set(debug).size, debug.length);
	});

	test('other modes are untouched by the new mode', () => {
		const read = names('read');
		assert.ok(read.every(tool => !(tool in approvalTypeOfBuiltinToolName)), 'read stays approval-free');
		const plan = names('plan');
		assert.deepStrictEqual(plan.filter(tool => !read.includes(tool)).sort(), ['append_file', 'create_file_or_folder', 'rewrite_file']);
		const multitask = names('multitask');
		assert.ok(!multitask.includes('edit_file') && !multitask.includes('run_command') && !multitask.includes('run_tests'));
		const agent = names('agent');
		assert.ok(agent.includes('edit_file') && agent.includes('run_command') && agent.includes('delete_file_or_folder') && agent.includes('lookup_symbol'));
		assert.deepStrictEqual(names('chat'), [], 'chat has no tools');
	});

	test('debug keeps workspace context', () => {
		assert.strictEqual(modeHasWorkspaceContext('debug'), true);
	});
});

suite('debug mode identity (saved-chat restore)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stable name is the lowercase id the picker persists', () => {
		assert.strictEqual(V3_DEBUG_MODE_NAME, 'debug');
	});

	test('persisted request mode names resolve back to the internal mode', () => {
		assert.strictEqual(resolveV3BuiltinModeName('debug'), 'debug');
		assert.strictEqual(resolveV3BuiltinModeName('Debug'), 'debug');
		assert.strictEqual(resolveV3BuiltinModeName('multitask'), 'multitask');
		assert.strictEqual(resolveV3BuiltinModeName('Multitask'), 'multitask');
		assert.strictEqual(resolveV3BuiltinModeName('agent'), undefined, 'Agent still resolves by wire kind');
		assert.strictEqual(resolveV3BuiltinModeName(undefined), undefined);
	});
});

suite('debug doctrine prompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Debug prompt carries the loop, the report headings and both ask_user option pairs', () => {
		const prompt = staticSystemMessage('debug');
		assert.ok(prompt.includes('in **Debug** mode'));
		assert.ok(prompt.includes('Debug loop'));
		for (const heading of V3_DEBUG_REPORT_HEADINGS) {
			assert.ok(prompt.includes(heading), `missing heading ${heading}`);
		}
		for (const option of Object.values(V3_DEBUG_ASK_OPTIONS)) {
			assert.ok(prompt.includes(`"${option}"`), `missing ask_user option ${option}`);
		}
		assert.ok(prompt.includes('confirmed, refuted or unresolved'));
		assert.ok(prompt.includes('never fabricate a root cause'));
		assert.ok(prompt.includes('If ask_user is unavailable'), 'enableAskUserTool=false fallback');
		assert.ok(prompt.includes('update_plan'));
		assert.ok(!prompt.includes('Multitask loop'));
	});

	test('the doctrine is injected only for Debug', () => {
		for (const mode of ['agent', 'read', 'plan', 'multitask', 'chat'] as const) {
			const prompt = staticSystemMessage(mode);
			assert.ok(!prompt.includes('Debug loop'), `${mode} must not carry the Debug loop`);
			assert.ok(!prompt.includes('in **Debug** mode'), `${mode} must not carry the Debug mode note`);
		}
	});

	test('prompt budget: Debug adds under 1.2k tokens over Agent on every profile', () => {
		for (const profile of Object.values(PROMPT_ASSEMBLY_PROFILES)) {
			const delta = staticSystemMessage('debug', profile).length - staticSystemMessage('agent', profile).length;
			assert.ok(delta < 1_200 * 4, `${profile.id}: Debug adds ${delta} chars over Agent`);
		}
	});
});
