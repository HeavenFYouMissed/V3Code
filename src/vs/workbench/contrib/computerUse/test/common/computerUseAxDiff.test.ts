/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	COMPUTER_USE_AX_FIELDS,
	ComputerUseAxSnapshot,
	assessAxDelta,
	countAxNodes,
	diffAxTrees,
	pruneAxTree,
	renderAxDelta,
} from '../../common/computerUseAxDiff.js';
import { ComputerUseAxNode } from '../../common/computerUseTypes.js';

suite('ComputerUse - accessibility tree diff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Builds a node with the boring fields filled in, so fixtures show only what matters. */
	function node(
		ref: string,
		role: string,
		extra?: Partial<Omit<ComputerUseAxNode, 'ref' | 'role'>>,
	): ComputerUseAxNode {
		return { ref, role, enabled: true, focused: false, ...extra };
	}

	/** Wraps a forest as a snapshot at a given generation. */
	function snapshot(generation: number, nodes: readonly ComputerUseAxNode[]): ComputerUseAxSnapshot {
		return { generation, nodes };
	}

	/** A three-button toolbar inside a window, the baseline for most cases below. */
	function baseline(): ComputerUseAxSnapshot {
		return snapshot(1, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e4', 'button', { label: 'Send', actions: ['press'] }),
							node('e5', 'button', { label: 'Cancel', actions: ['press'] }),
						],
					}),
				],
			}),
		]);
	}

	test('an identical snapshot produces an empty delta and an unchanged verdict', () => {
		const delta = diffAxTrees(baseline(), snapshot(2, baseline().nodes));
		assert.deepStrictEqual(
			{
				added: delta.added,
				removed: delta.removed,
				changed: delta.changed,
				stats: delta.stats,
				assessment: assessAxDelta(delta),
			},
			{
				added: [],
				removed: [],
				changed: [],
				stats: {
					previousNodeCount: 5,
					nodeCount: 5,
					addedNodeCount: 0,
					removedNodeCount: 0,
					changedNodeCount: 0,
					unchangedNodeCount: 5,
					matchedByRef: 5,
					matchedByPath: 0,
				},
				assessment: {
					useDelta: true,
					reason: 'unchanged',
					deltaNodeCount: 0,
					fullNodeCount: 5,
					ratio: 0,
				},
			},
		);
	});

	test('identity survives a sibling reorder because refs match', () => {
		const reordered = snapshot(2, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e5', 'button', { label: 'Cancel', actions: ['press'] }),
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e4', 'button', { label: 'Send', actions: ['press'] }),
						],
					}),
				],
			}),
		]);
		const delta = diffAxTrees(baseline(), reordered);
		assert.deepStrictEqual(
			{
				added: delta.added,
				removed: delta.removed,
				changed: delta.changed,
				matchedByRef: delta.stats.matchedByRef,
				matchedByPath: delta.stats.matchedByPath,
			},
			{ added: [], removed: [], changed: [], matchedByRef: 5, matchedByPath: 0 },
		);
	});

	test('identity survives a relabel, and reports the label as the change', () => {
		const relabelled = snapshot(2, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e4', 'button', { label: 'Send now', actions: ['press'] }),
							node('e5', 'button', { label: 'Cancel', actions: ['press'] }),
						],
					}),
				],
			}),
		]);
		const delta = diffAxTrees(baseline(), relabelled);
		assert.deepStrictEqual(
			{ added: delta.added, removed: delta.removed, changed: delta.changed },
			{
				added: [],
				removed: [],
				changed: [
					{
						ref: 'e4',
						previousRef: undefined,
						role: 'button',
						label: 'Send now',
						changes: [{ field: 'label', from: 'Send', to: 'Send now' }],
					},
				],
			},
		);
	});

	test('identity survives a relabel that also re-minted the ref, via the structural path', () => {
		// A protocol-2 helper mints a new ref when the label changes, so the node arrives as e9.
		const relabelled = snapshot(2, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e9', 'button', { label: 'Send now', actions: ['press'] }),
							node('e5', 'button', { label: 'Cancel', actions: ['press'] }),
						],
					}),
				],
			}),
		]);
		const delta = diffAxTrees(baseline(), relabelled);
		assert.deepStrictEqual(
			{
				added: delta.added,
				removed: delta.removed,
				changed: delta.changed,
				matchedByRef: delta.stats.matchedByRef,
				matchedByPath: delta.stats.matchedByPath,
			},
			{
				added: [],
				removed: [],
				changed: [
					{
						ref: 'e9',
						previousRef: 'e4',
						role: 'button',
						label: 'Send now',
						changes: [{ field: 'label', from: 'Send', to: 'Send now' }],
					},
				],
				matchedByRef: 4,
				matchedByPath: 1,
			},
		);
	});

	test('identity survives a re-layout: every ref is re-minted but the shape is unchanged', () => {
		// The worst realistic case — a protocol-1 helper, so nothing matches by ref at all.
		const remade = snapshot(2, [
			node('r1', 'window', {
				label: 'Untitled',
				frame: { x: 400, y: 400, width: 900, height: 700 },
				children: [
					node('r2', 'toolbar', {
						frame: { x: 400, y: 400, width: 900, height: 40 },
						children: [
							node('r3', 'button', { label: 'Save', actions: ['press'], frame: { x: 410, y: 405, width: 60, height: 30 } }),
							node('r4', 'button', { label: 'Send', actions: ['press'], frame: { x: 480, y: 405, width: 60, height: 30 } }),
							node('r5', 'button', { label: 'Cancel', actions: ['press'], frame: { x: 550, y: 405, width: 60, height: 30 } }),
						],
					}),
				],
			}),
		]);
		const delta = diffAxTrees(baseline(), remade);
		// Geometry is not compared, so a pure move plus fresh refs is *no change at all*.
		assert.deepStrictEqual(
			{
				added: delta.added,
				removed: delta.removed,
				changed: delta.changed,
				matchedByRef: delta.stats.matchedByRef,
				matchedByPath: delta.stats.matchedByPath,
			},
			{ added: [], removed: [], changed: [], matchedByRef: 0, matchedByPath: 5 },
		);
	});

	test('an inserted subtree is reported once, at its root, with the parent it appeared inside', () => {
		const withSheet = snapshot(2, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e4', 'button', { label: 'Send', actions: ['press'] }),
							node('e5', 'button', { label: 'Cancel', actions: ['press'] }),
						],
					}),
					node('e6', 'sheet', {
						label: 'Discard changes?',
						children: [
							node('e7', 'button', { label: 'Discard', actions: ['press'] }),
							node('e8', 'button', { label: 'Keep', actions: ['press'] }),
						],
					}),
				],
			}),
		]);
		const delta = diffAxTrees(baseline(), withSheet);
		assert.deepStrictEqual(
			{
				addedRefs: delta.added.map(entry => [entry.parentRef, entry.node.ref]),
				addedNodeCount: delta.stats.addedNodeCount,
				removed: delta.removed,
				changed: delta.changed,
			},
			{
				addedRefs: [['e1', 'e6']],
				addedNodeCount: 3,
				removed: [],
				changed: [],
			},
		);
	});

	test('a removed subtree is reported once, at its root, with its descendant count', () => {
		const emptied = snapshot(2, [node('e1', 'window', { label: 'Untitled' })]);
		const delta = diffAxTrees(baseline(), emptied);
		assert.deepStrictEqual(
			{ added: delta.added, removed: delta.removed, changed: delta.changed, stats: delta.stats },
			{
				added: [],
				removed: [{ ref: 'e2', role: 'toolbar', label: undefined, descendantCount: 3 }],
				changed: [],
				stats: {
					previousNodeCount: 5,
					nodeCount: 1,
					addedNodeCount: 0,
					removedNodeCount: 4,
					changedNodeCount: 0,
					unchangedNodeCount: 1,
					matchedByRef: 1,
					matchedByPath: 0,
				},
			},
		);
	});

	test('a node that moved keeps its ref, so the newcomer in its old slot is an addition', () => {
		// e4 moved out of the toolbar and a brand new button took its slot. Pairing the newcomer with
		// e4 by structural path would be a silent mismatch; the ref match wins and e7 is an addition.
		const moved = snapshot(2, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e7', 'button', { label: 'Print', actions: ['press'] }),
							node('e5', 'button', { label: 'Cancel', actions: ['press'] }),
						],
					}),
					node('e4', 'button', { label: 'Send', actions: ['press'] }),
				],
			}),
		]);
		const delta = diffAxTrees(baseline(), moved);
		assert.deepStrictEqual(
			{
				addedRefs: delta.added.map(entry => entry.node.ref),
				removedRefs: delta.removed.map(entry => entry.ref),
				changedRefs: delta.changed.map(entry => entry.ref),
				matchedByRef: delta.stats.matchedByRef,
				matchedByPath: delta.stats.matchedByPath,
			},
			{
				addedRefs: ['e7'],
				removedRefs: [],
				changedRefs: [],
				matchedByRef: 5,
				matchedByPath: 0,
			},
		);
	});

	test('every compared field is reported, and geometry is never one of them', () => {
		const before = snapshot(1, [
			node('e1', 'checkBox', {
				label: 'Wrap lines',
				value: 'off',
				enabled: true,
				focused: false,
				actions: ['press'],
				frame: { x: 0, y: 0, width: 10, height: 10 },
			}),
		]);
		const after = snapshot(2, [
			node('e1', 'radioButton', {
				label: 'Wrap long lines',
				value: 'on',
				enabled: false,
				focused: true,
				actions: ['press', 'showMenu'],
				frame: { x: 999, y: 999, width: 20, height: 20 },
			}),
		]);
		const delta = diffAxTrees(before, after);
		assert.deepStrictEqual(
			{
				fields: delta.changed[0].changes,
				coveredEveryField:
					delta.changed[0].changes.length === COMPUTER_USE_AX_FIELDS.length,
			},
			{
				fields: [
					{ field: 'role', from: 'checkBox', to: 'radioButton' },
					{ field: 'label', from: 'Wrap lines', to: 'Wrap long lines' },
					{ field: 'value', from: 'off', to: 'on' },
					{ field: 'enabled', from: 'true', to: 'false' },
					{ field: 'focused', from: 'false', to: 'true' },
					{ field: 'actions', from: 'press', to: 'press,showMenu' },
				],
				coveredEveryField: true,
			},
		);
	});

	test('geometry alone is not a change, and action ordering alone is not a change', () => {
		const before = snapshot(1, [
			node('e1', 'button', { label: 'Go', actions: ['press', 'showMenu'], frame: { x: 0, y: 0, width: 8, height: 8 } }),
		]);
		const after = snapshot(2, [
			node('e1', 'button', { label: 'Go', actions: ['showMenu', 'press'], frame: { x: 500, y: 700, width: 8, height: 8 } }),
		]);
		assert.deepStrictEqual(diffAxTrees(before, after).changed, []);
	});

	test('a progress indicator counting up is not reported as a change', () => {
		const before = snapshot(1, [node('e1', 'progressIndicator', { label: 'Indexing', value: '12' })]);
		const after = snapshot(2, [node('e1', 'progressIndicator', { label: 'Indexing', value: '87' })]);
		assert.deepStrictEqual(diffAxTrees(before, after).changed, []);
	});

	test('an empty label and an absent label are the same thing', () => {
		const before = snapshot(1, [node('e1', 'button', { label: '' })]);
		const after = snapshot(2, [node('e1', 'button')]);
		assert.deepStrictEqual(diffAxTrees(before, after).changed, []);
	});

	test('the size guard rejects a delta with no baseline, nothing matched, or too much churn', () => {
		const empty = snapshot(0, []);
		const noBaseline = assessAxDelta(diffAxTrees(empty, baseline()));

		// A completely different application: nothing matches by ref and no path matches either,
		// because every role differs.
		const alien = snapshot(2, [
			node('x1', 'sheet', { label: 'Alien', children: [node('x2', 'textField', { value: 'hi' })] }),
		]);
		const nothingMatched = assessAxDelta(diffAxTrees(baseline(), alien));

		// Same shape, but every button relabelled: 3 of 5 nodes changed, over the half-tree limit.
		const churned = snapshot(2, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'A', actions: ['press'] }),
							node('e4', 'button', { label: 'B', actions: ['press'] }),
							node('e5', 'button', { label: 'C', actions: ['press'] }),
						],
					}),
				],
			}),
		]);
		const tooMuch = assessAxDelta(diffAxTrees(baseline(), churned));

		// One button relabelled: 1 of 5 nodes, well under the limit.
		const worthwhile = assessAxDelta(
			diffAxTrees(
				baseline(),
				snapshot(2, [
					node('e1', 'window', {
						label: 'Untitled',
						children: [
							node('e2', 'toolbar', {
								children: [
									node('e3', 'button', { label: 'Save', actions: ['press'] }),
									node('e4', 'button', { label: 'Send', actions: ['press'] }),
									node('e5', 'button', { label: 'Dismiss', actions: ['press'] }),
								],
							}),
						],
					}),
				]),
			),
		);

		assert.deepStrictEqual(
			[noBaseline, nothingMatched, tooMuch, worthwhile].map(a => [a.useDelta, a.reason, a.deltaNodeCount, a.fullNodeCount]),
			[
				[false, 'noBaseline', 5, 5],
				[false, 'nothingMatched', 7, 2],
				[false, 'notSmaller', 3, 5],
				[true, 'smaller', 1, 5],
			],
		);
	});

	test('pruning drops scrollbar furniture and collapses transparent single-child containers', () => {
		const noisy: readonly ComputerUseAxNode[] = [
			node('e1', 'window', {
				label: 'Doc',
				children: [
					node('e2', 'group', {
						children: [
							node('e3', 'scrollArea', {
								children: [
									node('e4', 'textArea', { value: 'hello' }),
								],
							}),
						],
					}),
					node('e5', 'scrollBar', {
						value: '0.4',
						children: [node('e6', 'incrementArrow'), node('e7', 'valueIndicator')],
					}),
					node('e8', 'group', {
						label: 'Sidebar',
						children: [node('e9', 'button', { label: 'Add', actions: ['press'] })],
					}),
				],
			}),
		];
		assert.deepStrictEqual(pruneAxTree(noisy), [
			{
				ref: 'e1',
				role: 'window',
				label: 'Doc',
				enabled: true,
				focused: false,
				children: [
					// e2 and e3 were unlabelled single-child scaffolding and collapsed away.
					{ ref: 'e4', role: 'textArea', value: 'hello', enabled: true, focused: false },
					// e8 is labelled, so it survives even though it holds one child.
					{
						ref: 'e8',
						role: 'group',
						label: 'Sidebar',
						enabled: true,
						focused: false,
						children: [
							{ ref: 'e9', role: 'button', label: 'Add', enabled: true, focused: false, actions: ['press'] },
						],
					},
				],
			},
		]);
	});

	test('pruning both snapshots turns a scroll into no change at all', () => {
		const withScroll = (offset: string, textRef: string): readonly ComputerUseAxNode[] => [
			node('e1', 'window', {
				label: 'Doc',
				children: [
					node('e2', 'scrollArea', { children: [node(textRef, 'textArea', { value: 'hello' })] }),
					node('e5', 'scrollBar', { value: offset }),
				],
			}),
		];
		const delta = diffAxTrees(
			snapshot(1, pruneAxTree(withScroll('0.0', 'e4'))),
			snapshot(2, pruneAxTree(withScroll('0.9', 'e4'))),
		);
		assert.deepStrictEqual(
			[delta.added, delta.changed, delta.removed, delta.stats.nodeCount],
			[[], [], [], 2],
		);
	});

	test('countAxNodes counts descendants', () => {
		assert.deepStrictEqual(
			[countAxNodes([]), countAxNodes(baseline().nodes)],
			[0, 5],
		);
	});

	test('rendering an unchanged delta says so in one line', () => {
		const rendered = renderAxDelta(diffAxTrees(baseline(), snapshot(2, baseline().nodes)));
		assert.deepStrictEqual(rendered, {
			text: [
				'Accessibility changes since generation 1 (now generation 2): 0 added, 0 removed, 0 changed, 5 unchanged.',
				'Nothing on screen changed.',
			].join('\n'),
			truncated: false,
		});
	});

	test('rendering preserves refs for added, changed and removed nodes alike', () => {
		const next = snapshot(4, [
			node('e1', 'window', {
				label: 'Untitled',
				children: [
					node('e2', 'toolbar', {
						children: [
							node('e3', 'button', { label: 'Save', actions: ['press'] }),
							node('e9', 'button', { label: 'Send now', enabled: false, actions: ['press'] }),
						],
					}),
					node('e6', 'sheet', {
						label: 'Discard changes?',
						frame: { x: 100, y: 200, width: 300, height: 120 },
						children: [node('e7', 'button', { label: 'Discard', actions: ['press'] })],
					}),
				],
			}),
		]);
		const rendered = renderAxDelta(diffAxTrees(baseline(), next));
		assert.deepStrictEqual(rendered, {
			text: [
				'Accessibility changes since generation 1 (now generation 4): 2 added, 1 removed, 1 changed, 3 unchanged.',
				'+ [ref=e6] sheet "Discard changes?" at=100,200 size=300x120 (appeared inside ref=e1)',
				'+   [ref=e7] button "Discard" actions=press',
				'~ [ref=e9] button "Send now" (was ref=e4) label: "Send" -> "Send now", enabled: "true" -> "false"',
				'- [ref=e5] button "Cancel"',
			].join('\n'),
			truncated: false,
		});
	});

	test('rendering respects the line budget and tells the model to re-read', () => {
		const many = (count: number, prefix: string): readonly ComputerUseAxNode[] =>
			Array.from({ length: count }, (_, i) => node(`${prefix}${i}`, 'button', { label: `Item ${i}` }));
		const rendered = renderAxDelta(
			diffAxTrees(snapshot(1, many(1, 'a')), snapshot(2, [...many(1, 'a'), ...many(5, 'b')])),
			{ maxLines: 2 },
		);
		assert.deepStrictEqual(
			[rendered.truncated, rendered.text.split('\n').length, rendered.text.split('\n')[3]],
			[true, 4, '... 3 more changes omitted. Re-read the screen in full.'],
		);
	});
});
