/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/agentWorkspaceFilesEditor.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { getErrorMessage } from '../../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { basename, isEqual } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as nls from '../../../../../../nls.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IFileService, IFileStat } from '../../../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, GroupIdentifier, IEditorOpenContext, IRevertOptions, ISaveOptions, IUntypedEditorInput, IUntypedFileEditorInput, SideBySideEditor } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../../common/editor/sideBySideEditorInput.js';
import { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { ITextEditorService } from '../../../../../services/textfile/common/textEditorService.js';

const FILES_EDITOR_SCHEME = 'v3-agent-files';

export class AgentWorkspaceFilesEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.input.agentWorkspaceFiles';
	static readonly EditorID = 'workbench.editor.agentWorkspaceFiles';

	readonly resource: URI;

	constructor(readonly root: URI) {
		super();
		this.resource = URI.from({
			scheme: FILES_EDITOR_SCHEME,
			authority: root.authority,
			path: root.path,
			query: root.toString(),
		});
	}

	override get typeId(): string { return AgentWorkspaceFilesEditorInput.TypeID; }
	override get editorId(): string { return AgentWorkspaceFilesEditorInput.EditorID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton; }

	override getName(): string {
		return nls.localize('agentWorkspace.filesEditor', "Files");
	}

	override getDescription(): string {
		return basename(this.root);
	}

	override getIcon(): ThemeIcon {
		return Codicon.files;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof AgentWorkspaceFilesEditorInput && other.root.toString() === this.root.toString());
	}
}

/**
 * One utility editor containing a native file editor on the left and the
 * workspace tree on the right. The native side-by-side editor treats its
 * right-hand input as primary, so this input explicitly forwards dirty/save
 * state to the file on the left.
 */
export class AgentWorkspaceFilesCompositeInput extends SideBySideEditorInput {

	constructor(
		readonly root: URI,
		readonly file: EditorInput,
		@IEditorService editorService: IEditorService,
	) {
		super(
			nls.localize('agentWorkspace.filesComposite', "Files"),
			file.getName(),
			file,
			new AgentWorkspaceFilesEditorInput(root),
			editorService,
		);
		this._register(file.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
	}

	override get capabilities(): EditorInputCapabilities {
		return (this.file.capabilities & ~EditorInputCapabilities.CanSplitInGroup) |
			EditorInputCapabilities.MultipleEditors |
			EditorInputCapabilities.Singleton;
	}

	override getIcon(): ThemeIcon {
		return Codicon.files;
	}

	override isDirty(): boolean { return this.file.isDirty(); }
	override isSaving(): boolean { return this.file.isSaving(); }
	override isReadonly() { return this.file.isReadonly(); }

	override async save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		const result = await this.file.save(group, options);
		return result && this.file.matches(result) ? this : result;
	}

	override async saveAs(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		const result = await this.file.saveAs(group, options);
		return result && this.file.matches(result) ? this : result;
	}

	override revert(group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		return this.file.revert(group, options);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof AgentWorkspaceFilesCompositeInput && this.file.matches(other.file));
	}
}

export class AgentWorkspaceFilesEditor extends EditorPane {

