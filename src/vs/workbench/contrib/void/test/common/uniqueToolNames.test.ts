/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { availableTools, uniqueToolsByName } from '../../common/prompt/prompts.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('unique tool names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('drops later duplicates so Anthropic and OpenAI never see colliding names', () => {
		const tools = uniqueToolsByName([
			{ name: 'read_file' },
			{ name: 'web_search' },
			{ name: 'read_file' },
			{ name: 'web_search' },
		]);
		assert.deepStrictEqual(tools?.map(t => t.name), ['read_file', 'web_search']);
	});

	test('agent and plan payloads have unique names even if MCP repeats a builtin', () => {
		const mcp = [
			{ name: 'srv_read_file', description: 'dup', mcpServerName: 'srv' },
			{ name: 'read_file', description: 'exact collision', mcpServerName: 'srv' },
		] as never;
		for (const mode of ['agent', 'plan'] as const) {
			const names = (availableTools(mode, mcp) ?? []).map(t => t.name);
			assert.strictEqual(new Set(names).size, names.length, mode);
		}
	});
});
