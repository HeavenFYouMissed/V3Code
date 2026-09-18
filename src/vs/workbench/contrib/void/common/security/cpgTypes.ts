/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel security engine — Code Property Graph (CPG) type model.
 *
 * This is the foundational data model the whole defensive scanner queries. A CPG
 * (Yamaguchi et al., IEEE S&P 2014 — the graph model under Joern and CodeQL) merges
 * three views of a program into one queryable graph so we can trace attacker-controlled
 * data from where it enters ("source") to where it does damage ("sink"):
 *   - AST edges  — syntactic structure (comes from V3Code's existing tree-sitter chunker)
 *   - CFG edges  — control flow (which statement can execute after which)
 *   - DDG edges  — data dependence (which value flows into which use) — the spine of taint
 *   - REF edges  — cross-file symbol def/ref links (from lspEdgeEnricher) for interprocedural reach
 *
 * Everything downstream (taint.ts, queryEngine.ts, reachability.ts) reads this model and
 * nothing else, so the engine stays portable and testable outside the editor. These are
 * pure types + a tiny in-memory graph — no editor imports, no runtime dependency.
 */

/** The four edge kinds that make a plain AST into a Code Property Graph. */
export type CpgEdgeLabel = 'AST' | 'CFG' | 'DDG' | 'REF';

/**
 * A node in the CPG. `kind` is a normalized, language-agnostic node category
 * (e.g. 'call', 'identifier', 'assign', 'member', 'literal', 'function', 'param',
 * 'return', 'if', 'binary') so taint/query rules are written once, not per-grammar.
 */
export interface CpgNode {
	/** Stable unique id within one CPG (e.g. `${file}#${startByte}-${endByte}`). */
	readonly id: string;
	/** Normalized node category — what taint/query rules match on. */
	readonly kind: string;
	/** Best-effort human name: identifier text, callee name, property name, or ''. */
	readonly name: string;
	/** Workspace-relative file this node lives in. */
	readonly file: string;
	/** 1-based line of the node's start, for reporting file:line to the user. */
	readonly line: number;
	/** 1-based column of the node's start. */
	readonly col: number;
	/** Raw source text of the node (bounded) — used for secret/entropy checks and traces. */
	readonly text: string;
	/** Open bag of extra facts a lifter attaches (e.g. { callee: 'eval', isAsync: true }). */
	readonly props: Readonly<Record<string, string | number | boolean>>;
}

/** A directed, labeled edge between two CPG nodes. */
export interface CpgEdge {
	readonly from: string;
	readonly to: string;
	readonly label: CpgEdgeLabel;
}

/**
 * An immutable, queryable Code Property Graph for one file (later merged across files
 * via REF edges). Adjacency is pre-indexed by (nodeId, label) so taint's graph walk is
 * O(1) per hop instead of scanning every edge.
 */
export interface CpgGraph {
	readonly file: string;
	readonly nodes: ReadonlyMap<string, CpgNode>;
	readonly edges: readonly CpgEdge[];
	/** All node ids of a given normalized kind — the entry point for rule matching. */
	byKind(kind: string): readonly string[];
	/** Successors of `id` following only `label` edges (e.g. DDG data-flow forward). */
	succ(id: string, label: CpgEdgeLabel): readonly string[];
	/** Predecessors of `id` following only `label` edges (e.g. DDG data-flow backward). */
	pred(id: string, label: CpgEdgeLabel): readonly string[];
	/** Fetch a node by id, or undefined. */
	node(id: string): CpgNode | undefined;
}

/**
 * Mutable builder used by the CPG lifter (Phase 1) to accumulate nodes/edges while it
 * walks the tree-sitter tree, then freeze into an immutable CpgGraph. Kept separate from
 * the read model so query code can never accidentally mutate the graph mid-scan.
 */
export class CpgBuilder {
	private readonly _nodes = new Map<string, CpgNode>();
	private readonly _edges: CpgEdge[] = [];
	private readonly _byKind = new Map<string, string[]>();
	private readonly _succ = new Map<string, CpgEdge[]>();
	private readonly _pred = new Map<string, CpgEdge[]>();

	constructor(public readonly file: string) { }

	addNode(node: CpgNode): void {
		if (this._nodes.has(node.id)) { return; }
		this._nodes.set(node.id, node);
		let ofKind = this._byKind.get(node.kind);
		if (!ofKind) { ofKind = []; this._byKind.set(node.kind, ofKind); }
		ofKind.push(node.id);
	}

	addEdge(from: string, to: string, label: CpgEdgeLabel): void {
		const edge: CpgEdge = { from, to, label };
		this._edges.push(edge);
		let outs = this._succ.get(from);
		if (!outs) { outs = []; this._succ.set(from, outs); }
		outs.push(edge);
		let ins = this._pred.get(to);
		if (!ins) { ins = []; this._pred.set(to, ins); }
		ins.push(edge);
	}

	freeze(): CpgGraph {
		const nodes = this._nodes;
		const edges = this._edges;
		const byKind = this._byKind;
		const succIdx = this._succ;
		const predIdx = this._pred;
		const EMPTY: readonly string[] = Object.freeze([]);
		return {
			file: this.file,
			nodes,
			edges,
			byKind: (kind) => byKind.get(kind) ?? EMPTY,
			succ: (id, label) => (succIdx.get(id) ?? []).filter(e => e.label === label).map(e => e.to),
			pred: (id, label) => (predIdx.get(id) ?? []).filter(e => e.label === label).map(e => e.from),
			node: (id) => nodes.get(id),
		};
	}
}
