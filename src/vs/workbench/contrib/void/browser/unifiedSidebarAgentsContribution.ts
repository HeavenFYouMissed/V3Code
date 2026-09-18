/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { $, addDisposableListener, append, clearNode, EventHelper, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { V3CODE_REMOTE_SHOW_QR_ACTION_ID } from './v3RemoteButton.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { SIDE_BAR_BACKGROUND } from '../../../common/theme.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IUnifiedSidebarContentController, IUnifiedSidebarService } from '../../../services/unifiedSidebar/browser/unifiedSidebarService.js';
import { AgentSessionsControl } from '../../chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../../chat/browser/agentSessions/agentSessionsFilter.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';
import { v3ChromeAvatarUrl } from './v3BrandAssets.js';
import { V3GoDock } from './v3GoPane.js';
import { TurboDraftDock } from './turboDraftDock.js';
import { ExternalAgentsDock } from './externalAgentsDock.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from './voidSettingsPane.js';

const DOCS_URL = 'https://docs.v3code.dev';

class UnifiedSidebarAgentsController extends Disposable implements IUnifiedSidebarContentController {

	private control: AgentSessionsControl | undefined;
	private root: HTMLElement | undefined;
	private listHost: HTMLElement | undefined;
	private accountAvatar: HTMLElement | undefined;
	private accountName: HTMLElement | undefined;
	private accountPlan: HTMLElement | undefined;
	private accountUpdateBtn: HTMLButtonElement | undefined;
	private readonly accountMenuStore = this._register(new MutableDisposable<DisposableStore>());
	private searchText = '';
	private lastLayout: { height: number; width: number } | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IHostService private readonly hostService: IHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IUpdateService private readonly updateService: IUpdateService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	mount(parent: HTMLElement): void {
		clearNode(parent);
		const root = this.root = append(parent, $('.unified-agents-cursor'));

		// ---- Cursor-style header: Search / New Agent / Customize ----
		const header = append(root, $('.unified-agents-cursor-header'));

		const search = append(header, $('.unified-agents-search'));
		const searchIcon = append(search, $('span.unified-agents-search-icon'));
		searchIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));
		const input = append(search, $('input.unified-agents-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('searchAgents', "Search Agents...");
		input.spellcheck = false;
		this._register(addDisposableListener(input, EventType.INPUT, () => {
			this.searchText = input.value.trim().toLowerCase();
			void this.control?.update();
		}));

		const newAgentRow = append(header, $('.unified-agents-row'));
		newAgentRow.setAttribute('role', 'button');
		newAgentRow.tabIndex = 0;
		const newAgentIcon = append(newAgentRow, $('span.unified-agents-row-icon'));
		newAgentIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(newAgentRow, $('span.unified-agents-row-label')).textContent = localize('newAgent', "New Agent");
		append(newAgentRow, $('span.unified-agents-row-kbd')).textContent = '⌘N';
		const runNewAgent = () => this.commandService.executeCommand('workbench.action.chat.newChat');
		this._register(addDisposableListener(newAgentRow, EventType.CLICK, runNewAgent));
		this._register(addDisposableListener(newAgentRow, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runNewAgent(); }
		}));

		// Pairing is real now, so this opens it rather than explaining that it is coming.
		// V3Code: use native chat editors so tabs and detached windows retain their lifecycle.
		for (const [label, command] of [
			[localize('newAgentWindow', "New agent window"), 'workbench.action.newChatWindow'],
			[localize('newSideChat', "New side chat"), 'workbench.action.openChatToSide'],
		]) {
			const row = append(header, $('.unified-agents-row'));
			row.setAttribute('role', 'button');
			row.tabIndex = 0;
			append(row, $('span.unified-agents-row-icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
			append(row, $('span.unified-agents-row-label')).textContent = label;
			const run = () => this.commandService.executeCommand(command);
			this._register(addDisposableListener(row, EventType.CLICK, run));
			this._register(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void run(); }
			}));
		}

		const mobileRow = append(header, $('.unified-agents-row.unified-agents-mobile-preview'));
		mobileRow.setAttribute('role', 'button');
		mobileRow.tabIndex = 0;
		mobileRow.title = localize('mobilePairingDescription', "Scan a QR to drive this editor from your phone");
		const mobileIcon = append(mobileRow, $('span.unified-agents-row-icon'));
		mobileIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.deviceMobile));
		append(mobileRow, $('span.unified-agents-row-label')).textContent = localize('mobile', "Mobile");
		const qrIcon = append(mobileRow, $('span.unified-agents-row-tail-icon'));
		qrIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.deviceMobile));
		const openPairing = () => { void this.commandService.executeCommand(V3CODE_REMOTE_SHOW_QR_ACTION_ID); };
		this._register(addDisposableListener(mobileRow, EventType.CLICK, openPairing));
		this._register(addDisposableListener(mobileRow, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPairing(); }
		}));

		const customizeRow = append(header, $('.unified-agents-row'));
		customizeRow.setAttribute('role', 'button');
		customizeRow.tabIndex = 0;
		const customizeIcon = append(customizeRow, $('span.unified-agents-row-icon'));
		customizeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.extensions));
		append(customizeRow, $('span.unified-agents-row-label')).textContent = localize('customize', "Customize");
		// Customization belongs to V3Code's own settings surface. Start on the
		// complete view so models, chat UI, tools, MCP and indexing stay discoverable.
		const runCustomize = () => this.commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID, 'all');
		this._register(addDisposableListener(customizeRow, EventType.CLICK, runCustomize));
		this._register(addDisposableListener(customizeRow, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runCustomize(); }
		}));

		const feedbackRow = append(header, $('.unified-agents-row.unified-agents-feedback-row'));
		feedbackRow.setAttribute('role', 'button');
		feedbackRow.tabIndex = 0;
		feedbackRow.title = localize('feedbackDescription', "Share feedback or report a problem directly to V3Code");
		const feedbackIcon = append(feedbackRow, $('span.unified-agents-row-icon'));
		feedbackIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.feedback));
		append(feedbackRow, $('span.unified-agents-row-label')).textContent = localize('feedbackAndIssues', "Feedback / Report Issue");
		const runFeedback = () => this.commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID, 'feedback');
		this._register(addDisposableListener(feedbackRow, EventType.CLICK, runFeedback));
		this._register(addDisposableListener(feedbackRow, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runFeedback(); }
		}));

		// ---- Session list (Today / Yesterday / …) ----
		const listHost = this.listHost = append(root, $('.unified-agents-cursor-list'));
		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewerFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Capped,
			overrideExclude: session => {
				if (this.searchText && !(session.label ?? '').toLowerCase().includes(this.searchText)) {
					return true;
				}

				const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
				if (workspaceFolders.length === 0) {
					return undefined;
				}
				const workingDirectoryPath = session.metadata?.workingDirectoryPath;
				if (!workingDirectoryPath) {
					return true;
				}
				const workingDirectory = URI.file(workingDirectoryPath);
				return workspaceFolders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(workingDirectory, folder.uri))
					? undefined
					: true;
			},
		}));
		const control = this.control = this._register(this.instantiationService.createInstance(AgentSessionsControl, listHost, {
			source: 'unifiedSidebarPart',
			filter,
			disableHover: true,
			overrideStyles: {
				listBackground: SIDE_BAR_BACKGROUND,
				treeStickyScrollBackground: SIDE_BAR_BACKGROUND,
				// Do NOT force inactive selection to sidebar bg — that hid the
				// Cursor-like "which chat is open" highlight in the Agents rail.
			},
			getHoverPosition: () => HoverPosition.RIGHT,
			trackActiveEditorSession: () => true,
			// Preserve the original three-state activity language: status spinner
			// while starting, six-dot grid while working, provider/tool icon when
			// idle. The separate LIVE label remains enabled beside the title.
			useStatusOnlyIcons: true,
			showActivityIndicator: true,
			showSectionIcons: true,
			repositoryGroupLimit: 8,
			groupPinnedSessions: true,
			itemHeight: 44,
			overrideSessionOpenOptions: openEvent => ({
				...openEvent,
				editorOptions: { ...openEvent.editorOptions, preserveFocus: false }
			}),
		}));
		this._register(this.hostService.onDidChangeFocus(hasFocus => {
			if (hasFocus) {
				control.refresh();
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			void control.update();
		}));
		this._register(Event.runAndSubscribe(this.chatWidgetService.onDidChangeFocusedSession, () => {
			const resource = this.chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource;
			if (resource) {
				control.reveal(resource);
			} else {
				control.clearFocus();
			}
		}));

		// ---- External agents strip (above Turbo) — only visible once an agent is enabled ----
		const externalAgents = this._register(this.instantiationService.createInstance(ExternalAgentsDock));
		append(root, externalAgents.element);
		this._register(externalAgents.onDidChangeHeight(() => {
			if (this.lastLayout) {
				this.layout(this.lastLayout.height, this.lastLayout.width);
			}
		}));

		// ---- Turbo Draft dock (above V Go) — pops open while drafting / reviewing ----
		const turbo = this._register(this.instantiationService.createInstance(TurboDraftDock));
		append(root, turbo.element);
		this._register(turbo.onDidChangeHeight(() => {
			if (this.lastLayout) {
				this.layout(this.lastLayout.height, this.lastLayout.width);
			}
		}));

		// ---- V Go dock (above plan / account chip) — pops open while predicting ----
		const vGo = this._register(this.instantiationService.createInstance(V3GoDock));
		append(root, vGo.element);
		this._register(vGo.onDidChangeHeight(() => {
			if (this.lastLayout) {
				this.layout(this.lastLayout.height, this.lastLayout.width);
			}
		}));

		// ---- Cursor-style account chip (avatar · name · plan · Update when available) ----
		this.mountAccountFooter(root);
		this._register(this.accountService.onDidChangeState(() => this.renderAccountFooter()));
		this._register(this.updateService.onStateChange(() => this.renderAccountFooter()));
	}

	private mountAccountFooter(root: HTMLElement): void {
		const footer = append(root, $('.unified-agents-account'));
		footer.setAttribute('role', 'button');
		footer.tabIndex = 0;
		footer.title = localize('agentsAccountMenu', "Account and settings");

		const avatar = this.accountAvatar = append(footer, $('.unified-agents-account-avatar'));
		const meta = append(footer, $('.unified-agents-account-meta'));
		this.accountName = append(meta, $('span.unified-agents-account-name'));
		this.accountPlan = append(meta, $('span.unified-agents-account-plan'));

		const updateBtn = this.accountUpdateBtn = append(footer, $('button.unified-agents-account-update')) as HTMLButtonElement;
		updateBtn.type = 'button';
		updateBtn.textContent = localize('agentsAccountUpdate', "Update");
		updateBtn.title = localize('agentsAccountUpdateTitle', "Install available update");
		updateBtn.hidden = true;

		const gear = append(footer, $('button.unified-agents-account-gear')) as HTMLButtonElement;
		gear.type = 'button';
		gear.setAttribute('aria-label', localize('agentsAccountSettings', "Open settings"));
		gear.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));

		this._register(addDisposableListener(updateBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			// Prefer apply/restart when ready; otherwise open the update check flow.
			const t = this.updateService.state.type;
			if (t === StateType.Ready || t === StateType.Downloaded) {
				void this.commandService.executeCommand('update.restart');
			} else if (t === StateType.AvailableForDownload) {
				void this.commandService.executeCommand('update.downloadUpdate');
			} else {
				void this.commandService.executeCommand('void.voidCheckUpdate');
			}
		}));
		this._register(addDisposableListener(gear, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			void this.commandService.executeCommand('workbench.action.openVoidSettings', 'account');
		}));
		const openMenu = () => this.openAccountMenu(footer);
		this._register(addDisposableListener(footer, EventType.CLICK, e => {
			const t = e.target as HTMLElement;
			if (t.closest('.unified-agents-account-update') || t.closest('.unified-agents-account-gear')) {
				return;
			}
			openMenu();
		}));
		this._register(addDisposableListener(footer, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openMenu();
			}
		}));
		this._register(addDisposableListener(avatar, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			openMenu();
		}));

		this.renderAccountFooter();
	}

	private isUpdateActionable(): boolean {
		switch (this.updateService.state.type) {
			case StateType.AvailableForDownload:
			case StateType.Downloading:
			case StateType.Downloaded:
			case StateType.Updating:
			case StateType.Ready:
			case StateType.Overwriting:
				return true;
			default:
				return false;
		}
	}

	private renderAccountFooter(): void {
		if (!this.accountAvatar || !this.accountName || !this.accountPlan) {
			return;
		}
		const state = this.accountService.state;
		this.accountName.textContent = state.displayName || localize('guest', "Guest");
		this.accountPlan.textContent = state.tierLabel || localize('freePlan', "Free");
		clearNode(this.accountAvatar);
		const avatarUrl = state.avatarUrl ?? v3ChromeAvatarUrl();
		this.accountAvatar.style.backgroundImage = `url("${avatarUrl}")`;
		this.accountAvatar.style.backgroundSize = 'cover';
		this.accountAvatar.style.backgroundPosition = 'center';
		this.accountAvatar.textContent = '';
		if (this.accountUpdateBtn) {
			const show = this.isUpdateActionable();
			this.accountUpdateBtn.hidden = !show;
			const t = this.updateService.state.type;
			if (t === StateType.Downloading || t === StateType.Updating || t === StateType.Overwriting) {
				this.accountUpdateBtn.textContent = localize('agentsAccountUpdating', "Updating…");
			} else if (t === StateType.Ready || t === StateType.Downloaded) {
				this.accountUpdateBtn.textContent = localize('agentsAccountRestart', "Restart");
			} else {
				this.accountUpdateBtn.textContent = localize('agentsAccountUpdate', "Update");
			}
		}
	}

	private openAccountMenu(anchor: HTMLElement): void {
		this.closeAccountMenu();
		const store = new DisposableStore();
		this.accountMenuStore.value = store;

		const menu = append(anchor.ownerDocument.body, $('.unified-agents-account-menu'));
		menu.setAttribute('role', 'menu');
		store.add({ dispose: () => menu.remove() });

		const open = (url: string) => {
			void this.openerService.open(URI.parse(url));
			this.closeAccountMenu();
		};
		const run = (commandId: string, ...args: unknown[]) => {
			void this.commandService.executeCommand(commandId, ...args);
			this.closeAccountMenu();
		};

		type Row = { kind: 'item'; icon: string; label: string; run: () => void } | { kind: 'separator' };
		const rows: Row[] = [
			{ kind: 'item', icon: 'device-mobile', label: localize('getMobile', "Get V3Code for Mobile"), run: () => open(DOCS_URL) },
			{ kind: 'item', icon: 'book', label: localize('docs', "Docs"), run: () => open(DOCS_URL) },
			{ kind: 'item', icon: 'keyboard', label: localize('shortcuts', "Shortcuts"), run: () => run('workbench.action.openGlobalKeybindings') },
			{ kind: 'item', icon: 'mail', label: localize('contact', "Contact Us"), run: () => open('mailto:daniel@publishd.app?subject=V3Code%20—%20Contact') },
			{ kind: 'item', icon: 'feedback', label: localize('agents.feedback', "Feedback"), run: () => run('v3code.sendFeedback') },
			{ kind: 'item', icon: 'bug', label: localize('agents.reportIssue', "Report an Issue"), run: () => run('v3code.reportIssue') },
			{ kind: 'separator' },
			{ kind: 'item', icon: 'sign-out', label: localize('logOut', "Log Out"), run: () => { void this.accountService.signOut(); this.closeAccountMenu(); } },
		];

		for (const row of rows) {
			if (row.kind === 'separator') {
				append(menu, $('.unified-agents-account-menu-sep'));
				continue;
			}
			const item = append(menu, $('.unified-agents-account-menu-item'));
			item.setAttribute('role', 'menuitem');
			const icon = append(item, $('span.unified-agents-account-menu-icon'));
			icon.classList.add('codicon', `codicon-${row.icon}`);
			append(item, $('span')).textContent = row.label;
			store.add(addDisposableListener(item, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				row.run();
			}));
		}

		const rect = anchor.getBoundingClientRect();
		const win = anchor.ownerDocument.defaultView ?? globalThis;
		menu.style.position = 'fixed';
		menu.style.left = `${Math.max(8, rect.left)}px`;
		menu.style.bottom = `${Math.max(8, win.innerHeight - rect.top + 6)}px`;
		menu.style.minWidth = `${Math.max(220, rect.width)}px`;
		menu.style.zIndex = '10000';

		const onDoc = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
				this.closeAccountMenu();
			}
		};
		anchor.ownerDocument.addEventListener('mousedown', onDoc, true);
		store.add({ dispose: () => anchor.ownerDocument.removeEventListener('mousedown', onDoc, true) });
	}

	private closeAccountMenu(): void {
		this.accountMenuStore.clear();
	}

	layout(height: number, width: number): void {
		this.lastLayout = { height, width };
		if (this.root) {
			this.root.style.height = `${height}px`;
			this.root.style.width = `${width}px`;
		}
		if (this.listHost) {
			// The list is the only flexible child. Let the browser subtract the real
			// header, dock, margin and account heights, then give the virtual list the
			// exact pixels that remain. A guessed subtraction made its scroll surface
			// taller than its visible slot and hid the final chats behind the docks.
			this.listHost.style.removeProperty('height');
		}
		const listHeight = this.listHost?.clientHeight ?? 0;
		this.control?.layout(listHeight, width);
	}

	focus(): void {
		this.control?.focus();
	}

	setVisible(visible: boolean): void {
		this.control?.setVisible(visible);
	}
}

class UnifiedSidebarAgentsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.unifiedSidebarAgents';

	constructor(
		@IUnifiedSidebarService unifiedSidebarService: IUnifiedSidebarService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(unifiedSidebarService.registerContentController(
			() => instantiationService.createInstance(UnifiedSidebarAgentsController),
		));
	}
}

registerWorkbenchContribution2(UnifiedSidebarAgentsContribution.ID, UnifiedSidebarAgentsContribution, WorkbenchPhase.BlockRestore);
