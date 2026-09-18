/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — CPG lifter: normalized AST → Code Property Graph.
 *
 * This is the engine's Phase 1 core. It walks an {@link AstNode} tree (which a thin
 * tree-sitter adapter produces, or tests build synthetically) and emits a {@link CpgGraph}
 * carrying three edge kinds:
 *
 *   • AST edges  — parent→child containment (structure).
 *   • CFG edges  — statement N → statement N+1 within a block, plus if→branch (control flow).
 *   • DDG edges  — data dependence: "if FROM is tainted, TO becomes tainted." This is the
 *                  spine taint analysis walks. We build it two ways:
 *                    (a) sub-expression flow — an operand/argument/object flows INTO the
 *                        expression that consumes it (bottom-up), so taint on `req.body`
 *                        reaches `sink(req.body)`.
 *                    (b) def→use flow — a variable's defining assignment flows to every later
 *                        use of that name (a light reaching-definitions pass over source
 *                        order), so `const x = req.body; sink(x)` connects.
 *
 * SCOPE HONESTY: v1 is intraprocedural and uses source-order def-use (flow-insensitive within a
 * function). That is deliberately high-recall — it can over-connect, which sanitizers later cut.
 * Phase 6 replaces source-order def-use with real CFG-based reaching definitions (flow- and
 * path-sensitive) and adds cross-function edges. The graph shape here does not change — only the
 * precision of which DDG edges exist — so downstream taint/query code is written once.
 *
 * PURE: no editor imports, no tree-sitter import. Fully unit-testable headless.
 */

import { AstNode } from './astTypes.js';
import { CpgBuilder, CpgGraph, CpgNode } from './cpgTypes.js';
import { CpgKind, normalizeKind } from './normalize.js';

/** Max raw text we store per node — literals (secrets) are short; big function bodies aren't useful verbatim. */
const MAX_NODE_TEXT = 400;

/** Stable CPG node id from a file + byte span. Byte spans disambiguate minified/one-line code. */
function nodeId(file: string, n: AstNode): string {
	return `${file}#${n.startByte}-${n.endByte}`;
}

/**
 * Identity check by source span — NOT reference equality. Critical: the tree-sitter adapter
 * wraps each underlying node lazily, so `node.fieldChild('value')` returns a DIFFERENT wrapper
 * object than the same node inside `node.children`. Comparing with `===` silently fails on real
 * parses (it only worked in synthetic tests that reused references). Two AstNodes are the same
 * program element iff they cover the same byte span.
 */
function sameNode(a: AstNode | undefined, b: AstNode | undefined): boolean {
	return !!a && !!b && a.startByte === b.startByte && a.endByte === b.endByte;
}

/**
 * A lexical scope frame: variable name → id of its current defining CPG node. A stack of these
 * models function scoping; lookups walk outward. v1 is intentionally coarse (function-level),
 * which favors recall — see scope note in the file header.
 */
type Scope = Map<string, string>;

export class CpgLifter {
	private readonly builder: CpgBuilder;
	/** Node ids that are structural names (property of a member, key of a pair, def targets) —
	 *  they must NOT be treated as variable *uses*. Populated when the parent is visited (pre-order). */
	private readonly skipAsUse = new Set<string>();
	private readonly scopes: Scope[] = [new Map()];

	constructor(private readonly file: string, private readonly languageId: string) {
		this.builder = new CpgBuilder(file);
	}

	/** Lift a parsed AST root into a frozen, queryable CPG. */
	static lift(root: AstNode, file: string, languageId: string): CpgGraph {
		const l = new CpgLifter(file, languageId);
		l.visit(root, undefined);
		return l.builder.freeze();
	}

	private scopeDefine(name: string, defNodeId: string): void {
		this.scopes[this.scopes.length - 1].set(name, defNodeId);
	}

