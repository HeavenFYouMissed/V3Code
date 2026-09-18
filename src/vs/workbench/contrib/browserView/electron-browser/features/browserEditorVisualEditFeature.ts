/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code Visual Edit — "Click anything. Change it yourself."
 *
 * A frosted control panel that lives INSIDE the live page (injected via the browser's isolated-world
 * exec path, model.executeScript), so it floats over the page exactly like the design mockup
 * (docs/mockups/visual-edit.html) and edits feel instant — no native-layer overlay fight, no
 * round-trip per tweak. Toggle the pill in the URL bar to arm it; click any element to select it;
 * restyle by hand (text, color, size, weight, padding, radius) with live preview. "Apply to source"
 * persists the exact hand edits into the real files; "Send to agent" handles freeform requests.
 *
 * The panel is a self-contained script injected into the page; this contribution arms/disarms it and
 * POLLS window.__v3veOut (drain script) every 350ms for the panel's outgoing messages, which it
 * relays into the chat widget as a precise source-edit request.
 */

import { localize, localize2 } from '../../../../../nls.js';
import { $ } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKey, IContextKeyService, ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { WorkbenchHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { Event } from '../../../../../base/common/event.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { IBrowserViewModel } from '../../../browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, IBrowserEditorWidgetContribution, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR } from '../browserEditor.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { VISUAL_EDIT_INJECT_SCRIPT, VISUAL_EDIT_TEARDOWN_SCRIPT, VISUAL_EDIT_DRAIN_SCRIPT } from './browserEditorVisualEditScript.js';

const BROWSER_EDITOR_ACTIVE = ContextKeyExpr.equals('activeEditor', BrowserEditorInput.EDITOR_ID);
const CONTEXT_VISUAL_EDIT_ACTIVE = new RawContextKey<boolean>('browserVisualEditActive', false, localize('browser.visualEditActive', "Whether Visual Edit is active"));
const BrowserCategory = localize2('browserCategory', "Browser");

/** One element's batched hand edits. */
interface VisualEditOne {
	readonly elementName?: string;
	readonly selector?: string;
	readonly outerHTML?: string;
	/** Exact CSS property -> value the user changed by hand. */
	readonly changes?: Record<string, string>;
	/** New text content, if the user edited it by hand. */
	readonly text?: string;
	/** Whether the element paints a background image/gradient (warn before replacing the bg color). */
	readonly hasBgImage?: boolean;
}

/** The batched message the panel sends when the user hits "Send to agent". */
interface VisualEditMessage {
	readonly type: 'send';
	/** Every element the user staged edits on, in one batch. */
	readonly edits?: VisualEditOne[];
	/** Optional freeform note the user added. */
	readonly note?: string;
}

/**
 * Arms/disarms the in-page Visual Edit panel and relays its "send to agent" calls into chat.
 */
export class BrowserEditorVisualEdit extends BrowserEditorContribution {
	private readonly _activeContext: IContextKey<boolean>;
	private readonly _toggleContainer: HTMLElement;
	private readonly _toggleButton: Button;

	private _active = false;
	private readonly _poll = this._register(new IntervalTimer());

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super(editor);
		this._activeContext = CONTEXT_VISUAL_EDIT_ACTIVE.bindTo(contextKeyService);

