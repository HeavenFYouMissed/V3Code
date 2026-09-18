/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Repo hygiene — worktrees and branches, explained in plain language and handled
 * OVERLY cautiously. People accumulate dozens of agent-made worktrees and are then
 * stumped by "push / cherry-pick / save N worktrees before deletion". This module is the
 * pure, testable heart: parse what git reports, put every worktree in exactly one bucket
 * with a one-line reason a non-git person understands, and never propose anything that
 * could lose work. Executing is the service's job; nothing here touches git.
 */

export interface WorktreeEntry {
	path: string;
	head: string;
	/** Short branch name, or null when HEAD is detached. */
	branch: string | null;
	isMain: boolean;
	locked: boolean;
	/** git says the directory is gone — `git worktree prune` would drop the record. */
	prunable: boolean;
}

export interface BranchFacts {
	upstream: string | null;
	ahead: number;
	behind: number;
	committerUnix: number | null;
}

export interface WorktreeFacts extends WorktreeEntry {
	isCurrent: boolean;
	dirtyCount: number;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	mergedIntoDefault: boolean;
	/** Commits on this branch that are not on the default branch (null = unknown). */
	aheadOfDefault: number | null;
	lastCommitUnix: number | null;
}

export type HygieneBucket = 'keep' | 'safe-to-remove' | 'push-first' | 'has-unsaved-work' | 'prunable';

export interface HygieneItem {
	facts: WorktreeFacts;
	bucket: HygieneBucket;
	/** One plain sentence — the WHY, no git jargon where avoidable. */
	reason: string;
	/** What the user may do about it, in the order it must happen. Empty = leave alone. */
	actions: Array<'push' | 'remove' | 'prune'>;
	/** True when the branch may also be deleted after the worktree is removed (merged only —
	 *  we only ever use `git branch -d`, which refuses anything unmerged). */
	branchDeletable: boolean;
}

export const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;

// ---- parsers -------------------------------------------------------------------------

/** `git worktree list --porcelain` */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> | null = null;
	const flush = () => {
		if (current?.path) {
			entries.push({
				path: current.path,
				head: current.head ?? '',
				branch: current.branch ?? null,
				isMain: entries.length === 0,
				locked: current.locked ?? false,
				prunable: current.prunable ?? false,
			});
		}
		current = null;
	};
	for (const rawLine of porcelain.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (line.startsWith('worktree ')) { flush(); current = { path: line.slice('worktree '.length).trim() }; continue; }
		if (!current) { continue; }
		if (line.startsWith('HEAD ')) { current.head = line.slice(5).trim(); }
		else if (line.startsWith('branch ')) { current.branch = line.slice(7).trim().replace(/^refs\/heads\//, ''); }
		else if (line === 'detached') { current.branch = null; }
		else if (line.startsWith('locked')) { current.locked = true; }
		else if (line.startsWith('prunable')) { current.prunable = true; }
		else if (line === '') { flush(); }
	}
	flush();
	return entries;
}

/** `git for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)' refs/heads` */
export function parseForEachRef(out: string): Map<string, BranchFacts> {
	const map = new Map<string, BranchFacts>();
	for (const rawLine of out.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line.trim()) { continue; }
		const [name, upstream, track, date] = line.split('\t');
		if (!name) { continue; }
		const ahead = /ahead (\d+)/.exec(track ?? '');
		const behind = /behind (\d+)/.exec(track ?? '');
		map.set(name.trim(), {
			upstream: upstream?.trim() ? upstream.trim() : null,
			ahead: ahead ? Number(ahead[1]) : 0,
			behind: behind ? Number(behind[1]) : 0,
			committerUnix: date && /^\d+$/.test(date.trim()) ? Number(date.trim()) : null,
		});
	}
	return map;
}

/** `git branch --merged <default> --format=%(refname:short)` */
export function parseMergedBranches(out: string): Set<string> {
	return new Set(out.split('\n').map(l => l.replace(/^[*+ ]+/, '').trim()).filter(Boolean));
}

/** Our batched probe: for every worktree path, `== <path>` then a count line
 *  (`git -C <path> status --porcelain | wc -l`) then `ahead <n>` (rev-list count vs default). */
export function parseWorktreeProbe(out: string): Map<string, { dirtyCount: number; aheadOfDefault: number | null }> {
	const map = new Map<string, { dirtyCount: number; aheadOfDefault: number | null }>();
	let current: string | null = null;
	for (const rawLine of out.split('\n')) {
		const line = rawLine.replace(/\r$/, '').trim();
		if (line.startsWith('== ')) { current = line.slice(3).trim(); map.set(current, { dirtyCount: 0, aheadOfDefault: null }); continue; }
		if (!current) { continue; }
		const entry = map.get(current)!;
		if (/^dirty \d+$/.test(line)) { entry.dirtyCount = Number(line.slice(6)); }
		else if (/^ahead \d+$/.test(line)) { entry.aheadOfDefault = Number(line.slice(6)); }
	}
	return map;
}

// ---- classification ------------------------------------------------------------------

