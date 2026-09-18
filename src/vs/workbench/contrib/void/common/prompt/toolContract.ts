/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Dependency-free JSON Schema contracts shared by every V3Code tool transport.
 *
 * Keep this module free of renderer, extension-host, and provider SDK imports. The same
 * schema must be safe to hand to native VS Code tools, model providers, and MCP clients.
 */

export type ToolSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
export type ToolSchemaLiteral = string | number | boolean | null;

export interface ToolJSONSchema {
	type?: ToolSchemaType | ToolSchemaType[];
	description?: string;
	enum?: ToolSchemaLiteral[];
	const?: ToolSchemaLiteral;
	default?: ToolSchemaLiteral | ToolSchemaLiteral[];
	properties?: Record<string, ToolJSONSchema>;
	required?: string[];
	items?: ToolJSONSchema;
	additionalProperties?: boolean | ToolJSONSchema;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	pattern?: string;
	format?: string;
	anyOf?: ToolJSONSchema[];
	oneOf?: ToolJSONSchema[];
	allOf?: ToolJSONSchema[];
	[key: string]: unknown;
}

export interface ToolInputSchema extends ToolJSONSchema {
	type: 'object';
	properties: Record<string, ToolJSONSchema>;
}

/** Runtime shape metadata for one top-level parameter. `required` is lifted to the object schema. */
export type ToolParamContract = Omit<ToolJSONSchema, 'description' | 'required'> & {
	type: ToolSchemaType;
	required: boolean;
};

export type ToolParamDescriptions = Record<string, { description: string }>;
export type ToolParamContracts = Record<string, ToolParamContract>;
export type ToolObjectContract = Omit<ToolJSONSchema, 'type' | 'properties' | 'required'> & {
	required?: string[];
};

export type SnakeCase<S extends string> =
	S extends 'URI' ? 'uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	: S extends `${infer C}${infer Rest}`
		? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
		: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Preserve a server-provided object schema instead of flattening it into description strings. */
export function toolInputSchemaFromUnknown(value: unknown): ToolInputSchema | undefined {
	if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) {
		return undefined;
	}
	return value as ToolInputSchema;
}

/**
 * Build the provider-facing object schema from V3Code's descriptions and typed shape registry.
 * Unknown params retain the old permissive string fallback so an out-of-tree caller does not break;
 * the builtin drift test forbids that fallback for every registered V3Code parameter.
 */
export function buildToolInputSchema(
	params: ToolParamDescriptions,
	contracts: ToolParamContracts | undefined,
	objectContract?: ToolObjectContract,
): ToolInputSchema {
	const properties: Record<string, ToolJSONSchema> = {};
	const required: string[] = [];

	for (const [name, param] of Object.entries(params)) {
		const contract = contracts?.[name];
		if (!contract) {
			properties[name] = { type: 'string', description: param.description };
			continue;
		}

		const { required: isRequired, ...schema } = contract;
		properties[name] = { ...schema, description: param.description };
		if (isRequired) {
			required.push(name);
		}
	}

	return {
		...objectContract,
		type: 'object',
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	};
}

export function schemaTypeLabel(schema: ToolJSONSchema | undefined): string {
	if (!schema?.type) { return 'value'; }
	return typeof schema.type === 'string' ? schema.type : schema.type.join(' | ');
}
