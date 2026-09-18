/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { providerInputSchemaOfTool, toOpenAICompatibleTool } from '../../common/prompt/openAICompatibleTool.js';

suite('OpenAI-compatible tool schema', () => {
	test('uses the proven provider-safe string schema', () => {
		const tool = toOpenAICompatibleTool({
			name: 'read_file',
			description: 'Read a file.',
			params: {
				uri: { description: 'Absolute path.' },
				page_number: { description: 'Optional page.' },
			},
		});

		assert.deepStrictEqual(tool.function.parameters, {
			type: 'object',
			properties: {
				uri: { description: 'Absolute path.', type: 'string' },
				page_number: { description: 'Optional page.', type: 'string' },
			},
		});
	});

	test('does not leak canonical unions into provider requests', () => {
		const schema = providerInputSchemaOfTool({
			name: 'custom',
			description: 'A custom tool.',
			params: {
				ref: { description: 'Element reference.' },
				x: { description: 'Horizontal coordinate.' },
			},
			inputSchema: {
				type: 'object',
				properties: {
					ref: { type: 'string' },
					x: { type: 'number' },
				},
				anyOf: [{ required: ['ref'] }, { required: ['x'] }],
			},
		});

		assert.deepStrictEqual(schema, {
			type: 'object',
			properties: {
				ref: { description: 'Element reference.', type: 'string' },
				x: { description: 'Horizontal coordinate.', type: 'string' },
			},
		});
	});
});
