/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/agentWorkspaceShell.css';
import { $, addDisposableListener, append, clearNode, EventHelper, EventType, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase, isEqual, isEqualOrParent } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as nls from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';

import { INativeHostService } from '../../../../../../platform/native/common/native.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IUntypedFileEditorInput, SideBySideEditor } from '../../../../../common/editor.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { ITextEditorService } from '../../../../../services/textfile/common/textEditorService.js';
import { BrowserEditorInput } from '../../../../browserView/common/browserEditorInput.js';

import { AgentSessionsControl } from '../../agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../../agentSessions/agentSessionsFilter.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { isSessionInProgressStatus } from '../../agentSessions/agentSessionsModel.js';
import { getRepositoryName } from '../../agentSessions/agentSessionsViewer.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { localChatSessionType } from '../../../common/chatSessionsService.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import type { IChatEditorOptions } from './chatEditor.js';
import { ChatEditorInput } from './chatEditorInput.js';
import { AgentWorkspaceFilesCompositeInput, AgentWorkspaceFilesEditorInput } from './agentWorkspaceFilesEditor.js';
import { AgentWorkspaceTerminalEditorInput } from './agentWorkspaceTerminalEditor.js';

import { VOID_SETTINGS_INITIAL_TAB_KEY, VoidSettingsInput } from '../../../../void/browser/voidSettingsPane.js';
import { IAgentProjectService } from './agentProjectService.js';
import { v3ChromeAvatarUrl } from '../../../../void/browser/v3BrandAssets.js';
import { IV3CodeAccountService } from '../../../../void/common/v3codeAccountService.js';

const EXPANDED_RAIL_WIDTH = 292;
const COMPACT_RAIL_WIDTH = 54;
const COMPACT_RAIL_BREAKPOINT = 760;
const MIN_CHAT_PANE_WIDTH = 420;
const MIN_UTILITY_PANE_WIDTH = 280;
const MIN_COMPACT_PRIMARY_WIDTH = COMPACT_RAIL_WIDTH + MIN_CHAT_PANE_WIDTH;
const MIN_EXPANDED_PRIMARY_WIDTH = EXPANDED_RAIL_WIDTH + MIN_CHAT_PANE_WIDTH;
const DOCS_URL = 'https://docs.v3code.dev';

type AgentWorkspaceRailScope = 'current' | 'workspaces';
type AgentWorkspaceRailPreference = 'auto' | 'expanded' | 'collapsed';

/**
 * Adds the product-owned workspace frame around the native ChatEditor. The chat
 * widget remains the editor's direct child so its renderer, accessibility and
 * editor styling contracts stay unchanged.
 */
export class AgentWorkspaceShell extends Disposable {
	private readonly _onDidRequestLayout = this._register(new Emitter<void>());
	readonly onDidRequestLayout = this._onDidRequestLayout.event;

	private readonly rail: HTMLElement;
	private readonly primaryGroupElement: HTMLElement | undefined;
	private readonly paneGutter: HTMLElement | undefined;
	private readonly chatHeader: HTMLElement;
	private readonly chatHeaderLabel: HTMLElement;
	private readonly chatHeaderCloseButton: HTMLButtonElement;
	private readonly landing: HTMLElement;
	private readonly landingNewAgentButton: HTMLButtonElement;
	private readonly railToggleButton: HTMLButtonElement;
	private readonly header: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly searchAction: HTMLElement;
	private readonly workspacesScopeButton: HTMLButtonElement;
	private readonly listHost: HTMLElement;
	private readonly compactActivityHost: HTMLElement;
	private readonly footer: HTMLElement;
	private readonly launcher: HTMLElement;
	private readonly focusButton: HTMLButtonElement;
	private readonly contextStateDisposables = this._register(new DisposableStore());
	private readonly compactActivityDisposables = this._register(new DisposableStore());
	private readonly utilityGroupDisposables = this._register(new DisposableStore());
	private readonly accountMenuStore = this._register(new MutableDisposable<DisposableStore>());
	private sessionsControl: AgentSessionsControl | undefined;
	private interactiveSession: HTMLElement | undefined;
	private contextBar: HTMLElement | undefined;

	private enabled = false;
	private visible = true;
	private compact = false;
	private railPreference: AgentWorkspaceRailPreference = 'auto';
	private utilityGroup: IEditorGroup | undefined;
	private selectedWorkspaceRoot: URI | undefined;
	private railScope: AgentWorkspaceRailScope = 'current';
	private readonly primaryGroupInitiallyLocked: boolean;
	private normalizingUtilityEditor = false;
	private primaryGroupNormalization: Promise<void> | undefined;
	private restoringPrimaryChat = false;
	private sessionDismissed = false;
	private accountAvatar: HTMLElement | undefined;
	private accountName: HTMLElement | undefined;
	private accountPlan: HTMLElement | undefined;
	private lastDimension = { height: 0, width: 0 };

