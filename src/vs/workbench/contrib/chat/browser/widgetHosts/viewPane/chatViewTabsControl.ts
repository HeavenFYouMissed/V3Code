/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/chatViewTabsControl.css';
import { $, append, clearNode, addDisposableListener, EventType } from '../../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { AgentSessionsPicker } from '../../agentSessions/agentSessionsPicker.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { AgentSessionStatus, isSessionInProgressStatus } from '../../agentSessions/agentSessionsModel.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { getChatSessionType } from '../../../common/model/chatUri.js';
import { getExternalAgentSessionIcon, v3AgentMark } from '../../agentSessions/agentSessions.js';

const STORAGE_OPEN_TABS = 'v3code.chatOpenTabs';
const MAX_OPEN_TABS = 12;

export interface IChatViewTabsState {
	readonly openTabResources: string[];
	readonly activeTabResource?: string;
}

export interface IChatViewTabsControlOptions {
	readonly onSelect: (resource: URI) => void | Promise<void>;
	readonly onNew: () => void | Promise<void>;
	readonly onClose: (resource: URI) => void | Promise<void>;
	readonly getActiveResource: () => URI | undefined;
}

/**
 * Cursor-style open-chat tabs inside the Chat column (shown when Agents rail is collapsed).
 * Close is UI-only — never archive/delete/cancel the underlying session.
 */
export class ChatViewTabsControl extends Disposable {

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private readonly container: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly actionsEl: HTMLElement;
	private historyAnchor: HTMLElement = undefined!;
	private readonly tabDisposables = this._register(new DisposableStore());

	private openTabs: URI[] = [];
	private visible = false;