		const hoverDelegate = this._register(instantiationService.createInstance(
			WorkbenchHoverDelegate, 'element', undefined, { position: { hoverPosition: HoverPosition.ABOVE } }
		));
		this._toggleContainer = $('.browser-visual-edit-toggle-container');
		this._toggleButton = this._register(new Button(this._toggleContainer, {
			supportIcons: true,
			title: localize('browser.visualEdit', "Visual Edit"),
			small: true,
			hoverDelegate,
		}));
		this._toggleButton.element.classList.add('browser-visual-edit-toggle');
		this._toggleButton.label = '$(edit)';
		this._register(this._toggleButton.onDidClick(() => this.toggle()));
	}

	override get urlBarWidgets(): readonly IBrowserEditorWidgetContribution[] {
		return [{ element: this._toggleContainer, order: 40 }];
	}

	protected override subscribeToModel(model: IBrowserViewModel, store: DisposableStore): void {
		this._toggleContainer.style.display = '';
		// Disarm only on a REAL main-frame load (loading -> true). NOT on SPA / same-document
		// navigation (history.pushState / hash change) — those keep the injected panel alive, so
		// tearing down then would make the panel vanish when the user clicks an in-app link.
		store.add(model.onDidChangeLoadingState(e => { if (e.loading && this._active) { void this._deactivate(); } }));
		store.add({ dispose: () => { if (this._active) { void this._deactivate(); } } });
	}

	override clear(): void {
		this._activeContext.reset();
		this._setButtonState(false);
		this._toggleContainer.style.display = 'none'; // no page -> no pill (mirrors the Share button)
	}

	async toggle(): Promise<void> {
		if (this._active) { await this._deactivate(); } else { await this._activate(); }
	}

	private _setButtonState(active: boolean): void {
		this._toggleButton.element.classList.toggle('active', active);
		this._toggleButton.label = active ? localize('browser.visualEditOn', "Visual Edit") + ' $(edit)' : '$(edit)';
	}

	private async _activate(): Promise<void> {
		const model = this.editor.model;
		if (!model || this._active || !model.url || model.error) { return; }
		try {
			// Inject the panel into the page's ISOLATED WORLD (shared DOM, separate JS context) —
			// the same mechanism the browser uses to read selected text. Returns 'v3ve-armed'.
			const res = await model.executeScript(VISUAL_EDIT_INJECT_SCRIPT);
			// The model may have been swapped/disposed during the await — don't arm a stale page.
			if (this.editor.model !== model || this._active) { return; }
			this.logService.trace('[VisualEdit] armed:', res);
			this._active = true;
			this._activeContext.set(true);
			this._setButtonState(true);
			// Poll for the panel's outgoing messages (the page can't call us directly).
			this._poll.cancelAndSet(() => { void this._drain(); }, 350);
		} catch (err) {
			this.logService.error('[VisualEdit] failed to arm', err);
		}
	}

	private async _deactivate(): Promise<void> {
		if (!this._active) { return; }
		this._active = false;
		this._activeContext.set(false);
		this._setButtonState(false);
		this._poll.cancel();
		const model = this.editor.model;
		if (model) { try { await model.executeScript(VISUAL_EDIT_TEARDOWN_SCRIPT); } catch { /* page may be gone */ } }
	}

	private async _drain(): Promise<void> {
		const model = this.editor.model;
		if (!model || !this._active) { return; }
		let out: unknown;
		try { out = await model.executeScript(VISUAL_EDIT_DRAIN_SCRIPT); } catch { return; }
		// Revalidate after the await: a disarm/navigation may have happened mid-flight.
		if (!this._active || this.editor.model !== model) { return; }
		if (typeof out !== 'string' || !out) { return; }
		let queue: VisualEditMessage[];
		try { queue = JSON.parse(out).map((s: string) => JSON.parse(s)); } catch { return; }
		// Process EVERY queued message (never drop a Send).
		for (const data of queue) {
			if (data.type === 'send') { await this._submitToAgent(data); }
		}
	}

	private async _revealChat(): Promise<IChatWidget | undefined> {
		const widget = await this.chatWidgetService.revealWidget() ?? this.chatWidgetService.lastFocusedWidget;
		if (widget && !widget.viewModel) { await Event.toPromise(widget.onDidChangeViewModel); }
		return widget;
	}

	/** Build a readable, self-contained instruction from the batch and SUBMIT it as a chat message.
	 *  The whole change set goes into the message TEXT (not an attachment the agent might not read),
	 *  so the agent reliably sees every edit. */
	private async _submitToAgent(data: VisualEditMessage): Promise<void> {
		const edits = (data.edits ?? []).filter(e => (e.changes && Object.keys(e.changes).length) || typeof e.text === 'string');
		const note = (data.note ?? '').trim();
		if (!edits.length && !note) { return; }

		const widget = await this._revealChat();
		if (!widget) { return; }
		const url = this.editor.model?.url ?? '';

		const lines: string[] = [];
		if (edits.length) {
			lines.push(`Apply these visual edits to the SOURCE of ${url || 'this page'} — edit the real CSS/markup in the project, not the live DOM. For each element, find it in the source and write the exact properties listed:`);
			edits.forEach((e, i) => {
				lines.push('');
				lines.push(`[${i + 1}] ${e.elementName ?? 'element'}   (selector: ${e.selector ?? '?'})`);
				for (const [k, v] of Object.entries(e.changes ?? {})) { lines.push(`    ${k}: ${v};`); }
				if (typeof e.text === 'string') { lines.push(`    text content -> ${JSON.stringify(e.text)}`); }
				if (e.hasBgImage && e.changes && e.changes['background-color'] !== undefined) {
					lines.push('    (this element has a background image/gradient — keep it; change only the color component)');
				}
			});
			lines.push('');
			lines.push('If a property comes from a shared class used by other elements, scope the change to just that element (don\'t restyle every instance). Keep edits minimal and consistent with the existing code.');
		}
		if (note) { lines.push(''); lines.push(edits.length ? `Also: ${note}` : note); }

		// Close the loop: the integrated browser caches, so the user won't SEE the change until the
		// page is reloaded. Tell the agent to reopen the URL at the very end — a fresh open_browser
		// navigation is a no-cache load (equivalent to a hard refresh), so the edits become visible.
		if (url) {
			lines.push('');
			lines.push(`When ALL edits are applied, finish by reopening ${url} in the integrated browser (use the open_browser tool). It's a fresh, no-cache load (equivalent to a hard refresh) so the changes actually show.`);
		}

		const message = lines.join('\n');
		// Preserve any half-typed chat text by prepending it, then submit as one user turn.
		const existing = widget.getInput().trim();
		try {
			await widget.acceptInput(existing ? `${existing}\n\n${message}` : message);
		} catch (err) {
			// Chat may be busy — fall back to filling the input so the user can send it manually.
			this.logService.warn('[VisualEdit] acceptInput failed, leaving message in the input', err);
			widget.setInput(existing ? `${existing}\n\n${message}` : message);
			widget.focusInput();
		}
	}
}

