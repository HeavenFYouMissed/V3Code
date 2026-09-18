/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/agentWorkspaceTerminalEditor.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { basename, isEqual } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as nls from '../../../../../../nls.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../../terminal/browser/terminal.js';

const TERMINAL_EDITOR_SCHEME = 'v3-agent-terminal';

export class AgentWorkspaceTerminalEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.input.agentWorkspaceTerminal';
	static readonly EditorID = 'workbench.editor.agentWorkspaceTerminal';

	readonly resource: URI;

	constructor(readonly root: URI | undefined) {
		super();
		this.resource = URI.from({ scheme: TERMINAL_EDITOR_SCHEME, path: '/workspace', query: root?.toString() ?? '' });
	}

	override get typeId(): string { return AgentWorkspaceTerminalEditorInput.TypeID; }
	override get editorId(): string { return AgentWorkspaceTerminalEditorInput.EditorID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Singleton; }
	override getName(): string { return nls.localize('agentWorkspace.terminalEditor', "Terminal"); }
	override getDescription(): string | undefined { return this.root ? basename(this.root) : undefined; }
	override getIcon(): ThemeIcon { return Codicon.terminal; }

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof AgentWorkspaceTerminalEditorInput && isEqual(other.root, this.root));
	}
}

/**
 * A single Agent-workspace terminal surface. Native terminal instances remain
 * alive while Browser or Files is selected, but are switched by the rail
 * instead of becoming workbench editor tabs.
 */
export class AgentWorkspaceTerminalEditor extends EditorPane {

	static readonly ID = AgentWorkspaceTerminalEditorInput.EditorID;

