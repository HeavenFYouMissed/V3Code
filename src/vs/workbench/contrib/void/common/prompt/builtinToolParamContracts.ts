/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Derived from BuiltinToolCallParams and reviewed against the live validators.
// Descriptions stay in builtinTools; this registry owns wire types, requiredness, and bounds.
// toolsRegistryDrift.test.ts enforces exact parameter parity so changes cannot silently fall back.

import type { BuiltinToolCallParams } from '../toolsServiceTypes.js';
import type { SnakeCaseKeys, ToolObjectContract, ToolParamContract } from './toolContract.js';

type BuiltinToolParamContractRegistry = {
	[T in keyof BuiltinToolCallParams]: Partial<Record<keyof SnakeCaseKeys<BuiltinToolCallParams[T]>, ToolParamContract>>
};

export const builtinToolParamContracts = {
	read_file: {
		uri: {
			type: 'string',
			required: true
		},
		start_line: {
			type: 'integer',
			required: false
		},
		end_line: {
			type: 'integer',
			required: false
		},
		page_number: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		}
	},
	ls_dir: {
		uri: {
			type: 'string',
			required: false
		},
		page_number: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		}
	},
	get_dir_tree: {
		uri: {
			type: 'string',
			required: true
		}
	},
	search_pathnames_only: {
		query: {
			type: 'string',
			required: true
		},
		include_pattern: {
			type: 'string',
			required: false
		},
		page_number: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		}
	},
	search_for_files: {
		query: {
			type: 'string',
			required: true
		},
		is_regex: {
			type: 'boolean',
			required: false
		},
		search_in_folder: {
			type: 'string',
			required: false
		},
		page_number: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		}
	},
	search_in_file: {
		uri: {
			type: 'string',
			required: true
		},
		query: {
			type: 'string',
			required: true
		},
		is_regex: {
			type: 'boolean',
			required: false
		}
	},
	read_lint_errors: {
		uri: {
			type: 'string',
			required: true
		}
	},
	read_skill: {
		name: {
			type: 'string',
			required: true
		}
	},
	security_scan: {
		pack_ids: {
			type: 'array',
			required: false
		},
		max_files: {
			type: 'number',
			required: false
		}
	},
	open_project: {
		path: {
			type: 'string',
			required: false
		},
		mode: {
			type: 'string',
			required: false,
			default: 'replace',
			enum: ['replace', 'add']
		}
	},
	close_project: {
		path: {
			type: 'string',
			required: true
		}
	},
	reload_window: {},
	rewrite_file: {
		uri: {
			type: 'string',
			required: true
		},
		new_content: {
			type: 'string',
			required: true
		}
	},
	append_file: {
		uri: {
			type: 'string',
			required: true
		},
		content: {
			type: 'string',
			required: true
		}
	},
	edit_file: {
		uri: {
			type: 'string',
			required: true
		},
		search_replace_blocks: {
			type: 'string',
			required: true
		}
	},
	create_file_or_folder: {
		uri: {
			type: 'string',
			required: true
		}
	},
	delete_file_or_folder: {
		uri: {
			type: 'string',
			required: true
		},
		is_recursive: {
			type: 'boolean',
			required: false
		}
	},
	run_command: {
		command: {
			type: 'string',
			required: true
		},
		cwd: {
			type: 'string',
			required: false
		},
		timeout_seconds: {
			type: 'integer',
			required: false,
			maximum: 600,
			minimum: 1
		}
	},
	open_persistent_terminal: {
		cwd: {
			type: 'string',
			required: false
		}
	},
	run_persistent_command: {
		command: {
			type: 'string',
			required: true
		},
		persistent_terminal_id: {
			type: 'string',
			required: true
		}
	},
	kill_persistent_terminal: {
		persistent_terminal_id: {
			type: 'string',
			required: true
		}
	},
	read_terminal_output: {
		persistent_terminal_id: {
			type: 'string',
			required: true
		}
	},
	ask_user: {
		question: {
			type: 'string',
			required: true
		},
		options: {
			type: 'array',
			items: {
				type: 'string',
				maxLength: 120
			},
			required: true,
			minItems: 2,
			maxItems: 6
		}
	},
	run_sandbox: {
		code: {
			type: 'string',
			required: true
		},
		timeout_ms: {
			type: 'integer',
			required: false,
			default: 3000,
			maximum: 10000,
			minimum: 1
		}
	},
	remember: {
		file_path: {
			type: 'string',
			required: true
		},
		symbol_name: {
			type: 'string',
			required: true
		},
		note: {
			type: 'string',
			required: true
		}
	},
	remember_editorial: {
		topic: {
			type: 'string',
			required: true
		},
		worked: {
			type: 'string',
			required: false
		},
		didnt_work: {
			type: 'string',
			required: false
		},
		build_notes: {
			type: 'string',
			required: false
		},
		mini_readme: {
			type: 'string',
			required: false
		},
		mode: {
			type: 'string',
			enum: [
				'append',
				'replace'
			],
			required: false
		}
	},
	forget_editorial: {
		topic: {
			type: 'string',
			required: true
		},
		section: {
			type: 'string',
			enum: [
				'worked',
				'didnt_work',
				'build_notes',
				'mini_readme'
			],
			required: false
		}
	},
	forget: {
		note_id: {
			type: 'string',
			required: true
		}
	},
	recover_session_anchors: {
		origin_root: {
			type: 'string',
			required: false
		},
		confirmed: {
			type: 'boolean',
			required: false,
			default: false
		}
	},
	team_checkin: {
		agent_id: {
			type: 'string',
			required: false
		},
		doing: {
			type: 'string',
			required: true
		},
		where: {
			type: 'string',
			required: false
		},
		status: {
			type: 'string',
			required: false
		}
	},
	team_board: {},
	team_contract: {
		action: {
			type: 'string',
			required: true
		},
		key: {
			type: 'string',
			required: true
		},
		value: {
			type: 'string',
			required: false
		},
		rationale: {
			type: 'string',
			required: false
		}
	},
	list_notes: {
		file_path: {
			type: 'string',
			required: false
		}
	},
	search_notes: {
		query: {
			type: 'string',
			required: true
		},
		file_path: {
			type: 'string',
			required: false
		},
		limit: {
			type: 'integer',
			required: false,
			default: 20,
			maximum: 50
		}
	},
	workspace_delta: {
		since_ms: {
			type: 'integer',
			required: false
		}
	},
	search_chat_memory: {
		query: {
			type: 'string',
			required: true
		},
		kind: {
			type: 'string',
			enum: [
				'prompt',
				'reply',
				'tool_call',
				'tool_result',
				'diff',
				'decision',
				'phase',
				'escalation',
				'note'
			],
			required: false
		},
		role: {
			type: 'string',
			enum: [
				'lead',
				'sprinter',
				'scout',
				'debugger',
				'user'
			],
			required: false
		},
		limit: {
			type: 'integer',
			required: false,
			default: 20,
			maximum: 50
		}
	},
	search_memory: {
		query: {
			type: 'string',
			required: true
		},
		scope: {
			type: 'string',
			enum: [
				'workspace',
				'session',
				'global'
			],
			required: false
		},
		depth: {
			type: 'string',
			enum: [
				'recent',
				'broad',
				'deep'
			],
			required: false
		},
		session_id: {
			type: 'string',
			required: false
		},
		before: {
			type: 'integer',
			required: false
		},
		after: {
			type: 'integer',
			required: false
		},
		kinds: {
			type: 'array',
			items: {
				type: 'string',
				enum: [
					'fact',
					'checkpoint',
					'archive-page',
					'symbol-note'
				]
			},
			required: false
		},
		limit: {
			type: 'integer',
			required: false,
			default: 12,
			maximum: 50
		}
	},
	get_memory_checkpoint: {
		checkpoint_id: {
			type: 'string',
			required: true
		},
		include_events: {
			type: 'boolean',
			required: false
		},
		event_page: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		}
	},
	get_chat_session: {
		session_id: {
			type: 'string',
			required: true
		}
	},
	get_chat_thread: {
		event_id: {
			type: 'string',
			required: true
		}
	},
	deep_recall: {
		query: {
			type: 'string',
			required: true
		},
		limit: {
			type: 'integer',
			required: false,
			default: 8
		}
	},
	get_shadow_record: {
		shadow_id: {
			type: 'string',
			required: true
		}
	},
	get_build_errors: {
		path_filter: {
			type: 'string',
			required: false
		},
		errors_only: {
			type: 'boolean',
			required: false
		}
	},
	session_diff: {
		path_filter: {
			type: 'string',
			required: false
		}
	},
	index_health: {
		rebuild: {
			type: 'boolean',
			required: false
		}
	},
	recent_edits: {
		n: {
			type: 'integer',
			required: false,
			default: 20,
			maximum: 50
		},
		file: {
			type: 'string',
			required: false
		}
	},
	get_editorial_briefing: {},
	search_editorial: {
		query: {
			type: 'string',
			required: true
		},
		cross_project: {
			type: 'boolean',
			required: false
		}
	},
	find_text: {
		query: {
			type: 'string',
			required: true
		},
		is_regex: {
			type: 'boolean',
			required: false
		},
		include_pattern: {
			type: 'string',
			required: false
		},
		page_number: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		},
		context_lines: {
			type: 'integer',
			required: false,
			default: 0,
			maximum: 10
		}
	},
	semantic_search: {
		query: {
			type: 'string',
			required: true
		},
		top_k: {
			type: 'integer',
			required: false,
			default: 15,
			maximum: 50,
			minimum: 1
		},
		include_file: {
			type: 'string',
			required: false
		},
		include_files: {
			type: 'array',
			items: {
				type: 'string'
			},
			required: false
		},
		rerank: {
			type: 'boolean',
			required: false
		}
	},
	symbol_lookup: {
		name: {
			type: 'string',
			required: true
		},
		defs_only: {
			type: 'boolean',
			required: false
		}
	},
	impact_trace: {
		target: {
			type: 'string',
			required: true
		},
		depth: {
			type: 'integer',
			required: false,
			default: 2,
			minimum: 1,
			maximum: 8
		}
	},
	get_file_context: {
		file_path: {
			type: 'string',
			required: true
		}
	},
	get_file_dependencies: {
		file_path: {
			type: 'string',
			required: true
		}
	},
	get_symbol_context: {
		file_path: {
			type: 'string',
			required: true
		},
		symbol_name: {
			type: 'string',
			required: true
		}
	},
	get_call_graph: {
		file_path: {
			type: 'string',
			required: true
		},
		symbol_name: {
			type: 'string',
			required: true
		},
		direction: {
			type: 'string',
			enum: [
				'incoming',
				'outgoing'
			],
			required: false
		},
		depth: {
			type: 'integer',
			required: false,
			default: 2,
			maximum: 4,
			minimum: 1
		}
	},
	pack_context: {
		file_path: {
			type: 'string',
			required: true
		},
		symbol_name: {
			type: 'string',
			required: true
		},
		task: {
			type: 'string',
			enum: [
				'understand',
				'refactor',
				'debug',
				'extend'
			],
			required: false
		},
		max_tokens: {
			type: 'integer',
			required: false,
			default: 3000
		}
	},
	get_project_briefing: {
		include_notes: {
			type: 'boolean',
			required: false
		}
	},
	web_search: {
		query: {
			type: 'string',
			required: true
		},
		max_results: {
			type: 'integer',
			required: false,
			default: 5
		}
	},
	web_fetch: {
		url: {
			type: 'string',
			required: true
		},
		page_number: {
			type: 'integer',
			required: false,
			default: 1,
			minimum: 1
		}
	},
	git_status: {},
	repo_hygiene: {
		action: {
			type: 'string',
			required: true
		},
		path: {
			type: 'string',
			required: false
		}
	},
	git_stage: {
		paths: {
			type: 'array',
			items: {
				type: 'string'
			},
			required: true,
			minItems: 1
		}
	},
	git_commit: {
		message: {
			type: 'string',
			required: true
		},
		paths: {
			type: 'array',
			items: {
				type: 'string'
			},
			required: false,
			minItems: 1
		}
	},
	git_diff: {
		base: {
			type: 'string',
			required: false
		},
		head: {
			type: 'string',
			required: false
		},
		path: {
			type: 'string',
			required: false
		},
		staged: {
			type: 'boolean',
			required: false
		}
	},
	git_log: {
		count: {
			type: 'integer',
			required: false,
			default: 10,
			maximum: 50
		}
	},
	git_branch: {},
	git_push: {
		remote: {
			type: 'string',
			required: false
		},
		branch: {
			type: 'string',
			required: false
		},
		set_upstream: {
			type: 'boolean',
			required: false
		}
	},
	git_pull: {
		remote: {
			type: 'string',
			required: false
		},
		branch: {
			type: 'string',
			required: false
		}
	},
	git_fetch: {
		remote: {
			type: 'string',
			required: false
		}
	},
	git_checkout: {
		branch: {
			type: 'string',
			required: true
		},
		create: {
			type: 'boolean',
			required: false
		}
	},
	git_stash: {
		action: {
			type: 'string',
			enum: [
				'push',
				'pop',
				'list'
			],
			required: true
		},
		message: {
			type: 'string',
			required: false
		},
		paths: {
			type: 'array',
			items: {
				type: 'string'
			},
			required: false,
			minItems: 1
		}
	},
	git_remote: {},
	git_show: {
		ref: {
			type: 'string',
			required: false
		},
		path: {
			type: 'string',
			required: false
		},
		stat_only: {
			type: 'boolean',
			required: false
		}
	},
	git_blame: {
		path: {
			type: 'string',
			required: true
		},
		start_line: {
			type: 'integer',
			required: false
		},
		end_line: {
			type: 'integer',
			required: false
		}
	},
	git_merge: {
		branch: {
			type: 'string',
			required: false
		},
		abort: {
			type: 'boolean',
			required: false
		}
	},
	git_rebase: {
		action: {
			type: 'string',
			enum: [
				'start',
				'abort',
				'continue',
				'skip'
			],
			required: true
		},
		branch: {
			type: 'string',
			required: false
		}
	},
	git_cherry_pick: {
		commit: {
			type: 'string',
			required: false
		},
		abort: {
			type: 'boolean',
			required: false
		}
	},
	git_restore: {
		paths: {
			type: 'array',
			items: {
				type: 'string'
			},
			required: true,
			minItems: 1
		},
		staged: {
			type: 'boolean',
			required: false
		}
	},
	git_reset: {
		mode: {
			type: 'string',
			enum: [
				'soft',
				'mixed'
			],
			required: false
		},
		ref: {
			type: 'string',
			required: false
		}
	},
	open_browser: {
		url: {
			type: 'string',
			required: true
		},
		mobile: {
			type: 'boolean',
			required: false
		}
	},
	open_browser_page: {
		url: {
			type: 'string',
			required: true
		},
		force_new: {
			type: 'string',
			required: false
		}
	},
	read_page: {
		page_id: {
			type: 'string',
			required: true
		}
	},
	click_element: {
		page_id: {
			type: 'string',
			required: true
		},
		element: {
			type: 'string',
			required: true
		},
		ref: {
			type: 'string',
			required: false
		},
		selector: {
			type: 'string',
			required: false
		},
		dbl_click: {
			type: 'string',
			required: false
		},
		button: {
			type: 'string',
			required: false
		}
	},
	type_in_page: {
		page_id: {
			type: 'string',
			required: true
		},
		text: {
			type: 'string',
			required: false
		},
		key: {
			type: 'string',
			required: false
		},
		ref: {
			type: 'string',
			required: false
		},
		element: {
			type: 'string',
			required: false
		}
	},
	screenshot_page: {
		page_id: {
			type: 'string',
			required: true
		},
		ref: {
			type: 'string',
			required: false
		},
		element: {
			type: 'string',
			required: false
		}
	},
	navigate_page: {
		page_id: {
			type: 'string',
			required: true
		},
		type: {
			type: 'string',
			required: false,
			enum: [
				'url',
				'back',
				'forward',
				'reload'
			],
			default: 'url'
		},
		url: {
			type: 'string',
			required: false
		}
	},
	hover_element: {
		page_id: {
			type: 'string',
			required: true
		},
		element: {
			type: 'string',
			required: true
		},
		ref: {
			type: 'string',
			required: false
		},
		selector: {
			type: 'string',
			required: false
		},
		settle_ms: {
			type: 'number',
			required: false,
			default: 400
		},
		wait_for_selector: {
			type: 'string',
			required: false
		}
	},
	drag_element: {
		page_id: {
			type: 'string',
			required: true
		},
		from_element: {
			type: 'string',
			required: true
		},
		to_element: {
			type: 'string',
			required: true
		},
		from_ref: {
			type: 'string',
			required: false
		},
		from_selector: {
			type: 'string',
			required: false
		},
		to_ref: {
			type: 'string',
			required: false
		},
		to_selector: {
			type: 'string',
			required: false
		}
	},
	handle_dialog: {
		page_id: {
			type: 'string',
			required: true
		},
		accept_modal: {
			type: 'string',
			required: false
		},
		prompt_text: {
			type: 'string',
			required: false
		},
		select_files: {
			type: 'string',
			required: false
		}
	},
	run_playwright_code: {
		page_id: {
			type: 'string',
			required: true
		},
		code: {
			type: 'string',
			required: false
		},
		deferred_result_id: {
			type: 'string',
			required: false
		},
		timeout_ms: {
			type: 'number',
			required: false,
			default: 5000
		}
	},
	extract_page_data: {
		page_id: {
			type: 'string',
			required: true
		},
		focus: {
			type: 'string',
			required: false,
			enum: [
				'full',
				'assets',
				'structure',
				'styles',
				'network'
			],
			default: 'full'
		}
	},
	get_browser_console_logs: {
		page_id: {
			type: 'string',
			required: true
		},
		max_lines: {
			type: 'number',
			required: false,
			default: 200,
			minimum: 1,
			maximum: 500
		}
	},
	reconstruct_page_sources: {
		script_url: {
			type: 'string',
			required: true
		},
		output_dir: {
			type: 'string',
			required: false
		},
		method: {
			type: 'string',
			required: false,
			enum: [
				'auto',
				'sourcemap',
				'webcrack'
			],
			default: 'auto'
		}
	},
	get_computed_styles: {
		page_id: {
			type: 'string',
			required: true
		},
		ref: {
			type: 'string',
			required: false
		},
		selector: {
			type: 'string',
			required: false
		},
		element: {
			type: 'string',
			required: false
		}
	},
	watch_page: {
		page_id: {
			type: 'string',
			required: true
		},
		ref: {
			type: 'string',
			required: false
		},
		selector: {
			type: 'string',
			required: false
		},
		text_contains: {
			type: 'string',
			required: false
		},
		timeout_ms: {
			type: 'number',
			required: false,
			default: 60000,
			minimum: 1000,
			maximum: 300000
		},
		interval_ms: {
			type: 'number',
			required: false,
			default: 1000,
			minimum: 200,
			maximum: 10000
		}
	},
	save_browser_session: {
		page_id: {
			type: 'string',
			required: true
		},
		session_name: {
			type: 'string',
			required: false
		}
	},
	restore_browser_session: {
		page_id: {
			type: 'string',
			required: true
		},
		session_name: {
			type: 'string',
			required: false
		},
		reload: {
			type: 'string',
			required: false
		}
	},
	fill_form: {
		page_id: {
			type: 'string',
			required: true
		},
		fields: {
			type: 'string',
			required: true
		}
	},
	intercept_network: {
		page_id: {
			type: 'string',
			required: true
		},
		url_pattern: {
			type: 'string',
			required: true
		},
		include_bodies: {
			type: 'string',
			required: false
		}
	},
	get_browser_network_log: {
		page_id: {
			type: 'string',
			required: true
		},
		clear: {
			type: 'string',
			required: false
		}
	},
	computer_read_screen: {
		pid: {
			type: 'integer',
			required: false
		},
		max_depth: {
			type: 'integer',
			required: false
		},
		include_all: {
			type: 'boolean',
			required: false
		}
	},
	computer_read_screen_changes: {
		pid: {
			type: 'integer',
			required: false
		},
		max_depth: {
			type: 'integer',
			required: false
		},
		include_all: {
			type: 'boolean',
			required: false
		}
	},
	computer_screenshot: {
		display_id: {
			type: 'integer',
			required: false
		},
		max_long_edge: {
			type: 'integer',
			required: false
		},
		include_elements: {
			type: 'boolean',
			required: false
		}
	},
	computer_click: {
		ref: {
			type: 'string',
			required: false
		},
		x: {
			type: 'integer',
			required: false
		},
		y: {
			type: 'integer',
			required: false
		},
		element: {
			type: 'string',
			required: true
		},
		button: {
			type: 'string',
			required: false,
			enum: [
				'left',
				'right',
				'middle'
			],
			default: 'left'
		},
		modifiers: {
			type: 'array',
			items: {
				type: 'string',
				enum: [
					'shift',
					'control',
					'alt',
					'meta'
				]
			},
			required: false
		},
		click_count: {
			type: 'integer',
			required: false,
			default: 1
		}
	},
	computer_type: {
		text: {
			type: 'string',
			required: true
		}
	},
	computer_key: {
		chord: {
			type: 'string',
			required: true
		},
		repeat: {
			type: 'integer',
			required: false,
			default: 1
		}
	},
	computer_scroll: {
		direction: {
			type: 'string',
			required: true,
			enum: [
				'up',
				'down',
				'left',
				'right'
			]
		},
		amount: {
			type: 'integer',
			required: true
		},
		ref: {
			type: 'string',
			required: false
		},
		x: {
			type: 'integer',
			required: false
		},
		y: {
			type: 'integer',
			required: false
		},
		element: {
			type: 'string',
			required: true
		}
	},
	computer_cursor: {},
	computer_wait_for_stable: {
		pid: {
			type: 'integer',
			required: false
		},
		timeout_ms: {
			type: 'integer',
			required: false
		}
	},
	computer_list_apps: {},
	computer_drag: {
		from_ref: {
			type: 'string',
			required: false
		},
		from_x: {
			type: 'integer',
			required: false
		},
		from_y: {
			type: 'integer',
			required: false
		},
		to_ref: {
			type: 'string',
			required: false
		},
		to_x: {
			type: 'integer',
			required: false
		},
		to_y: {
			type: 'integer',
			required: false
		},
		button: {
			type: 'string',
			required: false,
			enum: [
				'left',
				'right',
				'middle'
			],
			default: 'left'
		},
		modifiers: {
			type: 'array',
			items: {
				type: 'string',
				enum: [
					'shift',
					'control',
					'alt',
					'meta'
				]
			},
			required: false
		},
		duration_ms: {
			type: 'integer',
			required: false
		},
		element: {
			type: 'string',
			required: true
		}
	},
	computer_hover: {
		ref: {
			type: 'string',
			required: false
		},
		x: {
			type: 'integer',
			required: false
		},
		y: {
			type: 'integer',
			required: false
		},
		settle_ms: {
			type: 'integer',
			required: false
		},
		element: {
			type: 'string',
			required: true
		}
	},
	computer_clipboard_read: {},
	computer_clipboard_write: {
		text: {
			type: 'string',
			required: true
		}
	},
	computer_open_app: {
		app: {
			type: 'string',
			required: true
		},
		wait_ms: {
			type: 'integer',
			required: false
		}
	},
	generate_image: {
		prompt: {
			type: 'string',
			required: true
		},
		output_path: {
			type: 'string',
			required: false
		},
		model: {
			type: 'string',
			required: false
		}
	},
	launch_subagent: {
		description: {
			type: 'string',
			required: true
		},
		prompt: {
			type: 'string',
			required: true
		},
		profile: {
			type: 'string',
			required: false
		}
	},
	message_subagent: {
		subagent_thread_id: {
			type: 'string',
			required: true
		},
		message: {
			type: 'string',
			required: true
		}
	},
	report_progress: {
		milestone: {
			type: 'string',
			required: true
		}
	},
	run_subagent: {
		prompt: {
			type: 'string',
			required: true
		},
		description: {
			type: 'string',
			required: true
		},
		agent_name: {
			type: 'string',
			required: false
		},
		model: {
			type: 'string',
			required: false
		},
		profile: {
			type: 'string',
			required: false
		}
	},
	rename_symbol: {
		symbol: {
			type: 'string',
			required: true
		},
		new_name: {
			type: 'string',
			required: true
		},
		file_path: {
			type: 'string',
			required: false
		},
		uri: {
			type: 'string',
			required: false
		},
		line_content: {
			type: 'string',
			required: true
		}
	},
	list_code_usages: {
		symbol: {
			type: 'string',
			required: true
		},
		file_path: {
			type: 'string',
			required: false
		},
		uri: {
			type: 'string',
			required: false
		},
		line_content: {
			type: 'string',
			required: true
		}
	},
	run_tests: {
		files: {
			type: 'string',
			required: false
		},
		test_names: {
			type: 'string',
			required: false
		},
		mode: {
			type: 'string',
			required: false
		},
		coverage_files: {
			type: 'string',
			required: false
		}
	},
	update_plan: {
		todos: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: {
						type: 'string'
					},
					content: {
						type: 'string'
					},
					status: {
						type: 'string',
						enum: [
							'pending',
							'in_progress',
							'completed',
							'cancelled'
						]
					}
				},
				required: [
					'id',
					'content',
					'status'
				],
				additionalProperties: false
			},
			required: true
		},
		merge: {
			type: 'boolean',
			required: false
		}
	}
} satisfies BuiltinToolParamContractRegistry;

