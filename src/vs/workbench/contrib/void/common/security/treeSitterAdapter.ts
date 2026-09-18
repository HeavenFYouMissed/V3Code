/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — tree-sitter → normalized AstNode adapter.
 *
 * This is the thin bridge the whole design hinges on: it wraps a REAL tree-sitter syntax node
 * in our {@link AstNode} interface so the pure engine (cpgLifter/taintEngine) can consume it
 * without ever importing tree-sitter. The engine stays headless-testable (synthetic AstNodes);
 * production feeds it real parsed nodes through this wrapper.
 *
 * Deliberately structural-typed: we accept any object shaped like a tree-sitter Node
 * (`type`, `text`, `startPosition`, `startIndex`/`endIndex`, `namedChildren`,
 * `childForFieldName`). That covers BOTH `web-tree-sitter` (Node) and `@vscode/tree-sitter-wasm`
 * (Node) without importing either package — so this file compiles in the pure `common/` layer.
 *
 * Lazy wrapping: children/fields are wrapped on access, not eagerly, so we never materialize a
 * second full tree — important for large files. Wrapped nodes are memoized per underlying node.
 */

import { AstNode } from './astTypes.js';

/** The minimal shape we need from a tree-sitter node (both wasm bindings satisfy this). */
export interface TsNodeLike {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { readonly row: number; readonly column: number };
	readonly startIndex: number;
	readonly endIndex: number;
	readonly namedChildren: readonly (TsNodeLike | null)[];
	childForFieldName(field: string): TsNodeLike | null;
}

/** Max text we keep per node — matches the lifter's own bound; avoids copying huge bodies. */
const MAX_TEXT = 4000;

/** Wrap a real tree-sitter node as a normalized AstNode (lazy children + fields). */
export function wrapTsNode(ts: TsNodeLike): AstNode {
	let childrenCache: readonly AstNode[] | undefined;
	const fieldCache = new Map<string, AstNode | undefined>();
	return {
		type: ts.type,
		text: ts.text.length > MAX_TEXT ? ts.text.slice(0, MAX_TEXT) : ts.text,
		startLine: ts.startPosition.row + 1,
		startCol: ts.startPosition.column,
		startByte: ts.startIndex,
		endByte: ts.endIndex,
		get children(): readonly AstNode[] {
			if (childrenCache === undefined) {
				const out: AstNode[] = [];
				for (const c of ts.namedChildren) { if (c) { out.push(wrapTsNode(c)); } }
				childrenCache = out;
			}
			return childrenCache;
		},
		fieldChild(field: string): AstNode | undefined {
			if (fieldCache.has(field)) { return fieldCache.get(field); }
			const c = ts.childForFieldName(field);
			const wrapped = c ? wrapTsNode(c) : undefined;
			fieldCache.set(field, wrapped);
			return wrapped;
		},
	};
}
