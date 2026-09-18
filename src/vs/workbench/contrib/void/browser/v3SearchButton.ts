/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3 Search pill — dedicated search control in the titlebar.
 *
 * Sits after the repo pill (v3RepoButton.ts) in `.titlebar-left`. Click opens the
 * quick-open picker with mode switching (`workbench.action.quickOpenWithModes` —
 * files / symbols / commands), same surface the native command center exposes.
 * It does NOT replace the command center; it is an always-visible affordance.
 *
 * Same runtime <style> injection + MutationObserver re-mount pattern as
 * v3SoloTabs.ts — the titlebar is re-rendered on layout changes, so the pill
 * re-inserts itself whenever it gets disconnected.
 */

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const STYLE_ELEMENT_ID = 'v3-search-button-styles';

const STYLES = `
.monaco-workbench .titlebar-left .v3-search-pill {
	display: inline-flex; align-items: center; height: 22px;
	margin: 0 4px 0 0; padding: 0 10px; border-radius: 6px; gap: 5px;
	background: rgba(255, 255, 255, 0.045);
	border: 1px solid rgba(255, 255, 255, 0.06);
	box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.15);
	color: var(--vscode-descriptionForeground, #9599a6);
	font-size: 11px; font-weight: 500; letter-spacing: 0.2px;
	cursor: pointer; -webkit-app-region: no-drag; user-select: none; flex: 0 0 auto;
	transition: background 160ms ease, color 160ms ease;
}
.monaco-workbench .titlebar-left .v3-search-pill:hover {
	color: var(--vscode-foreground, #dddddd);
	background: rgba(255, 255, 255, 0.07);
}
.monaco-workbench .titlebar-left .v3-search-pill .codicon {
	font-size: 12px;
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

class V3SearchButtonContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3SearchButton';

	private _pill: HTMLElement | undefined;
	private readonly _reinjectObserver = this._register(new MutableDisposable());

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		injectStyles();
		this._ensurePill();
		this._observeTitleBar();
	}

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

		const pill = $('div.v3-search-pill');
		pill.setAttribute('role', 'button');
		pill.setAttribute('aria-label', localize('v3SearchButton.aria', 'Search files, symbols, and commands'));
		pill.title = localize('v3SearchButton.title', "Search files, symbols, and commands");

		append(pill, $('span.codicon.codicon-search'));
		const label = append(pill, $('span'));
		label.textContent = localize('v3SearchButton.label', "Search");

		this._register(addDisposableListener(pill, EventType.CLICK, () => {
			this.commandService.executeCommand('workbench.action.quickOpenWithModes').then(undefined, err => {
				this.logService.error('[v3SearchButton] quickOpenWithModes failed', err);
			});
		}));

		// Mount after the repo pill when present, else after the solo tabs / mode
		// pill, else at the front. Both this and v3RepoButton anchor relative to
		// what exists at mount time, so the final order converges to:
		// mode pill → solo tabs → repo → search regardless of who mounts first.
		const anchor = titlebarLeft.querySelector('.v3-repo-pill')
			?? titlebarLeft.querySelector('.v3-solo-tabs')
			?? titlebarLeft.querySelector('.v3-mode-pill');
		if (anchor && anchor.nextSibling) {
			titlebarLeft.insertBefore(pill, anchor.nextSibling);
		} else if (anchor) {
			titlebarLeft.appendChild(pill);
		} else {
			titlebarLeft.insertBefore(pill, titlebarLeft.firstChild);
		}

		this._pill = pill;
	}

	override dispose(): void {
		this._pill?.remove();
		super.dispose();
	}
}

registerWorkbenchContribution2(V3SearchButtonContribution.ID, V3SearchButtonContribution, WorkbenchPhase.AfterRestored);
