/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinTools, inputSchemaOfTool } from '../../common/prompt/prompts.js';
import { builtinToolParamContracts } from '../../common/prompt/builtinToolParamContracts.js';
import { approvalTypeOfBuiltinToolName } from '../../common/toolsServiceTypes.js';

/**
 * Drift guards for the LLM tool registry.
 *
 * The TypeScript mapped types `ValidateBuiltinParams`, `CallBuiltinTool`,
 * `BuiltinToolResultToString` (toolsService.ts) plus the `satisfies` clause on
 * `builtinTools` (prompts.ts) already enforce that every key in
 * `BuiltinToolResultType` has matching entries in all four registries — `tsc`
 * fails the build if those drift apart.
 *
 * What `tsc` does NOT catch — and this test does:
 *  1. An entry in `approvalTypeOfBuiltinToolName` whose key no longer exists in
 *     `builtinTools` (rename / delete leftover). Silently dead approval policy.
 *  2. A `builtinTools` entry registered with empty description or empty param
 *     descriptions. The auto-generated XML tool descriptor is the LLM's only
 *     introduction to most tools — a blank description makes the tool unusable
 *     even though it's wired.
 */
suite('toolsRegistry / drift guards', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const registeredToolNames = Object.keys(builtinTools);

	test('approvalTypeOfBuiltinToolName only references registered tools', () => {
		const registered = new Set(registeredToolNames);
		const orphans: string[] = [];
		for (const name of Object.keys(approvalTypeOfBuiltinToolName)) {
			if (!registered.has(name)) {
				orphans.push(name);
			}
		}
		assert.deepStrictEqual(orphans, [], `approvalTypeOfBuiltinToolName lists tools that no longer exist in builtinTools (likely a rename/delete leftover): ${orphans.join(', ')}`);
	});

	test('every registered tool has a non-empty description', () => {
		const empty: string[] = [];
		for (const name of registeredToolNames) {
			const info = (builtinTools as Record<string, { description?: string }>)[name];
			if (!info || typeof info.description !== 'string' || info.description.trim().length === 0) {
				empty.push(name);
			}
		}
		assert.deepStrictEqual(empty, [], `Tools registered without a description — the LLM has nothing to read: ${empty.join(', ')}`);
	});

	test('every registered tool param has a non-empty description', () => {
		const offenders: string[] = [];
		for (const name of registeredToolNames) {
			const info = (builtinTools as Record<string, { params?: Record<string, { description?: string }> }>)[name];
			const params = info?.params;
			if (!params) continue;
			for (const paramName of Object.keys(params)) {
				const desc = params[paramName]?.description;
				if (typeof desc !== 'string' || desc.trim().length === 0) {
					offenders.push(`${name}.${paramName}`);
				}
			}
		}
		assert.deepStrictEqual(offenders, [], `Tool params registered without a description — the LLM won't know what to pass: ${offenders.join(', ')}`);
	});

	test('every registered tool param has exactly one typed wire contract', () => {
		const missing: string[] = [];
		const orphaned: string[] = [];
		for (const name of registeredToolNames) {
			const info = builtinTools[name as keyof typeof builtinTools];
			const params = new Set(Object.keys(info.params));
			const contracts = (builtinToolParamContracts as Record<string, Record<string, unknown>>)[name] ?? {};
			for (const paramName of params) {
				if (!contracts[paramName]) { missing.push(`${name}.${paramName}`); }
			}
			for (const contractName of Object.keys(contracts)) {
				if (!params.has(contractName)) { orphaned.push(`${name}.${contractName}`); }
			}
		}
		assert.deepStrictEqual(missing, [], `Params fell back to the legacy string schema: ${missing.join(', ')}`);
		assert.deepStrictEqual(orphaned, [], `Typed contracts no longer exposed by builtinTools: ${orphaned.join(', ')}`);
	});

	test('canonical schemas retain required fields, enums, arrays, and bounds', () => {
		const gitDiff = inputSchemaOfTool(builtinTools.git_diff);
		assert.strictEqual(gitDiff.required, undefined);
		for (const name of ['base', 'head', 'path']) {
			assert.strictEqual(gitDiff.properties[name].type, 'string');
		}
		assert.strictEqual(gitDiff.properties.staged.type, 'boolean');

		const runCommand = inputSchemaOfTool(builtinTools.run_command);
		assert.deepStrictEqual(runCommand.required, ['command']);
		assert.strictEqual(runCommand.properties.cwd.type, 'string');
		assert.strictEqual(runCommand.properties.timeout_seconds.type, 'integer');
		assert.strictEqual(runCommand.properties.timeout_seconds.minimum, 1);
		assert.strictEqual(runCommand.properties.timeout_seconds.maximum, 600);

		const semanticSearch = inputSchemaOfTool(builtinTools.semantic_search);
		assert.deepStrictEqual(semanticSearch.required, ['query']);
		assert.strictEqual(semanticSearch.properties.top_k.type, 'integer');
		assert.strictEqual(semanticSearch.properties.top_k.maximum, 50);
		assert.deepStrictEqual(semanticSearch.properties.include_files.items, { type: 'string' });
		assert.strictEqual(semanticSearch.properties.rerank.type, 'boolean');

		const packContext = inputSchemaOfTool(builtinTools.pack_context);
		assert.deepStrictEqual(packContext.properties.task.enum, ['understand', 'refactor', 'debug', 'extend']);
		assert.deepStrictEqual(packContext.required, ['file_path', 'symbol_name']);

		const askUser = inputSchemaOfTool(builtinTools.ask_user);
		assert.strictEqual(askUser.properties.options.minItems, 2);
		assert.strictEqual(askUser.properties.options.maxItems, 6);
		assert.strictEqual(askUser.properties.options.items?.maxLength, 120);

		const openProject = inputSchemaOfTool(builtinTools.open_project);
		assert.strictEqual(openProject.required, undefined);
		assert.strictEqual(openProject.properties.path.type, 'string');
		assert.deepStrictEqual(openProject.properties.mode.enum, ['replace', 'add']);
		assert.strictEqual(openProject.properties.mode.default, 'replace');

		const closeProject = inputSchemaOfTool(builtinTools.close_project);
		assert.deepStrictEqual(closeProject.required, ['path']);
		assert.strictEqual(closeProject.properties.path.type, 'string');

		const reloadWindow = inputSchemaOfTool(builtinTools.reload_window as Parameters<typeof inputSchemaOfTool>[0]);
		assert.strictEqual(reloadWindow.type, 'object');
		assert.deepStrictEqual(reloadWindow.properties, {});
		assert.strictEqual(reloadWindow.required, undefined);
		assert.strictEqual(approvalTypeOfBuiltinToolName.reload_window, 'projects');

		const typeInPage = inputSchemaOfTool(builtinTools.type_in_page);
		assert.deepStrictEqual(typeInPage.required, ['page_id']);
		assert.deepStrictEqual(typeInPage.anyOf, [{ required: ['text'] }, { required: ['key'] }]);

		const computerClick = inputSchemaOfTool(builtinTools.computer_click);
		assert.deepStrictEqual(computerClick.required, ['element']);
		assert.deepStrictEqual(computerClick.anyOf, [{ required: ['ref'] }, { required: ['x', 'y'] }]);
		assert.deepStrictEqual(computerClick.properties.button.enum, ['left', 'right', 'middle']);

		const hoverElement = inputSchemaOfTool(builtinTools.hover_element);
		assert.deepStrictEqual(hoverElement.required, ['page_id', 'element']);
		assert.deepStrictEqual(hoverElement.anyOf, [{ required: ['ref'] }, { required: ['selector'] }]);
		assert.strictEqual(hoverElement.properties.settle_ms.type, 'number');
		assert.strictEqual(hoverElement.properties.settle_ms.default, 400);
		assert.strictEqual(hoverElement.required?.includes('wait_for_selector'), false);

		const runPlaywrightCode = inputSchemaOfTool(builtinTools.run_playwright_code);
		assert.deepStrictEqual(runPlaywrightCode.required, ['page_id']);
		assert.deepStrictEqual(runPlaywrightCode.anyOf, [{ required: ['code'] }, { required: ['deferred_result_id'] }]);
		assert.strictEqual(runPlaywrightCode.properties.timeout_ms.type, 'number');
		assert.strictEqual(runPlaywrightCode.properties.timeout_ms.default, 5000);

		const plan = inputSchemaOfTool(builtinTools.update_plan);
		assert.strictEqual(plan.additionalProperties, false);
		assert.deepStrictEqual(plan.properties.todos.items?.properties?.status.enum, ['pending', 'in_progress', 'completed', 'cancelled']);
	});

	test('every canonical schema is internally type-consistent', () => {
		const problems: string[] = [];
		const valueMatches = (type: unknown, value: unknown): boolean => {
			switch (type) {
				case 'string': return typeof value === 'string';
				case 'number': return typeof value === 'number' && Number.isFinite(value);
				case 'integer': return typeof value === 'number' && Number.isInteger(value);
				case 'boolean': return typeof value === 'boolean';
				case 'array': return Array.isArray(value);
				case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
				default: return true;
			}
		};

		for (const name of registeredToolNames) {
			const info = builtinTools[name as keyof typeof builtinTools] as Parameters<typeof inputSchemaOfTool>[0];
			const schema = inputSchemaOfTool(info);
			const propertyNames = new Set(Object.keys(schema.properties));
			for (const required of schema.required ?? []) {
				if (!propertyNames.has(required)) { problems.push(`${name}.required references missing ${required}`); }
			}
			for (const [propertyName, property] of Object.entries(schema.properties)) {
				if (property.default !== undefined && !valueMatches(property.type, property.default)) {
					problems.push(`${name}.${propertyName} default does not match ${String(property.type)}`);
				}
				for (const enumValue of property.enum ?? []) {
					if (!valueMatches(property.type, enumValue)) { problems.push(`${name}.${propertyName} enum does not match ${String(property.type)}`); }
				}
				if ((property.minimum !== undefined || property.maximum !== undefined) && property.type !== 'number' && property.type !== 'integer') {
					problems.push(`${name}.${propertyName} has numeric bounds on ${String(property.type)}`);
				}
				if ((property.minLength !== undefined || property.maxLength !== undefined) && property.type !== 'string') {
					problems.push(`${name}.${propertyName} has string bounds on ${String(property.type)}`);
				}
				if ((property.minItems !== undefined || property.maxItems !== undefined) && property.type !== 'array') {
					problems.push(`${name}.${propertyName} has array bounds on ${String(property.type)}`);
				}
			}
			for (const [branchKind, branches] of [['anyOf', schema.anyOf], ['oneOf', schema.oneOf]] as const) {
				for (const branch of branches ?? []) {
					for (const required of branch.required ?? []) {
						if (!propertyNames.has(required)) { problems.push(`${name}.${branchKind} references missing ${required}`); }
					}
				}
			}
		}

		assert.deepStrictEqual(problems, []);
	});

	test('server-provided MCP schemas survive unchanged', () => {
		const inputSchema = {
			type: 'object' as const,
			properties: {
				count: { type: 'integer' as const, minimum: 1, maximum: 10 },
				mode: { type: 'string' as const, enum: ['fast', 'careful'] },
			},
			required: ['count'],
			additionalProperties: false,
		};
		const resolved = inputSchemaOfTool({
			name: 'third_party_tool',
			description: 'External tool.',
			params: { count: { description: 'Count.' }, mode: { description: 'Mode.' } },
			inputSchema,
			mcpServerName: 'example',
		});
		assert.strictEqual(resolved, inputSchema);
	});
});
