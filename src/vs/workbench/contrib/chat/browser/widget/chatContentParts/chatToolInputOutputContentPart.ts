/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { ButtonWithIcon } from '../../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, ISettableObservable, observableValue } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { observableConfigValue } from '../../../../../../platform/observable/common/platformObservableUtils.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { LanguageModelPartAudience } from '../../../common/languageModels.js';
import { AccessibilityWorkbenchSettingId } from '../../../../accessibility/browser/accessibilityConfiguration.js';
import { ChatTreeItem, IChatCodeBlockInfo } from '../../chat.js';
import { CodeBlockPart, ICodeBlockData, ICodeBlockRenderOptions } from './codeBlockPart.js';
import { IDisposableReference } from './chatCollections.js';
import { ChatQueryTitlePart } from './chatConfirmationWidget.js';
import { IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatToolOutputContentSubPart } from './chatToolOutputContentSubPart.js';
import { getChatMarkdownRenderOptions } from '../chatContentMarkdownRenderer.js';

export interface IChatCollapsibleIOCodePart {
	kind: 'code';
	data: string; // The text content to create a model from
	languageId: string;
	options: ICodeBlockRenderOptions;
	codeBlockIndex: number;
	ownerMarkdownPartId: string;
	title?: string | IMarkdownString;
	/**
	 * Optional pre-rendered DOM to show INSTEAD of the Monaco code block. Used to swap a
	 * `diff`-language block for the compact full-row diff view (renderUnifiedDiff),
	 * which needs semantic per-line elements a Monaco code block can't provide. When set, the
	 * code block is not rendered for this part.
	 */
	customDomNode?: HTMLElement;
}

export interface IChatCollapsibleIODataPart {
	kind: 'data';
	value?: Uint8Array;
	/**
	 * Base64-encoded value that can be decoded lazily to avoid expensive
	 * decoding during scroll. Takes precedence over `value` when present.
	 */
	base64Value?: string;
	audience?: LanguageModelPartAudience[];
	mimeType: string | undefined;
	uri: URI;
}

export type ChatCollapsibleIOPart = IChatCollapsibleIOCodePart | IChatCollapsibleIODataPart;

export interface IChatCollapsibleInputData extends IChatCollapsibleIOCodePart { }
export interface IChatCollapsibleOutputData {
	parts: ChatCollapsibleIOPart[];
}

export class ChatCollapsibleInputOutputContentPart extends Disposable {
	private readonly _editorReferences: IDisposableReference<CodeBlockPart>[] = [];
	private readonly _titlePart: ChatQueryTitlePart;
	private _outputSubPart: ChatToolOutputContentSubPart | undefined;
	private _contentBody: HTMLElement | undefined;
	public readonly domNode: HTMLElement;
	private _contentInitialized = false;

	get codeblocks(): IChatCodeBlockInfo[] {
		const outputCodeblocks = this._outputSubPart?.codeblocks ?? [];
		return outputCodeblocks;
	}

	public set title(s: string | IMarkdownString) {
		this._titlePart.title = s;
	}

	public get title(): string | IMarkdownString {
		return this._titlePart.title;
	}

	private readonly _expanded: ISettableObservable<boolean>;

	public get expanded(): boolean {
		return this._expanded.get();
	}

	private _headerActionHost: HTMLElement | undefined;

