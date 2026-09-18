/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as dom from '../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { toAction } from '../../../../../base/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ChatMemoryFileResource } from '../../common/chatArtifactExtraction.js';
import { IChatArtifact, IChatArtifactsService, IArtifactSourceGroup, ArtifactSource } from '../../common/tools/chatArtifactsService.js';
import { IChatImageCarouselService } from '../chatImageCarouselService.js';
import { getEditorOverrideForChatResource } from './chatContentParts/chatInlineAnchorWidget.js';

const ARTIFACT_TYPE_ICONS: Record<string, ThemeIcon> = {
	devServer: Codicon.globe,
	screenshot: Codicon.file,
	plan: Codicon.book,
};

/**
 * A group node in the artifact tree. Groups artifacts by `groupName`.
 */
interface IArtifactGroupNode {
	readonly kind: 'group';
	readonly groupName: string;
	readonly artifacts: IChatArtifact[];
	readonly onlyShowGroup: boolean;
	readonly onClear?: () => void;
}

/**
 * A leaf artifact node, optionally annotated with subtext (e.g. source/group name
 * when the artifact is the sole item of its group, shown at top level).
 */
interface IArtifactLeafNode {
	readonly kind: 'leaf';
	readonly artifact: IChatArtifact;
	readonly description?: string;
	readonly onClear?: () => void;
}

type ArtifactTreeElement = IArtifactGroupNode | IArtifactLeafNode;

function isGroupNode(element: ArtifactTreeElement): element is IArtifactGroupNode {
	return element.kind === 'group';
}

function isLeafNode(element: ArtifactTreeElement): element is IArtifactLeafNode {
	return element.kind === 'leaf';
}

/** V3Code: stable per-artifact key used for the dismissal set + dedup. */
function artifactKey(a: IChatArtifact): string {
	return a.toolCallId ? `${a.toolCallId}:${a.dataPartIndex}` : a.uri;
}

export class ChatArtifactsWidget extends Disposable {
	readonly domNode: HTMLElement;

	private readonly _sessionResource = observableValue<URI | undefined>(this, undefined);
	private readonly _isCollapsed = observableValue(this, false);

	// V3Code: artifacts can be auto-extracted from the response (source kind 'rules'),
	// which the service treats as non-clearable — so the per-row / header X had nothing
	// to remove and "did nothing". We add a UI-level dismissal set (by artifact key) that
	// filters dismissed artifacts out of the tree. This makes the X actually kill the
	// item/image for the session, regardless of its source. Reset when the session changes.
	private readonly _dismissed = observableValue<ReadonlySet<string>>(this, new Set());

	private readonly _currentArtifacts = derived(this, reader => {
		const sr = this._sessionResource.read(reader);
		return sr ? this._chatArtifactsService.getArtifacts(sr) : undefined;
	});

	private readonly _treeData = derived(this, reader => {
		const artifacts = this._currentArtifacts.read(reader);
		if (!artifacts) {
			return undefined;
		}
		const dismissed = this._dismissed.read(reader);
		const groups = artifacts.artifactGroups.read(reader)
			.map(g => ({ source: g.source, artifacts: g.artifacts.filter(a => !dismissed.has(artifactKey(a))) }))
			.filter(g => g.artifacts.length > 0);
		const totalCount = groups.reduce((sum, g) => sum + g.artifacts.length, 0);
		if (totalCount === 0) {
			return undefined;
		}
		const multiSource = groups.length > 1;
		const treeElements = buildTreeElementsFromGroups(groups, multiSource, arts => this._dismissArtifacts(arts));
		const visibleCount = countVisibleRows(treeElements);
		const itemsShown = Math.min(visibleCount, ChatArtifactsWidget.MAX_ITEMS_SHOWN);
		return {
			totalCount,
			treeElements,
			treeHeight: itemsShown * ChatArtifactsWidget.ELEMENT_HEIGHT,
		};
	});

