/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Schema, Type } from '@google/genai';
import { ToolJSONSchema, ToolSchemaType } from '../../common/prompt/toolContract.js';

const geminiTypeOf = (type: ToolSchemaType | readonly ToolSchemaType[] | undefined): Type => {
	const scalar = Array.isArray(type) ? type.find(value => value !== 'object') ?? type[0] : type;
	switch (scalar) {
		case 'object': return Type.OBJECT;
		case 'array': return Type.ARRAY;
		case 'boolean': return Type.BOOLEAN;
		case 'integer': return Type.INTEGER;
		case 'number': return Type.NUMBER;
		default: return Type.STRING;
	}
};

/**
 * Convert V3Code's JSON Schema contract to the subset accepted by the pinned
 * @google/genai SDK. `oneOf` becomes the SDK's supported `anyOf`; item/length
 * bounds are strings because that is the SDK's declared wire contract.
 * Unsupported OpenAPI fields (allOf/additionalProperties) are deliberately not
 * invented or weakened here.
 */
export const toGeminiSchema = (schema: ToolJSONSchema): Schema => {
	const inferredType = schema.type ?? (schema.properties || schema.required ? 'object' : undefined);
	const converted: Record<string, unknown> = { type: geminiTypeOf(inferredType) };
	if (schema.description) { converted.description = schema.description; }
	if (schema.enum) { converted.enum = schema.enum.filter(value => value !== null).map(String); }
	if (schema.const !== undefined && schema.const !== null) { converted.enum = [String(schema.const)]; }
	if (schema.default !== undefined) { converted.default = schema.default; }
	if (schema.format) { converted.format = schema.format; }
	if (schema.pattern) { converted.pattern = schema.pattern; }
	if (schema.required) { converted.required = [...schema.required]; }
	if (schema.items) { converted.items = toGeminiSchema(schema.items); }
	if (schema.anyOf) { converted.anyOf = schema.anyOf.map(toGeminiSchema); }
	if (schema.oneOf) { converted.anyOf = schema.oneOf.map(toGeminiSchema); }
	if (schema.properties) {
		converted.properties = Object.fromEntries(
			Object.entries(schema.properties).map(([name, property]) => [name, toGeminiSchema(property)])
		);
	}
	if (schema.minimum !== undefined) { converted.minimum = schema.minimum; }
	if (schema.maximum !== undefined) { converted.maximum = schema.maximum; }
	if (schema.minLength !== undefined) { converted.minLength = String(schema.minLength); }
	if (schema.maxLength !== undefined) { converted.maxLength = String(schema.maxLength); }
	if (schema.minItems !== undefined) { converted.minItems = String(schema.minItems); }
	if (schema.maxItems !== undefined) { converted.maxItems = String(schema.maxItems); }
	return converted as Schema;
};