	private readonly instanceDisposables = this._register(new DisposableStore());
	private readonly railDisposables = this._register(new DisposableStore());
	private root: HTMLElement | undefined;
	private terminalHost: HTMLElement | undefined;
	private railList: HTMLElement | undefined;
	private railCount: HTMLElement | undefined;
	private readonly instanceRoots = new Map<ITerminalInstance, string | undefined>();
	private activeInstance: ITerminalInstance | undefined;
	private lastDimension: Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@ITerminalInstanceService private readonly terminalInstanceService: ITerminalInstanceService,
	) {
		super(AgentWorkspaceTerminalEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.terminalEditorService.onDidChangeInstances(() => this.refreshInstances()));
		this._register(this.terminalEditorService.onDidChangeActiveInstance(instance => {
			if (instance && instance !== this.activeInstance && this.instanceMatchesInput(instance)) {
				this.activateInstance(instance, false);
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.agent-workspace-terminal-editor'));
		this.terminalHost = append(this.root, $('.agent-workspace-terminal-host'));

		const rail = append(this.root, $('.agent-workspace-terminal-rail'));
		const railHeader = append(rail, $('.agent-workspace-terminal-rail-header'));
		this.railCount = append(railHeader, $('span.agent-workspace-terminal-count'));
		const addButton = append(railHeader, $('button.agent-workspace-terminal-add')) as HTMLButtonElement;
		addButton.type = 'button';
		addButton.title = nls.localize('agentWorkspace.terminal.new', "New Terminal");
		addButton.setAttribute('aria-label', addButton.title);
		addButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		this._register(addDisposableListener(addButton, EventType.CLICK, () => void this.createTerminal()));
		this.railList = append(rail, $('.agent-workspace-terminal-list'));
	}

	override async setInput(input: AgentWorkspaceTerminalEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.activeInstance && !this.instanceMatchesInput(this.activeInstance)) {
			this.activeInstance.setVisible(false);
			this.activeInstance.detachFromElement();
			this.activeInstance = undefined;
			this.instanceDisposables.clear();
		}
		const instances = this.getInputInstances();
		if (!instances.length) {
			await this.createTerminal();
		} else {
			const active = this.terminalEditorService.activeInstance;
			this.activateInstance(active && instances.includes(active) ? active : instances[0], false);
		}
		this.refreshInstances();
	}

	private async createTerminal(): Promise<void> {
		const root = this.input instanceof AgentWorkspaceTerminalEditorInput ? this.input.root : undefined;
		const launchConfig = this.terminalInstanceService.convertProfileToShellLaunchConfig(undefined, root);
		const instance = this.terminalInstanceService.createInstance(launchConfig, TerminalLocation.Editor);
		this.instanceRoots.set(instance, root?.toString());
		this.terminalEditorService.resolveResource(instance);
		this.activateInstance(instance, true);
		this.refreshInstances();
	}

	private activateInstance(instance: ITerminalInstance, focus: boolean): void {
		if (!this.terminalHost) {
			return;
		}
		if (this.activeInstance !== instance) {
			this.activeInstance?.setVisible(false);
			this.activeInstance?.detachFromElement();
			this.instanceDisposables.clear();
			this.activeInstance = instance;
			instance.attachToElement(this.terminalHost);
			this.instanceDisposables.add(instance.onTitleChanged(() => this.refreshInstances()));
			this.instanceDisposables.add(instance.onDisposed(() => {
				this.instanceRoots.delete(instance);
				if (this.activeInstance === instance) {
					this.activeInstance = undefined;
				}
				this.refreshInstances();
			}));
		}
		// Editor panes are reused as the utility tabs change. Reattach even when
		// the logical instance did not change so xterm cannot remain mounted in a
		// detached host from the previous pane lifecycle.
		instance.attachToElement(this.terminalHost);
		this.terminalEditorService.setActiveInstance(instance);
		instance.setVisible(this.isVisible());
		this.layoutActiveInstance();
		if (focus) {
			void instance.focusWhenReady(true);
		}
	}

	private refreshInstances(): void {
		if (!this.railList || !this.railCount) {
			return;
		}
		this.railDisposables.clear();
		clearNode(this.railList);
		const instances = this.getInputInstances();
		this.railCount.textContent = instances.length === 1
			? nls.localize('agentWorkspace.terminal.one', "1 Terminal")
			: nls.localize('agentWorkspace.terminal.count', "{0} Terminals", instances.length);

		for (const instance of instances) {
			this.railDisposables.add(instance.onTitleChanged(() => this.refreshInstances()));
			this.railDisposables.add(instance.onDisposed(() => {
				this.instanceRoots.delete(instance);
				if (this.terminalEditorService.instances.includes(instance)) {
					this.terminalEditorService.detachInstance(instance);
				}
				this.refreshInstances();
			}));
			const row = append(this.railList, $('.agent-workspace-terminal-row'));
			row.classList.toggle('active', instance === this.activeInstance);
			row.setAttribute('role', 'button');
			row.tabIndex = 0;
			row.title = instance.description ? `${instance.title} — ${instance.description}` : instance.title;

			const icon = append(row, $('span.agent-workspace-terminal-row-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.terminal));
			append(row, $('span.agent-workspace-terminal-row-title')).textContent = instance.title || nls.localize('agentWorkspace.terminal.untitled', "Terminal {0}", instance.instanceId);
			const close = append(row, $('button.agent-workspace-terminal-close')) as HTMLButtonElement;
			close.type = 'button';
			close.title = nls.localize('agentWorkspace.terminal.kill', "Kill Terminal");
			close.setAttribute('aria-label', close.title);
			close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));

			const activate = () => this.activateInstance(instance, true);
			this.railDisposables.add(addDisposableListener(row, EventType.CLICK, activate));
			this.railDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					activate();
				}
			}));
			this.railDisposables.add(addDisposableListener(close, EventType.CLICK, event => {
				event.stopPropagation();
				void this.closeTerminal(instance);
			}));
		}
	}

	private async closeTerminal(instance: ITerminalInstance): Promise<void> {
		const instances = this.getInputInstances();
		const index = instances.indexOf(instance);
		const next = instances[index + 1] ?? instances[index - 1];
		if (this.activeInstance === instance) {
			instance.setVisible(false);
			instance.detachFromElement();
			this.activeInstance = undefined;
		}
		this.terminalEditorService.detachInstance(instance);
		this.instanceRoots.delete(instance);
		await this.terminalService.safeDisposeTerminal(instance);
		if (next) {
			this.activateInstance(next, false);
		} else if (this.isVisible()) {
			await this.createTerminal();
		}
		this.refreshInstances();
	}

	private getInputInstances(): ITerminalInstance[] {
		return this.terminalEditorService.instances.filter(instance => this.instanceMatchesInput(instance));
	}

	private instanceMatchesInput(instance: ITerminalInstance): boolean {
		const root = this.input instanceof AgentWorkspaceTerminalEditorInput ? this.input.root : undefined;
		if (this.instanceRoots.has(instance)) {
			return this.instanceRoots.get(instance) === root?.toString();
		}
		const cwd = instance.shellLaunchConfig.cwd;
		if (!root) {
			return cwd === undefined;
		}
		if (!cwd) {
			return false;
		}
		return isEqual(typeof cwd === 'string' ? URI.file(cwd) : cwd, root);
	}

	private layoutActiveInstance(): void {
		if (!this.lastDimension || !this.activeInstance) {
			return;
		}
		this.activeInstance.layout({
			width: Math.max(0, this.terminalHost?.clientWidth ?? this.lastDimension.width),
			height: this.lastDimension.height,
		});
	}

	override layout(dimension: Dimension): void {
		this.lastDimension = dimension;
		this.layoutActiveInstance();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && this.activeInstance && this.terminalHost) {
			this.activeInstance.attachToElement(this.terminalHost);
		}
		this.activeInstance?.setVisible(visible);
		if (visible) {
			this.layoutActiveInstance();
		}
	}

	override focus(): void {
		this.activeInstance?.focus(true);
	}

	override clearInput(): void {
		this.activeInstance?.setVisible(false);
		this.activeInstance?.detachFromElement();
		this.activeInstance = undefined;
		this.instanceDisposables.clear();
		super.clearInput();
	}
}