	public static readonly ELEMENT_HEIGHT = 22;
	private static readonly MAX_ITEMS_SHOWN = 6;

	constructor(
		@IChatArtifactsService private readonly _chatArtifactsService: IChatArtifactsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IFileService private readonly _fileService: IFileService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IChatImageCarouselService private readonly _chatImageCarouselService: IChatImageCarouselService,
	) {
		super();
		this.domNode = dom.$('.chat-artifacts-widget');
		this.domNode.style.display = 'none';

		this._register(autorun(reader => {
			const artifacts = this._currentArtifacts.read(reader);

			dom.clearNode(this.domNode);

			if (!artifacts) {
				this.domNode.style.display = 'none';
				return;
			}

			const store = reader.store;

			const expandoContainer = dom.$('.chat-artifacts-expand');
			const headerButton = store.add(new Button(expandoContainer, { supportIcons: true }));

			const titleSection = dom.$('.chat-artifacts-title-section');
			const expandIcon = dom.$('.expand-icon.codicon');
			expandIcon.setAttribute('aria-hidden', 'true');
			const titleElement = dom.$('.chat-artifacts-title');

			titleSection.appendChild(expandIcon);
			titleSection.appendChild(titleElement);
			headerButton.element.appendChild(titleSection);

			// V3Code: a header-level "clear all" (X) so artifacts/images can be killed
			// even while the list is collapsed. The per-row X only renders inside the
			// list rows, which are hidden when collapsed — so there was previously no way
			// to dismiss an artifact from the collapsed header. Sits as a sibling of the
			// expand button (not inside it) so clicking X never toggles the collapse.
			const headerActions = dom.$('.chat-artifacts-header-actions');
			const clearAllBar = store.add(new ActionBar(headerActions));
			clearAllBar.push(toAction({
				id: 'chatArtifacts.clearAll',
				label: localize('chat.artifacts.clearAll', "Clear artifacts"),
				class: ThemeIcon.asClassName(Codicon.close),
				run: () => this._dismissAllArtifacts(),
			}), { icon: true, label: false });
			expandoContainer.appendChild(headerActions);

			this.domNode.appendChild(expandoContainer);

			const listContainer = dom.$('.chat-artifacts-list');
			this.domNode.appendChild(listContainer);

			const tree = store.add(this._instantiationService.createInstance(
				WorkbenchObjectTree<ArtifactTreeElement>,
				'ChatArtifactsTree',
				listContainer,
				new ChatArtifactsTreeDelegate(),
				[
					new ChatArtifactGroupRenderer(),
					new ChatArtifactLeafRenderer(artifact => this._saveArtifact(artifact)),
				],
				{
					alwaysConsumeMouseWheel: false,
					accessibilityProvider: new ChatArtifactsAccessibilityProvider(),
				},
			));

			store.add(tree.onDidOpen(e => {
				if (!e.element) {
					return;
				}
				if (isGroupNode(e.element)) {
					if (e.element.onlyShowGroup) {
						this._openGroupInCarousel(e.element);
					}
				} else if (isLeafNode(e.element)) {
					this._openLeafArtifact(e.element.artifact);
				}
			}));

			store.add(headerButton.onDidClick(() => {
				this._isCollapsed.set(!this._isCollapsed.read(undefined), undefined);
			}));

			store.add(autorun(reader => {
				const collapsed = this._isCollapsed.read(reader);
				expandIcon.classList.toggle('codicon-chevron-down', !collapsed);
				expandIcon.classList.toggle('codicon-chevron-right', collapsed);
				headerButton.element.setAttribute('aria-expanded', String(!collapsed));
				listContainer.style.display = collapsed ? 'none' : 'block';
			}));

			store.add(autorun(reader => {
				const data = this._treeData.read(reader);
				if (!data) {
					this.domNode.style.display = 'none';
					return;
				}
				this.domNode.style.display = '';

				titleElement.textContent = data.totalCount === 1
					? localize('chat.artifacts.one', "1 Artifact")
					: localize('chat.artifacts.count', "{0} Artifacts", data.totalCount);

				tree.layout(data.treeHeight);
				tree.getHTMLElement().style.height = `${data.treeHeight}px`;
				tree.setChildren(null, data.treeElements);
			}));
		}));
	}

