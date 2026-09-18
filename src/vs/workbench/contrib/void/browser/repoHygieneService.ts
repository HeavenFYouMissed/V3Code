/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Repo hygiene service — gathers the facts git knows about every worktree of the
 * current repo and executes the (few) safe actions. One implementation behind both the
 * agent tool (`repo_hygiene`) and the native "Tidy up worktrees" command, so the plan a
 * person sees in a quick pick and the plan the agent explains in chat are the same plan.
 *
 * Safety rules, enforced here regardless of caller:
 *   - never `--force` anything; a worktree git refuses to remove is reported, not forced
 *   - branches are only ever deleted with `git branch -d` (refuses unmerged), and only
 *     when the classifier said the branch is merged
 *   - pushes are plain `git push -u origin <branch>` from inside that worktree
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { buildHygienePlan, formatHygienePlan, HygieneItem, HygienePlan, parseForEachRef, parseMergedBranches, parseWorktreeList, parseWorktreeProbe, WorktreeFacts } from '../common/repoHygiene.js';
import { ITerminalToolService } from './terminalToolService.js';

export interface IRepoHygieneService {
	readonly _serviceBrand: undefined;
	/** Inventory + classification. Read-only: runs only `git worktree list`, `for-each-ref`,
	 *  `branch --merged`, and per-worktree `status --porcelain` / `rev-list --count`. */
	plan(): Promise<{ plan: HygienePlan; text: string }>;
	/** `git push -u origin <branch>` from inside the worktree. Never force. */
	push(item: HygieneItem): Promise<string>;
	/** `git worktree remove <path>` (no --force) then, only if the classifier marked the
	 *  branch deletable, `git branch -d <branch>` (refuses unmerged). */
	remove(item: HygieneItem): Promise<string>;
	/** `git worktree prune` — forgets records whose folders are already gone. */
	prune(): Promise<string>;
}

export const IRepoHygieneService = createDecorator<IRepoHygieneService>('repoHygieneService');