	constructor(
		private readonly parent: HTMLElement,
		private readonly primaryGroup: IEditorGroup,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextEditorService private readonly textEditorService: ITextEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAgentProjectService private readonly agentProjectService: IAgentProjectService,
	) {
		super();
		this.primaryGroupInitiallyLocked = primaryGroup.isLocked;
		this.primaryGroupElement = parent.closest<HTMLElement>('.editor-group-container') ?? undefined;
		this.primaryGroupElement?.classList.add('agent-workspace-primary-group');
		this.paneGutter = this.primaryGroupElement ? append(this.primaryGroupElement, $('.agent-workspace-pane-gutter')) : undefined;
		if (this.paneGutter) {
			this.paneGutter.setAttribute('aria-hidden', 'true');
			append(this.paneGutter, $('.agent-workspace-pane-gutter-grip'));
		}
		this._register({
			dispose: () => {
				this.paneGutter?.remove();
				this.primaryGroupElement?.classList.remove('agent-workspace-primary-group', 'agent-workspace-primary-has-utility');
				this.primaryGroupElement?.style.removeProperty('--agent-workspace-rail-width');
			}
		});

		const primaryGroupTitle = this.primaryGroupElement
			? Array.from(this.primaryGroupElement.children).find((child): child is HTMLElement => isHTMLElement(child) && child.classList.contains('title'))
			: undefined;
		this.chatHeader = append(primaryGroupTitle ?? parent, $('.agent-workspace-chat-header'));
		this._register({ dispose: () => this.chatHeader.remove() });
		this.chatHeader.setAttribute('role', 'heading');
		this.chatHeader.setAttribute('aria-level', '2');
		const chatHeaderIcon = append(this.chatHeader, $('span.agent-workspace-chat-header-icon'));
		chatHeaderIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.chatSparkle));
		this.chatHeaderLabel = append(this.chatHeader, $('span.agent-workspace-chat-header-label'));
		const chatHeaderIdeButton = append(this.chatHeader, $('button.agent-workspace-chat-header-ide')) as HTMLButtonElement;
		chatHeaderIdeButton.type = 'button';
		append(chatHeaderIdeButton, $('span.agent-workspace-chat-header-ide-label')).textContent = nls.localize('agentWorkspace.ide', "IDE");
		const chatHeaderIdeIcon = append(chatHeaderIdeButton, $('span.agent-workspace-chat-header-ide-icon'));
		chatHeaderIdeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.linkExternal));
		chatHeaderIdeButton.title = nls.localize('agentWorkspace.showIde', "Show IDE");
		chatHeaderIdeButton.setAttribute('aria-label', nls.localize('agentWorkspace.showIde', "Show IDE"));
		this._register(addDisposableListener(chatHeaderIdeButton, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this.runSafely(() => this.showIde());
		}));
		this.chatHeaderCloseButton = append(this.chatHeader, $('button.agent-workspace-chat-header-close')) as HTMLButtonElement;
		this.chatHeaderCloseButton.type = 'button';
		this.chatHeaderCloseButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.chatHeaderCloseButton.title = nls.localize('agentWorkspace.leaveChat', "Leave chat");
		this.chatHeaderCloseButton.setAttribute('aria-label', nls.localize('agentWorkspace.leaveChat', "Leave chat"));
		this._register(addDisposableListener(this.chatHeaderCloseButton, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this.dismissSession();
		}));
		this.updateChatHeader();

		this.landing = append(parent, $('.agent-workspace-landing'));
		this.landing.setAttribute('aria-label', nls.localize('agentWorkspace.landing', "Agents"));
		const landingIcon = append(this.landing, $('span.agent-workspace-landing-icon'));
		landingIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.chatSparkle));
		append(this.landing, $('h2.agent-workspace-landing-title')).textContent = nls.localize('agentWorkspace.landing.title', "Agents");
		append(this.landing, $('p.agent-workspace-landing-description')).textContent = nls.localize('agentWorkspace.landing.description', "Choose an agent from the sidebar or start a new one.");
		this.landingNewAgentButton = append(this.landing, $('button.agent-workspace-landing-new')) as HTMLButtonElement;
		this.landingNewAgentButton.type = 'button';
		const landingButtonIcon = append(this.landingNewAgentButton, $('span.agent-workspace-landing-new-icon'));
		landingButtonIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(this.landingNewAgentButton, $('span')).textContent = nls.localize('agentWorkspace.newAgent', "New Agent");
		this._register(addDisposableListener(this.landingNewAgentButton, EventType.CLICK, () => this.runSafely(() => this.openNewSession())));

		this.rail = append(parent, $('.agent-workspace-rail'));
		this.rail.setAttribute('aria-label', nls.localize('agentWorkspace.rail', "Agents"));

		this.header = append(this.rail, $('.agent-workspace-rail-header'));
		this.railToggleButton = append(this.header, $('button.agent-workspace-rail-toggle')) as HTMLButtonElement;
		this.railToggleButton.type = 'button';
		this._register(addDisposableListener(this.railToggleButton, EventType.CLICK, () => this.toggleRail()));
		this.updateRailToggle();
		// One control type for the whole header. This used to be four different
		// widgets stacked together - a pill action, a live text input, a segmented
		// two-button toggle and an icon action - which is why the top of the rail
		// read as noisy next to the reference panels. Every entry below is the same
		// row: one height, one icon column, one hover treatment.
		this.createAction(this.header, Codicon.add, nls.localize('agentWorkspace.newAgent', "New Agent"), () => this.openNewSession());

		// Search OPENS a picker; it is not a permanently-mounted text field. An
		// always-visible input reads as a form control in what is otherwise a
		// navigation column, and it was the single largest structural difference
		// from Cursor/ChatGPT's sidebars. The filter machinery is unchanged - only
		// how the query is collected moves. The hidden input remains the state
		// holder so `overrideExclude` and the existing update path keep working.
		const searchInput = this.searchInput = append(this.header, $('input.agent-workspace-search-input')) as HTMLInputElement;
		searchInput.type = 'search';
		searchInput.tabIndex = -1;
		searchInput.setAttribute('aria-hidden', 'true');
		searchInput.spellcheck = false;
		this.searchAction = this.createAction(this.header, Codicon.search, nls.localize('agentWorkspace.search', "Search"), () => this.promptForSearch());

		this.createAction(this.header, Codicon.settingsGear, nls.localize('agentWorkspace.customize', "Customize"), () => this.openSettingsMode());
		this.projectsAction = this.createAction(this.header, Codicon.folderLibrary, nls.localize('agentWorkspace.projects', "Projects"), () => this.showProjects());

		// Workspaces is a normal row that switches the list in place. The old
		// Current/Workspaces segmented pair forced a side-by-side control for what
		// is really one destination, and it was the most visually conflicting
		// element in the header. setRailScope stays as the state machine; only its
		// trigger changed.
		this.workspacesScopeButton = this.createAction(this.header, Codicon.repo, nls.localize('agentWorkspace.scope.workspaces', "Workspaces"), () => this.toggleWorkspaceScope()) as HTMLButtonElement;
		this.updateScopeButtons();

		this.listHost = append(this.rail, $('.agent-workspace-session-list'));
		this._register(addDisposableListener(searchInput, EventType.INPUT, () => {
			void this.sessionsControl?.update();
		}));
		this.compactActivityHost = append(this.rail, $('.agent-workspace-compact-activity'));
		this.compactActivityHost.setAttribute('aria-label', nls.localize('agentWorkspace.compactSessions', "Agent activity"));

		this.footer = append(this.rail, $('.agent-workspace-rail-footer'));
		this.mountAccountFooter();
		this._register(this.accountService.onDidChangeState(() => this.renderAccountFooter()));

		this.launcher = append(parent, $('.agent-workspace-utility-launcher'));
		this.launcher.setAttribute('aria-label', nls.localize('agentWorkspace.utilityLauncher', "Workspace tools"));
		this.createLauncherButton(Codicon.globe, nls.localize('agentWorkspace.browser', "Browser"), () => this.openBrowser());
		this.createLauncherButton(Codicon.terminal, nls.localize('agentWorkspace.terminal', "Terminal"), () => this.openTerminal());
		this.createLauncherButton(Codicon.files, nls.localize('agentWorkspace.files', "Files"), () => this.openFiles());
		this.focusButton = this.createLauncherButton(Codicon.layoutSidebarRightOff, nls.localize('agentWorkspace.toggleFocus', "Focus or restore chat"), () => this.toggleChatFocus());

		// No ambient Turbo/V-Go chips here on purpose. Two lettered pills bolted under
		// the icon launcher read as debug badges rather than product chrome, and the
		// same state is already reachable from the status bar. The rail stays icons-only.

		this._register(this.editorGroupsService.onDidRemoveGroup(group => {
			if (group.id === this.utilityGroup?.id) {
				this.clearUtilityGroup();
			}
			this.updateUtilityState();
		}));
		this._register(this.editorGroupsService.onDidChangeGroupMaximized(() => this.updateUtilityState()));
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.renderCompactActivity()));
		this._register(this.primaryGroup.onDidActiveEditorChange(() => {
			this.renderCompactActivity();
			this.updateChatHeader();

			// The chat group holds one chat and nothing else. Locking it turns most
			// opens away, but a reveal of an already-open editor, a `ForceReveal`
			// input or a restored layout can still land a file, Browser or Terminal
			// in the chat slot. Normalization is otherwise only scheduled once when
			// the shell is enabled, so without this the misplaced editor sits on top
			// of the chat until the next time Agent Workspace is entered.
			if (this.enabled && this.primaryGroup.editors.some(editor => !(editor instanceof ChatEditorInput))) {
				this.schedulePrimaryGroupNormalization();
			}
		}));
		this._register(this.primaryGroup.onDidCloseEditor(event => {
			if (!this.enabled || !(event.editor instanceof ChatEditorInput)) {
				return;
			}
			const resource = event.editor.sessionResource ?? event.editor.resource;
			this.parent.ownerDocument.defaultView?.setTimeout(() => {
				if (!this.enabled || !this.parent.isConnected || this.restoringPrimaryChat ||
					this.primaryGroup.editors.some(editor => editor instanceof ChatEditorInput)) {
					return;
				}
				this.restoringPrimaryChat = true;
				this.runSafely(async () => {
					try {
						await this.openSession(resource);
					} finally {
						this.restoringPrimaryChat = false;
					}
				});
			}, 0);
		}));

		this.setEnabled(false);
		this.renderCompactActivity();
	}

	private ensureSessionsControl(): AgentSessionsControl {
		if (this.sessionsControl) {
			return this.sessionsControl;
		}

		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			groupResults: () => {
				if (this.railScope === 'workspaces') {
					return AgentSessionsGrouping.Repository;
				}
				return AgentSessionsGrouping.Capped;
			},
			overrideExclude: session => {
				const query = this.searchInput.value.trim().toLowerCase();
				if (query && !(session.label ?? '').toLowerCase().includes(query)) {
					return true;
				}

				// Project filter: when a project is active, only show its members
				if (this._activeProjectFilter) {
					const membership = this.agentProjectService.getMembership(session.resource.toString());
					if (membership !== this._activeProjectFilter) {
						return true;
					}
					return undefined;
				}

				if (this.railScope === 'workspaces') {
					return undefined;
				}

				const root = this.selectedWorkspaceRoot ?? this.getCurrentWorkspaceRoot();
				const sessionRoot = this.getSessionWorkspaceRoot(session.resource);
				if (!root) {
					return undefined;
				}
				if (!sessionRoot) {
					return true;
				}
				return !extUriBiasedIgnorePathCase.isEqualOrParent(sessionRoot, root);
			},
		}));
		this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.listHost, {
			source: 'agentWorkspace',
			filter,
			disableHover: true,
			overrideStyles: {
				listBackground: 'transparent',
				treeStickyScrollBackground: 'transparent',
			},
			getHoverPosition: () => HoverPosition.RIGHT,
			trackActiveEditorSession: () => true,
			useStatusOnlyIcons: true,
			showActivityIndicator: true,
			showSectionIcons: true,
			repositoryGroupLimit: 8,
			groupPinnedSessions: true,
			// Rows are ONE line now (title only; the timestamp is a11y-only), so
			// this drops 52 -> 40 to match --ags-row-height in
			// agentWorkspaceShell.css. These two numbers MUST move together: the
			// list measures the row in JS and the CSS paints it, so a mismatch
			// either clips the title or leaves dead space under it.
			//
			// This also fixes the section rhythm. Gemini runs row 40 / section 44
			// = 1.10, so the gap between groups is LARGER than a row and the
			// groups separate on space alone. At 52/44 = 0.85 the gap was smaller
			// than a row, which is why the list read as one undifferentiated run
			// no matter how the header was styled.
			itemHeight: 40,
			// 22 (base header) + 22 (the rail's padding-top group gap in
			// agentWorkspaceShell.css). The list measures this row in JS, so without
			// paying for that gap here the label renders past the row box and the
			// bottom half of "MORE" is clipped off.
			sectionHeight: 44,
			collapseOlderSections: () => this.railScope === 'workspaces',
			overrideSessionOpen: async resource => this.openSession(resource),
		}));
		return this.sessionsControl;
	}

	/* Search collects its query through a picker instead of a mounted input.

		The list already filters through `overrideExclude`, which reads
		`this.searchInput.value` - so the input survives as the state holder and
		nothing in the filter path changes. Only the collection UI moved.

		Live-updating as the user types keeps the instant-filter feel of the old
		input; the difference is purely that the field is summoned rather than
		permanently occupying a row of navigation chrome. */
	private async promptForSearch(): Promise<void> {
		const input = this.quickInputService.createInputBox();
		const store = new DisposableStore();
		try {
			input.placeholder = nls.localize('agentWorkspace.searchAgents', "Search agents");
			input.value = this.searchInput.value;
			const apply = (value: string) => {
				this.searchInput.value = value;
				this.updateSearchAffordance();
				void this.sessionsControl?.update();
			};
			store.add(input.onDidChangeValue(apply));
			store.add(input.onDidAccept(() => input.hide()));
			await new Promise<void>(resolve => {
				store.add(input.onDidHide(() => resolve()));
				input.show();
			});
		} finally {
			store.dispose();
			input.dispose();
		}
	}

	/* The search row carries its own active state because the query is no longer
		visible in the header. Without this a filtered list looks identical to an
		unfiltered one, which is the main risk of moving search behind a picker. */
	private updateSearchAffordance(): void {
		const active = this.searchInput.value.trim().length > 0;
		this.searchAction.classList.toggle('active', active);
		const label = active
			? nls.localize('agentWorkspace.searchActive', "Search: {0}", this.searchInput.value.trim())
			: nls.localize('agentWorkspace.search', "Search");
		this.searchAction.title = label;
		this.searchAction.setAttribute('aria-label', label);
		const labelElement = this.searchAction.querySelector('.agent-workspace-action-label');
		if (labelElement) {
			labelElement.textContent = active ? this.searchInput.value.trim() : nls.localize('agentWorkspace.search', "Search");
		}
	}

	/* One row, two destinations - replaces the segmented Current/Workspaces pair.
		The scope state machine is untouched; this only flips between its two values
		in place so the workspace list opens without a side-by-side control. */
	private toggleWorkspaceScope(): void {
		this.setRailScope(this.railScope === 'workspaces' ? 'current' : 'workspaces');
	}

	/* Projects reuses the existing section machinery: the list already groups by
		repository (`repositoryGroupLimit`), so a project IS a named group. Until
		explicit membership lands, this surfaces the repositories the sessions
		already belong to and scopes the list to the chosen one - which is the
		useful half of the feature and needs no new persistence. */
	/** Show projects management: create new, scope to existing, or assign
	 *  sessions. Uses the persistent AgentProjectService. */
	private async showProjects(): Promise<void> {
		const projects = this.agentProjectService.getProjects();

		// Count sessions per project
		const countMap = new Map<string, number>();
		for (const session of this.agentSessionsService.model.sessions) {
			const pid = this.agentProjectService.getMembership(session.resource.toString());
			if (pid) {
				countMap.set(pid, (countMap.get(pid) ?? 0) + 1);
			}
		}

		// Current chat's project membership
		const currentSession = this.primaryGroup.activeEditor;
		const currentUri = currentSession instanceof ChatEditorInput ? currentSession.sessionResource?.toString() : undefined;
		const currentProjectId = currentUri ? this.agentProjectService.getMembership(currentUri) : undefined;

		type ProjectPick = IQuickPickItem & { projectId?: string; action?: 'create' | 'all' | 'assign' | 'unassign' | 'rename' | 'delete' };
		const picks: ProjectPick[] = [];

		// Header: show/clear filter
		picks.push({
			id: 'all',
			label: `$(list-flat) ${nls.localize('agentWorkspace.projects.all', "All chats")}`,
			description: this._activeProjectFilter ? nls.localize('agentWorkspace.projects.clearFilter', "Clear filter") : undefined,
			action: 'all' as const,
		});

		// Projects list
		for (const p of projects) {
			const count = countMap.get(p.id) ?? 0;
			const isActive = this._activeProjectFilter === p.id;
			const isCurrent = currentProjectId === p.id;
			picks.push({
				id: p.id,
				label: `$(${p.icon}) ${p.name}`,
				description: `${count} ${count === 1 ? 'chat' : 'chats'}${isActive ? '  $(check)' : ''}${isCurrent ? '  $(arrow-right) current' : ''}`,
				projectId: p.id,
			});
		}

		// Assign/unassign current chat
		if (currentUri) {
			picks.push({ type: 'separator', label: nls.localize('agentWorkspace.projects.currentChat', "Current Chat") } as any);
			if (currentProjectId) {
				const proj = this.agentProjectService.getProject(currentProjectId);
				picks.push({
					id: 'unassign',
					label: `$(close) ${nls.localize('agentWorkspace.projects.unassign', "Remove from {0}", proj?.name ?? 'project')}`,
					action: 'unassign' as const,
				});
			}
			for (const p of projects) {
				if (p.id !== currentProjectId) {
					picks.push({
						id: `assign-${p.id}`,
						label: `$(arrow-right) ${nls.localize('agentWorkspace.projects.assignTo', "Move to {0}", p.name)}`,
						action: 'assign' as const,
						projectId: p.id,
					});
				}
			}
		}

		// Create new
		picks.push({ type: 'separator', label: '' } as any);
		picks.push({
			id: 'create',
			label: `$(add) ${nls.localize('agentWorkspace.projects.create', "Create Project")}`,
			action: 'create' as const,
		});

		const picked = await this.quickInputService.pick(picks, {
			placeHolder: this._activeProjectFilter
				? nls.localize('agentWorkspace.projects.placeholderFiltered', "Viewing: {0} — pick to switch or manage", this.agentProjectService.getProject(this._activeProjectFilter)?.name ?? 'project')
				: nls.localize('agentWorkspace.projects.placeholder', "Choose a project to scope chats"),
		});
		if (!picked) { return; }

		if (picked.action === 'create') {
			await this.createProjectFlow();
			return;
		}

		if (picked.action === 'all') {
			this._activeProjectFilter = undefined;
			void this.sessionsControl?.update();
			this.updateProjectsAffordance();
			return;
		}

		if (picked.action === 'assign' && picked.projectId && currentUri) {
			this.agentProjectService.setMembership(currentUri, picked.projectId);
			void this.sessionsControl?.update();
			return;
		}

		if (picked.action === 'unassign' && currentUri) {
			this.agentProjectService.setMembership(currentUri, undefined);
			void this.sessionsControl?.update();
			return;
		}

		if (picked.projectId) {
			this._activeProjectFilter = picked.projectId;
			void this.sessionsControl?.update();
			this.updateProjectsAffordance();
			return;
		}
	}

	/** Visual indicator on the Projects button when a filter is active. */
	private projectsAction: HTMLElement | undefined;
	private updateProjectsAffordance(): void {
		if (!this.projectsAction) { return; }
		const active = !!this._activeProjectFilter;
		this.projectsAction.classList.toggle('active', active);
		const project = active ? this.agentProjectService.getProject(this._activeProjectFilter!) : undefined;
		const label = project
			? nls.localize('agentWorkspace.projects.active', "Project: {0}", project.name)
			: nls.localize('agentWorkspace.projects', "Projects");
		this.projectsAction.title = label;
		this.projectsAction.setAttribute('aria-label', label);
		const labelEl = this.projectsAction.querySelector('.agent-workspace-action-label');
		if (labelEl) {
			labelEl.textContent = project ? project.name : nls.localize('agentWorkspace.projects', "Projects");
		}
	}

	private _activeProjectFilter: string | undefined;

	/** Interactive create-project flow: name → done. Icon and colour auto-assigned. */
	private async createProjectFlow(): Promise<void> {
		const name = await this.quickInputService.input({
			placeHolder: nls.localize('agentWorkspace.projects.name', "Project name"),
			prompt: nls.localize('agentWorkspace.projects.namePrompt', "Create a new project to organize your chats"),
		});
		if (!name) { return; }
		this.agentProjectService.createProject(name);
	}

	private mountAccountFooter(): void {
		this.footer.setAttribute('role', 'button');
		this.footer.tabIndex = 0;
		this.footer.title = nls.localize('agentWorkspace.accountMenu', "Account and settings");

		this.accountAvatar = append(this.footer, $('.agent-workspace-account-avatar'));
		const meta = append(this.footer, $('.agent-workspace-account-meta'));
		this.accountName = append(meta, $('span.agent-workspace-account-name'));
		this.accountPlan = append(meta, $('span.agent-workspace-account-plan'));

		const gear = append(this.footer, $('button.agent-workspace-account-gear')) as HTMLButtonElement;
		gear.type = 'button';
		gear.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));
		gear.setAttribute('aria-label', nls.localize('agentWorkspace.accountSettings', "Open account settings"));
		gear.title = nls.localize('agentWorkspace.accountSettings', "Open account settings");

		const openMenu = () => this.openAccountMenu();
		this._register(addDisposableListener(this.footer, EventType.CLICK, event => {
			if ((event.target as HTMLElement).closest('.agent-workspace-account-gear')) {
				return;
			}
			openMenu();
		}));
		this._register(addDisposableListener(this.footer, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			// Match the click listener above: the gear is its own control, and
			// preventDefault() here would also cancel its native activation.
			if ((event.target as HTMLElement).closest('.agent-workspace-account-gear')) {
				return;
			}
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				openMenu();
			}
		}));
		this._register(addDisposableListener(gear, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.runSafely(() => this.openSettingsMode('account'));
		}));
		this.renderAccountFooter();
	}

	private renderAccountFooter(): void {
		if (!this.accountAvatar || !this.accountName || !this.accountPlan) {
			return;
		}
		const state = this.accountService.state;
		this.accountName.textContent = state.displayName || nls.localize('agentWorkspace.guest', "Guest");
		// A revoked login keeps the plan, so say what is actually wrong here rather than
		// letting the rail read as healthy while every request fails.
		this.accountPlan.textContent = state.sessionExpired
			? nls.localize('agentWorkspace.signInAgain', "Sign in again")
			: (state.tierLabel || nls.localize('agentWorkspace.freePlan', "Free"));
		this.accountPlan.classList.toggle('agent-workspace-account-attention', !!state.sessionExpired);
		this.accountAvatar.style.backgroundImage = `url("${state.avatarUrl ?? v3ChromeAvatarUrl()}")`;
	}

	private openAccountMenu(): void {
		this.accountMenuStore.clear();
		const store = new DisposableStore();
		this.accountMenuStore.value = store;

		// Theme variables are emitted scoped to `.monaco-workbench`, so a menu parented
		// to <body> resolves every `var(--vscode-*)` to nothing and renders unreadable.
		const menuHost = this.footer.closest<HTMLElement>('.monaco-workbench') ?? this.footer.ownerDocument.body;
		const menu = append(menuHost, $('.agent-workspace-account-menu'));
		menu.setAttribute('role', 'menu');
		store.add({ dispose: () => menu.remove() });

		const close = () => this.accountMenuStore.clear();
		const openUrl = (url: string) => {
			void this.openerService.open(URI.parse(url));
			close();
		};
		const runCommand = (commandId: string, ...args: unknown[]) => {
			void this.commandService.executeCommand(commandId, ...args);
			close();
		};

		type MenuRow = { kind: 'item'; icon: ThemeIcon; label: string; run: () => void } | { kind: 'separator' };
		const accountAction: MenuRow = this.accountService.state.status === 'signedIn'
			? { kind: 'item', icon: Codicon.signOut, label: nls.localize('agentWorkspace.logOut', "Log Out"), run: () => { this.accountService.signOut(); close(); } }
			: { kind: 'item', icon: Codicon.signIn, label: nls.localize('agentWorkspace.signIn', "Sign In"), run: () => { this.accountService.signIn(); close(); } };
		const rows: MenuRow[] = [
			// Real pairing, not the docs page it used to open.
			{ kind: 'item', icon: Codicon.deviceMobile, label: nls.localize('agentWorkspace.getMobile', "Connect to Mobile"), run: () => runCommand('v3code.remote.showQr') },
			{ kind: 'item', icon: Codicon.book, label: nls.localize('agentWorkspace.docs', "Docs"), run: () => openUrl(DOCS_URL) },
			{ kind: 'item', icon: Codicon.keyboard, label: nls.localize('agentWorkspace.shortcuts', "Shortcuts"), run: () => runCommand('workbench.action.openGlobalKeybindings') },
			{ kind: 'item', icon: Codicon.mail, label: nls.localize('agentWorkspace.contact', "Contact Us"), run: () => openUrl('mailto:daniel@publishd.app?subject=V3Code%20Contact') },
			{ kind: 'separator' },
			accountAction,
		];
		let firstItem: HTMLElement | undefined;

		for (const row of rows) {
			if (row.kind === 'separator') {
				append(menu, $('.agent-workspace-account-menu-separator'));
				continue;
			}
			const item = append(menu, $('.agent-workspace-account-menu-item'));
			firstItem ??= item;
			item.setAttribute('role', 'menuitem');
			item.tabIndex = 0;
			const icon = append(item, $('span.agent-workspace-account-menu-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(row.icon));
			append(item, $('span')).textContent = row.label;
			const activate = (event: Event) => {
				EventHelper.stop(event, true);
				row.run();
			};
			store.add(addDisposableListener(item, EventType.CLICK, activate));
			store.add(addDisposableListener(item, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter' || event.key === ' ') {
					activate(event);
				}
			}));
		}

		const rect = this.footer.getBoundingClientRect();
		const win = this.footer.ownerDocument.defaultView;
		menu.style.position = 'fixed';
		menu.style.left = `${Math.max(8, rect.left + 8)}px`;
		menu.style.bottom = `${Math.max(8, (win?.innerHeight ?? rect.bottom) - rect.top + 6)}px`;
		menu.style.width = `${Math.max(260, rect.width - 16)}px`;
		menu.style.zIndex = '10000';

		const dismiss = (event: MouseEvent) => {
			if (!menu.contains(event.target as Node) && !this.footer.contains(event.target as Node)) {
				close();
			}
		};
		this.footer.ownerDocument.addEventListener('mousedown', dismiss, true);
		store.add({ dispose: () => this.footer.ownerDocument.removeEventListener('mousedown', dismiss, true) });
		firstItem?.focus();
	}

	private setRailScope(scope: AgentWorkspaceRailScope, collapseWorkspaceGroups = true): void {
		const changed = this.railScope !== scope;
		this.railScope = scope;
		this.updateScopeButtons();
		this.parent.classList.toggle('agent-workspace-browsing-workspaces', scope === 'workspaces');
		void this.sessionsControl?.update().then(() => {
			if (changed && scope === 'workspaces' && collapseWorkspaceGroups) {
				this.sessionsControl?.collapseAllSections();
			}
		});
	}

	/* Single row now, so this reflects state on one element instead of keeping a
		pair of segmented buttons in sync. aria-pressed stays: the row is still a
		toggle, it just no longer needs a second button to say so. */
	private updateScopeButtons(): void {
		const active = this.railScope === 'workspaces';
		this.workspacesScopeButton.classList.toggle('active', active);
		this.workspacesScopeButton.setAttribute('aria-pressed', String(active));
	}

	private createAction(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => Promise<unknown> | void): HTMLElement {
		const row = append(parent, $('.agent-workspace-action'));
		row.setAttribute('role', 'button');
		row.setAttribute('aria-label', label);
		row.title = label;
		row.tabIndex = 0;
		const iconElement = append(row, $('span.agent-workspace-action-icon'));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		append(row, $('span.agent-workspace-action-label')).textContent = label;
		const activate = () => this.runSafely(run);
		this._register(addDisposableListener(row, EventType.CLICK, activate));
		this._register(addDisposableListener(row, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				activate();
			}
		}));
		return row;
	}

	private createLauncherButton(icon: ThemeIcon, label: string, run: () => Promise<unknown> | void): HTMLButtonElement {
		const button = append(this.launcher, $('button.agent-workspace-utility-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.title = label;
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		this._register(addDisposableListener(button, EventType.CLICK, () => this.runSafely(run)));
		return button;
	}

	private updateChatHeader(): void {
		if (this.sessionDismissed) {
			this.chatHeaderLabel.textContent = nls.localize('agentWorkspace.landing', "Agents");
			return;
		}
		const active = this.primaryGroup.activeEditor;
		this.chatHeaderLabel.textContent = active instanceof ChatEditorInput
			? active.getName()
			: nls.localize('agentWorkspace.chat', "Chat");
	}

	private toggleRail(): void {
		if (this.compact) {
			this.railPreference = 'expanded';
			const part = this.editorGroupsService.getPart(this.primaryGroup);
			const utilityGroup = this.findUtilityGroup();
			const currentPrimaryWidth = part.getSize(this.primaryGroup).width;
			if (utilityGroup && currentPrimaryWidth < MIN_EXPANDED_PRIMARY_WIDTH &&
				part.contentDimension.width >= MIN_EXPANDED_PRIMARY_WIDTH + MIN_UTILITY_PANE_WIDTH) {
				// Expanding the rail must move the native editor-group divider instead
				// of consuming the chat column. This keeps the three-pane contract:
				// Agent rail | readable chat | utility surface.
				part.setSize(this.primaryGroup, {
					width: MIN_EXPANDED_PRIMARY_WIDTH,
					height: part.contentDimension.height,
				});
			}
		} else {
			this.railPreference = 'collapsed';
		}
		this.layout(this.lastDimension.height, this.lastDimension.width);
		this._onDidRequestLayout.fire();
	}

	private updateRailToggle(): void {
		const collapsing = !this.compact;
		const label = collapsing
			? nls.localize('agentWorkspace.collapseRail', "Collapse Agents")
			: nls.localize('agentWorkspace.expandRail', "Expand Agents");
		this.railToggleButton.textContent = collapsing ? '<<' : '>>';
		this.railToggleButton.title = label;
		this.railToggleButton.setAttribute('aria-label', label);
	}

	private runSafely(run: () => Promise<unknown> | void): void {
		Promise.resolve(run()).catch(error => this.notificationService.error(error));
	}

	private async showIde(): Promise<void> {
		const workspace = this.workspaceContextService.getWorkspace();
		await this.nativeHostService.swapAgentWorkspaceWindow({
			workspaceUri: workspace.configuration ?? undefined,
			folderUri: workspace.configuration ? undefined : workspace.folders.at(0)?.uri,
			agentWorkspace: false,
		});
	}

	private async openNewSession(): Promise<void> {
		await this.openSession(LocalChatSessionUri.getNewSessionUri());
	}

	private async openSession(resource: URI): Promise<void> {
		this.showSession();
		this.selectedWorkspaceRoot = this.getSessionWorkspaceRoot(resource) ?? this.selectedWorkspaceRoot ?? this.getCurrentWorkspaceRoot();
		this.setRailScope('current', false);
		this.refreshContextBar();
		const options = { pinned: true, sticky: true, agentWorkspace: true } satisfies IChatEditorOptions;
		const input = this.instantiationService.createInstance(ChatEditorInput, resource, options);
		const openChats = () => this.primaryGroup.editors.filter((editor): editor is ChatEditorInput => editor instanceof ChatEditorInput);

		// The shell owns exactly one chat slot. Opening the new session first and
		// closing the old one afterwards leaves a second chat tab in the group for
		// the duration of the open, and leaves it there permanently whenever the
		// close is vetoed by a pending edit session. Replacing in place keeps the
		// slot atomic and inherits the replaced tab's index.
		const alreadyOpen = openChats().find(editor => editor.matches(input));
		if (alreadyOpen) {
			input.dispose();
			await this.primaryGroup.openEditor(alreadyOpen, options);
		} else {
			const superseded = openChats();
			if (superseded.length) {
				await this.primaryGroup.replaceEditors([{ editor: superseded[0], replacement: input, options }]);
			} else {
				await this.primaryGroup.openEditor(input, options);
			}
		}

		// Re-read the group only now. A chat input's session resource is still being
		// settled while its model resolves, and a second rail click can land during
		// the await, so any list captured before this point both misses tabs and
		// mis-identifies them. Whatever ended up active is the slot; nothing else
		// belongs in the chat group.
		const active = this.primaryGroup.activeEditor;
		const leftovers = openChats().filter(editor => editor !== active);
		if (leftovers.length) {
			await this.primaryGroup.closeEditors(leftovers, { preserveFocus: true });
		}
		await this.retargetVisibleUtilitySurface();
		this.renderCompactActivity();
	}

	private getCurrentWorkspaceRoot(): URI | undefined {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private getSessionWorkspaceRoot(resource: URI): URI | undefined {
		const workingDirectoryPath = this.agentSessionsService.model.getSession(resource)?.metadata?.workingDirectoryPath;
		return typeof workingDirectoryPath === 'string' && workingDirectoryPath ? URI.file(workingDirectoryPath) : undefined;
	}

	private async retargetVisibleUtilitySurface(): Promise<void> {
		await this.waitForPrimaryGroupNormalization();
		const active = this.utilityGroup?.activeEditor;
		if (active instanceof AgentWorkspaceFilesEditorInput || active instanceof AgentWorkspaceFilesCompositeInput) {
			await this.openFiles(true);
		} else if (active instanceof AgentWorkspaceTerminalEditorInput) {
			await this.openTerminal(true);
		}
	}

	private getOrCreateUtilityGroup(): IEditorGroup {
		const part = this.editorGroupsService.getPart(this.primaryGroup);
		const knownGroup = this.utilityGroup && part.groups.includes(this.utilityGroup) ? this.utilityGroup : undefined;
		const immediatelyRight = part.findGroup({ direction: GroupDirection.RIGHT }, this.primaryGroup);
		const utilityGroup = knownGroup
			?? immediatelyRight
			?? part.getGroups(GroupsOrder.GRID_APPEARANCE).find(group => group.id !== this.primaryGroup.id);
		this.setUtilityGroup(utilityGroup ?? part.addGroup(this.primaryGroup, GroupDirection.RIGHT));
		if (!knownGroup && !immediatelyRight && !utilityGroup) {
			const preferredWidth = this.getPreferredUtilityWidth(part.contentDimension.width, 0.44, 360);
			part.setSize(this.utilityGroup!, { width: preferredWidth, height: part.contentDimension.height });
		}

		if (part.hasMaximizedGroup()) {
			part.toggleMaximizeGroup(this.primaryGroup);
		}
		this.ensureReadablePrimaryPane(part);
		this.updateUtilityState();
		return this.utilityGroup!;
	}

	private getPreferredUtilityWidth(totalWidth: number, ratio: number, preferredMinimum: number): number {
		const desiredWidth = Math.max(preferredMinimum, Math.round(totalWidth * ratio));
		const maximumWidth = Math.max(MIN_UTILITY_PANE_WIDTH, totalWidth - MIN_COMPACT_PRIMARY_WIDTH);
		return Math.min(desiredWidth, maximumWidth);
	}

	private ensureReadablePrimaryPane(part = this.editorGroupsService.getPart(this.primaryGroup)): void {
		const utilityGroup = this.findUtilityGroup();
		if (!utilityGroup || part.hasMaximizedGroup()) {
			return;
		}

		const availablePrimaryWidth = Math.max(0, part.contentDimension.width - MIN_UTILITY_PANE_WIDTH);
		const minimumPrimaryWidth = Math.min(MIN_COMPACT_PRIMARY_WIDTH, availablePrimaryWidth);
		const currentPrimarySize = part.getSize(this.primaryGroup);
		if (currentPrimarySize.width < minimumPrimaryWidth) {
			part.setSize(this.primaryGroup, {
				width: minimumPrimaryWidth,
				height: part.contentDimension.height,
			});
		}
	}

	private setUtilityGroup(group: IEditorGroup): void {
		if (this.utilityGroup?.id === group.id) {
			return;
		}
		this.utilityGroupDisposables.clear();
		this.utilityGroup = group;
		this.utilityGroupDisposables.add(group.onDidActiveEditorChange(() => {
			this.runSafely(() => this.normalizeUtilityEditor());
		}));
	}

	private clearUtilityGroup(): void {
		this.utilityGroupDisposables.clear();
		this.utilityGroup = undefined;
	}

	private async normalizeUtilityEditor(): Promise<void> {
		const group = this.utilityGroup;
		const active = group?.activeEditor;
		const root = this.selectedWorkspaceRoot ?? this.getCurrentWorkspaceRoot();
		if (!group || !active || !root || this.normalizingUtilityEditor ||
			active instanceof BrowserEditorInput ||
			active instanceof AgentWorkspaceTerminalEditorInput ||
			active instanceof AgentWorkspaceFilesEditorInput ||
			active instanceof AgentWorkspaceFilesCompositeInput ||
			!active.resource || !isEqualOrParent(active.resource, root)) {
			return;
		}

		this.normalizingUtilityEditor = true;
		try {
			const oldFileSurfaces = group.editors.filter(editor => editor !== active &&
				(editor instanceof AgentWorkspaceFilesEditorInput || editor instanceof AgentWorkspaceFilesCompositeInput));
			if (oldFileSurfaces.length && !(await group.closeEditors(oldFileSurfaces, { preserveFocus: true }))) {
				await group.closeEditor(active, { preserveFocus: true });
				await group.openEditor(oldFileSurfaces[0], { pinned: true });
				return;
			}

			const fileInput: IUntypedFileEditorInput = { resource: active.resource, forceFile: true };
			const file = await this.textEditorService.resolveTextEditor(fileInput);
			const replacement = new AgentWorkspaceFilesCompositeInput(root, file, this.editorService);
			const options: IEditorOptions = {
				pinned: true,
				viewState: { primary: {}, secondary: {}, focus: SideBySideEditor.SECONDARY, ratio: 0.72 },
			};
			await group.replaceEditors([{
				editor: active,
				replacement,
				options,
			}]);
		} finally {
			this.normalizingUtilityEditor = false;
		}
	}

	private async runInUtilityGroup(commandId: string, argument?: unknown): Promise<void> {
		await this.waitForPrimaryGroupNormalization();
		const utilityGroup = this.getOrCreateUtilityGroup();
		this.editorGroupsService.getPart(utilityGroup).activateGroup(utilityGroup);
		utilityGroup.focus();
		await this.commandService.executeCommand(commandId, argument);
	}

	private async openSettingsMode(initialTab = 'all'): Promise<void> {
		await this.waitForPrimaryGroupNormalization();
		const utilityGroup = this.getOrCreateUtilityGroup();
		const existing = utilityGroup.editors.find(editor => editor instanceof VoidSettingsInput);
		this.storageService.store(VOID_SETTINGS_INITIAL_TAB_KEY, initialTab, StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (existing) {
			await utilityGroup.openEditor(existing, { pinned: true });
			return;
		}
		await utilityGroup.openEditor(this.instantiationService.createInstance(VoidSettingsInput), { pinned: true });
	}

	private async openBrowser(): Promise<void> {
		await this.waitForPrimaryGroupNormalization();
		const utilityGroup = this.getOrCreateUtilityGroup();
		const existing = utilityGroup.editors.find(editor => editor instanceof BrowserEditorInput);
		if (existing) {
			await utilityGroup.openEditor(existing, { pinned: true });
			return;
		}
		await this.runInUtilityGroup('workbench.action.browser.open');
	}

	private async openTerminal(preserveFocus = false): Promise<void> {
		await this.waitForPrimaryGroupNormalization();
		const root = this.selectedWorkspaceRoot ?? this.getCurrentWorkspaceRoot();
		const utilityGroup = this.getOrCreateUtilityGroup();
		const existing = utilityGroup.editors.find(editor => editor instanceof AgentWorkspaceTerminalEditorInput && isEqual(editor.root, root));
		if (existing) {
			await utilityGroup.openEditor(existing, { pinned: true, preserveFocus });
			return;
		}
		const oldTerminalSurfaces = utilityGroup.editors.filter(editor => editor instanceof AgentWorkspaceTerminalEditorInput);
		if (oldTerminalSurfaces.length) {
			await utilityGroup.closeEditors(oldTerminalSurfaces, { preserveFocus: true });
		}
		await utilityGroup.openEditor(new AgentWorkspaceTerminalEditorInput(root), { pinned: true, preserveFocus });
	}

	private async openFiles(preserveFocus = false): Promise<void> {
		await this.waitForPrimaryGroupNormalization();
		const root = this.selectedWorkspaceRoot ?? this.getCurrentWorkspaceRoot();
		if (!root) {
			this.notificationService.info(nls.localize('agentWorkspace.files.noWorkspace', "Open a folder to use the Agent workspace file tree."));
			return;
		}

		const utilityGroup = this.getOrCreateUtilityGroup();
		const existing = utilityGroup.editors.find(editor => editor instanceof AgentWorkspaceFilesCompositeInput && isEqual(editor.root, root));
		if (existing) {
			await utilityGroup.openEditor(existing, { pinned: true, preserveFocus });
			return;
		}
		const oldFileSurfaces = utilityGroup.editors.filter(editor =>
			editor instanceof AgentWorkspaceFilesEditorInput || editor instanceof AgentWorkspaceFilesCompositeInput
		);
		if (oldFileSurfaces.length && !(await utilityGroup.closeEditors(oldFileSurfaces, { preserveFocus: true }))) {
			return;
		}
		const file = await this.textEditorService.resolveTextEditor({ resource: undefined, forceUntitled: true });
		const input = new AgentWorkspaceFilesCompositeInput(root, file, this.editorService);
		await utilityGroup.openEditor(input, {
			pinned: true,
			preserveFocus,
			viewState: { primary: {}, secondary: {}, focus: SideBySideEditor.SECONDARY, ratio: 0.72 },
		});
		const part = this.editorGroupsService.getPart(utilityGroup);
		part.setSize(utilityGroup, {
			width: this.getPreferredUtilityWidth(part.contentDimension.width, 0.48, 420),
			height: part.contentDimension.height,
		});
	}

	bindSessionToWorkspace(model: IChatModel): void {
		if (!this.enabled) {
			return;
		}
		if (model.workingDirectory) {
			this.selectedWorkspaceRoot = model.workingDirectory;
			this.setRailScope('current', false);
			this.refreshContextBar();
			return;
		}
		const root = this.selectedWorkspaceRoot ?? this.getCurrentWorkspaceRoot();
		if (!root) {
			return;
		}
		model.setWorkingDirectory(root);
		void this.agentSessionsService.model.resolve(localChatSessionType);
	}

	setChatEmpty(empty: boolean): void {
		this.parent.classList.toggle('agent-workspace-empty', this.enabled && empty);
	}

	private dismissSession(): void {
		if (!this.enabled || this.sessionDismissed) {
			return;
		}
		this.sessionDismissed = true;
		this.parent.classList.add('agent-workspace-session-dismissed');
		this.interactiveSession?.setAttribute('aria-hidden', 'true');
		this.updateChatHeader();
		this.landingNewAgentButton.focus();
	}

	private showSession(): void {
		if (!this.sessionDismissed) {
			return;
		}
		this.sessionDismissed = false;
		this.parent.classList.remove('agent-workspace-session-dismissed');
		this.interactiveSession?.removeAttribute('aria-hidden');
		this.updateChatHeader();
	}

	private renderCompactActivity(): void {
		this.compactActivityDisposables.clear();
		clearNode(this.compactActivityHost);
		const activeResource = this.primaryGroup.activeEditor instanceof ChatEditorInput
			? this.primaryGroup.activeEditor.sessionResource
			: undefined;
		const sessions = this.agentSessionsService.model.sessions
			.filter(session => !session.isArchived())
			.sort((a, b) => {
				const activityDelta = Number(isSessionInProgressStatus(b.status)) - Number(isSessionInProgressStatus(a.status));
				return activityDelta || (b.timing.lastRequestStarted ?? b.timing.created) - (a.timing.lastRequestStarted ?? a.timing.created);
			})
			.slice(0, 8);

		for (const session of sessions) {
			const button = append(this.compactActivityHost, $('button.agent-workspace-compact-session')) as HTMLButtonElement;
			button.type = 'button';
			const working = isSessionInProgressStatus(session.status);
			const repository = getRepositoryName(session);
			button.classList.toggle('working', working);
			button.classList.toggle('attention', !working && !session.isRead());
			button.classList.toggle('active', activeResource?.toString() === session.resource.toString());
			button.title = repository ? `${session.label} — ${repository}` : session.label;
			button.setAttribute('aria-label', working
				? nls.localize('agentWorkspace.sessionWorking', "{0}, working", session.label)
				: session.label);
			const icon = append(button, $('span.agent-workspace-compact-session-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.chatSparkle));
			this.compactActivityDisposables.add(addDisposableListener(button, EventType.CLICK, () => this.runSafely(() => this.openSession(session.resource))));
		}
	}

	attachToChatInput(): void {
		if (this.contextBar) {
			return;
		}

		// eslint-disable-next-line no-restricted-syntax -- ChatWidget owns this subtree; this is its stable input host contract.
		const inputPart = this.parent.querySelector<HTMLElement>('.interactive-input-part');
		if (!inputPart) {
			return;
		}
		for (let element = inputPart.parentElement; element && element !== this.parent; element = element.parentElement) {
			if (element.classList.contains('interactive-session')) {
				this.interactiveSession = element;
				break;
			}
		}
		if (this.sessionDismissed) {
			this.interactiveSession?.setAttribute('aria-hidden', 'true');
		}

		// The workspace / branch / machine chips that used to sit here were
		// inert: createContextChip attaches no handler, so all three rendered
		// as buttons and did nothing when clicked. Above a composer they read
		// as the place you choose a worktree or switch local/cloud, which made
		// dead labels actively misleading rather than merely redundant - the
		// same facts are already in the rail and the window title.
		//
		// They come back when there is a real picker behind them (worktree,
		// branch and host selection at new-chat time). Until then the bar stays
		// empty: refreshContextBar/observeBranch are retained and no-op safely
		// via the null guards below, so wiring a picker is additive.
		this.contextBar = $('.agent-workspace-context-bar');
		inputPart.insertBefore(this.contextBar, inputPart.firstChild);
		this.refreshContextBar();
	}

	/** No-op while the context bar has no chips. Kept as the single entry point
		so a future worktree/branch/host picker re-populates the bar here rather
		than growing a second path. */
	private refreshContextBar(): void {
		this.contextStateDisposables.clear();
	}

	private toggleChatFocus(): void {
		const part = this.editorGroupsService.getPart(this.primaryGroup);
		if (!this.findUtilityGroup()) {
			return;
		}
		part.toggleMaximizeGroup(this.primaryGroup);
		this.updateUtilityState();
	}

	private findUtilityGroup(): IEditorGroup | undefined {
		const part = this.editorGroupsService.getPart(this.primaryGroup);
		const utilityGroup = this.utilityGroup && part.groups.includes(this.utilityGroup)
			? this.utilityGroup
			: part.findGroup({ direction: GroupDirection.RIGHT }, this.primaryGroup)
			?? part.getGroups(GroupsOrder.GRID_APPEARANCE).find(group => group.id !== this.primaryGroup.id);
		if (utilityGroup) {
			this.setUtilityGroup(utilityGroup);
		} else {
			this.clearUtilityGroup();
		}
		return utilityGroup;
	}

	private updateUtilityState(): void {
		const utilityGroup = this.findUtilityGroup();
		const part = this.editorGroupsService.getPart(this.primaryGroup);
		this.parent.classList.toggle('agent-workspace-has-utility', !!utilityGroup);
		this.primaryGroupElement?.classList.toggle('agent-workspace-primary-has-utility', !!utilityGroup);
		this.parent.classList.toggle('agent-workspace-chat-focused', !!utilityGroup && part.hasMaximizedGroup());
		this.focusButton.disabled = !utilityGroup;
	}

	/** True while this editor is hosting the Agent Workspace shell (rail + utility grid) rather than ordinary editor chat. */
	isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.parent.classList.toggle('agent-workspace-enabled', enabled);
		this.rail.setAttribute('aria-hidden', String(!enabled));
		this.chatHeader.setAttribute('aria-hidden', String(!enabled));
		this.launcher.setAttribute('aria-hidden', String(!enabled));
		if (enabled) {
			this.primaryGroup.lock(true);
			this.ensureSessionsControl().setVisible(this.visible && !this.compact);
			this.schedulePrimaryGroupNormalization();
			this.renderCompactActivity();
			this.updateUtilityState();
		} else {
			this.showSession();
			if (!this.primaryGroupInitiallyLocked) {
				this.primaryGroup.lock(false);
			}
			this.parent.classList.remove('agent-workspace-empty');
			this.sessionsControl?.setVisible(false);
		}
		this.layout(this.lastDimension.height, this.lastDimension.width);
		this._onDidRequestLayout.fire();
	}

	private schedulePrimaryGroupNormalization(): void {
		const predecessor = this.primaryGroupNormalization;
		const normalization = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve())
			.then(() => this.enabled ? this.normalizePrimaryGroup() : undefined)
			.catch(error => this.notificationService.error(error));
		this.primaryGroupNormalization = normalization;
		void normalization.finally(() => {
			if (this.primaryGroupNormalization === normalization) {
				this.primaryGroupNormalization = undefined;
			}
		});
	}

	private async waitForPrimaryGroupNormalization(): Promise<void> {
		while (this.primaryGroupNormalization) {
			const normalization = this.primaryGroupNormalization;
			await normalization;
			if (this.primaryGroupNormalization === normalization) {
				return;
			}
		}
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.sessionsControl?.setVisible(this.enabled && visible && !this.compact);
	}

	layout(height: number, width: number): { height: number; width: number } {
		// `width` and `height` are the rendered ChatEditor host's content box, not
		// the editor part's pre-split dimensions. The host already excludes the
		// structural pane gutter, so subtracting it again would make the renderer
		// narrower than the CSS grid it occupies.
		const containerHeight = height;
		const containerWidth = Math.max(0, width);
		this.lastDimension = { height: containerHeight, width };
		if (!this.enabled) {
			this.parent.style.removeProperty('--agent-workspace-rail-width');
			this.primaryGroupElement?.style.removeProperty('--agent-workspace-rail-width');
			return { height, width };
		}

		const mustCompact = containerWidth < MIN_EXPANDED_PRIMARY_WIDTH;
		this.compact = mustCompact || this.railPreference === 'collapsed' ||
			(this.railPreference === 'auto' && containerWidth < COMPACT_RAIL_BREAKPOINT);
		const railWidth = this.compact ? COMPACT_RAIL_WIDTH : EXPANDED_RAIL_WIDTH;
		this.parent.classList.toggle('agent-workspace-compact-rail', this.compact);
		this.parent.style.setProperty('--agent-workspace-rail-width', `${railWidth}px`);
		this.primaryGroupElement?.style.setProperty('--agent-workspace-rail-width', `${railWidth}px`);
		this.updateRailToggle();

		this.listHost.style.removeProperty('height');
		const listHeight = this.compact ? 0 : Math.max(0, containerHeight - this.header.offsetHeight - this.footer.offsetHeight);
		this.sessionsControl?.setVisible(this.visible && !this.compact);
		this.sessionsControl?.layout(listHeight, railWidth);

		return { height: containerHeight, width: Math.max(0, containerWidth - railWidth) };
	}

	private async normalizePrimaryGroup(): Promise<void> {
		const part = this.editorGroupsService.getPart(this.primaryGroup);
		try {
			const otherGroups = part.getGroups(GroupsOrder.GRID_APPEARANCE).filter(group => group.id !== this.primaryGroup.id);
			if (otherGroups.length) {
				const utilityGroup = otherGroups[0]!;
				this.setUtilityGroup(utilityGroup);
				for (const extraGroup of otherGroups.slice(1)) {
					for (const editor of [...extraGroup.editors]) {
						extraGroup.moveEditor(editor, utilityGroup, { pinned: true });
					}
					if (extraGroup.count === 0) {
						part.removeGroup(extraGroup);
					}
				}
			}

			const misplacedEditors = this.primaryGroup.editors.filter(editor => !(editor instanceof ChatEditorInput));
			if (misplacedEditors.length) {
				const utilityGroup = this.getOrCreateUtilityGroup();
				for (const editor of misplacedEditors) {
					this.primaryGroup.moveEditor(editor, utilityGroup, { pinned: true });
				}
			}

			const active = this.primaryGroup.activeEditor;
			if (active instanceof ChatEditorInput) {
				const staleChats = this.primaryGroup.editors.filter(editor => editor instanceof ChatEditorInput && editor !== active);
				if (staleChats.length) {
					await this.primaryGroup.closeEditors(staleChats, { preserveFocus: true });
				}
			}
		} finally {
			const utilityGroup = this.findUtilityGroup();
			if (utilityGroup && utilityGroup.count === 0) {
				this.clearUtilityGroup();
				part.removeGroup(utilityGroup);
			} else if (utilityGroup && part.hasMaximizedGroup()) {
				// A restored editor grid can retain the primary group's maximized state
				// from the IDE window. In Agent Workspace that leaves the Browser,
				// Terminal, or Files group alive but at 0x0 until the user resizes the
				// window. Entering the workspace always starts in the structural
				// two-pane layout; the focus control can maximize chat again afterward.
				part.toggleMaximizeGroup(this.primaryGroup);
			}
			this.ensureReadablePrimaryPane(part);
			this.updateUtilityState();
			// Moving editors and removing surplus groups changes the real editor cell
			// after ChatEditor has already received its first layout. Request a fresh
			// DOM measurement so restored sessions do not keep that startup geometry.
			this._onDidRequestLayout.fire();
		}
	}
}