	setSessionResource(sessionResource: URI | undefined): void {
		if (this._sessionResource.get()?.toString() !== sessionResource?.toString()) {
			// New session — forget anything dismissed in the previous one.
			this._dismissed.set(new Set(), undefined);
		}
		this._sessionResource.set(sessionResource, undefined);
	}

	private async _openGroupInCarousel(group: IArtifactGroupNode): Promise<void> {
		// Open the first artifact in the group — the carousel service will collect
		// all images from the chat widget session automatically.
		const first = group.artifacts[0];
		if (first?.uri) {
			await this._chatImageCarouselService.openCarouselAtResource(URI.parse(first.uri));
		}
	}

	private _openLeafArtifact(artifact: IChatArtifact): void {
		if (artifact.type === 'screenshot' && this._configurationService.getValue<boolean>(ChatConfiguration.ImageCarouselEnabled)) {
			this._openScreenshotInCarousel(artifact);
		} else if (artifact.uri) {
			const uri = URI.parse(artifact.uri);
			if (ChatMemoryFileResource.isChatMemoryFileUri(uri)) {
				this._openMemoryFileArtifact(uri);
			} else {
				const editorOverride = getEditorOverrideForChatResource(uri, this._configurationService);
				this._openerService.open(uri, {
					fromUserGesture: true,
					editorOptions: { override: editorOverride },
				});
			}
		}
	}

	private async _openScreenshotInCarousel(clicked: IChatArtifact): Promise<void> {
		if (clicked.uri) {
			await this._chatImageCarouselService.openCarouselAtResource(URI.parse(clicked.uri));
		}
	}

	private async _openMemoryFileArtifact(uri: URI): Promise<void> {
		const { memoryPath, sessionResource } = ChatMemoryFileResource.parse(uri);
		const resolvedUriStr: string | undefined = await this._commandService.executeCommand(
			'github.copilot.chat.tools.memory.resolveMemoryFileUri',
			memoryPath,
			sessionResource,
		);
		if (resolvedUriStr) {
			const resolvedUri = URI.parse(resolvedUriStr);
			const editorOverride = getEditorOverrideForChatResource(resolvedUri, this._configurationService);
			this._openerService.open(resolvedUri, {
				fromUserGesture: true,
				editorOptions: { override: editorOverride },
			});
		}
	}

	/** V3Code: dismiss specific artifacts (hide them for this session). Also purges the
	 *  underlying agent/subagent source where possible so they don't re-appear from storage. */
	private _dismissArtifacts(toDismiss: readonly IChatArtifact[]): void {
		if (toDismiss.length === 0) {
			return;
		}
		const next = new Set(this._dismissed.get());
		for (const a of toDismiss) {
			next.add(artifactKey(a));
		}
		this._dismissed.set(next, undefined);

		// Best-effort hard clear for clearable sources so they don't persist.
		const artifacts = this._currentArtifacts.get();
		if (artifacts) {
			const dismissedKeys = new Set(toDismiss.map(artifactKey));
			for (const group of artifacts.artifactGroups.get()) {
				const allDismissed = group.artifacts.every(a => dismissedKeys.has(artifactKey(a)));
				if (!allDismissed) {
					continue;
				}
				if (group.source.kind === 'agent') {
					artifacts.clearAgentArtifacts();
				} else if (group.source.kind === 'subagent') {
					artifacts.clearSubagentArtifacts(group.source.invocationId);
				}
			}
		}
	}

