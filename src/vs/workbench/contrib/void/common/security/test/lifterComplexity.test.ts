/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * PERMANENT REGRESSION GUARD — CPG lifter must stay LINEAR in node count.
 *
 * History: the lifter twice shipped a visit()-arm that called a child-flow helper WITHOUT
 * returning `handled = true`, so visit()'s generic fallback loop re-walked every child a second
 * time. On deeply-nested expressions (a `||`/ternary chain, e.g. base/common/semver/semver.js at
 * depth 88) this doubling compounds per level to 2^depth node visits and OOMs the whole scan —
 * while every shallow synthetic unit test stays green. That failure mode is invisible to normal
 * tests, so this guard exists specifically to make it LOUD: it builds increasingly deep binary
 * chains and asserts edges-per-node stays a small constant and does NOT grow with depth. A
 * double-visit regression turns ~2.0 edges/node into thousands and fails here immediately.
 *
 * Run standalone (no editor boot): compile this folder and
 *   node <out>/test/lifterComplexity.test.js
 */

import { AstNode } from '../astTypes.js';
import { CpgLifter } from '../cpgLifter.js';

let cursor = 0;
function leaf(type: string, text: string): AstNode {
	const startByte = cursor; cursor += (text.length + 1);
	return { type, text, startLine: 1, startCol: 0, startByte, endByte: cursor - 1, children: [], fieldChild: () => undefined };
}
/** A binary_expression with unique byte spans (distinct CPG ids) and left/right fields. */
function bin(left: AstNode, right: AstNode): AstNode {
	const op = leaf('identifier', 'x');
	const children = [left, op, right];
	return {
		type: 'binary_expression', text: 'L||R', startLine: 1, startCol: 0,
		startByte: left.startByte, endByte: cursor++, children,
		fieldChild: (f: string) => (f === 'left' ? left : f === 'right' ? right : undefined),
	};
}
/** Left-deep chain of `depth` nested binary expressions, wrapped in a program. */
function buildChain(depth: number): AstNode {
	cursor = 0;
	let node: AstNode = leaf('identifier', 'a');
	for (let i = 0; i < depth; i++) { node = bin(node, leaf('identifier', 'b' + i)); }
	return { type: 'program', text: 'p', startLine: 1, startCol: 0, startByte: 0, endByte: cursor++, children: [node], fieldChild: () => undefined };
}

function measure(depth: number): { depth: number; nodes: number; edges: number } {
	const g = CpgLifter.lift(buildChain(depth), 'guard.ts', 'typescript');
	const nodes = g.nodes.size; // ReadonlyMap — .size, NOT .length (a .length here reads undefined and makes the ratio NaN → a vacuous pass)
	if (typeof nodes !== 'number' || nodes === 0) { throw new Error('guard self-check: node count unreadable — assertion would be vacuous'); }
	return { depth, nodes, edges: g.edges.length };
}

export function runLifterComplexityGuard(): void {
	const rows = [10, 20, 40, 80, 160, 320].map(measure);
	const ratios = rows.map(r => r.edges / r.nodes);
	const maxRatio = Math.max(...ratios);
	const RATIO_CAP = 6;                                   // real value ~2.0; 2^depth would be thousands
	const grows = ratios[ratios.length - 1] > ratios[0] * 1.5; // ratio must stay FLAT across depth

	// eslint-disable-next-line no-console
	console.log('depth | nodes | edges | edges/node');
	for (const r of rows) {
		// eslint-disable-next-line no-console
		console.log(`${String(r.depth).padStart(5)} | ${String(r.nodes).padStart(5)} | ${String(r.edges).padStart(5)} | ${(r.edges / r.nodes).toFixed(2)}`);
	}
	if (maxRatio > RATIO_CAP) { throw new Error(`GUARD FAILED: edges/node ${maxRatio.toFixed(2)} > cap ${RATIO_CAP} — non-linear (double-visit regression).`); }
	if (grows) { throw new Error(`GUARD FAILED: edges/node grows with depth (${ratios[0].toFixed(2)} → ${ratios[ratios.length - 1].toFixed(2)}) — super-linear, likely 2^depth.`); }
	// eslint-disable-next-line no-console
	console.log(`\nGUARD PASS: edges linear in nodes (max ratio ${maxRatio.toFixed(2)}, flat across depth 10→320).`);
}

runLifterComplexityGuard();
