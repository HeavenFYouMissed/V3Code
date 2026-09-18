/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ComputerUseAxNode } from './computerUseTypes.js';

/**
 * Snapshot-to-snapshot diffing of accessibility trees.
 *
 * **Why this exists, and why it lives here rather than in the helper.** The expensive channel is not
 * the stdio pipe to the helper — a three-thousand-node tree crosses that in under a millisecond —
 * it is the model's context window, where the same tree costs thousands of tokens on *every* turn of
 * a read-act-read loop. After the first read, almost nothing on screen has changed, so almost all of
 * those tokens buy nothing. Diffing captures that saving, and diffing pure data in TypeScript means
 * the algorithm is written once and unit-tested headlessly instead of being written twice, in Swift
 * and in C++, inside the two native helpers.
 *
 * **What identity is keyed on, and what breaks it.** A diff that silently pairs the wrong two nodes
 * is far worse than sending the whole tree: it tells the model a button is now labelled `Delete`
 * when in truth a different row scrolled into view. So matching is layered, most trustworthy first,
 * and every layer refuses rather than guesses:
 *
 * 1. **`ref`** — the opaque handle the helper minted. From protocol version 2 a ref is bound to
 *    `(element identity, role, label)` and is *stable across snapshots* while those hold, so a ref
 *    present in both snapshots is proof of the same element. This layer survives re-layout, sibling
 *    reorder, scrolling, resizing, and a value change, because none of those touch the key.
 * 2. **Structural path** — `/window[0]/splitGroup[0]/group[2]/button[1]`, where the index counts
 *    occurrences *among same-role siblings only*, chained from the root. Used only for nodes whose
 *    ref did not match, which is what happens when the helper re-mints a ref (a label changed) or
 *    when talking to an older helper that re-mints on every walk. Because the path deliberately
 *    excludes the label, a relabelled node still matches and is reported as a `label` change rather
 *    than as a delete plus an insert.
 *
 * A path match is additionally **refused** when the candidate's own ref appears somewhere in the new
 * snapshot, because that ref is stronger evidence of where the node really went.
 *
 * What breaks identity, stated plainly:
 *
 * - **Inserting or removing a same-role sibling, when refs did not match.** Every later sibling's
 *   occurrence index shifts by one, so paths pair off by one. The result is a run of spurious
 *   `changed` nodes. Refs prevent this; the fallback cannot.
 * - **Reordering siblings, when refs did not match.** Same mechanism.
 * - **A role change together with a re-minted ref.** The path encodes the role, so neither layer
 *   matches and the node is reported as removed plus added. That is the correct answer, but it is
 *   larger than it needs to be.
 * - **An application restart.** Element pointers are gone, so no ref survives; treat the first
 *   snapshot after a restart as a baseline, never as a diff.
 *
 * **What is compared, and what is deliberately not.** {@link ComputerUseAxField} lists the compared
 * fields. `frame` is *absent on purpose*: bounds change on every scroll, on every window resize, and
 * continuously for the whole duration of an animation. Comparing geometry would mean that scrolling
 * a list dirties every node in it, which is exactly the noise the diff exists to remove. Bounds are
 * still carried in the payload for added nodes — the model needs them to orient — they are simply
 * never a reason to call a node changed.
 *
 * Everything here is pure: no I/O, no platform types, no clock. The caller owns the previous
 * snapshot cache and the decision to fall back to a full tree.
 */

// ---------------------------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------------------------

/**
 * A delta is only worth sending when it describes at most this fraction of the new tree.
 *
 * Above it the delta is both larger to read and harder to reason about than the tree itself: the
 * model has to reconstruct the current state from a baseline it can no longer see. Half is
 * deliberately conservative — the win case is typically a few percent.
 */
export const COMPUTER_USE_AX_DELTA_MAX_RATIO = 0.5;

/**
 * Line budget for {@link renderAxDelta}, matching the full-tree listing's own cap so a delta can
 * never cost the model more than the thing it replaces.
 */
export const COMPUTER_USE_AX_DELTA_MAX_LINES = 400;