	/** V3Code: dismiss every currently-shown artifact (header "X"). */
	private _dismissAllArtifacts(): void {
		const artifacts = this._currentArtifacts.get();
		if (!artifacts) {
			return;
		}
		const all: IChatArtifact[] = [];
		for (const group of artifacts.artifactGroups.get()) {
			all.push(...group.artifacts);
		}
		this._dismissArtifacts(all);
	}

	private async _saveArtifact(artifact: IChatArtifact): Promise<void> {
		const sourceUri = URI.parse(artifact.uri);
		const defaultFileName = sourceUri.path.split('/').pop() ?? artifact.label;
		const defaultPath = await this._fileDialogService.defaultFilePath();
		const defaultUri = URI.joinPath(defaultPath, defaultFileName);

		const targetUri = await this._fileDialogService.showSaveDialog({
			defaultUri,
			title: localize('chat.artifacts.saveDialog.title', "Save Artifact"),
		});

		if (targetUri) {
			const content = await this._fileService.readFile(sourceUri);
			await this._fileService.writeFile(targetUri, content.value);
		}
	}
}

// --- Tree infrastructure ---

function sourceDisplayName(source: ArtifactSource): string {
	switch (source.kind) {
		case 'rules': return localize('chat.artifacts.source.rules', "Rules");
		case 'agent': return localize('chat.artifacts.source.agent', "Agent");
		case 'subagent': return source.name ?? localize('chat.artifacts.source.subagent', "Subagent");
	}
}

function buildTreeElementsFromGroups(sourceGroups: readonly IArtifactSourceGroup[], multiSource: boolean, onDismiss: (artifacts: readonly IChatArtifact[]) => void): IObjectTreeElement<ArtifactTreeElement>[] {
	const elements: IObjectTreeElement<ArtifactTreeElement>[] = [];

	for (const sourceGroup of sourceGroups) {
		const prefix = multiSource ? sourceDisplayName(sourceGroup.source) : undefined;
		// V3Code: every node is dismissible now (even rules-sourced artifacts). Each node's
		// X dismisses exactly its own artifact(s) via the widget's dismissal set.
		const groups = new Map<string, { config: { groupName: string; onlyShowGroup: boolean }; artifacts: IChatArtifact[] }>();
		const ungrouped: IChatArtifact[] = [];

		for (const artifact of sourceGroup.artifacts) {
			if (artifact.groupName) {
				let group = groups.get(artifact.groupName);
				if (!group) {
					group = { config: { groupName: artifact.groupName, onlyShowGroup: artifact.onlyShowGroup ?? false }, artifacts: [] };
					groups.set(artifact.groupName, group);
				}
				group.artifacts.push(artifact);
			} else {
				ungrouped.push(artifact);
			}
		}

		for (const [, group] of groups) {
			const displayName = prefix ? `${prefix}: ${group.config.groupName}` : group.config.groupName;

			// Single-artifact group: promote to top-level leaf with description
			if (group.artifacts.length === 1 && !group.config.onlyShowGroup) {
				const single = group.artifacts[0];
				elements.push({ element: { kind: 'leaf', artifact: single, description: displayName, onClear: () => onDismiss([single]) } });
				continue;
			}

			const groupNode: IArtifactGroupNode = {
				kind: 'group',
				groupName: displayName,
				artifacts: group.artifacts,
				onlyShowGroup: group.config.onlyShowGroup,
				onClear: () => onDismiss(group.artifacts),
			};

			if (group.config.onlyShowGroup) {
				elements.push({ element: groupNode, collapsible: false, collapsed: false });
			} else {
				elements.push({
					element: groupNode,
					collapsible: true,
					collapsed: false,
					children: group.artifacts.map((a): IObjectTreeElement<ArtifactTreeElement> => ({ element: { kind: 'leaf', artifact: a, onClear: () => onDismiss([a]) } })),
				});
			}
		}

		if (ungrouped.length > 0 && prefix) {
			// Single ungrouped artifact from a source: show as leaf with source name
			if (ungrouped.length === 1) {
				const single = ungrouped[0];
				elements.push({ element: { kind: 'leaf', artifact: single, description: prefix, onClear: () => onDismiss([single]) } });
			} else {
				const groupNode: IArtifactGroupNode = {
					kind: 'group',
					groupName: prefix,
					artifacts: ungrouped,
					onlyShowGroup: false,
					onClear: () => onDismiss(ungrouped),
				};
				elements.push({
					element: groupNode,
					collapsible: true,
					collapsed: false,
					children: ungrouped.map((a): IObjectTreeElement<ArtifactTreeElement> => ({ element: { kind: 'leaf', artifact: a, onClear: () => onDismiss([a]) } })),
				});
			}
		} else {
			for (const artifact of ungrouped) {
				elements.push({ element: { kind: 'leaf', artifact, onClear: () => onDismiss([artifact]) } });
			}
		}
	}

	return elements;
}