	/**
	 * Adds a button to the right of the header title, before the expand chevron. Used to
	 * open the full diff for an edit without expanding the card. The click is swallowed so
	 * it does not also toggle the card.
	 */
	public addHeaderAction(icon: ThemeIcon, tooltip: string, run: () => void): void {
		if (!this._headerActionHost) { return; }
		const button = dom.$('a.chat-confirmation-widget-header-action');
		button.setAttribute('role', 'button');
		button.setAttribute('tabindex', '0');
		button.setAttribute('aria-label', tooltip);
		button.title = tooltip;
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		const activate = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			run();
		};
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, activate));
		this._register(dom.addDisposableListener(button, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) { activate(e); }
		}));
		this._headerActionHost.insertBefore(button, this._headerActionHost.lastChild);
	}

	constructor(
		title: IMarkdownString | string,
		subtitle: string | IMarkdownString | undefined,
		progressTooltip: IMarkdownString | string | undefined,
		private readonly context: IChatContentPartRenderContext,
		private readonly input: IChatCollapsibleInputData,
		private readonly output: IChatCollapsibleOutputData | undefined,
		isError: boolean,
		initiallyExpanded: boolean,
		shimmer: boolean,
		/** Tool's own icon (file/terminal), shown when complete instead of a generic checkmark. */
		private readonly toolIcon: ThemeIcon | undefined,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		const container = dom.h('.chat-confirmation-widget-container');
		// Diff cards own their body rendering/CSS. Every other V3Code input-output result gets a
		// dedicated class so it can copy the diff card's metrics without changing the signed-off
		// diff rules themselves.
		if (!input.customDomNode) {
			container.root.classList.add('v3-muted-tool-card');
		}
		const titleEl = dom.h('.chat-confirmation-widget-title-inner');
		const elements = dom.h('.chat-confirmation-widget');
		this.domNode = container.root;
		container.root.appendChild(elements.root);

		this._titlePart = this._register(_instantiationService.createInstance(
			ChatQueryTitlePart,
			titleEl.root,
			title,
			subtitle,
		));
		this._titlePart.setOptions({ markdownRenderOptions: getChatMarkdownRenderOptions(), renderFileWidgets: true });
		const spacer = document.createElement('span');
		spacer.style.flexGrow = '1';

		const btn = this._register(new ButtonWithIcon(elements.root, {}));
		btn.element.classList.add('chat-confirmation-widget-title', 'monaco-text-button');
		btn.labelElement.append(titleEl.root);

		// Add hover chevron indicator on the right (decorative, hide from screen readers)
		const hoverChevron = dom.$('span.chat-collapsible-hover-chevron.codicon.codicon-chevron-right');
		hoverChevron.setAttribute('aria-hidden', 'true');
		btn.element.appendChild(hoverChevron);
		this._headerActionHost = btn.element;

		// Only show leading icon for errors, or for checkmarks/loading when the accessibility setting is on
		const showCheckmarks = observableConfigValue(AccessibilityWorkbenchSettingId.ShowChatCheckmarks, false, this.configurationService);

		const expanded = this._expanded = observableValue(this, initiallyExpanded);
		this._register(autorun(r => {
			const value = expanded.read(r);
			const checkmarksEnabled = showCheckmarks.read(r);
			elements.root.classList.toggle('collapsed', !value);

			// Diff cards have input but no output — treat customDomNode / input as "done" content.
			const hasResult = !!(output || this.input.customDomNode || this.input.data?.trim());
			const isInProgress = !hasResult && !isError;
			if (isError) {
				btn.icon = Codicon.error;
			} else if (isInProgress) {
				btn.icon = ThemeIcon.modify(Codicon.loading, 'spin');
			} else {
				// Prefer the tool's own glyph (file / terminal) over a checkmark so the
				// collapsed row reads as "icon + name + stats" rather than "done".
				btn.icon = this.toolIcon ?? Codicon.check;
			}
			elements.root.classList.toggle('shimmer-progress', shimmer && isInProgress);

			container.root.classList.toggle('show-checkmarks', checkmarksEnabled);

			// Update hover chevron direction
			hoverChevron.classList.toggle('codicon-chevron-right', !value);
			hoverChevron.classList.toggle('codicon-chevron-down', value);

			// Lazy initialization: render content only when expanded for the first time
			if (value && !this._contentInitialized) {
				this._contentInitialized = true;
				const messageContainer = dom.h('.chat-confirmation-widget-message');
				const messageContents = this.createMessageContents();
				messageContainer.root.appendChild(messageContents);
				elements.root.appendChild(messageContainer.root);
				// Custom diff renderers own their scroll container and continuation treatment.
				// Ordinary read/search/memory bodies scroll here, so only those receive this
				// outer-body fade observer.
				if (!this.input.customDomNode) {
					this.installEdgeFades(messageContents);
				}
			}
		}));

		const toggle = (e: Event) => {
			if (!e.defaultPrevented) {
				const value = expanded.get();
				expanded.set(!value, undefined);
				e.preventDefault();
			}
		};

		this._register(btn.onDidClick(toggle));

		const topLevelResources = this.output?.parts
			.filter(p => p.kind === 'data')
			.filter(p => !p.audience || p.audience.includes(LanguageModelPartAudience.User));
		if (topLevelResources?.length) {
			const resourceSubPart = this._register(this._instantiationService.createInstance(
				ChatToolOutputContentSubPart,
				this.context,
				topLevelResources,
			));
			const group = resourceSubPart.domNode;
			group.classList.add('chat-collapsible-top-level-resource-group');
			container.root.appendChild(group);
			this._register(autorun(r => {
				group.style.display = expanded.read(r) ? 'none' : '';
			}));
		}
	}

	private createMessageContents() {
		// No "Input" / "Output" section titles — those double up the header. Content is enough.
		const contents = dom.h('div.v3-tool-io-body', [
			dom.h('div@input'),
			dom.h('div@output'),
		]);

		const { input, output } = this;

		if (input.customDomNode) {
			// Pre-rendered view (e.g. the full-row diff) takes the place of the code block.
			contents.input.classList.add('v3-unified-diff-host');
			contents.input.appendChild(input.customDomNode);
		} else if (input.data?.trim()) {
			this.addCodeBlock(input, contents.input);
		} else {
			contents.input.remove();
		}

		if (!output) {
			contents.output.remove();
		} else {
			const outputSubPart = this._register(this._instantiationService.createInstance(
				ChatToolOutputContentSubPart,
				this.context,
				output.parts,
			));
			this._outputSubPart = outputSubPart;
			contents.output.appendChild(outputSubPart.domNode);
		}

		return contents.root;
	}

	/**
	 * Keep a soft edge only where a fixed-height tool body has more content off-screen.
	 * The classes follow the real scroll position, so a fully visible card stays crisp and
	 * the fade clears as the user reaches either edge instead of permanently fogging output.
	 */
	private installEdgeFades(element: HTMLElement): void {
		this._contentBody = element;
		const update = () => this.updateEdgeFades();

		this._register(dom.addDisposableListener(element, dom.EventType.SCROLL, update));
		const resizeObserver = this._register(new dom.DisposableResizeObserver(
			'ChatCollapsibleInputOutputContentPart.edgeFades',
			update,
			dom.getWindow(element),
		));
		this._register(resizeObserver.observe(element));
		for (const child of element.children) {
			this._register(resizeObserver.observe(child));
		}
		this._register(dom.runAtThisOrScheduleAtNextAnimationFrame(dom.getWindow(element), update));
	}

	private updateEdgeFades(): void {
		const element = this._contentBody;
		if (!element) {
			return;
		}

		const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
		const threshold = 2;
		element.classList.toggle('v3-scroll-fade-top', maxScrollTop > 0 && element.scrollTop > threshold);
		element.classList.toggle('v3-scroll-fade-bottom', maxScrollTop > 0 && element.scrollTop < maxScrollTop - threshold);
	}

	private addCodeBlock(part: IChatCollapsibleIOCodePart, container: HTMLElement) {
		const data: ICodeBlockData = {
			languageId: part.languageId,
			text: part.data,
			codeBlockIndex: part.codeBlockIndex,
			element: this.context.element,
			parentContextKeyService: this.contextKeyService,
			renderOptions: part.options,
			chatSessionResource: this.context.element.sessionResource,
		};
		const key = CodeBlockPart.poolKey(this.context.element.id, part.codeBlockIndex);
		const editorReference = this._register(this.context.editorPool.get(key));
		editorReference.object.render(data, this.context.currentWidth.get() || 300);
		container.appendChild(editorReference.object.element);
		this._editorReferences.push(editorReference);
	}

	hasSameContent(other: IChatRendererContent, followingContent: IChatRendererContent[], element: ChatTreeItem): boolean {
		// For now, we consider content different unless it's exactly the same instance
		return false;
	}

	layout(width: number): void {
		this._editorReferences.forEach(r => r.object.layout(width));
		this._outputSubPart?.layout(width);
		this.updateEdgeFades();
	}
}
