/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3 Profile button — avatar + dropdown in the titlebar right side.
 *
 * Avatar is a "V" monogram placeholder (no real accounts in v1 — the account
 * stub service always reports a signed-out Guest). The dropdown is a custom DOM
 * popover (not IContextMenuService) for screenshot fidelity: header with name +
 * tier badge, then action rows.
 *
 * Rows: Manage Account · Theme · Check for Updates · Help/Docs · Contact Us ·
 * Report Issue · Feedback · Usage this session · Log Out.
 * No voice row — the mic already lives in the chat composer toolbar.
 *
 * Same runtime <style> injection + MutationObserver re-mount pattern as
 * v3SoloTabs.ts.
 */

import { $, append, addDisposableListener, EventType, EventHelper } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';
import { v3ChromeAvatarUrl } from './v3BrandAssets.js';

const STYLE_ELEMENT_ID = 'v3-profile-button-styles';

const DOCS_URL = 'https://docs.v3code.dev';
const CONTACT_MAILTO = 'mailto:daniel@publishd.app?subject=V3Code%20—%20Contact';

const STYLES = `
.monaco-workbench .titlebar-right .v3-profile-btn {
	display: inline-flex; align-items: center; justify-content: center;
	width: 22px; height: 22px; margin: 0 6px; border-radius: 50%;
	background-color: #0a0a0a;
	color: #ffffff; font-size: 11px; font-weight: 700;
	cursor: pointer; -webkit-app-region: no-drag; user-select: none; flex: 0 0 auto;
	border: 1px solid rgba(180, 184, 192, 0.55);
	box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.12);
	transition: box-shadow 160ms ease, transform 160ms ease;
}
.monaco-workbench .titlebar-right .v3-profile-btn:hover {
	box-shadow: 0 0 0 2px rgba(180, 184, 192, 0.35);
}
.monaco-workbench .titlebar-right .v3-profile-btn.v3-before-controls {
	/* Win/Linux: the native minimize/maximize/close controls sit to the RIGHT of
	   this button, so reserve extra gap and keep the avatar (plus its hover ring)
	   from crowding the minimize control. On mac the controls are on the left, so
	   this class is not applied and the default 6px margin stands. */
	margin-right: 12px;
}
.v3-profile-menu {
	position: fixed; z-index: 2600; min-width: 240px;
	background: var(--vscode-menu-background, #1f2023);
	color: var(--vscode-menu-foreground, #cccccc);
	border: 1px solid var(--vscode-menu-border, rgba(255, 255, 255, 0.08));
	border-radius: 8px; padding: 4px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
	font-size: 12px; user-select: none;
}
.v3-profile-menu .v3-profile-menu-header {
	display: flex; align-items: center; gap: 8px;
	padding: 8px 10px 10px 10px;
	border-bottom: 1px solid var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08));
	margin-bottom: 4px;
}
.v3-profile-menu .v3-profile-menu-avatar {
	display: inline-flex; align-items: center; justify-content: center;
	width: 28px; height: 28px; border-radius: 50%;
	background-color: #0a0a0a;
	background-size: cover; background-position: center;
	color: #ffffff; font-size: 13px; font-weight: 700; flex: 0 0 auto;
	border: 1px solid rgba(180, 184, 192, 0.55);
	box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.12);
	overflow: hidden;
}
.v3-profile-menu .v3-profile-menu-name {
	font-weight: 600; color: var(--vscode-foreground, #dddddd);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.v3-profile-menu .v3-profile-menu-tier {
	display: inline-block; margin-left: auto; padding: 1px 7px; border-radius: 999px;
	font-size: 10px; font-weight: 600; letter-spacing: 0.3px;
	background: rgba(80, 168, 230, 0.1875); color: #5FB0DE;
	border: 1px solid rgba(80, 168, 230, 0.35); flex: 0 0 auto;
}
.v3-profile-menu .v3-profile-menu-item {
	display: flex; align-items: center; gap: 8px;
	padding: 6px 10px; border-radius: 5px; cursor: pointer;
	color: var(--vscode-menu-foreground, #cccccc);
}
.v3-profile-menu .v3-profile-menu-item:hover {
	background: var(--vscode-menu-selectionBackground, rgba(255, 255, 255, 0.08));
	color: var(--vscode-menu-selectionForeground, #ffffff);
}
.v3-profile-menu .v3-profile-menu-item .codicon { font-size: 13px; flex: 0 0 auto; }
.v3-profile-menu .v3-profile-menu-separator {
	height: 1px; margin: 4px 8px;
	background: var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08));
}
.v3-profile-menu .v3-profile-menu-tokens {
	padding: 6px 10px 8px 10px;
	border-bottom: 1px solid var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08));
	margin-bottom: 4px;
}
.v3-profile-menu .v3-profile-menu-tokens-label {
	display: flex; justify-content: space-between; gap: 8px;
	font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d);
	margin-bottom: 5px;
}
.v3-profile-menu .v3-profile-menu-tokens-bar {
	height: 3px; border-radius: 999px; overflow: hidden;
	background: rgba(255, 255, 255, 0.08);
}
.v3-profile-menu .v3-profile-menu-tokens-fill {
	height: 100%; border-radius: 999px;
	background: linear-gradient(90deg, #6AA3CC 0%, #3F7FA8 100%);
}
.v3-profile-menu .v3-profile-menu-tokens-fill.v3-low {
	background: linear-gradient(90deg, #f0a030 0%, #e05540 100%);
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

type MenuRow =
	| { kind: 'item'; icon: string; label: string; run: () => void }
	| { kind: 'separator' };

/** Friendly remaining-usage label — the only "how much is left" customers see. */
function remainingUsageLabel(percentUsed: number): string {
	if (percentUsed >= 100) { return localize('v3ProfileButton.usageOut', "Out of included usage"); }
	if (percentUsed < 20) { return localize('v3ProfileButton.usagePlenty', "Plenty left"); }
	if (percentUsed < 45) { return localize('v3ProfileButton.usageGood', "Good amount left"); }
	if (percentUsed < 70) { return localize('v3ProfileButton.usageSome', "Some left"); }
	if (percentUsed < 90) { return localize('v3ProfileButton.usageLow', "Running low"); }
	return localize('v3ProfileButton.usageAlmost', "Almost at limit");
}

class V3ProfileButtonContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3ProfileButton';

	private _btn: HTMLElement | undefined;
	private _menu: HTMLElement | undefined;
	private readonly _menuDisposables = this._register(new DisposableStore());
	private readonly _reinjectObserver = this._register(new MutableDisposable());

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		injectStyles();
		this._ensureButton();
		this._observeTitleBar();
	}

	// --- DOM -----------------------------------------------------------------

	private _observeTitleBar(): void {
		const observer = new MutationObserver(() => {
			if (!this._btn || !this._btn.isConnected) {
				this._ensureButton();
			}
		});
		observer.observe(mainWindow.document.body, { childList: true, subtree: true });
		this._reinjectObserver.value = { dispose: () => observer.disconnect() };
	}

	/** Profile image when the hub has one; the chrome V brand mark otherwise. */
	private _renderButtonFace(btn: HTMLElement): void {
		const avatarUrl = this.accountService.state.avatarUrl ?? v3ChromeAvatarUrl();
		btn.textContent = '';
		btn.style.backgroundImage = `url("${avatarUrl}")`;
		btn.style.backgroundSize = 'cover';
		btn.style.backgroundPosition = 'center';
		btn.style.backgroundColor = '#0a0a0a';
	}

	private _ensureButton(): void {
		const titlebarRight = mainWindow.document.querySelector('.titlebar-right') as HTMLElement | null;
		if (!titlebarRight) { return; }
		if (this._btn && this._btn.isConnected) { return; }

		const btn = $('div.v3-profile-btn');
		btn.setAttribute('role', 'button');
		btn.setAttribute('aria-label', localize('v3ProfileButton.aria', 'Account and help'));
		btn.title = localize('v3ProfileButton.title', "Account and help");
		this._renderButtonFace(btn);
		this._register(this.accountService.onDidChangeState(() => {
			if (this._btn) { this._renderButtonFace(this._btn); }
		}));

		this._register(addDisposableListener(btn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			if (this._menu) {
				this._closeMenu();
			} else {
				this._openMenu(btn);
			}
		}));

		// Sit at the far right of the pre-window-controls area. On mac the traffic
		// lights are on the left, so appending puts the avatar at the true corner;
		// on win/linux insert before the window controls.
		const windowControls = titlebarRight.querySelector('.window-controls-container');
		if (windowControls) {
			btn.classList.add('v3-before-controls');
			titlebarRight.insertBefore(btn, windowControls);
		} else {
			titlebarRight.appendChild(btn);
		}

		this._btn = btn;
	}

	// --- Menu ----------------------------------------------------------------

	private _rows(): MenuRow[] {
		const open = (url: string) => {
			this.openerService.open(URI.parse(url)).then(undefined, err => {
				this.logService.error('[v3ProfileButton] open failed', err);
			});
		};
		const run = (commandId: string) => {
			this.commandService.executeCommand(commandId).then(undefined, err => {
				this.logService.error(`[v3ProfileButton] command ${commandId} failed`, err);
			});
		};

		const acctState = this.accountService.state;
		const rows: MenuRow[] = [
			{ kind: 'item', icon: 'account', label: localize('v3ProfileButton.manageAccount', "Manage Account"), run: () => this.accountService.manageAccount() },
		];
		// Signed-out (or expired-session) users need a way IN — the menu used to offer only
		// "Log Out" to a guest, and free users had no upgrade path anywhere outside Settings.
		if (acctState.status !== 'signedIn') {
			rows.push({
				kind: 'item',
				icon: 'sign-in',
				label: localize('v3ProfileButton.signIn', "Sign In"),
				run: () => this.accountService.signIn(),
			});
		}
		if (acctState.status !== 'signedIn' || !acctState.isPaid) {
			rows.push({
				kind: 'item',
				icon: 'rocket',
				label: localize('v3ProfileButton.upgrade', "Upgrade Plan…"),
				run: () => this.accountService.openPlans(),
			});
		}
		if (this.accountService.isPlanCreditExhausted()) {
			rows.push({
				kind: 'item',
				icon: 'credit-card',
				label: localize('v3ProfileButton.enableOverage', "Enable on-demand overage…"),
				run: () => this.accountService.openOverageSettings(),
			});
		}
		rows.push(
			{ kind: 'separator' },
			{ kind: 'item', icon: 'symbol-color', label: localize('v3ProfileButton.theme', "Theme"), run: () => run('workbench.action.selectTheme') },
			{ kind: 'item', icon: 'cloud-download', label: localize('v3ProfileButton.checkUpdates', "Check for Updates"), run: () => run('void.voidCheckUpdate') },
			{ kind: 'separator' },
			{ kind: 'item', icon: 'book', label: localize('v3ProfileButton.docs', "Help / Docs"), run: () => open(DOCS_URL) },
			{ kind: 'item', icon: 'device-mobile', label: localize('v3ProfileButton.mobile', "Get V3Code for Mobile"), run: () => open(DOCS_URL) },
			{ kind: 'item', icon: 'keyboard', label: localize('v3ProfileButton.shortcuts', "Shortcuts"), run: () => run('workbench.action.openGlobalKeybindings') },
			{ kind: 'item', icon: 'mail', label: localize('v3ProfileButton.contact', "Contact Us"), run: () => open(CONTACT_MAILTO) },
			{ kind: 'item', icon: 'bug', label: localize('v3ProfileButton.reportIssue', "Report an Issue"), run: () => run('v3code.reportIssue') },
			{ kind: 'item', icon: 'feedback', label: localize('v3ProfileButton.feedback', "Feedback"), run: () => run('v3code.sendFeedback') },
			{ kind: 'separator' },
			{ kind: 'item', icon: 'graph', label: localize('v3ProfileButton.usage', "Usage"), run: () => { this.commandService.executeCommand('workbench.action.openVoidSettings', 'account').then(undefined, err => { this.logService.error('[v3ProfileButton] open settings failed', err); }); } },
		);
		// Log Out only makes sense with a session to log out of — and its separator goes with it,
		// or guests get a dangling rule at the bottom of the menu.
		if (acctState.status === 'signedIn') {
			rows.push(
				{ kind: 'separator' },
				{ kind: 'item', icon: 'sign-out', label: localize('v3ProfileButton.logOut', "Log Out"), run: () => this.accountService.signOut() },
			);
		}
		return rows;
	}

	private _openMenu(anchor: HTMLElement): void {
		this._closeMenu();

		const doc = mainWindow.document;
		const menu = $('div.v3-profile-menu');
		menu.setAttribute('role', 'menu');

		// Header: avatar + name + tier badge from the account service.
		const state = this.accountService.state;
		const header = append(menu, $('div.v3-profile-menu-header'));
		const avatar = append(header, $('div.v3-profile-menu-avatar'));
		avatar.style.backgroundImage = `url("${state.avatarUrl ?? v3ChromeAvatarUrl()}")`;
		avatar.style.backgroundSize = 'cover';
		avatar.style.backgroundPosition = 'center';
		avatar.textContent = '';
		const name = append(header, $('span.v3-profile-menu-name'));
		name.textContent = state.displayName;
		const tier = append(header, $('span.v3-profile-menu-tier'));
		tier.textContent = state.tierLabel;

		// SuperClaw AI token meter — only when the hub reports one (hosted mode +
		// active plan). Numbers may be a session old; kick a background refresh so
		// the NEXT open is current (the render below uses the snapshot we have).
		if (state.status === 'signedIn') {
			this.accountService.refreshFromHub().then(undefined, () => { /* best-effort */ });
		}
		// Hosted usage meter — percent + friendly label ONLY (raw token counts and
		// dollar values are internal and never shown to customers).
		// A paid plan ALWAYS shows the master usage bar (empty → growing from 0), never
		// hidden just because no hosted request has landed yet.
		if (state.status === 'signedIn' && (state.isPaid || state.credit || (state.hostedMonthlyLimit !== null && state.hostedTokensRemaining !== null))) {
			const percentUsed = state.credit
				? state.credit.percentUsed
				: (state.hostedMonthlyLimit && state.hostedMonthlyLimit > 0
					? Math.min(100, Math.max(0, (1 - (state.hostedTokensRemaining ?? 0) / state.hostedMonthlyLimit) * 100))
					: 0);
			const remainingText = state.credit?.remainingLabel ?? remainingUsageLabel(percentUsed);
			const tokens = append(menu, $('div.v3-profile-menu-tokens'));
			const labelRow = append(tokens, $('div.v3-profile-menu-tokens-label'));
			const labelLeft = append(labelRow, $('span'));
			labelLeft.textContent = localize('v3ProfileButton.hostedUsage', "Hosted AI");
			const labelRight = append(labelRow, $('span'));
			labelRight.textContent = remainingText;
			const bar = append(tokens, $('div.v3-profile-menu-tokens-bar'));
			const fill = append(bar, $('div.v3-profile-menu-tokens-fill'));
			const remainingFraction = Math.max(0, Math.min(100, 100 - percentUsed));
			fill.style.width = `${Math.round(remainingFraction)}%`;
			if (remainingFraction < 10) {
				fill.classList.add('v3-low');
			}
		}

		for (const row of this._rows()) {
			if (row.kind === 'separator') {
				append(menu, $('div.v3-profile-menu-separator'));
				continue;
			}
			const item = append(menu, $('div.v3-profile-menu-item'));
			item.setAttribute('role', 'menuitem');
			append(item, $(`span.codicon.codicon-${row.icon}`));
			const label = append(item, $('span'));
			label.textContent = row.label;
			this._menuDisposables.add(addDisposableListener(item, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				this._closeMenu();
				row.run();
			}));
		}

		doc.body.appendChild(menu);

		// Anchor under the avatar, right-aligned to it (clamped to the viewport).
		const rect = anchor.getBoundingClientRect();
		const menuRect = menu.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.right - menuRect.width, mainWindow.innerWidth - menuRect.width - 8));
		menu.style.left = `${left}px`;
		menu.style.top = `${rect.bottom + 6}px`;

		// Dismissal: click-outside (capture so titlebar clicks count) + Escape.
		this._menuDisposables.add(addDisposableListener(doc.body, EventType.MOUSE_DOWN, e => {
			if (!menu.contains(e.target as Node) && e.target !== anchor) {
				this._closeMenu();
			}
		}, true));
		this._menuDisposables.add(addDisposableListener(doc.body, EventType.KEY_DOWN, e => {
			if ((e as KeyboardEvent).key === 'Escape') {
				this._closeMenu();
			}
		}, true));

		this._menu = menu;
	}

	private _closeMenu(): void {
		this._menuDisposables.clear();
		this._menu?.remove();
		this._menu = undefined;
	}

	override dispose(): void {
		this._closeMenu();
		this._btn?.remove();
		super.dispose();
	}
}

registerWorkbenchContribution2(V3ProfileButtonContribution.ID, V3ProfileButtonContribution, WorkbenchPhase.AfterRestored);