	static readonly ID = AgentWorkspaceFilesEditorInput.EditorID;

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly treeDisposables = this._register(new DisposableStore());
	private readonly expandedDirectories = new Set<string>();
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => this.renderTree(), 200));

	private root: URI | undefined;
	private container: HTMLElement | undefined;
	private tree: HTMLElement | undefined;
	private rootLabel: HTMLElement | undefined;
	private filterInput: HTMLInputElement | undefined;
	private selectedRow: HTMLElement | undefined;
	private firstRow: HTMLElement | undefined;
	private readonly renderedNodes: { readonly element: HTMLElement; readonly key: string; readonly name: string; readonly ancestors: readonly string[] }[] = [];
	private renderGeneration = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextEditorService private readonly textEditorService: ITextEditorService,
	) {
		super(AgentWorkspaceFilesEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.agent-workspace-files-editor'));

		const toolbar = append(this.container, $('.agent-workspace-files-toolbar'));
		const title = append(toolbar, $('.agent-workspace-files-title'));
		const titleIcon = append(title, $('span'));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		this.rootLabel = append(title, $('span.agent-workspace-files-root'));

		const toolbarActions = append(toolbar, $('.agent-workspace-files-actions'));
		this.createToolbarButton(toolbarActions, Codicon.newFile, nls.localize('agentWorkspace.files.new', "New File"), () => {
			void this.openNewFile();
		});
		this.createToolbarButton(toolbarActions, Codicon.collapseAll, nls.localize('agentWorkspace.files.collapse', "Collapse folders"), () => {
			this.expandedDirectories.clear();
			this.renderTree();
		});
		this.createToolbarButton(toolbarActions, Codicon.refresh, nls.localize('agentWorkspace.files.refresh', "Refresh files"), () => this.renderTree());

		const filter = append(this.container, $('.agent-workspace-files-filter'));
		const filterIcon = append(filter, $('span'));
		filterIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));
		this.filterInput = append(filter, $('input.agent-workspace-files-filter-input')) as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = nls.localize('agentWorkspace.files.filter', "Filter files");
		this.filterInput.setAttribute('aria-label', nls.localize('agentWorkspace.files.filterAria', "Filter workspace files"));
		this.filterInput.spellcheck = false;
		this._register(addDisposableListener(this.filterInput, EventType.INPUT, () => this.applyFilter()));

		this.tree = append(this.container, $('.agent-workspace-files-tree'));
		this.tree.setAttribute('role', 'tree');
		this.tree.setAttribute('aria-label', nls.localize('agentWorkspace.files.treeAria', "Workspace files"));
	}

	private createToolbarButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const button = append(parent, $('button.agent-workspace-files-toolbar-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		this._register(addDisposableListener(button, EventType.CLICK, run));
	}

	override async setInput(input: AgentWorkspaceFilesEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const sameRoot = !!this.root && isEqual(this.root, input.root);
		await super.setInput(input, options, context, token);
		this.root = input.root;
		if (this.rootLabel) {
			this.rootLabel.textContent = basename(input.root);
			this.rootLabel.title = input.root.fsPath;
		}
		if (sameRoot) {
			return;
		}

		this.expandedDirectories.clear();

		this.editorDisposables.clear();
		this.editorDisposables.add(this.fileService.watch(input.root));
		this.editorDisposables.add(this.fileService.onDidFilesChange(event => {
			if (event.affects(input.root)) {
				this.refreshScheduler.schedule();
			}
		}));
		await this.renderTree();
	}

	private async renderTree(): Promise<void> {
		if (!this.root || !this.tree) {
			return;
		}

		const generation = ++this.renderGeneration;
		this.treeDisposables.clear();
		this.renderedNodes.length = 0;
		this.firstRow = undefined;
		clearNode(this.tree);
		const loading = append(this.tree, $('.agent-workspace-files-message'));
		loading.textContent = nls.localize('agentWorkspace.files.loading', "Loading files…");

		try {
			// Ask for every remembered expansion in this one call. Resolving them as we
			// walk the tree instead costs one sequential round trip per expanded folder
			// before anything can be shown, which is what made the pane slow to open.
			const expandedTargets = [...this.expandedDirectories].map(value => URI.parse(value));
			const rootStat = await this.fileService.resolve(this.root, expandedTargets.length ? { resolveTo: expandedTargets } : undefined);
			if (generation !== this.renderGeneration || !this.tree) {
				return;
			}
			clearNode(this.tree);
			await this.renderChildren(rootStat, this.tree, 0, generation);
			if (!rootStat.children?.length) {
				const empty = append(this.tree, $('.agent-workspace-files-message'));
				empty.textContent = nls.localize('agentWorkspace.files.empty', "This workspace is empty.");
			}
			this.applyFilter();
		} catch (error) {
			if (generation !== this.renderGeneration || !this.tree) {
				return;
			}
			clearNode(this.tree);
			const message = append(this.tree, $('.agent-workspace-files-message.error'));
			message.textContent = nls.localize('agentWorkspace.files.error', "Files could not be loaded: {0}", getErrorMessage(error));
		}
	}

	private async renderChildren(parentStat: IFileStat, parent: HTMLElement, depth: number, generation: number, ancestors: readonly string[] = []): Promise<void> {
		const children = [...(parentStat.children ?? [])].sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
		});

		for (const child of children) {
			if (generation !== this.renderGeneration) {
				return;
			}

			const node = append(parent, $('.agent-workspace-file-node'));
			const key = child.resource.toString();
			this.renderedNodes.push({ element: node, key, name: child.name.toLowerCase(), ancestors });
			const row = append(node, $('.agent-workspace-file-row'));
			this.firstRow ??= row;
			row.style.paddingLeft = `${5 + depth * 13}px`;
			row.setAttribute('role', 'treeitem');
			row.setAttribute('aria-label', child.name);
			row.tabIndex = 0;

			const twistie = append(row, $('span.agent-workspace-file-twistie'));
			const icon = append(row, $('span.agent-workspace-file-icon'));
			append(row, $('span.agent-workspace-file-name')).textContent = child.name;

			if (child.isDirectory) {
				const expanded = this.expandedDirectories.has(child.resource.toString());
				row.setAttribute('aria-expanded', String(expanded));
				twistie.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.chevronDown : Codicon.chevronRight));
				icon.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.folderOpened : Codicon.folder));
				const toggle = () => this.toggleDirectory(child.resource);
				this.treeDisposables.add(addDisposableListener(row, EventType.CLICK, toggle));
				this.treeDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						toggle();
					}
				}));

				if (expanded) {
					const childrenContainer = append(node, $('.agent-workspace-file-children'));
					try {
						// Normally already populated by the root resolve above; only pay for
						// a round trip when this folder was expanded after that call.
						const stat = child.children ? child : await this.fileService.resolve(child.resource);
						await this.renderChildren(stat, childrenContainer, depth + 1, generation, [...ancestors, key]);
					} catch {
						node.classList.add('unavailable');
					}
				}
			} else {
				twistie.classList.add('empty');
				icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
				const open = (pinned: boolean) => {
					this.selectRow(row);
					void this.openFile(child.resource, pinned);
				};
				this.treeDisposables.add(addDisposableListener(row, EventType.CLICK, () => open(false)));
				this.treeDisposables.add(addDisposableListener(row, EventType.DBLCLICK, () => open(true)));
				this.treeDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
					if (event.key === 'Enter') {
						event.preventDefault();
						open(true);
					}
				}));
			}
		}
	}

	private toggleDirectory(resource: URI): void {
		const key = resource.toString();
		if (this.expandedDirectories.has(key)) {
			this.expandedDirectories.delete(key);
		} else {
			this.expandedDirectories.add(key);
		}
		void this.renderTree();
	}

	private selectRow(row: HTMLElement): void {
		this.selectedRow?.classList.remove('selected');
		this.selectedRow = row;
		row.classList.add('selected');
	}

	private async openFile(resource: URI, pinned: boolean): Promise<void> {
		const active = this.group.activeEditor;
		if (active instanceof AgentWorkspaceFilesCompositeInput && isEqual(active.file.resource, resource)) {
			await this.group.openEditor(active, { pinned: true });
			return;
		}

		const fileInput: IUntypedFileEditorInput = { resource, forceFile: true };
		const file = await this.textEditorService.resolveTextEditor(fileInput);
		await this.replaceFile(file, pinned);
	}

	private async openNewFile(): Promise<void> {
		const file = await this.textEditorService.resolveTextEditor({ resource: undefined, forceUntitled: true });
		await this.replaceFile(file, true);
	}

	private async replaceFile(file: EditorInput, pinned: boolean): Promise<void> {
		const active = this.group.activeEditor;
		const replacement = new AgentWorkspaceFilesCompositeInput(this.root!, file, this.editorService);
		const options: IEditorOptions = {
			pinned,
			preserveFocus: false,
			viewState: {
				primary: {},
				secondary: {},
				focus: SideBySideEditor.SECONDARY,
				ratio: 0.72,
			},
		};

		if (active) {
			await this.group.replaceEditors([{ editor: active, replacement, options }]);
			if (this.group.contains(active)) {
				// The user cancelled a dirty-file replacement. Remove the new surface
				// and return to the original file/tree without losing either state.
				await this.group.closeEditor(replacement, { preserveFocus: true });
				await this.group.openEditor(active, { pinned: true });
			}
			return;
		}

		await this.group.openEditor(replacement, options);
	}

	private applyFilter(): void {
		if (!this.tree) {
			return;
		}
		const query = this.filterInput?.value.trim().toLowerCase() ?? '';
		const matches = new Set<string>();
		if (query) {
			for (const node of this.renderedNodes) {
				if (node.name.includes(query)) {
					matches.add(node.key);
					for (const ancestor of node.ancestors) {
						matches.add(ancestor);
					}
				}
			}
		}
		for (const node of this.renderedNodes) {
			node.element.classList.toggle('filtered-out', !!query && !matches.has(node.key));
		}
	}

	override layout(_dimension: Dimension): void {
	}

	override focus(): void {
		this.firstRow?.focus();
	}
}