function countVisibleRows(elements: IObjectTreeElement<ArtifactTreeElement>[]): number {
	let count = 0;
	for (const el of elements) {
		count++; // The element itself
		if (el.children && !el.collapsed) {
			count += countVisibleRows([...el.children]);
		}
	}
	return count;
}

class ChatArtifactsTreeDelegate implements IListVirtualDelegate<ArtifactTreeElement> {
	getHeight(): number {
		return ChatArtifactsWidget.ELEMENT_HEIGHT;
	}
	getTemplateId(element: ArtifactTreeElement): string {
		return isGroupNode(element)
			? ChatArtifactGroupRenderer.TEMPLATE_ID
			: ChatArtifactLeafRenderer.TEMPLATE_ID;
	}
}

class ChatArtifactsAccessibilityProvider implements IListAccessibilityProvider<ArtifactTreeElement> {
	getAriaLabel(element: ArtifactTreeElement): string | null {
		if (isGroupNode(element)) {
			return localize('chat.artifacts.group.aria', "{0} ({1} items)", element.groupName, element.artifacts.length);
		}
		return element.artifact.label;
	}
	getWidgetAriaLabel(): string {
		return localize('chat.artifacts.widget.aria', "Chat Artifacts");
	}
}

// --- Group renderer ---

interface IArtifactGroupTemplate {
	readonly container: HTMLElement;
	readonly iconElement: HTMLElement;
	readonly labelElement: HTMLElement;
	readonly actionBar: ActionBar;
	readonly elementDisposables: DisposableStore;
}

class ChatArtifactGroupRenderer implements ITreeRenderer<ArtifactTreeElement, void, IArtifactGroupTemplate> {
	static readonly TEMPLATE_ID = 'chatArtifactGroupRenderer';
	readonly templateId = ChatArtifactGroupRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IArtifactGroupTemplate {
		const row = dom.append(container, dom.$('.chat-artifacts-list-row'));
		const iconElement = dom.append(row, dom.$('.chat-artifacts-list-icon'));
		const labelElement = dom.append(row, dom.$('.chat-artifacts-list-label'));
		const actionsContainer = dom.append(row, dom.$('.chat-artifacts-list-actions'));
		const elementDisposables = new DisposableStore();
		const actionBar = new ActionBar(actionsContainer);
		return { container: row, iconElement, labelElement, actionBar, elementDisposables };
	}

	renderElement(node: ITreeNode<ArtifactTreeElement>, _index: number, templateData: IArtifactGroupTemplate): void {
		const group = node.element;
		if (!isGroupNode(group)) {
			return;
		}

		templateData.elementDisposables.clear();

		const firstType = group.artifacts[0]?.type;
		const icon = (firstType && ARTIFACT_TYPE_ICONS[firstType]) || Codicon.archive;
		templateData.iconElement.className = 'chat-artifacts-list-icon ' + ThemeIcon.asClassName(icon);
		templateData.labelElement.textContent = `${group.groupName} (${group.artifacts.length})`;
		templateData.container.title = group.groupName;

		templateData.actionBar.clear();
		if (group.onClear) {
			const clearFn = group.onClear;
			templateData.actionBar.push(toAction({
				id: 'chatArtifacts.clearSource',
				label: localize('chat.artifacts.clearSource', "Clear"),
				class: ThemeIcon.asClassName(Codicon.close),
				run: () => clearFn(),
			}), { icon: true, label: false });
		}
	}