export const builtinToolObjectContracts = {
	hover_element: {
		anyOf: [
			{
				required: [
					'ref'
				]
			},
			{
				required: [
					'selector'
				]
			}
		]
	},
	type_in_page: {
		anyOf: [
			{
				required: [
					'text'
				]
			},
			{
				required: [
					'key'
				]
			}
		]
	},
	handle_dialog: {
		anyOf: [
			{
				required: [
					'accept_modal'
				]
			},
			{
				required: [
					'select_files'
				]
			}
		]
	},
	run_playwright_code: {
		anyOf: [
			{
				required: [
					'code'
				]
			},
			{
				required: [
					'deferred_result_id'
				]
			}
		]
	},
	get_computed_styles: {
		anyOf: [
			{
				required: [
					'ref'
				]
			},
			{
				required: [
					'selector'
				]
			}
		]
	},
	watch_page: {
		anyOf: [
			{
				required: [
					'ref'
				]
			},
			{
				required: [
					'selector'
				]
			},
			{
				required: [
					'text_contains'
				]
			}
		]
	},
	computer_click: {
		anyOf: [
			{
				required: [
					'ref'
				]
			},
			{
				required: [
					'x',
					'y'
				]
			}
		]
	},
	computer_scroll: {
		anyOf: [
			{
				required: [
					'ref'
				]
			},
			{
				required: [
					'x',
					'y'
				]
			}
		]
	},
	computer_drag: {
		anyOf: [
			{
				required: [
					'from_ref',
					'to_ref'
				]
			},
			{
				required: [
					'from_ref',
					'to_x',
					'to_y'
				]
			},
			{
				required: [
					'from_x',
					'from_y',
					'to_ref'
				]
			},
			{
				required: [
					'from_x',
					'from_y',
					'to_x',
					'to_y'
				]
			}
		]
	},
	computer_hover: {
		anyOf: [
			{
				required: [
					'ref'
				]
			},
			{
				required: [
					'x',
					'y'
				]
			}
		]
	}
} satisfies Partial<Record<keyof BuiltinToolCallParams, ToolObjectContract>>;