/**
 * Roles whose `value` changes on its own, without anybody touching the UI.
 *
 * A spinner reporting progress would otherwise dirty the tree on every single snapshot and make
 * every diff useless. Their structural presence and disappearance is still reported — only the
 * self-driving value is suppressed.
 */
const VOLATILE_VALUE_ROLES: ReadonlySet<string> = new Set([
	'progressIndicator',
	'busyIndicator',
	'levelIndicator',
	'relevanceIndicator',
]);

/**
 * Roles dropped wholesale by {@link pruneAxTree}, together with their subtrees.
 *
 * Scrollbar furniture is never a target, and its value tracks the scroll offset, so it is pure
 * churn. Dropping it before the diff rather than after is the point: filtering afterwards means
 * diffing noise and then hiding the result, which wastes the comparison and inflates the counts the
 * size guard depends on.
 */
const NOISE_ROLES: ReadonlySet<string> = new Set([
	'scrollBar',
	'incrementor',
	'incrementArrow',
	'decrementArrow',
	'incrementPage',
	'decrementPage',
	'valueIndicator',
	'growArea',
]);

/**
 * Roles that carry no meaning of their own and exist only to hold something else.
 *
 * Collapsed away by {@link pruneAxTree} when unlabelled, action-less, unfocused and holding exactly
 * one child. Depth in these trees is mostly layout scaffolding, and every level of it is another
 * ancestor whose insertion or removal can shift a structural path.
 */
const TRANSPARENT_CONTAINER_ROLES: ReadonlySet<string> = new Set([
	'group',
	'unknown',
	'layoutArea',
	'layoutItem',
	'splitGroup',
	'scrollArea',
]);

// ---------------------------------------------------------------------------------------------
// Delta shape
// ---------------------------------------------------------------------------------------------

/**
 * A snapshot of one application's accessibility tree, as far as the diff is concerned.
 *
 * Structurally satisfied by `ComputerUseAxTreeResult`, so a caller can pass a helper result
 * directly, but declared narrowly so this module never depends on the app or transport fields.
 */
export interface ComputerUseAxSnapshot {
	readonly nodes: readonly ComputerUseAxNode[];
	/** Sequence number of the snapshot, echoed into the delta so the model can see what it is against. */
	readonly generation: number;
}

/**
 * The fields the diff compares.
 *
 * `frame` is absent by design — see the module comment. `children` is absent because structural
 * change is expressed as added and removed nodes, not as a field of the parent.
 */
export type ComputerUseAxField = 'role' | 'label' | 'value' | 'enabled' | 'focused' | 'actions';

/** Every compared field, for exhaustive iteration in tests. */
export const COMPUTER_USE_AX_FIELDS: readonly ComputerUseAxField[] = [
	'role',
	'label',
	'value',
	'enabled',
	'focused',
	'actions',
];

/**
 * One field that differs between the baseline and the new snapshot.
 *
 * Values are pre-rendered to strings because that is the only form the model ever sees, and because
 * comparing rendered forms is what makes `actions: ['press']` and `actions: ['press']` equal
 * regardless of how the two helpers ordered them.
 */
export interface ComputerUseAxFieldChange {
	readonly field: ComputerUseAxField;
	/** Baseline value, or `undefined` when the field was absent then. */
	readonly from?: string;
	/** Current value, or `undefined` when the field is absent now. */
	readonly to?: string;
}

/** A node present in both snapshots whose compared fields differ. */
export interface ComputerUseAxChangedNode {
	/** Ref in the *new* snapshot — the one the caller must act on. */
	readonly ref: string;
	/**
	 * Ref the same node carried in the baseline, when the helper re-minted it.
	 *
	 * Present only for path matches. Surfacing it lets the caller invalidate whatever it had cached
	 * under the old ref instead of leaking a handle the helper will now reject.
	 */
	readonly previousRef?: string;
	readonly role: string;
	readonly label?: string;
	readonly changes: readonly ComputerUseAxFieldChange[];
}