	private scopeLookup(name: string): string | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const hit = this.scopes[i].get(name);
			if (hit !== undefined) { return hit; }
		}
		return undefined;
	}

	/** Create (dedup) the CPG node for an AstNode and return its id. */
	private ensureNode(n: AstNode, kind: CpgKind): string {
		const id = nodeId(this.file, n);
		const node: CpgNode = {
			id,
			kind,
			name: nameOf(n, kind),
			file: this.file,
			line: n.startLine,
			col: n.startCol,
			text: n.text.length > MAX_NODE_TEXT ? n.text.slice(0, MAX_NODE_TEXT) : n.text,
			props: { rawType: n.type },
		};
		this.builder.addNode(node);
		return id;
	}

	/**
	 * Pre-order walk. Creates the node, wires AST/CFG/DDG edges, then recurses. `parentId` is the
	 * enclosing CPG node id for the AST containment edge. Returns this node's id so callers can
	 * wire sub-expression DDG flow (child → this).
	 */
	private visit(n: AstNode, parentId: string | undefined): string {
		const kind = normalizeKind(this.languageId, n.type);
		const id = this.ensureNode(n, kind);
		if (parentId !== undefined) { this.builder.addEdge(parentId, id, 'AST'); }

		const pushedScope = kind === 'function';
		if (pushedScope) { this.scopes.push(new Map()); }

		// Handle structure-specific DDG wiring. Each handler returns true if it fully managed
		// its children's traversal (so the generic recursion below is skipped for those).
		let handled = false;
		switch (kind) {
			case 'member': handled = this.liftMember(n, id); break;
			case 'index': handled = this.liftIndex(n, id); break;
			case 'call':
			case 'new': handled = this.liftCall(n, id); break;
			case 'assign': handled = this.liftAssign(n, id); break;
			case 'var_decl': handled = this.liftVarDecl(n, id); break;
			case 'property': handled = this.liftPair(n, id); break;
			case 'binary':
			case 'ternary':
			case 'unary':
			case 'template':
			case 'return':
			case 'await':
			case 'spread': handled = this.flowChildrenInto(n, id); break; // operands flow into the expression (OWNS recursion)
			case 'block':
			case 'program': handled = this.wireCfgSequence(n); break; // statements get CFG order (owns its recursion)
			case 'identifier': this.liftIdentifierUse(n, id); break;
			default: break;
		}

		if (!handled) {
			for (const child of n.children) { this.visit(child, id); }
		}

		if (pushedScope) { this.scopes.pop(); }
		return id;
	}

	/** a.b : the OBJECT flows into the member; the property name is a label, never a var use. */
	private liftMember(n: AstNode, id: string): boolean {
		const obj = n.fieldChild('object');
		const prop = n.fieldChild('property');
		if (prop) { this.skipAsUse.add(nodeId(this.file, prop)); }
		for (const child of n.children) {
			const childId = this.visit(child, id);
			if (sameNode(child, obj)) { this.builder.addEdge(childId, id, 'DDG'); }
		}
		return true;
	}

	/** a[b] : both the object and the index expression flow into the access. */
	private liftIndex(n: AstNode, id: string): boolean {
		for (const child of n.children) {
			const childId = this.visit(child, id);
			this.builder.addEdge(childId, id, 'DDG'); // over-connect on purpose (recall)
		}
		return true;
	}

	/** f(args) / new C(args) : each argument AND the callee/receiver flows into the call node. */
	private liftCall(n: AstNode, id: string): boolean {
		const callee = n.fieldChild('function') ?? n.fieldChild('constructor');
		const args = n.fieldChild('arguments');
		for (const child of n.children) {
			const childId = this.visit(child, id);
			if (sameNode(child, callee)) {
				// Receiver taint: `tainted.foo()` — the callee member (whose object is tainted)
				// flows into the call result.
				this.builder.addEdge(childId, id, 'DDG');
			} else if (sameNode(child, args)) {
				// Each argument flows into the call. The `arguments` node was just visited (so its
				// sub-edges exist); wire each direct argument straight to the call so tainted args
				// reach the sink in one DDG hop.
				for (const arg of child.children) {
					this.builder.addEdge(nodeId(this.file, arg), id, 'DDG');
				}
			}
		}
		return true;
	}

	/** x = rhs : rhs flows into the assign node; if the target is a plain name, (re)define it. */
	private liftAssign(n: AstNode, id: string): boolean {
		const left = n.fieldChild('left');
		const right = n.fieldChild('right');
		if (left && (left.type === 'identifier')) { this.skipAsUse.add(nodeId(this.file, left)); }
		for (const child of n.children) {
			const childId = this.visit(child, id);
			if (sameNode(child, right)) { this.builder.addEdge(childId, id, 'DDG'); }
		}
		if (left && left.type === 'identifier') {
			// Define AFTER visiting rhs so the def node (this assign) carries rhs taint forward.
			this.scopeDefine(left.text, id);
		}
		return true;
	}

	/** const x = value : value flows into the declarator; bind name → this def node. */
	private liftVarDecl(n: AstNode, id: string): boolean {
		const name = n.fieldChild('name');
		const value = n.fieldChild('value');
		if (name && name.type === 'identifier') { this.skipAsUse.add(nodeId(this.file, name)); }
		for (const child of n.children) {
			const childId = this.visit(child, id);
			if (sameNode(child, value)) { this.builder.addEdge(childId, id, 'DDG'); }
		}
		if (name && name.type === 'identifier') { this.scopeDefine(name.text, id); }
		return true;
	}

	/** { key: value } : value flows into the pair; key is a label, not a var use. */
	private liftPair(n: AstNode, id: string): boolean {
		const key = n.fieldChild('key');
		const value = n.fieldChild('value');
		if (key) { this.skipAsUse.add(nodeId(this.file, key)); }
		for (const child of n.children) {
			const childId = this.visit(child, id);
			if (sameNode(child, value)) { this.builder.addEdge(childId, id, 'DDG'); }
		}
		return true;
	}

	/**
	 * Generic bottom-up: every child expression flows into this expression node. OWNS its
	 * children's traversal and returns true so the generic loop in visit() does NOT re-walk them.
	 *
	 * WHY THIS RETURNS A BOOLEAN (do not "simplify" it back to void): the arms that call this —
	 * binary/ternary/unary/template/return/await/spread — nest arbitrarily deep (a chain of `||`
	 * or ternaries). If this returned void, `handled` stays falsy and visit()'s fallback loop
	 * walks every child a SECOND time; the duplication compounds per level to 2^depth visits and
	 * OOMs on real deeply-nested files (e.g. semver.js at depth 88). This is the exact defect
	 * wireCfgSequence already guards against — same bug class, two sites.
	 */
	private flowChildrenInto(n: AstNode, id: string): boolean {
		for (const child of n.children) {
			const childId = this.visit(child, id);
			this.builder.addEdge(childId, id, 'DDG');
		}
		return true;
	}

	/**
	 * A statement list: visit each child once and wire prev→next CFG edges so control order is
	 * queryable (Phase 6 uses it). Returns true because it OWNS its children's traversal — the
	 * caller must not recurse again, or every node below a block is visited twice.
	 */
	private wireCfgSequence(n: AstNode): boolean {
		let prevId: string | undefined;
		for (const child of n.children) {
			const childId = this.visit(child, nodeId(this.file, n));
			if (prevId !== undefined) { this.builder.addEdge(prevId, childId, 'CFG'); }
			prevId = childId;
		}
		return true;
	}

	/**
	 * An identifier in use position: link its defining node → this use (def-use DDG).
	 *
	 * This intentionally does NOT return a handled flag, so visit() runs its generic child loop
	 * afterward. That is safe ONLY because an identifier is a leaf in tree-sitter (n.children is
	 * empty) — the loop runs zero iterations, so there is no double-visit here. If identifiers ever
	 * gained children this would need to own its traversal like the expression arms above.
	 */
	private liftIdentifierUse(n: AstNode, id: string): void {
		if (this.skipAsUse.has(id)) { return; }
		const def = this.scopeLookup(n.text);
		if (def !== undefined && def !== id) { this.builder.addEdge(def, id, 'DDG'); }
	}
}