const GIT_TIMEOUT_SEC = 60;
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export class RepoHygieneService extends Disposable implements IRepoHygieneService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private _cwd(): string | null {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder?.uri.scheme === 'file' ? folder.uri.fsPath : null;
	}

	private async _git(cmd: string, cwd: string | null): Promise<string> {
		const { resPromise } = await this.terminalToolService.runCommand(cmd, { type: 'temporary', cwd, terminalId: generateUuid(), inactivityTimeoutSec: GIT_TIMEOUT_SEC });
		const { result, resolveReason } = await resPromise;
		const output = result.trim();
		if (resolveReason.type === 'timeout') {
			throw new Error(`\`${cmd}\` did not finish within ${GIT_TIMEOUT_SEC}s${resolveReason.mightBeWaitingForInput ? ' — it seems to be waiting for input (credentials?)' : ''}.${output ? `\n${output}` : ''}`);
		}
		if (resolveReason.type === 'done' && typeof resolveReason.exitCode === 'number' && resolveReason.exitCode !== 0) {
			throw new Error(`\`${cmd}\` failed (exit ${resolveReason.exitCode}).${output ? `\n${output}` : ''}`);
		}
		return output;
	}

	async plan(): Promise<{ plan: HygienePlan; text: string }> {
		const cwd = this._cwd();
		if (!cwd) { throw new Error('Open a folder that is a git repository first.'); }
		const worktreesOut = await this._git('git --no-pager worktree list --porcelain', cwd);
		const entries = parseWorktreeList(worktreesOut);
		if (entries.length === 0) { throw new Error('This folder does not look like a git repository (no worktrees reported).'); }
		const mainPath = entries[0].path;

		// Default branch: origin/HEAD when set, else main/master if they exist.
		let defaultBranch = 'main';
		try {
			const head = await this._git('git --no-pager symbolic-ref --short refs/remotes/origin/HEAD', mainPath);
			if (head) { defaultBranch = head.replace(/^origin\//, ''); }
		} catch {
			try { await this._git('git --no-pager rev-parse --verify --quiet master', mainPath); defaultBranch = 'master'; } catch { /* keep main */ }
		}
		const defaultRef = (await this._git(`git --no-pager rev-parse --verify --quiet ${q('origin/' + defaultBranch)} || echo`, mainPath)) ? `origin/${defaultBranch}` : defaultBranch;

		const refsOut = await this._git(`git --no-pager for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)' refs/heads`, mainPath);
		const refs = parseForEachRef(refsOut);
		let merged = new Set<string>();
		try { merged = parseMergedBranches(await this._git(`git --no-pager branch --merged ${q(defaultRef)} --format='%(refname:short)'`, mainPath)); } catch { /* no default ref yet */ }

		// One batched probe instead of two commands per worktree (100 worktrees would be ~200 spawns).
		const probeScript = entries.map(e => `echo "== ${e.path}"; echo "dirty $(git -C ${q(e.path)} status --porcelain 2>/dev/null | wc -l | tr -d ' ')"; ${e.branch ? `echo "ahead $(git -C ${q(e.path)} rev-list --count ${q(defaultRef)}..HEAD 2>/dev/null || echo)"` : 'echo "ahead "'}`).join('; ');
		const probe = parseWorktreeProbe(await this._git(probeScript, mainPath));

		const currentRoot = cwd.replace(/[\\/]+$/, '');
		const facts: WorktreeFacts[] = entries.map(e => {
			const ref = e.branch ? refs.get(e.branch) : undefined;
			const p = probe.get(e.path);
			return {
				...e,
				isCurrent: e.path.replace(/[\\/]+$/, '') === currentRoot,
				dirtyCount: p?.dirtyCount ?? 0,
				upstream: ref?.upstream ?? null,
				ahead: ref ? ref.ahead : null,
				behind: ref ? ref.behind : null,
				mergedIntoDefault: e.branch ? merged.has(e.branch) : false,
				aheadOfDefault: p?.aheadOfDefault ?? null,
				lastCommitUnix: ref?.committerUnix ?? null,
			};
		});
		const plan = buildHygienePlan(facts, defaultBranch, Date.now());
		this.logService.info(`[repoHygiene] ${plan.items.length} worktrees: ${Object.entries(plan.byBucket).map(([b, items]) => `${b}=${items.length}`).join(' ')}`);
		return { plan, text: formatHygienePlan(plan) };
	}

	async push(item: HygieneItem): Promise<string> {
		if (!item.facts.branch) { throw new Error('Cannot push a detached worktree.'); }
		if (!item.actions.includes('push')) { throw new Error(`"${item.facts.branch}" does not need a push.`); }
		const out = await this._git(`git --no-pager push -u origin ${q(item.facts.branch)}`, item.facts.path);
		return out || `Pushed ${item.facts.branch} to origin.`;
	}

	async remove(item: HygieneItem): Promise<string> {
		if (!item.actions.includes('remove')) { throw new Error(`"${item.facts.path}" is not safe to remove: ${item.reason}`); }
		if (item.actions.includes('push') && (item.facts.ahead ?? item.facts.aheadOfDefault ?? 0) > 0) {
			throw new Error(`"${item.facts.branch}" still has unpushed commits — push first.`);
		}
		const mainPath = this._cwd() ?? item.facts.path;
		// No --force, ever. If git refuses (changes appeared since the plan), say so.
		const out = await this._git(`git --no-pager worktree remove ${q(item.facts.path)}`, mainPath);
		let branchNote = '';
		if (item.branchDeletable && item.facts.branch) {
			try {
				await this._git(`git --no-pager branch -d ${q(item.facts.branch)}`, mainPath); // -d refuses unmerged
				branchNote = ` Deleted branch ${item.facts.branch} (it was merged).`;
			} catch (e) {
				branchNote = ` Kept branch ${item.facts.branch} (git would not confirm it is merged: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}).`;
			}
		}
		return `${out || `Removed worktree ${item.facts.path}.`}${branchNote}`;
	}

	async prune(): Promise<string> {
		const out = await this._git('git --no-pager worktree prune -v', this._cwd());
		return out || 'Nothing to prune.';
	}
}

registerSingleton(IRepoHygieneService, RepoHygieneService, InstantiationType.Delayed);