/** A subtree that appeared. Reported at its root only; descendants come with it. */
export interface ComputerUseAxAddedNode {
	/**
	 * Ref of the nearest ancestor that survived from the baseline, or `undefined` at the top level.
	 *
	 * Without it the model is told a dialog appeared but not where, which is not actionable.
	 */
	readonly parentRef?: string;
	/** The whole new subtree, verbatim. */
	readonly node: ComputerUseAxNode;
}

/** A subtree that disappeared. Reported at its root only. */
export interface ComputerUseAxRemovedNode {
	/** Ref the node carried in the baseline. It is now stale by definition. */
	readonly ref: string;
	readonly role: string;
	readonly label?: string;
	/** Descendants that went with it, so the caller can weigh the loss without walking anything. */
	readonly descendantCount: number;
}

/**
 * Counts describing the comparison itself.
 *
 * `matchedByRef` versus `matchedByPath` is the health metric for the whole approach: a snapshot pair
 * that matched entirely by path means the helper is re-minting refs on every walk, and the diff is
 * therefore only as good as the structural fallback.
 */
export interface ComputerUseAxDeltaStats {
	/** Nodes in the baseline snapshot, after any pruning the caller applied. */
	readonly previousNodeCount: number;
	/** Nodes in the new snapshot, after any pruning the caller applied. */
	readonly nodeCount: number;
	/** Added nodes including the descendants carried along with each added root. */
	readonly addedNodeCount: number;
	/** Removed nodes including the descendants carried along with each removed root. */
	readonly removedNodeCount: number;
	readonly changedNodeCount: number;
	readonly unchangedNodeCount: number;
	readonly matchedByRef: number;
	readonly matchedByPath: number;
}

/** The complete difference between two snapshots. */
export interface ComputerUseAxDelta {
	readonly fromGeneration: number;
	readonly toGeneration: number;
	readonly added: readonly ComputerUseAxAddedNode[];
	readonly removed: readonly ComputerUseAxRemovedNode[];
	readonly changed: readonly ComputerUseAxChangedNode[];
	readonly stats: ComputerUseAxDeltaStats;
}

// ---------------------------------------------------------------------------------------------
// Flattening and keys
// ---------------------------------------------------------------------------------------------

/** A node plus everything the matcher needs about its place in the tree. Internal. */
interface IndexedAxNode {
	node: ComputerUseAxNode;
	/** Structural path key — see the module comment. */
	key: string;
	depth: number;
	/** Index of the parent in the flattened array, or -1 for a top-level node. */
	parent: number;
	/** Descendants below this node, filled in once its subtree has been walked. */
	subtreeSize: number;
}

/**
 * Flattens a tree in preorder, assigning each node its structural path key.
 *
 * Preorder matters: it makes "is my parent matched" answerable with an already-computed value, and
 * it gives the serializer a stable, human-readable order for free.
 */
function flattenAxTree(nodes: readonly ComputerUseAxNode[]): IndexedAxNode[] {
	const flat: IndexedAxNode[] = [];

	const walk = (list: readonly ComputerUseAxNode[], parentKey: string, parent: number, depth: number): void => {
		const occurrences = new Map<string, number>();
		for (const node of list) {
			const occurrence = occurrences.get(node.role) ?? 0;
			occurrences.set(node.role, occurrence + 1);
			const index = flat.length;
			const key = `${parentKey}/${node.role}[${occurrence}]`;
			flat.push({ node, key, depth, parent, subtreeSize: 0 });
			walk(node.children ?? [], key, index, depth + 1);
			flat[index].subtreeSize = flat.length - index - 1;
		}
	};

	walk(nodes, '', -1, 0);
	return flat;
}

/** Total nodes in a forest, including every descendant. */
export function countAxNodes(nodes: readonly ComputerUseAxNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1 + countAxNodes(node.children ?? []);
	}
	return total;
}

// ---------------------------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------------------------