/** Best-effort display name for a node, used in reports and def-use tracking. */
function nameOf(n: AstNode, kind: CpgKind): string {
	switch (kind) {
		case 'identifier': return n.text.split('\n')[0].slice(0, 120);
		case 'member':
			// Full dotted path ('req.query', 'db.query') — NOT just the property. The receiver is
			// what distinguishes a taint source (req.body) from a benign access (db.query), and it
			// reads better in reports. Falls back to raw text for computed/complex receivers.
			return dottedName(n);
		case 'call':
		case 'new': {
			const callee = n.fieldChild('function') ?? n.fieldChild('constructor');
			return callee ? dottedName(callee) : n.text.slice(0, 120);
		}
		case 'literal':
		case 'template': return n.text.slice(0, 120);
		default: return '';
	}
}

/**
 * Flatten a member/identifier chain to a dotted name like `res.send` or `req.query.name`.
 * Used for BOTH member nodes and call callees so a spec can match `req.body` (source) or
 * `child_process.exec` (sink) precisely by its full path instead of a bare property name.
 */
function dottedName(node: AstNode): string {
	if (node.type === 'identifier') { return node.text; }
	const obj = node.fieldChild('object');
	const prop = node.fieldChild('property');
	if (obj && prop) { return `${dottedName(obj)}.${prop.text}`; }
	// Computed access (a[b]) or an unusual receiver: fall back to bounded raw text.
	return node.text.split('\n')[0].slice(0, 120);
}
