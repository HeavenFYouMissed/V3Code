/*---------------------------------------------------------------------------------------------
 *  Copyright (c) V3Code. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Type } from '@google/genai';
import { toGeminiSchema } from '../../electron-main/llmMessage/geminiToolSchema.js';

suite('Gemini tool schema conversion', () => {
	test('preserves supported typed object, array, enum, and bound fields', () => {
		const schema = toGeminiSchema({
			type: 'object',
			required: ['mode', 'files'],
			additionalProperties: false,
			properties: {
				mode: { type: 'integer', enum: [1, 2] },
				files: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 2 } },
			},
		});

		assert.strictEqual(schema.type, Type.OBJECT);
		assert.deepStrictEqual(schema.required, ['mode', 'files']);
		assert.strictEqual(schema.properties?.mode.type, Type.INTEGER);
		assert.deepStrictEqual(schema.properties?.mode.enum, ['1', '2']);
		assert.strictEqual(schema.properties?.files.type, Type.ARRAY);
		assert.strictEqual(schema.properties?.files.minItems, '1');
		assert.strictEqual(schema.properties?.files.maxItems, '3');
		assert.strictEqual(schema.properties?.files.items?.minLength, '2');
		assert.strictEqual('additionalProperties' in schema, false);
	});

	test('maps oneOf to the SDK-supported anyOf without weakening allOf', () => {
		const schema = toGeminiSchema({
			oneOf: [{ type: 'string' }, { type: 'number' }],
			allOf: [{ type: 'object', properties: { id: { type: 'string' } } }],
		});
		assert.deepStrictEqual(schema.anyOf?.map(item => item.type), [Type.STRING, Type.NUMBER]);
		assert.strictEqual('allOf' in schema, false);
	});
});