	disposeElement(_element: ITreeNode<ArtifactTreeElement>, _index: number, templateData: IArtifactGroupTemplate): void {
		templateData.elementDisposables.clear();
	}

	disposeTemplate(templateData: IArtifactGroupTemplate): void {
		templateData.elementDisposables.dispose();
		templateData.actionBar.dispose();
	}
}

// --- Leaf artifact renderer ---

interface IArtifactLeafTemplate {
	readonly container: HTMLElement;
	readonly iconElement: HTMLElement;
	readonly labelElement: HTMLElement;
	readonly descriptionElement: HTMLElement;
	readonly actionBar: ActionBar;
	readonly elementDisposables: DisposableStore;
}

class ChatArtifactLeafRenderer implements ITreeRenderer<ArtifactTreeElement, void, IArtifactLeafTemplate> {
	static readonly TEMPLATE_ID = 'chatArtifactLeafRenderer';
	readonly templateId = ChatArtifactLeafRenderer.TEMPLATE_ID;

	constructor(private readonly _onSave: (artifact: IChatArtifact) => void) { }

	renderTemplate(container: HTMLElement): IArtifactLeafTemplate {
		const row = dom.append(container, dom.$('.chat-artifacts-list-row'));
		const iconElement = dom.append(row, dom.$('.chat-artifacts-list-icon'));
		const labelElement = dom.append(row, dom.$('.chat-artifacts-list-label'));
		const descriptionElement = dom.append(row, dom.$('.chat-artifacts-list-description'));
		const actionsContainer = dom.append(row, dom.$('.chat-artifacts-list-actions'));
		const elementDisposables = new DisposableStore();
		const actionBar = new ActionBar(actionsContainer);
		return { container: row, iconElement, labelElement, descriptionElement, actionBar, elementDisposables };
	}

	renderElement(node: ITreeNode<ArtifactTreeElement>, _index: number, templateData: IArtifactLeafTemplate): void {
		if (!isLeafNode(node.element)) {
			return;
		}

		templateData.elementDisposables.clear();

		const { artifact, description, onClear } = node.element;
		const icon = (artifact.type && ARTIFACT_TYPE_ICONS[artifact.type]) || Codicon.archive;
		templateData.iconElement.className = 'chat-artifacts-list-icon ' + ThemeIcon.asClassName(icon);
		templateData.labelElement.textContent = artifact.label;
		templateData.descriptionElement.textContent = description ?? '';
		templateData.descriptionElement.style.display = description ? '' : 'none';
		templateData.container.title = artifact.uri;

		templateData.actionBar.clear();
		const actions = [];
		if (onClear) {
			const clearFn = onClear;
			actions.push(toAction({
				id: 'chatArtifacts.clearSource',
				label: localize('chat.artifacts.clearSource', "Clear"),
				class: ThemeIcon.asClassName(Codicon.close),
				run: () => clearFn(),
			}));
		}
		actions.push(toAction({
			id: 'chatArtifacts.save',
			label: localize('chat.artifacts.save', "Save artifact"),
			class: ThemeIcon.asClassName(Codicon.save),
			run: () => this._onSave(artifact),
		}));
		templateData.actionBar.push(actions, { icon: true, label: false });
	}

	disposeElement(_element: ITreeNode<ArtifactTreeElement>, _index: number, templateData: IArtifactLeafTemplate): void {
		templateData.elementDisposables.clear();
	}

	disposeTemplate(templateData: IArtifactLeafTemplate): void {
		templateData.elementDisposables.dispose();
		templateData.actionBar.dispose();
	}
}
