/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { localize } from '../../../../../../nls.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { IOpenEditorOptions } from '../../../../../../platform/editor/browser/editor.js';
import { IEditorService, SIDE_GROUP } from '../../../../../services/editor/common/editorService.js';
import { IChatExternalEdit } from '../../../common/chatService/chatService.js';
import { IEditSessionDiffStats } from '../../../common/editing/chatEditingService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { ChatEditPillElement } from './chatEditPillElement.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';

/**
 * Renders an {@link IChatExternalEdit} progress part as a static "edit pill".
 *
 * Unlike {@link CollapsedCodeBlock}, this part receives all of its data
 * (URI, edit kind, diff stats, before/after content URIs) up-front from the
 * producer (the agent host) and never reads from an
 * {@link IChatEditingSession}. It exists because agent hosts already know
 * the diff metadata for a completed tool call and there's no value in
 * re-deriving it through the chat editing pipeline.
 *
 * Activation (click / Enter) opens the side-by-side diff editor when both
 * `beforeContentUri` and `afterContentUri` are present, falling back to
 * opening the resulting file otherwise.
 */
export class ChatExternalEditContentPart extends ChatEditPillElement implements IChatContentPart {

	private readonly _onDidChangeDiff = this._register(new Emitter<IEditSessionDiffStats>());
	/**
	 * Fires once with the static diff stats from the part data. Wired up by
	 * the list renderer so {@link ChatThinkingContentPart} can aggregate
	 * per-file stats into the thinking title.
	 *
	 * The fire is deferred to the next microtask so that consumers
	 * subscribing immediately after construction (e.g. via
	 * `ChatThinkingContentPart.appendItem`) still receive the initial value.
	 */
	readonly onDidChangeDiff: Event<IEditSessionDiffStats> = this._onDidChangeDiff.event;

	get domNode(): HTMLElement { return this.element; }

	constructor(
		private readonly edit: IChatExternalEdit,
		_context: IChatContentPartRenderContext,
		@ILabelService labelService: ILabelService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		super(labelService, modelService, languageService, hoverService);

		this.render(edit);
		this._register(this.onDidClick(opts => this.openEdit(opts)));
	}

	private render(edit: IChatExternalEdit): void {
		this.setUri(edit.uri);

		const { icon, label } = describeEdit(edit);
		this.setStatus(icon, label);
		this.setProgressFill(undefined);
		this.setLabelDetail('');

		if (edit.diff && (edit.diff.added > 0 || edit.diff.removed > 0)) {
			this.setDiff(edit.diff);
			const fileName = this.labelService.getUriBasenameLabel(edit.uri);
			const insertionsFragment = edit.diff.added === 1
				? localize('chat.codeblock.insertions.one', "1 insertion")
				: localize('chat.codeblock.insertions', "{0} insertions", edit.diff.added);
			const deletionsFragment = edit.diff.removed === 1
				? localize('chat.codeblock.deletions.one', "1 deletion")
				: localize('chat.codeblock.deletions', "{0} deletions", edit.diff.removed);
			this.setAriaLabel(localize('summary', 'Edited {0}, {1}, {2}', fileName, insertionsFragment, deletionsFragment));
			// Fire the aggregated stats event on the next microtask so
			// listeners attached immediately after construction (the
			// `ChatThinkingContentPart.appendItem` path subscribes after
			// `createInstance` returns) still observe the value. The
			// `Emitter` is not replayable on subscribe, so a synchronous
			// fire would drop the initial stats on the floor.
			const diff = edit.diff;
			queueMicrotask(() => {
				if (this._store.isDisposed) {
					return;
				}
				this._onDidChangeDiff.fire({ added: diff.added, removed: diff.removed });
			});
		} else {
			this.setDiff(undefined);
			this.setAriaLabel(`${label} ${this.labelService.getUriBasenameLabel(edit.uri)}`);
		}
	}

	private async openEdit({ editorOptions: options, openToSide }: IOpenEditorOptions): Promise<void> {
		const group = openToSide ? SIDE_GROUP : undefined;
		// Pin so workbench preview mode cannot replace the diff tab before snapshots resolve.
		const pinnedOptions = { ...options, pinned: true };
		// Fallback so a click never dead-ends on an error pane.
		const openFile = () => {
			if (this.edit.editKind !== 'delete') {
				this.editorService.openEditor({ resource: this.edit.uri, options: pinnedOptions }, group).catch(() => { /* nothing more we can do */ });
			}
		};
		if (this.edit.beforeContentUri && this.edit.afterContentUri
			&& await this.bothSnapshotsReady()) {
			try {
				await this.editorService.openEditor({
					original: { resource: this.edit.beforeContentUri },
					modified: { resource: this.edit.afterContentUri },
					options: pinnedOptions,
				}, group);
			} catch {
				openFile();
			}
		} else if (this.edit.editKind === 'delete' && this.edit.beforeContentUri) {
			// The file no longer exists on disk; show the pre-deletion
			// content from the snapshot instead of opening the missing URI.
			this.editorService.openEditor({ resource: this.edit.beforeContentUri, options: pinnedOptions }, group).catch(() => { /* deleted file, snapshot gone */ });
		} else {
			openFile();
		}
	}

	/**
	 * Check that both snapshot sides are resolvable. Single attempt — snapshot content is cached
	 * in v3codeToolAdapters so resolver disposal during this probe is harmless; the diff editor
	 * recreates models from cache on open. Pills from before a window reload (no cache entry)
	 * return false and fall back to opening the plain file instantly.
	 */
	private async bothSnapshotsReady(): Promise<boolean> {
		const before = this.edit.beforeContentUri;
		const after = this.edit.afterContentUri;
		if (!before || !after) {
			return false;
		}
		try {
			const [beforeRef, afterRef] = await Promise.all([
				this.textModelService.createModelReference(before),
				this.textModelService.createModelReference(after),
			]);
			beforeRef.dispose();
			afterRef.dispose();
			return true;
		} catch {
			return false;
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'externalEdit') {
			return false;
		}
		return (
			isEqual(other.uri, this.edit.uri) &&
			other.editKind === this.edit.editKind &&
			(other.diff?.added ?? 0) === (this.edit.diff?.added ?? 0) &&
			(other.diff?.removed ?? 0) === (this.edit.diff?.removed ?? 0)
		);
	}
}

function describeEdit(edit: IChatExternalEdit): { icon: ThemeIcon; label: string } {
	switch (edit.editKind) {
		case 'create':
			return { icon: Codicon.check, label: localize('chat.externalEdit.created', 'Created') };
		case 'delete':
			return { icon: Codicon.check, label: localize('chat.externalEdit.deleted', 'Deleted') };
		case 'rename':
			return { icon: Codicon.check, label: localize('chat.externalEdit.renamed', 'Renamed') };
		case 'edit':
			return { icon: Codicon.check, label: localize('chat.codeblock.edited', 'Edited') };
	}
}

