/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * "V3Code: Tidy up worktrees" — the editor handles worktree cleanup for people who
 * should never have to learn what a worktree is. Plain-language plan, pick what to do,
 * one confirmation per step, nothing ever forced. Same service and same rules as the
 * agent's `repo_hygiene` tool.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { HygieneItem } from '../common/repoHygiene.js';
import { IRepoHygieneService } from './repoHygieneService.js';

const CATEGORY = localize2('v3code.category', 'V3Code');

interface HygienePick extends IQuickPickItem { item?: HygieneItem; prune?: boolean }

const shortPath = (p: string): string => p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'v3code.repoHygiene',
			title: localize2('v3code.repoHygiene', 'V3Code: Tidy Up Worktrees & Branches'),
			category: CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const hygiene = accessor.get(IRepoHygieneService);
		const quickInput = accessor.get(IQuickInputService);
		const dialogs = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);

		let plan;
		try {
			plan = (await hygiene.plan()).plan;
		} catch (e) {
			notifications.error(localize('v3code.repoHygiene.failed', "Could not read the repository: {0}", e instanceof Error ? e.message : String(e)));
			return;
		}

		const picks: Array<HygienePick | IQuickPickSeparator> = [];
		const addGroup = (label: string, items: HygieneItem[], describe: (i: HygieneItem) => string) => {
			if (items.length === 0) { return; }
			picks.push({ type: 'separator', label });
			for (const item of items) {
				picks.push({ label: `${shortPath(item.facts.path)}${item.facts.branch ? `  [${item.facts.branch}]` : ''}`, description: describe(item), detail: item.reason, item, picked: false });
			}
		};
		addGroup(localize('v3code.repoHygiene.safe', "Safe to remove — nothing would be lost"), plan.byBucket['safe-to-remove'], () => localize('v3code.repoHygiene.remove', "remove folder"));
		addGroup(localize('v3code.repoHygiene.pushFirst', "Needs a push first — commits only on this computer"), plan.byBucket['push-first'], () => localize('v3code.repoHygiene.pushThenRemove', "push, then remove folder"));
		if (plan.byBucket['prunable'].length > 0) {
			picks.push({ type: 'separator', label: localize('v3code.repoHygiene.stale', "Stale records — folders already gone") });
			picks.push({ label: localize('v3code.repoHygiene.pruneLabel', "Forget {0} stale record(s)", plan.byBucket['prunable'].length), detail: localize('v3code.repoHygiene.pruneDetail', "Nothing is deleted — git just stops listing folders that no longer exist."), prune: true });
		}

		const unsaved = plan.byBucket['has-unsaved-work'].length;
		const kept = plan.byBucket['keep'].length;
		if (picks.length === 0) {
			notifications.info(localize('v3code.repoHygiene.nothing', "Nothing to tidy: {0} worktree(s) kept{1}.", kept, unsaved ? localize('v3code.repoHygiene.unsavedNote', ", {0} with unsaved changes left alone", unsaved) : ''));
			return;
		}

		const chosen = await quickInput.pick(picks, {
			canPickMany: true,
			placeHolder: localize('v3code.repoHygiene.placeholder', "Pick what to tidy — each step asks before it runs. {0} kept, {1} with unsaved changes are not listed (leave those alone).", kept, unsaved),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!chosen || chosen.length === 0) { return; }

		const results: string[] = [];
		for (const pick of chosen) {
			try {
				if (pick.prune) {
					const ok = await dialogs.confirm({ message: localize('v3code.repoHygiene.confirmPrune', "Forget the stale worktree records?"), detail: localize('v3code.repoHygiene.confirmPruneDetail', "Runs `git worktree prune`. No files are deleted."), primaryButton: localize('v3code.repoHygiene.pruneBtn', "Forget them") });
					if (ok.confirmed) { results.push(await hygiene.prune()); }
					continue;
				}
				const item = pick.item!;
				const name = item.facts.branch ?? shortPath(item.facts.path);
				if (item.actions.includes('push')) {
					const ok = await dialogs.confirm({ message: localize('v3code.repoHygiene.confirmPush', "Push \"{0}\" to origin?", name), detail: localize('v3code.repoHygiene.confirmPushDetail', "{0}\n\nRuns `git push -u origin {1}` — a plain push, nothing rewritten.", item.reason, name), primaryButton: localize('v3code.repoHygiene.pushBtn', "Push") });
					if (!ok.confirmed) { results.push(`Skipped ${name}.`); continue; }
					results.push(await hygiene.push(item));
					item.actions = item.actions.filter(a => a !== 'push');
					if (item.facts.ahead !== null) { item.facts.ahead = 0; }
					item.facts.aheadOfDefault = null;
				}
				if (item.actions.includes('remove')) {
					const ok = await dialogs.confirm({ message: localize('v3code.repoHygiene.confirmRemove', "Remove the worktree folder \"{0}\"?", shortPath(item.facts.path)), detail: localize('v3code.repoHygiene.confirmRemoveDetail', "{0}\n\nRuns `git worktree remove` without --force; if git finds anything unsaved it refuses and nothing happens.{1}", item.reason, item.branchDeletable ? localize('v3code.repoHygiene.branchNote', " The merged branch \"{0}\" is deleted afterwards with the safe `-d` flag.", name) : ''), primaryButton: localize('v3code.repoHygiene.removeBtn', "Remove") });
					if (!ok.confirmed) { results.push(`Skipped ${name}.`); continue; }
					results.push(await hygiene.remove(item));
				}
			} catch (e) {
				results.push(`${pick.label}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
			}
		}
		notifications.notify({ severity: Severity.Info, message: localize('v3code.repoHygiene.done', "Tidy-up finished:\n{0}", results.join('\n')), sticky: true });
	}
});
