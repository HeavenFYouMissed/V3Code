/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — grammar node-type normalization.
 *
 * Different tree-sitter grammars name the same concept differently: a function call is
 * `call_expression` in JS/TS but `call` in Python and `call_expression` again in Rust; an
 * assignment is `assignment_expression` vs `assignment` vs `assignment_expression`. If taint
 * rules matched on raw grammar types we'd rewrite every rule per language. Instead the lifter
 * runs each raw node type through {@link normalizeKind} to get ONE language-agnostic CPG kind,
 * and every downstream rule matches on that kind.
 *
 * The normalized kinds are the vocabulary the CPG + taint engine speak:
 *   call | member | identifier | assign | var_decl | literal | template | binary | unary |
 *   function | param | return | if | for | while | try | catch | object | property | array |
 *   index | spread | await | new | ternary | block | program | other
 *
 * SCOPE: JS/TS/JSX/TSX is fully modeled (the vibe-code target). Python/Go/Rust/Java/etc. have
 * partial maps here and get completed as Phase 8 framework/language packs — but because the
 * normalized VOCAB is fixed, adding a language is data, never an engine change.
 */

/** The fixed, language-agnostic node vocabulary the whole engine matches on. */
export type CpgKind =
	| 'call' | 'member' | 'identifier' | 'assign' | 'var_decl' | 'literal' | 'template'
	| 'binary' | 'unary' | 'function' | 'param' | 'return' | 'if' | 'for' | 'while'
	| 'try' | 'catch' | 'object' | 'property' | 'array' | 'index' | 'spread' | 'await'
	| 'new' | 'ternary' | 'block' | 'program' | 'other';

/**
 * JS/TS/JSX/TSX raw grammar node type → normalized CpgKind. The four JS-family grammars
 * (tree-sitter-javascript / typescript / tsx) share these node names, so one map covers all.
 * Anything not listed normalizes to 'other' (still a graph node, just not rule-significant).
 */
const JS_KIND: Readonly<Record<string, CpgKind>> = {
	// calls & construction — the sinks of most vulns
	call_expression: 'call',
	new_expression: 'new',
	// member / index access — how tainted objects get read (req.body.x, obj[key])
	member_expression: 'member',
	subscript_expression: 'index',
	// names & literals — taint sources and constants
	identifier: 'identifier',
	shorthand_property_identifier: 'identifier',
	property_identifier: 'identifier',
	string: 'literal',
	number: 'literal',
	true: 'literal',
	false: 'literal',
	null: 'literal',
	regex: 'literal',
	template_string: 'template',
	template_substitution: 'template',
	// assignment & declaration — how taint propagates variable→variable
	assignment_expression: 'assign',
	augmented_assignment_expression: 'assign',
	variable_declarator: 'var_decl',
	// operators
	binary_expression: 'binary',
	unary_expression: 'unary',
	ternary_expression: 'ternary',
	// functions — interprocedural boundaries (Phase 6)
	function_declaration: 'function',
	function_expression: 'function',
	arrow_function: 'function',
	generator_function_declaration: 'function',
	method_definition: 'function',
	formal_parameters: 'other',
	required_parameter: 'param',
	optional_parameter: 'param',
	// control flow — CFG edges hang off these
	return_statement: 'return',
	if_statement: 'if',
	for_statement: 'for',
	for_in_statement: 'for',
	while_statement: 'while',
	do_statement: 'while',
	try_statement: 'try',
	catch_clause: 'catch',
	statement_block: 'block',
	program: 'program',
	// data structures — prototype-pollution & object-shape reasoning
	object: 'object',
	pair: 'property',
	array: 'array',
	spread_element: 'spread',
	// async
	await_expression: 'await',
};

/** Python raw node type → CpgKind (partial; completed in Phase 8). */
const PY_KIND: Readonly<Record<string, CpgKind>> = {
	call: 'call',
	attribute: 'member',
	subscript: 'index',
	identifier: 'identifier',
	string: 'literal',
	integer: 'literal',
	float: 'literal',
	true: 'literal',
	false: 'literal',
	none: 'literal',
	assignment: 'assign',
	augmented_assignment: 'assign',
	binary_operator: 'binary',
	unary_operator: 'unary',
	function_definition: 'function',
	return_statement: 'return',
	if_statement: 'if',
	for_statement: 'for',
	while_statement: 'while',
	try_statement: 'try',
	except_clause: 'catch',
	dictionary: 'object',
	pair: 'property',
	list: 'array',
	block: 'block',
	module: 'program',
};

/** languageId → its raw-type→kind map. */
const KIND_MAPS: Readonly<Record<string, Readonly<Record<string, CpgKind>>>> = {
	typescript: JS_KIND,
	typescriptreact: JS_KIND,
	javascript: JS_KIND,
	javascriptreact: JS_KIND,
	python: PY_KIND,
};

/**
 * Normalize a raw grammar node type into the engine's fixed CpgKind vocabulary for a given
 * languageId. Unknown types (and unknown languages) fall back to 'other' — they still become
 * graph nodes so structure/containment is preserved, they're just not rule-significant.
 */
export function normalizeKind(languageId: string, rawType: string): CpgKind {
	const map = KIND_MAPS[languageId];
	if (map) {
		const k = map[rawType];
		if (k) { return k; }
	}
	return 'other';
}

/** True if Sentinel has a real (non-fallback) node map for this language. */
export function isLanguageModeled(languageId: string): boolean {
	return languageId in KIND_MAPS;
}

/**
 * The grammar field name that holds the "callee" of a call/new for a language — e.g. JS calls
 * store the callee under the 'function' field. Used by the lifter to read `foo(...)`'s `foo`
 * precisely instead of guessing the first child.
 */
export function calleeField(languageId: string): string {
	switch (languageId) {
		case 'python': return 'function';
		default: return 'function'; // JS/TS also use 'function'
	}
}

/**
 * The grammar field names for the two sides of an assignment (left = target, right = value),
 * so the lifter can wire a DDG edge value→target. JS uses 'left'/'right'; Python 'left'/'right'.
 */
export function assignFields(_languageId: string): { readonly left: string; readonly right: string } {
	return { left: 'left', right: 'right' };
}