/** True when a container has nothing of its own to say and merely wraps its single child. */
function isTransparentContainer(node: ComputerUseAxNode): boolean {
	return (
		TRANSPARENT_CONTAINER_ROLES.has(node.role) &&
		(node.label === undefined || node.label.length === 0) &&
		(node.value === undefined || node.value.length === 0) &&
		!node.focused &&
		(node.actions === undefined || node.actions.length === 0) &&
		(node.children?.length ?? 0) === 1
	);
}

/**
 * Removes churn and scaffolding before a diff.
 *
 * **Both snapshots must be pruned identically, or the diff is meaningless** — a node pruned on one
 * side and kept on the other reads as an insertion. The caller should therefore prune on the way
 * into its snapshot cache, never on the way out.
 *
 * Two transformations, both conservative. Scrollbar furniture is dropped with its subtree because it
 * is never a target and its value tracks the scroll offset. A transparent container holding exactly
 * one child is replaced by that child, because it contributes a path segment and nothing else.
 * Containers with several children are left alone: splicing them into the parent would renumber
 * their siblings, which is precisely the churn this is trying to avoid.
 */
export function pruneAxTree(nodes: readonly ComputerUseAxNode[]): readonly ComputerUseAxNode[] {
	const pruned: ComputerUseAxNode[] = [];
	for (const node of nodes) {
		if (NOISE_ROLES.has(node.role)) {
			continue;
		}
		let current: ComputerUseAxNode = node;
		// Collapse chains, not just single levels: layout scaffolding nests.
		while (isTransparentContainer(current)) {
			current = current.children![0];
			if (NOISE_ROLES.has(current.role)) {
				break;
			}
		}
		if (NOISE_ROLES.has(current.role)) {
			continue;
		}
		const children = pruneAxTree(current.children ?? []);
		pruned.push(children.length > 0 ? { ...current, children } : withoutChildren(current));
	}
	return pruned;
}

/** Drops an empty `children` array so pruned nodes compare cleanly against hand-written fixtures. */
function withoutChildren(node: ComputerUseAxNode): ComputerUseAxNode {
	if (node.children === undefined) {
		return node;
	}
	const { children, ...rest } = node;
	return rest;
}

// ---------------------------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------------------------

