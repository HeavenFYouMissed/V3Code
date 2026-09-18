/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — normalized AST node model (the CPG lifter's input contract).
 *
 * WHY THIS EXISTS: V3Code's tree-sitter chunkers (chunker.ts / treeSitterChunker.ts) both
 * call `tree.delete()` and throw the syntax tree away — they emit line-range Chunk[], not a
 * queryable tree. So Sentinel does its OWN parse pass, but we do NOT want the whole engine
 * bolted to `@vscode/tree-sitter-wasm`'s concrete node type. Instead the lifter consumes this
 * small normalized interface, and a thin adapter (browser layer, Phase 5) maps a real
 * tree-sitter Node onto it. Two payoffs:
 *   1. The engine is PURE — no editor/runtime imports — so it type-checks and runs headless.
 *   2. Tests build synthetic AstNode trees directly (see `astLeaf`/`astNode` helpers), so every
 *      lifter rule is verifiable without a grammar wasm or an editor boot.
 *
 * The shape deliberately mirrors tree-sitter's Node API (type/text/positions/namedChildren/
 * childForFieldName) so the real adapter is a ~10-line wrapper, not a translation layer.
 */

/**
 * One syntax-tree node, grammar-agnostic in structure but still carrying the RAW grammar
 * `type` string (e.g. 'call_expression'). Normalization of that raw type into a
 * language-agnostic CPG kind ('call', 'assign', …) happens in normalize.ts, never here.
 */
export interface AstNode {
	/** Raw tree-sitter grammar node type, e.g. 'call_expression', 'identifier'. */
	readonly type: string;
	/** Full source text spanned by this node (bounded by the parser, not us). */
	readonly text: string;
	/** 1-based start line (for reporting file:line to the user). */
	readonly startLine: number;
	/** 0-based start column. */
	readonly startCol: number;
	/**
	 * Byte offset of the node's start/end in the file. Used to mint STABLE, unique CPG node
	 * ids (`${file}#${startByte}-${endByte}`) — line/col alone collide on minified code.
	 */
	readonly startByte: number;
	readonly endByte: number;
	/** Named children in source order (mirrors tree-sitter `namedChildren`). */
	readonly children: readonly AstNode[];
	/**
	 * The child stored under a grammar field name (mirrors tree-sitter `childForFieldName`),
	 * e.g. the 'function' field of a call, the 'left'/'right' of an assignment, the 'name' of
	 * a declaration. Returns undefined when the field is absent. This is what lets the lifter
	 * read structure precisely instead of guessing by child position.
	 */
	fieldChild(field: string): AstNode | undefined;
}

/**
 * Test/adapter helper: build a leaf AstNode (no children, no fields) from just a type and
 * text. Byte offsets auto-derive from a shared cursor so ids stay unique within a synthetic
 * tree. Real code goes through the tree-sitter adapter; this keeps unit tests terse.
 */
export function astLeaf(type: string, text: string, opts?: Partial<Pick<AstNode, 'startLine' | 'startCol' | 'startByte' | 'endByte'>>): AstNode {
	const startByte = opts?.startByte ?? 0;
	return {
		type,
		text,
		startLine: opts?.startLine ?? 1,
		startCol: opts?.startCol ?? 0,
		startByte,
		endByte: opts?.endByte ?? startByte + text.length,
		children: [],
		fieldChild: () => undefined,
	};
}

/**
 * Test/adapter helper: build a branch AstNode with children and optional named fields.
 * `fields` maps a grammar field name to one of the children (by reference), so tests can
 * exercise `fieldChild(...)` exactly the way the real adapter will populate it.
 */
export function astNode(
	type: string,
	children: readonly AstNode[],
	opts?: { text?: string; startLine?: number; startCol?: number; startByte?: number; endByte?: number; fields?: Readonly<Record<string, AstNode>> },
): AstNode {
	const fields = opts?.fields ?? {};
	const startByte = opts?.startByte ?? (children.length ? children[0].startByte : 0);
	const endByte = opts?.endByte ?? (children.length ? children[children.length - 1].endByte : startByte);
	return {
		type,
		text: opts?.text ?? children.map(c => c.text).join(' '),
		startLine: opts?.startLine ?? (children.length ? children[0].startLine : 1),
		startCol: opts?.startCol ?? 0,
		startByte,
		endByte,
		children,
		fieldChild: (field: string) => fields[field],
	};
}
