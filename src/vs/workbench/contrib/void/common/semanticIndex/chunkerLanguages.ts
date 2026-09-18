/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ChunkKind } from './semanticIndexTypes.js';

/**
 * Per-language map from tree-sitter node type → semantic chunk kind. The map is
 * intentionally narrow: we only chunk the structural boundaries that are
 * meaningful for retrieval (functions, classes, methods, interfaces, types,
 * enums). Anything else falls through to file-level chunking — better to over-
 * include than over-fragment.
 *
 * The grammar `.wasm` filename convention is `tree-sitter-{lang}.wasm` under
 * `vselite/extensions/...` (path resolved at runtime by the chunker).
 */
export interface LanguageProfile {
	/** VS Code language id. */
	id: string;
	/** Grammar wasm asset filename (without extension). */
	grammar: string;
	/** Tree-sitter node-type → ChunkKind. */
	nodeTypeMap: Record<string, ChunkKind>;
	/** Optional field name on the node that holds the symbol identifier. */
	nameField?: string;
	/** Optional fallback: scan children for `identifier` if nameField fails. */
	nameFromIdentifierChild?: boolean;
}

const TS_LIKE_MAP: Record<string, ChunkKind> = {
	function_declaration: 'function',
	function_expression: 'function',
	arrow_function: 'function',
	generator_function_declaration: 'function',
	class_declaration: 'class',
	class: 'class',
	method_definition: 'method',
	interface_declaration: 'interface',
	type_alias_declaration: 'type',
	enum_declaration: 'enum',
};

const PY_MAP: Record<string, ChunkKind> = {
	function_definition: 'function',
	class_definition: 'class',
	decorated_definition: 'function', // covers decorated funcs/classes; resolved at chunk time
};

const GO_MAP: Record<string, ChunkKind> = {
	function_declaration: 'function',
	method_declaration: 'method',
	type_declaration: 'type',
};

const RUST_MAP: Record<string, ChunkKind> = {
	function_item: 'function',
	impl_item: 'class',
	struct_item: 'type',
	enum_item: 'enum',
	trait_item: 'interface',
	type_item: 'type',
	mod_item: 'class',
};

const JAVA_MAP: Record<string, ChunkKind> = {
	method_declaration: 'method',
	constructor_declaration: 'method',
	class_declaration: 'class',
	interface_declaration: 'interface',
	enum_declaration: 'enum',
	annotation_type_declaration: 'type',
};

const CSHARP_MAP: Record<string, ChunkKind> = {
	method_declaration: 'method',
	constructor_declaration: 'method',
	class_declaration: 'class',
	interface_declaration: 'interface',
	struct_declaration: 'type',
	enum_declaration: 'enum',
	record_declaration: 'type',
	delegate_declaration: 'type',
};

const CPP_MAP: Record<string, ChunkKind> = {
	function_definition: 'function',
	class_specifier: 'class',
	struct_specifier: 'type',
	enum_specifier: 'enum',
	namespace_definition: 'class',
};

const RUBY_MAP: Record<string, ChunkKind> = {
	method: 'method',
	singleton_method: 'method',
	class: 'class',
	module: 'class',
};

const PHP_MAP: Record<string, ChunkKind> = {
	function_definition: 'function',
	method_declaration: 'method',
	class_declaration: 'class',
	interface_declaration: 'interface',
	trait_declaration: 'interface',
	enum_declaration: 'enum',
};

/**
 * Language id → profile. Keys MUST match VS Code's languageId values.
 * Missing languages fall through to the sliding-window fallback in chunker.ts.
 */
export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
	typescript: { id: 'typescript', grammar: 'tree-sitter-typescript', nodeTypeMap: TS_LIKE_MAP, nameField: 'name', nameFromIdentifierChild: true },
	typescriptreact: { id: 'typescriptreact', grammar: 'tree-sitter-tsx', nodeTypeMap: TS_LIKE_MAP, nameField: 'name', nameFromIdentifierChild: true },
	javascript: { id: 'javascript', grammar: 'tree-sitter-javascript', nodeTypeMap: TS_LIKE_MAP, nameField: 'name', nameFromIdentifierChild: true },
	javascriptreact: { id: 'javascriptreact', grammar: 'tree-sitter-tsx', nodeTypeMap: TS_LIKE_MAP, nameField: 'name', nameFromIdentifierChild: true },
	python: { id: 'python', grammar: 'tree-sitter-python', nodeTypeMap: PY_MAP, nameField: 'name', nameFromIdentifierChild: true },
	go: { id: 'go', grammar: 'tree-sitter-go', nodeTypeMap: GO_MAP, nameField: 'name', nameFromIdentifierChild: true },
	rust: { id: 'rust', grammar: 'tree-sitter-rust', nodeTypeMap: RUST_MAP, nameField: 'name', nameFromIdentifierChild: true },
	java: { id: 'java', grammar: 'tree-sitter-java', nodeTypeMap: JAVA_MAP, nameField: 'name', nameFromIdentifierChild: true },
	csharp: { id: 'csharp', grammar: 'tree-sitter-c-sharp', nodeTypeMap: CSHARP_MAP, nameField: 'name', nameFromIdentifierChild: true },
	cpp: { id: 'cpp', grammar: 'tree-sitter-cpp', nodeTypeMap: CPP_MAP, nameField: 'declarator', nameFromIdentifierChild: true },
	// Deliberately the C++ grammar. @vscode/tree-sitter-wasm has never published a
	// tree-sitter-c.wasm, so this profile named an asset that cannot exist and every
	// .c/.h file fell back to blind line windows regardless of what packaging shipped.
	// The C++ grammar is a superset of C for the constructs extracted here, and
	// CPP_MAP was already the node map — only the asset name was wrong.
	c: { id: 'c', grammar: 'tree-sitter-cpp', nodeTypeMap: CPP_MAP, nameField: 'declarator', nameFromIdentifierChild: true },
	ruby: { id: 'ruby', grammar: 'tree-sitter-ruby', nodeTypeMap: RUBY_MAP, nameField: 'name', nameFromIdentifierChild: true },
	php: { id: 'php', grammar: 'tree-sitter-php', nodeTypeMap: PHP_MAP, nameField: 'name', nameFromIdentifierChild: true },
};

/** File extension → languageId. Used when the file doesn't have an open editor. */
export const EXT_TO_LANGUAGE: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescriptreact',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascriptreact',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.py': 'python',
	'.pyi': 'python',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.cs': 'csharp',
	'.cpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.hpp': 'cpp',
	'.hh': 'cpp',
	'.h': 'c',
	'.c': 'c',
	'.rb': 'ruby',
	'.php': 'php',
};

export function languageFromExtension(filePath: string): string | undefined {
	const dot = filePath.lastIndexOf('.');
	if (dot < 0) return undefined;
	const ext = filePath.slice(dot).toLowerCase();
	return EXT_TO_LANGUAGE[ext];
}

export function profileFor(languageId: string): LanguageProfile | undefined {
	return LANGUAGE_PROFILES[languageId];
}
