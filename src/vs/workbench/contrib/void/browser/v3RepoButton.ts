/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3 Repo pill — repo/branch control in the titlebar.
 *
 * Shows the current git branch (falls back to the workspace folder name, or
 * "Open Folder" when nothing is open). Click opens a dropdown with repo-level
 * actions: Open Folder, Clone Git Repository, Connect Remote Host, Open Recent.
 *
 * Always visible (not gated on v3-agent-mode). Same runtime <style> injection +
 * MutationObserver re-mount pattern as v3SoloTabs.ts.
 *
 * Branch label sources, in priority order:
 *   1. ISCMViewService.activeRepository → historyProvider → historyItemRef.name (live git branch)
 *   2. first workspace folder name
 *   3. "Open Folder"
 */

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ISCMViewService } from '../../scm/common/scm.js';

const STYLE_ELEMENT_ID = 'v3-repo-button-styles';

const STYLES = `
.monaco-workbench .titlebar-left .v3-repo-pill {
	display: inline-flex; align-items: center; height: 24px;
	margin: 0 6px 0 0; padding: 0 10px; border-radius: 8px; gap: 6px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.08);
	box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.15);
	color: var(--vscode-foreground, #dddddd);
	font-size: 12px; font-weight: 500; letter-spacing: 0.1px;
	cursor: pointer; -webkit-app-region: no-drag; user-select: none; flex: 0 0 auto;
	max-width: 280px;
	transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
}
.monaco-workbench .titlebar-left .v3-repo-pill:hover {
	color: var(--vscode-foreground, #ffffff);
	background: rgba(255, 255, 255, 0.1);
	border-color: rgba(255, 255, 255, 0.14);
}
.monaco-workbench .titlebar-left .v3-repo-pill .codicon {
	font-size: 13px; flex: 0 0 auto; opacity: 0.85;
}
.monaco-workbench .titlebar-left .v3-repo-pill .v3-repo-pill-label {
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.monaco-workbench .titlebar-left .v3-repo-pill .v3-repo-pill-branch {
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	opacity: 0.55; font-weight: 400; max-width: 110px;
}
`;

function injectStyles(): void {
	const doc = mainWindow.document;
	if (doc.getElementById(STYLE_ELEMENT_ID)) { return; }
	const style = doc.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

class V3RepoButtonContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3RepoButton';

	private _pill: HTMLElement | undefined;
	private _labelEl: HTMLElement | undefined;
	private _branchEl: HTMLElement | undefined;
	private _iconEl: HTMLElement | undefined;
	private _branchName: string | undefined;
	private readonly _reinjectObserver = this._register(new MutableDisposable());

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		injectStyles();
		this._ensurePill();
		this._observeTitleBar();

		// Live branch tracking: autorun re-fires whenever any observable in the
		// chain changes (active repo swap, history provider init, branch checkout).
		this._register(autorun(reader => {
			const active = this.scmViewService.activeRepository.read(reader);
			const historyProvider = active?.repository.provider.historyProvider.read(reader);
			const ref = historyProvider?.historyItemRef.read(reader);
			this._branchName = ref?.name;
			this._renderLabel();
		}));

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._renderLabel()));
	}

	// --- DOM -----------------------------------------------------------------

	private _observeTitleBar(): void {
		const observer = new MutationObserver(() => {
			if (!this._pill || !this._pill.isConnected) {
				this._ensurePill();
			}
		});
		observer.observe(mainWindow.document.body, { childList: true, subtree: true });
		this._reinjectObserver.value = { dispose: () => observer.disconnect() };
	}

	private _ensurePill(): void {
		const titlebarLeft = mainWindow.document.querySelector('.titlebar-left') as HTMLElement | null;
		if (!titlebarLeft) { return; }
		if (this._pill && this._pill.isConnected) { return; }

		const pill = $('div.v3-repo-pill');
		pill.setAttribute('role', 'button');
		pill.setAttribute('aria-label', localize('v3RepoButton.aria', 'Repository and branch actions'));

		// Folder-first pill (Cursor-style) — replaces the inert centered window-title text.
		this._iconEl = append(pill, $('span.codicon.codicon-folder'));
		this._labelEl = append(pill, $('span.v3-repo-pill-label'));
		this._branchEl = append(pill, $('span.v3-repo-pill-branch'));

		this._register(addDisposableListener(pill, EventType.CLICK, () => this._showMenu(pill)));

		// Mount right after the solo tabs / mode pill when present, else at the front.
		const anchor = titlebarLeft.querySelector('.v3-solo-tabs')
			?? titlebarLeft.querySelector('.v3-mode-pill');
		if (anchor && anchor.nextSibling) {
			titlebarLeft.insertBefore(pill, anchor.nextSibling);
		} else if (anchor) {
			titlebarLeft.appendChild(pill);
		} else {
			titlebarLeft.insertBefore(pill, titlebarLeft.firstChild);
		}

		this._pill = pill;
		this._renderLabel();
	}

	private _renderLabel(): void {
		if (!this._labelEl || !this._iconEl || !this._branchEl) { return; }

		const folderName = this.workspaceContextService.getWorkspace().folders[0]?.name;
		// Prefer folder name (what Cursor shows); branch is a muted suffix when known.
		this._labelEl.textContent = folderName ?? this._branchName ?? localize('v3RepoButton.openFolder', "Open Folder");
		this._iconEl.className = 'codicon codicon-folder';
		if (folderName && this._branchName) {
			this._branchEl.textContent = this._branchName;
			this._branchEl.style.display = '';
		} else {
			this._branchEl.textContent = '';
			this._branchEl.style.display = 'none';
		}
		this._pill!.title = this._branchName
			? localize('v3RepoButton.titleBranch', "On branch {0} — click for repository actions", this._branchName)
			: localize('v3RepoButton.titleNoBranch', "Repository actions");
	}

	// --- Menu ----------------------------------------------------------------

	private _showMenu(anchor: HTMLElement): void {
		const run = (commandId: string) => {
			this.commandService.executeCommand(commandId).then(undefined, err => {
				this.logService.error(`[v3RepoButton] command ${commandId} failed`, err);
			});
		};

		const actions: IAction[] = [];

		actions.push(toAction({
			id: 'v3code.repoButton.openFolder',
			label: localize('v3RepoButton.menu.openFolder', "Open Folder…"),
			run: () => run(isMacintosh ? 'workbench.action.files.openFileFolder' : 'workbench.action.files.openFolder'),
		}));

		actions.push(toAction({
			id: 'v3code.repoButton.cloneRepo',
			label: localize('v3RepoButton.menu.cloneRepo', "Clone Git Repository…"),
			run: () => run('git.clone'),
		}));

		// Remote menu is contributed by the remote indicator — omit when not present
		// (e.g. remote extension points disabled in this build).
		if (CommandsRegistry.getCommand('workbench.action.remote.showMenu')) {
			actions.push(toAction({
				id: 'v3code.repoButton.connectRemote',
				label: localize('v3RepoButton.menu.connectRemote', "Connect to Remote Host…"),
				run: () => run('workbench.action.remote.showMenu'),
			}));
		}

		actions.push(new Separator());

		actions.push(toAction({
			id: 'v3code.repoButton.openRecent',
			label: localize('v3RepoButton.menu.openRecent', "Open Recent…"),
			run: () => run('workbench.action.openRecent'),
		}));

		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	override dispose(): void {
		this._pill?.remove();
		super.dispose();
	}
}

registerWorkbenchContribution2(V3RepoButtonContribution.ID, V3RepoButtonContribution, WorkbenchPhase.AfterRestored);