export function classifyWorktree(facts: WorktreeFacts, now: number): HygieneItem {
	const name = facts.branch ?? '(detached)';
	if (facts.prunable) {
		return { facts, bucket: 'prunable', reason: `The folder is gone; only git's record of it is left. Pruning just forgets the record — nothing is deleted.`, actions: ['prune'], branchDeletable: false };
	}
	if (facts.isMain) {
		return { facts, bucket: 'keep', reason: 'This is the main checkout of the repo.', actions: [], branchDeletable: false };
	}
	if (facts.isCurrent) {
		return { facts, bucket: 'keep', reason: 'You are working in this one right now.', actions: [], branchDeletable: false };
	}
	if (facts.dirtyCount > 0) {
		return { facts, bucket: 'has-unsaved-work', reason: `${facts.dirtyCount} file(s) have uncommitted changes. Nothing is touched until you commit or stash them.`, actions: [], branchDeletable: false };
	}
	if (facts.branch === null) {
		return { facts, bucket: 'keep', reason: 'Not on a branch (detached). Needs a human look before anything is removed.', actions: [], branchDeletable: false };
	}
	if (facts.locked) {
		return { facts, bucket: 'keep', reason: 'Git has this worktree locked; something is using it.', actions: [], branchDeletable: false };
	}
	const recent = facts.lastCommitUnix !== null && (now - facts.lastCommitUnix * 1000) < RECENT_ACTIVITY_MS;
	if (facts.upstream) {
		if ((facts.ahead ?? 0) > 0) {
			return { facts, bucket: 'push-first', reason: `${facts.ahead} commit(s) on "${name}" exist only on this computer. Push first so they are safe; then it can go.`, actions: ['push', 'remove'], branchDeletable: facts.mergedIntoDefault };
		}
		if (recent && !facts.mergedIntoDefault) {
			return { facts, bucket: 'keep', reason: `"${name}" had commits in the last day and is not merged yet — keeping it out of the way for now.`, actions: [], branchDeletable: false };
		}
		return {
			facts, bucket: 'safe-to-remove',
			reason: facts.mergedIntoDefault
				? `"${name}" is merged and fully pushed — the worktree folder is a copy you no longer need.`
				: `Everything on "${name}" is pushed to ${facts.upstream}; removing the folder loses nothing (the branch stays).`,
			actions: ['remove'], branchDeletable: facts.mergedIntoDefault,
		};
	}
	// No upstream at all.
	if (facts.mergedIntoDefault) {
		return { facts, bucket: 'safe-to-remove', reason: `"${name}" was never pushed, but all of its commits are already in the default branch — nothing would be lost.`, actions: ['remove'], branchDeletable: true };
	}
	if ((facts.aheadOfDefault ?? 1) === 0) {
		return { facts, bucket: 'safe-to-remove', reason: `"${name}" has no commits of its own beyond the default branch.`, actions: ['remove'], branchDeletable: true };
	}
	return { facts, bucket: 'push-first', reason: `"${name}" was never pushed and has ${facts.aheadOfDefault ?? 'some'} commit(s) not in the default branch. Push it first so nothing is lost; then it can go.`, actions: ['push', 'remove'], branchDeletable: false };
}

export interface HygienePlan {
	items: HygieneItem[];
	byBucket: Record<HygieneBucket, HygieneItem[]>;
	defaultBranch: string;
}

export function buildHygienePlan(facts: readonly WorktreeFacts[], defaultBranch: string, now: number): HygienePlan {
	const items = facts.map(f => classifyWorktree(f, now));
	const byBucket: Record<HygieneBucket, HygieneItem[]> = { 'keep': [], 'safe-to-remove': [], 'push-first': [], 'has-unsaved-work': [], 'prunable': [] };
	for (const item of items) { byBucket[item.bucket].push(item); }
	return { items, byBucket, defaultBranch };
}

const shortPath = (p: string): string => p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;

/** Plain-language plan, the way a careful colleague would explain it. */
export function formatHygienePlan(plan: HygienePlan): string {
	const total = plan.items.length;
	const lines: string[] = [`${total} worktree(s) found (default branch: ${plan.defaultBranch}).`];
	const section = (title: string, items: HygieneItem[]) => {
		if (items.length === 0) { return; }
		lines.push('', `${title} (${items.length}):`);
		for (const item of items) {
			lines.push(`- ${shortPath(item.facts.path)}${item.facts.branch ? ` [${item.facts.branch}]` : ''} — ${item.reason}`);
		}
	};
	section('SAFE TO REMOVE — nothing would be lost', plan.byBucket['safe-to-remove']);
	section('NEEDS A PUSH FIRST — commits only on this computer', plan.byBucket['push-first']);
	section('HAS UNSAVED CHANGES — leave alone until committed or stashed', plan.byBucket['has-unsaved-work']);
	section('STALE RECORDS — folder already gone, safe to prune', plan.byBucket['prunable']);
	section('KEEP', plan.byBucket['keep']);
	lines.push('', 'Nothing is ever force-deleted: a worktree with uncommitted changes is skipped, branches are only deleted when git agrees they are merged, and every step asks first.');
	return lines.join('\n');
}
