/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ProgressBar } from '../../../../../../../base/browser/ui/progressbar/progressbar.js';
import { onUnexpectedError } from '../../../../../../../base/common/errors.js';
import { IMarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../../../base/common/lazy.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { getExtensionForMimeType } from '../../../../../../../base/common/mime.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { basename } from '../../../../../../../base/common/resources.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { localize } from '../../../../../../../nls.js';
import { ILanguageService } from '../../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../../editor/common/services/model.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ChatConfiguration } from '../../../../common/constants.js';
import { ChatResponseResource } from '../../../../common/model/chatModel.js';
import { IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { IToolResultInputOutputDetails } from '../../../../common/tools/languageModelToolsService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { parseSlimDiffPayload, SlimDiffCardPayload, SLIM_DIFF_LANGUAGE_ID } from '../../../../common/chatSlimDiffPayload.js';
import { ChatCollapsibleInputOutputContentPart, ChatCollapsibleIOPart, IChatCollapsibleIOCodePart } from '../chatToolInputOutputContentPart.js';
import { renderSlimDiff } from '../chatSlimDiffView.js';
import { renderUnifiedDiff } from '../chatUnifiedDiffView.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { getToolApprovalMessage, shouldShimmerForTool } from './chatToolPartUtilities.js';

/**
 * Hard ceiling before a diff card hands the rest of the review to the native editor.
 * The renderer applies a smaller visible preview and reports the remaining rows.
 */
const SLIM_DIFF_CARD_MAX_ITEMS = 40;

export class ChatInputOutputMarkdownProgressPart extends BaseChatToolInvocationSubPart {
	/** Remembers expanded tool parts on re-render */
	private static readonly _expandedByDefault = new WeakMap<IChatToolInvocation | IChatToolInvocationSerialized, boolean>();

	public readonly domNode: HTMLElement;
	private readonly collapsibleListPart: ChatCollapsibleInputOutputContentPart;

	public get codeblocks(): IChatCodeBlockInfo[] {
		return this.collapsibleListPart.codeblocks;
	}

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		context: IChatContentPartRenderContext,
		codeBlockStartIndex: number,
		message: string | IMarkdownString,
		subtitle: string | IMarkdownString | undefined,
		input: string,
		inputLanguage: string | undefined,
		output: IToolResultInputOutputDetails['output'] | undefined,
		isError: boolean,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(toolInvocation);

		let codeBlockIndex = codeBlockStartIndex;

		// Simple factory to create code part data objects
		const createCodePart = (data: string, languageId = 'json'): IChatCollapsibleIOCodePart => ({
			kind: 'code',
			data,
			languageId,
			codeBlockIndex: codeBlockIndex++,
			ownerMarkdownPartId: this.codeblocksPartId,
			options: {
				hideToolbar: true,
				reserveWidth: 19,
				// A few lines, not a wall of output.
				maxHeightInLines: 5,
				verticalPadding: 5,
				editorOptions: {
					wordWrap: 'on'
				}
			}
		});

		// Diff cards render as rows, not as a Monaco code block: a code block can only color the
		// +/- characters, never tint the whole line. See docs/CHAT-DIFF-SPEC.md.
		const inputPart = createCodePart(input, inputLanguage);
		let diffPayload: SlimDiffCardPayload | undefined;
		if (inputLanguage === SLIM_DIFF_LANGUAGE_ID) {
			const payload = diffPayload = parseSlimDiffPayload(input);
			// This runs inside the tool part's render, which in turn runs inside the
			// invocation being marked complete. Anything thrown here would leave the card
			// stuck showing progress forever, so a broken diff degrades to no diff.
			try {
				if (!payload) { throw new Error('unparseable slim diff payload'); }
				inputPart.customDomNode = renderSlimDiff(payload.original, payload.modified, this._languageService, {
					// One number per row; two columns is for a full review surface.
					showLineNumbers: 'partial',
					maxItems: SLIM_DIFF_CARD_MAX_ITEMS,
					languageId: payload.path,
					tabSize: configurationService.getValue<number>('editor.tabSize') ?? 4,
				});
			} catch (err) {
				onUnexpectedError(err);
				inputPart.customDomNode = undefined;
				// Blank rather than fall through — the raw payload is JSON, not something to show.
				inputPart.data = '';
			}
		} else if (inputLanguage === 'diff' && input.trim().length > 0) {
			inputPart.customDomNode = renderUnifiedDiff(input);
		}

		let processedOutput = output;
		if (typeof output === 'string') { // back compat with older stored versions
			processedOutput = [{ type: 'embed', value: output, isText: true }];
		}

		const collapsibleListPart = this.collapsibleListPart = this._register(instantiationService.createInstance(
			ChatCollapsibleInputOutputContentPart,
			message,
			subtitle,
			this.getAutoApproveMessageContent(),
			context,
			inputPart,
			processedOutput && processedOutput.length > 0 ? {
				parts: processedOutput.map((o, i): ChatCollapsibleIOPart => {
					const permalinkBasename = o.type === 'ref' || o.uri
						? basename(o.uri!)
						: o.mimeType && getExtensionForMimeType(o.mimeType)
							? `file${getExtensionForMimeType(o.mimeType)}`
							: 'file' + (o.isText ? '.txt' : '.bin');


					if (o.type === 'ref') {
						return { kind: 'data', uri: o.uri, mimeType: o.mimeType };
					} else if (o.isText && !o.asResource) {
						return createCodePart(o.value);
					} else {
						// Defer base64 decoding to avoid expensive decode during scroll.
						// The value will be decoded lazily in ChatToolOutputContentSubPart.
						const permalinkUri = ChatResponseResource.createUri(context.element.sessionResource, toolInvocation.toolCallId, i, permalinkBasename);
						if (!o.isText) {
							// Pass base64 string for lazy decoding
							return { kind: 'data', base64Value: o.value, mimeType: o.mimeType, uri: permalinkUri, audience: o.audience };
						} else {
							// Text content: encode immediately since it's not expensive
							return { kind: 'data', value: new TextEncoder().encode(o.value), mimeType: o.mimeType, uri: permalinkUri, audience: o.audience };
						}
					}
				}),
			} : undefined,
			isError,
			// Expand by default when there's an error (if setting enabled),
			// otherwise use the stored expanded state (defaulting to false)
			(isError && configurationService.getValue<boolean>(ChatConfiguration.AutoExpandToolFailures)) ||
			(ChatInputOutputMarkdownProgressPart._expandedByDefault.get(toolInvocation) ?? false),
			shouldShimmerForTool(toolInvocation),
			toolInvocation.icon,
		));
		this._register(toDisposable(() => ChatInputOutputMarkdownProgressPart._expandedByDefault.set(toolInvocation, collapsibleListPart.expanded)));

		// Only offer the button when the tool left snapshots behind. A created file has none
		// (both sides would be empty), and there is nothing worth opening in that case.
		if (diffPayload?.originalUri && diffPayload.modifiedUri) {
			const original = URI.parse(diffPayload.originalUri);
			const modified = URI.parse(diffPayload.modifiedUri);
			const name = diffPayload.path ? basename(URI.file(diffPayload.path)) : localize('chatDiffFile', "file");
			collapsibleListPart.addHeaderAction(
				Codicon.diffSingle,
				localize('chatOpenDiff', "Open changes to {0}", name),
				() => this.openDiffEditor(original, modified, name, diffPayload.original, diffPayload.modified, diffPayload.path),
			);
		}

		const progressObservable = toolInvocation.kind === 'toolInvocation' ? toolInvocation.state.map((s, r) => s.type === IChatToolInvocation.StateKind.Executing ? s.progress.read(r) : undefined) : undefined;
		const progressBar = new Lazy(() => this._register(new ProgressBar(collapsibleListPart.domNode)));
		if (progressObservable) {
			this._register(autorun(reader => {
				const progress = progressObservable?.read(reader);
				if (progress?.message) {
					collapsibleListPart.title = progress.message;
				}
				if (progress?.progress && !IChatToolInvocation.isComplete(toolInvocation, reader)) {
					progressBar.value.setWorked(progress.progress * 100);
				}
			}));
		}

		this.domNode = collapsibleListPart.domNode;
	}

	private getAutoApproveMessageContent() {
		return getToolApprovalMessage(this.toolInvocation);
	}

	/**
	 * Opens the edit in a real diff editor using the snapshot resources created by the tool.
	 * Their scheme has a registered provider; restored cards rehydrate the provider's
	 * in-memory source from their durable before/after payload before the editor resolves.
	 */
	private openDiffEditor(original: URI, modified: URI, name: string, originalContent: string, modifiedContent: string, path: string | undefined): void {
		// Diff cards survive application restarts, while the tool adapter's snapshot
		// cache is intentionally process-local. Rehydrate the immutable models from
		// the card payload before asking the native diff editor to resolve them.
		// Without this, a restored chat points at valid snapshot URIs with no content
		// provider entry and the right-hand editor opens on an error page.
		const languageId = path ? (this._languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(path)) ?? 'plaintext') : 'plaintext';
		for (const [resource, content] of [[original, originalContent], [modified, modifiedContent]] as const) {
			if (!this._modelService.getModel(resource)) {
				this._modelService.createModel(content, this._languageService.createById(languageId), resource, false);
			}
		}
		this._editorService.openEditor({
			original: { resource: original },
			modified: { resource: modified },
			label: localize('chatDiffTitle', "{0} (chat edit)", name),
			options: { pinned: false },
		}).catch(onUnexpectedError);
	}
}