	constructor(
		parent: HTMLElement,
		private readonly options: IChatViewTabsControlOptions,
		@IStorageService private readonly storageService: IStorageService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatService private readonly chatService: IChatService,
	) {
		super();
		this.container = append(parent, $('.chat-view-tabs'));
		this.container.style.display = 'none';

		const left = append(this.container, $('.chat-view-tabs-left'));
		const showAgents = this._register(new Action(
			'chatViewTabs.showAgents',
			localize('showAgentsSideBar', "Show Agents Side Bar"),
			ThemeIcon.asClassName(Codicon.layoutSidebarLeft),
			true,
			() => this.commandService.executeCommand('workbench.action.toggleUnifiedSidebar'),
		));
		const leftBar = this._register(new ActionBar(left));
		leftBar.push(showAgents, { icon: true, label: false });

		this.tabsEl = append(this.container, $('.chat-view-tabs-list'));
		this.actionsEl = append(this.container, $('.chat-view-tabs-actions'));
		const newTab = this._register(new Action(
			'chatViewTabs.new',
			localize('newChatTab', "New Chat"),
			ThemeIcon.asClassName(Codicon.add),
			true,
			() => this.options.onNew(),
		));
		const history = this._register(new Action(
			'chatViewTabs.history',
			localize('chatHistory', "Chat History"),
			ThemeIcon.asClassName(Codicon.history),
			true,
			() => this.openHistoryPicker(),
		));
		const more = this._register(new Action(
			'chatViewTabs.more',
			localize('chatOptions', "Chat Options"),
			ThemeIcon.asClassName(Codicon.ellipsis),
			true,
			() => this.showMoreMenu(),
		));
		const newBar = this._register(new ActionBar(this.actionsEl));
		newBar.push(newTab, { icon: true, label: false });
		// Dedicated host so the sessions picker can anchor to History (not 0,0).
		this.historyAnchor = append(this.actionsEl, $('.chat-view-tabs-history'));
		const historyBar = this._register(new ActionBar(this.historyAnchor));
		historyBar.push(history, { icon: true, label: false });
		const moreBar = this._register(new ActionBar(this.actionsEl));
		moreBar.push(more, { icon: true, label: false });

		this.restore();
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => {
			this.pruneMissingTabs();
			if (this.visible) {
				this.render();
			}
		}));
		this._register(this.agentSessionsService.onDidChangeSessionArchivedState(session => {
			if (session.isArchived()) {
				this.removeTab(session.resource);
			}
		}));
	}

	get element(): HTMLElement { return this.container; }

	getHeight(): number {
		return this.visible ? 36 : 0;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		this.container.style.display = visible ? '' : 'none';
		if (visible) {
			this.ensureActiveTab();
			this.render();
		}
		this._onDidChangeHeight.fire();
	}

	ensureTab(resource: URI): void {
		if (this.openTabs.some(t => isEqual(t, resource))) {
			if (this.visible) {
				this.render();
			}
			return;
		}
		// Prefer not stacking multiple blank "New Agent" placeholders.
		// Blank sessions are excluded from agentSessionsService.model (!hasRequests),
		// so dedupe must use the live ChatModel — otherwise every New Agent adds a tab.
		if (this.isBlankTabResource(resource) && this.openTabs.some(t => this.isBlankTabResource(t))) {
			return;
		}
		this.openTabs.push(resource);
		while (this.openTabs.length > MAX_OPEN_TABS) {
			this.openTabs.shift();
		}
		this.persist();
		if (this.visible) {
			this.render();
		}
	}

	/** True when this URI is an empty welcome chat (no user turns yet). */
	private isBlankTabResource(resource: URI): boolean {
		const chatModel = this.chatService.getSession(resource);
		if (chatModel) {
			return !chatModel.hasRequests;
		}
		const session = this.agentSessionsService.model.getSession(resource);
		if (session) {
			const label = session.label ?? '';
			return !label || label === 'New Agent' || label === 'Chat';
		}
		// No live model and not in Agents list — treat as blank/stale placeholder.
		return true;
	}

	removeTab(resource: URI): void {
		const idx = this.openTabs.findIndex(t => isEqual(t, resource));
		if (idx < 0) {
			return;
		}
		this.openTabs.splice(idx, 1);
		this.persist();
		if (this.visible) {
			this.render();
		}
	}

	private ensureActiveTab(): void {
		const active = this.options.getActiveResource();
		if (active) {
			this.ensureTab(active);
		}
	}

	private pruneMissingTabs(): void {
		const before = this.openTabs.length;
		this.openTabs = this.openTabs.filter(r => {
			const s = this.agentSessionsService.model.getSession(r);
			if (s) {
				return !s.isArchived();
			}
			// Keep live chats not yet in the Agents model (e.g. blank New Agent).
			return !!this.chatService.getSession(r);
		});
		if (this.openTabs.length !== before) {
			this.persist();
		}
	}

	private restore(): void {
		try {
			const raw = this.storageService.get(STORAGE_OPEN_TABS, StorageScope.WORKSPACE);
			if (!raw) {
				return;
			}
			const state = JSON.parse(raw) as IChatViewTabsState;
			this.openTabs = (state.openTabResources ?? []).map(s => URI.parse(s)).slice(-MAX_OPEN_TABS);
			this.pruneMissingTabs();
		} catch {
			this.openTabs = [];
		}
	}

	private persist(): void {
		const active = this.options.getActiveResource();
		const state: IChatViewTabsState = {
			openTabResources: this.openTabs.map(u => u.toString()),
			activeTabResource: active?.toString(),
		};
		this.storageService.store(STORAGE_OPEN_TABS, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/**
	 * Anchor the sessions picker to the History control in the chat tab strip.
	 * The shared pickAgentSession command uses the (often hidden) title-label
	 * element, which leaves anchor undefined and drops the picker at 0,0.
	 */
	private async openHistoryPicker(): Promise<void> {
		const picker = this.instantiationService.createInstance(AgentSessionsPicker, this.historyAnchor, undefined);
		await picker.pickAgentSession();
	}

	private showMoreMenu(): void {
		const actions: Action[] = [
			new Action('chatViewTabs.more.new', localize('newChatTab', "New Chat"), ThemeIcon.asClassName(Codicon.add), true,
				() => this.options.onNew()),
			new Action('chatViewTabs.more.history', localize('chatHistory', "Chat History"), ThemeIcon.asClassName(Codicon.history), true,
				() => this.openHistoryPicker()),
			new Action('chatViewTabs.more.settings', localize('chatSettings', "Chat Settings"), ThemeIcon.asClassName(Codicon.settingsGear), true,
				// NOT workbench.action.chat.manageSettings — that opens GitHub Copilot.
				() => this.commandService.executeCommand('workbench.action.chat.openFeatureSettings')),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.actionsEl,
			getActions: () => actions,
			onHide: () => { for (const a of actions) { a.dispose(); } },
		});
	}

	private async closeTab(resource: URI): Promise<void> {
		const active = this.options.getActiveResource();
		const wasActive = !!active && isEqual(active, resource);
		this.removeTab(resource);
		await this.options.onClose(resource);
		if (!wasActive) {
			return;
		}
		const next = this.openTabs[this.openTabs.length - 1];
		if (next) {
			await this.options.onSelect(next);
		}
		// Last tab closed: do NOT spawn another New Chat (that was the spam loop).
	}

	/**
	 * Live working state for a tab — same signal as the Agents rail (hasActiveRequest),
	 * so tool/confirm gaps still show the spinny circle on background tabs.
	 */
	private bindTabWorkingIndicator(
		tab: HTMLElement,
		indicator: HTMLElement,
		resource: URI,
		fallbackStatus: AgentSessionStatus | undefined,
		isActive: boolean,
	): void {
		const spinClasses = ThemeIcon.asClassNameArray(ThemeIcon.modify(Codicon.loading, 'spin'));
		const apply = (isWorking: boolean, needsInput: boolean) => {
			const spinning = isWorking && !needsInput;
			tab.classList.toggle('in-progress', spinning);
			tab.classList.toggle('needs-input', needsInput);
			tab.classList.remove('unread');
			indicator.className = 'chat-view-tabs-tab-indicator';
			if (spinning) {
				indicator.classList.add(...spinClasses);
				indicator.setAttribute('aria-label', localize('tabWorking', "Agent working"));
			} else if (needsInput) {
				indicator.setAttribute('aria-label', localize('tabNeedsInput', "Input needed"));
			} else if (!isActive) {
				const session = this.agentSessionsService.model.getSession(resource);
				if (session && !session.isRead()) {
					tab.classList.add('unread');
					indicator.setAttribute('aria-label', localize('tabUnread', "Unread"));
				} else {
					indicator.removeAttribute('aria-label');
				}
			} else {
				indicator.removeAttribute('aria-label');
			}
		};

		const chatModel = this.chatService.getSession(resource);
		if (chatModel) {
			this.tabDisposables.add(autorun(reader => {
				const needsInput = !!chatModel.requestNeedsInput.read(reader);
				const isWorking = chatModel.hasActiveRequest.read(reader)
					|| chatModel.requestInProgress.read(reader)
					|| needsInput;
				apply(isWorking, needsInput);
			}));
			return;
		}

		const status = fallbackStatus;
		apply(
			!!status && isSessionInProgressStatus(status),
			status === AgentSessionStatus.NeedsInput,
		);
	}

	private render(): void {
		this.tabDisposables.clear();
		clearNode(this.tabsEl);
		const active = this.options.getActiveResource();

		for (const resource of this.openTabs) {
			const session = this.agentSessionsService.model.getSession(resource);
			const tab = append(this.tabsEl, $('.chat-view-tabs-tab'));
			tab.tabIndex = 0;
			tab.setAttribute('role', 'tab');
			const isActive = !!active && isEqual(active, resource);
			tab.classList.toggle('active', isActive);
			tab.setAttribute('aria-selected', String(isActive));

			// Working spinner first so background tabs light up while you're on another chat.
			const indicator = append(tab, $('.chat-view-tabs-tab-indicator'));
			this.bindTabWorkingIndicator(tab, indicator, resource, session?.status, isActive);

			const label = append(tab, $('.chat-view-tabs-tab-label'));
			// V3Code: identify the actual session owner without changing session routing.
			const type = getChatSessionType(resource);
			const icon = getExternalAgentSessionIcon(type) ?? (type === 'local' ? v3AgentMark : type === 'agent-host-claude' || type === 'claude-code' ? Codicon.claude : Codicon.plug);
			const mark = $('.chat-view-tabs-tab-icon');
			mark.classList.add(...ThemeIcon.asClassNameArray(icon));
			mark.setAttribute('aria-hidden', 'true');
			tab.insertBefore(mark, label);
			label.textContent = session?.label || localize('newAgent', "New Agent");

			const closeBtn = append(tab, $('button.chat-view-tabs-tab-close')) as HTMLButtonElement;
			closeBtn.type = 'button';
			closeBtn.title = localize('close', "Close");
			closeBtn.setAttribute('aria-label', localize('close', "Close"));
			closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			this.tabDisposables.add(addDisposableListener(closeBtn, EventType.MOUSE_DOWN, e => {
				e.preventDefault();
				e.stopPropagation();
			}));
			this.tabDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				void this.closeTab(resource);
			}));

			this.tabDisposables.add(addDisposableListener(tab, EventType.CLICK, e => {
				if ((e.target as HTMLElement).closest('.chat-view-tabs-tab-close')) {
					return;
				}
				void this.options.onSelect(resource);
			}));
			this.tabDisposables.add(addDisposableListener(tab, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					void this.options.onSelect(resource);
				} else if (e.key === 'Backspace' || e.key === 'Delete') {
					e.preventDefault();
					void this.closeTab(resource);
				}
			}));
		}

		this.persist();
	}

	notifyActiveChanged(resource: URI | undefined): void {
		if (resource) {
			this.ensureTab(resource);
		}
		if (this.visible) {
			this.render();
		} else {
			this.persist();
		}
	}
}