/** Normalizes an optional string field: an empty string and an absent field mean the same thing. */
function normalizeText(text: string | undefined): string | undefined {
	return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * Renders an action list into a comparable string.
 *
 * Sorted, because the two helpers enumerate a platform's actions in whatever order the platform
 * hands them over, and a pure ordering difference is not a change the model should be told about.
 */
function normalizeActions(actions: readonly string[] | undefined): string | undefined {
	if (actions === undefined || actions.length === 0) {
		return undefined;
	}
	return [...actions].sort().join(',');
}

/** Collects the compared fields that differ between a baseline node and its current counterpart. */
function compareAxNodes(before: ComputerUseAxNode, after: ComputerUseAxNode): ComputerUseAxFieldChange[] {
	const changes: ComputerUseAxFieldChange[] = [];

	const record = (field: ComputerUseAxField, from: string | undefined, to: string | undefined): void => {
		if (from !== to) {
			changes.push({ field, from, to });
		}
	};

	record('role', before.role, after.role);
	record('label', normalizeText(before.label), normalizeText(after.label));
	// A self-driving value is suppressed on both sides, so a spinner never dirties the tree.
	if (!VOLATILE_VALUE_ROLES.has(after.role) && !VOLATILE_VALUE_ROLES.has(before.role)) {
		record('value', normalizeText(before.value), normalizeText(after.value));
	}
	record('enabled', String(before.enabled), String(after.enabled));
	record('focused', String(before.focused), String(after.focused));
	record('actions', normalizeActions(before.actions), normalizeActions(after.actions));

	return changes;
}

// ---------------------------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------------------------

/**
 * Diffs two accessibility snapshots into a compact patch.
 *
 * Matching is the two-layer scheme documented at the top of this module: refs first, structural
 * paths for whatever is left, and a refusal to path-match a node whose ref turned up elsewhere.
 * Added and removed subtrees are reported at their roots only, so a sheet appearing eight levels
 * down costs a handful of entries rather than a whole window.
 *
 * The result is always internally consistent, but it is not always *useful* — pass it to
 * {@link assessAxDelta} before showing it to a model.
 */
export function diffAxTrees(
	previous: ComputerUseAxSnapshot,
	next: ComputerUseAxSnapshot,
): ComputerUseAxDelta {
	const before = flattenAxTree(previous.nodes);
	const after = flattenAxTree(next.nodes);

	const beforeByRef = new Map<string, number>();
	const beforeByKey = new Map<string, number>();
	for (let i = 0; i < before.length; i++) {
		const ref = before[i].node.ref;
		// First occurrence wins: a helper that minted a duplicate ref must not make the matcher
		// non-deterministic.
		if (ref.length > 0 && !beforeByRef.has(ref)) {
			beforeByRef.set(ref, i);
		}
		beforeByKey.set(before[i].key, i);
	}

	const afterRefs = new Set<string>();
	for (const entry of after) {
		if (entry.node.ref.length > 0) {
			afterRefs.add(entry.node.ref);
		}
	}

	/** For each node in the new snapshot, the baseline index it matched, or -1. */
	const matchOf: number[] = new Array(after.length).fill(-1);
	const consumed = new Set<number>();
	let matchedByRef = 0;
	let matchedByPath = 0;

	// Layer 1 — refs. Strongest evidence, so it runs to completion before paths get a look.
	for (let i = 0; i < after.length; i++) {
		const ref = after[i].node.ref;
		if (ref.length === 0) {
			continue;
		}
		const candidate = beforeByRef.get(ref);
		if (candidate !== undefined && !consumed.has(candidate)) {
			matchOf[i] = candidate;
			consumed.add(candidate);
			matchedByRef++;
		}
	}

	// Layer 2 — structural paths, for nodes whose ref was re-minted or absent.
	for (let i = 0; i < after.length; i++) {
		if (matchOf[i] !== -1) {
			continue;
		}
		const candidate = beforeByKey.get(after[i].key);
		if (candidate === undefined || consumed.has(candidate)) {
			continue;
		}
		// Refuse the guess when the candidate's ref is still live somewhere in the new snapshot: that
		// ref says where the node really went, and pairing it here would be a silent mismatch.
		const candidateRef = before[candidate].node.ref;
		if (candidateRef.length > 0 && afterRefs.has(candidateRef)) {
			continue;
		}
		matchOf[i] = candidate;
		consumed.add(candidate);
		matchedByPath++;
	}

	const changed: ComputerUseAxChangedNode[] = [];
	const added: ComputerUseAxAddedNode[] = [];
	let unchangedNodeCount = 0;
	let addedNodeCount = 0;

	for (let i = 0; i < after.length; i++) {
		const entry = after[i];
		const match = matchOf[i];

		if (match === -1) {
			// Only the topmost unmatched node is reported; its descendants ride along inside it.
			const parent = entry.parent;
			if (parent !== -1 && matchOf[parent] === -1) {
				continue;
			}
			added.push({
				parentRef: parent === -1 ? undefined : after[parent].node.ref,
				node: entry.node,
			});
			addedNodeCount += 1 + entry.subtreeSize;
			continue;
		}

		const baseline = before[match].node;
		const changes = compareAxNodes(baseline, entry.node);
		if (changes.length === 0) {
			unchangedNodeCount++;
			continue;
		}
		changed.push({
			ref: entry.node.ref,
			previousRef: baseline.ref === entry.node.ref ? undefined : baseline.ref,
			role: entry.node.role,
			label: normalizeText(entry.node.label),
			changes,
		});
	}

	const removed: ComputerUseAxRemovedNode[] = [];
	let removedNodeCount = 0;
	for (let j = 0; j < before.length; j++) {
		if (consumed.has(j)) {
			continue;
		}
		const parent = before[j].parent;
		if (parent !== -1 && !consumed.has(parent)) {
			continue;
		}
		const entry = before[j];
		removed.push({
			ref: entry.node.ref,
			role: entry.node.role,
			label: normalizeText(entry.node.label),
			descendantCount: entry.subtreeSize,
		});
		removedNodeCount += 1 + entry.subtreeSize;
	}

	return {
		fromGeneration: previous.generation,
		toGeneration: next.generation,
		added,
		removed,
		changed,
		stats: {
			previousNodeCount: before.length,
			nodeCount: after.length,
			addedNodeCount,
			removedNodeCount,
			changedNodeCount: changed.length,
			unchangedNodeCount,
			matchedByRef,
			matchedByPath,
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Size guard
// ---------------------------------------------------------------------------------------------

/** Why {@link assessAxDelta} reached its verdict. Machine-readable; never shown to a model verbatim. */
export type ComputerUseAxDeltaReason =
	/** Nothing changed at all. The cheapest and most valuable answer there is. */
	| 'unchanged'
	/** The delta is meaningfully smaller than the tree. Send it. */
	| 'smaller'
	/** There was no baseline to diff against, so the "delta" is just the whole tree relabelled. */
	| 'noBaseline'
	/**
	 * Not one node matched between the snapshots, so no correspondence exists and the patch cannot
	 * be interpreted as a change to anything the model has seen.
	 */
	| 'nothingMatched'
	/** The delta touches too much of the tree to be easier to read than the tree. */
	| 'notSmaller';

/** Whether a caller should send the delta or the whole tree. */
export interface ComputerUseAxDeltaAssessment {
	/** True when the delta is worth sending in place of the full tree. */
	readonly useDelta: boolean;
	readonly reason: ComputerUseAxDeltaReason;
	/** Nodes the delta describes, counting descendants of added and removed roots. */
	readonly deltaNodeCount: number;
	/** Nodes in the new snapshot. */
	readonly fullNodeCount: number;
	/** `deltaNodeCount / fullNodeCount`, or 0 when the new snapshot is empty. */
	readonly ratio: number;
}

/**
 * Decides whether a delta is an improvement on sending the whole tree.
 *
 * This is a real correctness concern, not an optimisation. A patch is only intelligible relative to
 * a baseline the model still remembers; once the patch covers most of the tree, the model is being
 * asked to reconstruct the present from a past it can no longer see, and it will get it wrong. When
 * this returns `useDelta: false` the caller must send the full tree — the delta is not a fallback,
 * it is the wrong answer.
 */
export function assessAxDelta(delta: ComputerUseAxDelta): ComputerUseAxDeltaAssessment {
	const { stats } = delta;
	const deltaNodeCount = stats.addedNodeCount + stats.removedNodeCount + stats.changedNodeCount;
	const fullNodeCount = stats.nodeCount;
	const ratio = fullNodeCount > 0 ? deltaNodeCount / fullNodeCount : 0;
	const base = { deltaNodeCount, fullNodeCount, ratio };

	if (stats.previousNodeCount === 0) {
		return { useDelta: false, reason: 'noBaseline', ...base };
	}
	if (deltaNodeCount === 0) {
		return { useDelta: true, reason: 'unchanged', ...base };
	}
	if (stats.matchedByRef + stats.matchedByPath === 0) {
		return { useDelta: false, reason: 'nothingMatched', ...base };
	}
	if (ratio > COMPUTER_USE_AX_DELTA_MAX_RATIO) {
		return { useDelta: false, reason: 'notSmaller', ...base };
	}
	return { useDelta: true, reason: 'smaller', ...base };
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

/** Rendered form of a delta, plus whether the line budget cut it short. */
export interface ComputerUseAxDeltaRender {
	readonly text: string;
	/** True when the line budget was hit; the caller should tell the model to re-read in full. */
	readonly truncated: boolean;
}

/**
 * Renders one node in the same dialect the full-tree listing uses.
 *
 * Matching that dialect exactly is free accuracy: the model then sees a single snapshot format
 * across every computer-use and browser tool, instead of having to learn a second one for deltas.
 * Bounds are included here — where the model needs to orient inside something newly appeared — even
 * though they are never compared.
 */
function describeAxNode(node: ComputerUseAxNode): string {
	const parts: string[] = [`[ref=${node.ref}] ${node.role}`];
	if (normalizeText(node.label) !== undefined) {
		parts.push(JSON.stringify(node.label));
	}
	if (normalizeText(node.value) !== undefined) {
		parts.push(`value=${JSON.stringify(node.value)}`);
	}
	if (!node.enabled) {
		parts.push('disabled');
	}
	if (node.focused) {
		parts.push('focused');
	}
	if (node.frame) {
		parts.push(
			`at=${Math.round(node.frame.x)},${Math.round(node.frame.y)} size=${Math.round(node.frame.width)}x${Math.round(node.frame.height)}`,
		);
	}
	if (node.actions && node.actions.length > 0) {
		parts.push(`actions=${node.actions.join(',')}`);
	}
	return parts.join(' ');
}

/** Renders a short identification of a node the model can no longer inspect. */
function describeAxStub(ref: string, role: string, label: string | undefined): string {
	return label === undefined ? `[ref=${ref}] ${role}` : `[ref=${ref}] ${role} ${JSON.stringify(label)}`;
}

/** Renders one field value, distinguishing an absent field from an empty string. */
function describeFieldValue(value: string | undefined): string {
	return value === undefined ? 'absent' : JSON.stringify(value);
}

/** Appends an added subtree, prefixing every line so the addition reads as one block. */
function appendAddedSubtree(node: ComputerUseAxNode, depth: number, lines: string[]): void {
	lines.push(`+ ${'  '.repeat(depth)}${describeAxNode(node)}`);
	for (const child of node.children ?? []) {
		appendAddedSubtree(child, depth + 1, lines);
	}
}

/**
 * Renders a delta as the text a model reads.
 *
 * Refs are preserved verbatim throughout, including on removed nodes: the model needs to recognize
 * that the ref it was about to act on is the one that just went away. Sections are ordered added,
 * changed, removed, and every section is in the preorder of the snapshot it came from, so the same
 * pair of snapshots always renders byte-identically.
 */
export function renderAxDelta(
	delta: ComputerUseAxDelta,
	options?: { readonly maxLines?: number },
): ComputerUseAxDeltaRender {
	const maxLines = options?.maxLines ?? COMPUTER_USE_AX_DELTA_MAX_LINES;
	const { stats } = delta;

	const header =
		`Accessibility changes since generation ${delta.fromGeneration} (now generation ${delta.toGeneration}): ` +
		`${stats.addedNodeCount} added, ${stats.removedNodeCount} removed, ${stats.changedNodeCount} changed, ` +
		`${stats.unchangedNodeCount} unchanged.`;

	const body: string[] = [];

	for (const entry of delta.added) {
		const rootLine = body.length;
		appendAddedSubtree(entry.node, 0, body);
		if (entry.parentRef !== undefined) {
			// Annotate the root of the block, not every line of it: the location is a property of the
			// insertion, and repeating it on each descendant would be pure noise.
			body[rootLine] += ` (appeared inside ref=${entry.parentRef})`;
		}
	}

	for (const entry of delta.changed) {
		const fields = entry.changes
			.map(change => `${change.field}: ${describeFieldValue(change.from)} -> ${describeFieldValue(change.to)}`)
			.join(', ');
		const previous = entry.previousRef === undefined ? '' : ` (was ref=${entry.previousRef})`;
		body.push(`~ ${describeAxStub(entry.ref, entry.role, entry.label)}${previous} ${fields}`);
	}

	for (const entry of delta.removed) {
		const carried = entry.descendantCount > 0 ? ` (with ${entry.descendantCount} descendants)` : '';
		body.push(`- ${describeAxStub(entry.ref, entry.role, entry.label)}${carried}`);
	}

	if (body.length === 0) {
		return { text: `${header}\nNothing on screen changed.`, truncated: false };
	}

	const truncated = body.length > maxLines;
	const kept = truncated ? body.slice(0, maxLines) : body;
	const lines = [header, ...kept];
	if (truncated) {
		lines.push(`... ${body.length - maxLines} more changes omitted. Re-read the screen in full.`);
	}
	return { text: lines.join('\n'), truncated };
}