BrowserEditor.registerContribution(BrowserEditorVisualEdit);

// -- Action (command palette + toolbar) ---------------------------------

class ToggleVisualEditAction extends Action2 {
	static readonly ID = 'browser.action.toggleVisualEdit';
	constructor() {
		super({
			id: ToggleVisualEditAction.ID,
			title: localize2('browser.toggleVisualEdit', 'Toggle Visual Edit'),
			category: BrowserCategory,
			icon: Codicon.edit,
			f1: true,
			toggled: CONTEXT_VISUAL_EDIT_ACTIVE,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate()),
			menu: { id: MenuId.BrowserActionsToolbar, group: 'actions', order: 2 },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorService).activeEditorPane;
		if (pane instanceof BrowserEditor) {
			await pane.getContribution(BrowserEditorVisualEdit)?.toggle();
		}
	}
}
registerAction2(ToggleVisualEditAction);

// Keep the toolbar entry gated on chat being available (the prompt path needs it).
MenuRegistry.appendMenuItem(MenuId.BrowserActionsToolbar, {
	command: { id: ToggleVisualEditAction.ID, title: localize('browser.visualEdit', "Visual Edit"), icon: Codicon.edit },
	group: 'actions',
	order: 2,
	when: ChatContextKeys.enabled,
});
