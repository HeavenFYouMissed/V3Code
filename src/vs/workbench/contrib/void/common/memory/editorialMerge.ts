/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { EditorialBranch } from './memoryTypes.js';

/**
 * Merge the workspace editorial store with a thread's carried anchors for the
 * briefing/search readers. Since remember_editorial dual-writes (workspace store +
 * thread anchor), the same topic exists twice with different ids; deduping by id alone
 * listed identical content twice.
 *
 * Rule: same name → prefer the WORKSPACE copy (the durable canonical store), keeping a
 * carried anchor only when the workspace has no branch of that name — EXCEPT a carried
 * branch decorated with cross-workspace provenance (originWorkspaceId), which is a
 * genuinely different branch imported from another workspace and must stay visible.
 */
export function mergeEditorialBranches(
	workspaceBranches: readonly EditorialBranch[],
	carriedBranches: readonly (EditorialBranch & { originWorkspaceId?: string })[],
): EditorialBranch[] {
	const byId = new Map<string, EditorialBranch>();
	const workspaceNames = new Set(workspaceBranches.map(branch => branch.name));
	for (const branch of workspaceBranches) byId.set(branch.id, branch);
	for (const branch of carriedBranches) {
		if (workspaceNames.has(branch.name) && !branch.originWorkspaceId) continue;
		byId.set(branch.id, branch);
	}
	return [...byId.values()].sort((a, b) => b.tsUpdated - a.tsUpdated);
}

export function formatEditorialBranchForTool(b: Pick<EditorialBranch, 'id' | 'name' | 'miniReadme' | 'worked' | 'didntWork' | 'buildNotes' | 'confidence'> & { originRoot?: string }): string {
	const carried = b.originRoot ? ` — carried with this thread from ${b.originRoot}` : '';
	const parts = [`### ${b.name} [${b.id}] (confidence ${b.confidence.toFixed(2)})${carried}`];
	if (b.miniReadme) parts.push(b.miniReadme);
	if (b.worked) parts.push(`Worked:\n${b.worked}`);
	if (b.didntWork) parts.push(`Didn't work:\n${b.didntWork}`);
	if (b.buildNotes) parts.push(`Build notes:\n${b.buildNotes}`);
	return parts.join('\n\n');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render the editorial briefing HONESTLY. The old text keyed "No editorial project filed
 * yet for this workspace" purely on the workspace project being absent and returned
 * before looking at `branches` — but after a workspace swap the branches carried with
 * the thread are exactly what's there, so the briefing said "empty" while
 * search_editorial returned them. An agent trusting the briefing started cold with four
 * topics sitting right there. Now: carried branches are always listed and labelled with
 * their origin, and the briefing says plainly what does NOT carry (workspace-level
 * auto-topics, per-workspace chat history) so a partial carry is visible, never silent.
 */
export function formatEditorialBriefing(
	result: { projectId: string | null; projectName: string; readme: string; branches: readonly EditorialBranch[] },
	folderName: string | undefined,
): string {
	const carried = result.branches.filter(branch => !!branch.originRoot);
	const origins = [...new Set(carried.map(branch => branch.originRoot!))];
	const carryNote = carried.length > 0
		? `\n\n${carried.length} branch(es) carried with this thread from ${origins.join(', ')}. Only editorial written in this thread carries across workspaces; workspace-level auto-topics (roadmap, hot-files, quirks, decisions, symbols) and chat history are per-workspace and stay behind — use recover_session_anchors if this thread's history seems incomplete.`
		: '';
	const branchList = result.branches.length
		? `\n\n${result.branches.map(formatEditorialBranchForTool).join('\n\n---\n\n')}`
		: '\n\n(no branches yet)';

	if (!result.projectId) {
		if (result.branches.length === 0) {
			return 'No editorial project filed yet for this workspace. Editorial rows appear after chat rollup (diff/decision events → ws_facts → fileToEditorial).';
		}
		return `No editorial project filed yet for THIS workspace, but ${result.branches.length} branch(es) are available to this thread:${carryNote}${branchList}`;
	}
	// Existing rows may have been filed before the folder-name fix, so the stored name /
	// readme title can still be a bare wsId UUID. Heal it at render time with the real
	// folder name until the next rollup overwrites the row.
	const rawName = (result.projectName ?? '').trim();
	const displayName = (!rawName || UUID_RE.test(rawName)) && folderName ? folderName : (rawName || folderName || '(unnamed)');
	const header = `Editorial project: ${displayName} [${result.projectId}] — ${result.branches.length} branch(es)`;
	let readmeBody = result.readme ?? '';
	if (readmeBody && folderName) {
		readmeBody = readmeBody.replace(/^#\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im, `# ${folderName}`);
	}
	const readme = readmeBody ? `\n\n## Readme\n${readmeBody}` : '';
	return header + carryNote + readme + branchList;
}
