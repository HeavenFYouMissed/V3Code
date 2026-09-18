/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The "V3Code is using your computer" overlay and its status-bar twin.
 *
 * Two things make an agent driving the machine tolerable: knowing it is happening, and being able to
 * stop it without hunting for a button. This surface provides both — a persistent, always-visible
 * banner and a single, universal escape hatch.
 *
 * The overlay deliberately does not block pointer events over the whole window. The user may still
 * need their machine while the agent works, and a full-screen input trap would be a worse hazard
 * than the one it guards against.
 */

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import './media/computerUseCancelOverlay.css';

/** Status-bar entry id. Owned by this module. */
const COMPUTER_USE_STATUS_ENTRY_ID = 'v3code.computerUse.active';

/** Root class name; every other selector in the stylesheet is nested under it. */
const OVERLAY_CLASS = 'v3code-computer-use-overlay';

/** What the overlay is currently telling the user the agent is doing. */
export interface ComputerUseOverlayState {
	/** Display name of the application being driven, when one is known. */
	readonly appName?: string;
	/** Short description of the action in flight, already localized. */
	readonly detail?: string;
}

/**
 * Shows and hides the cancel affordance for an in-flight computer-use action.
 *
 * Owned by `ComputerUseService`, which is the only thing that knows when an action starts and
 * stops. Instantiate through `IInstantiationService` so the injected services resolve.
 */
export class ComputerUseCancelOverlay extends Disposable {

	private readonly _onDidRequestCancel = this._register(new Emitter<void>());
	/**
	 * Fires the instant the user asks to stop — on Escape or on the button.
	 *
	 * The listener must abort the in-flight action immediately rather than marking it for a later
	 * stop: a cancel that takes effect after the next click has already landed is not a cancel.
	 */
	readonly onDidRequestCancel: Event<void> = this._onDidRequestCancel.event;

	/** Everything created by {@link show}, torn down as one unit by {@link hide}. */
	private readonly _active = this._register(new MutableDisposable<DisposableStore>());

	private _statusEntry: IStatusbarEntryAccessor | undefined;
	private _detailElement: HTMLElement | undefined;
	private _state: ComputerUseOverlayState = {};

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
	}

	/** True while the overlay is mounted. */
	get isVisible(): boolean {
		return this._active.value !== undefined;
	}

	/**
	 * Mounts the overlay, or updates it in place when it is already mounted.
	 *
	 * Idempotent so a burst of actions inside one agent turn does not flicker the banner off and on.
	 */
	show(state: ComputerUseOverlayState = {}): void {
		this._state = state;
		if (this._active.value) {
			this._renderDetail();
			this._renderStatusEntry();
			return;
		}

		const store = new DisposableStore();
		this._active.value = store;

		const container = this.layoutService.activeContainer;
		const root = dom.$(`.${OVERLAY_CLASS}`);
		root.setAttribute('role', 'status');
		root.setAttribute('aria-live', 'polite');

		const card = dom.append(root, dom.$(`.${OVERLAY_CLASS}__card`));
		dom.append(card, dom.$(`.${OVERLAY_CLASS}__pulse`));

		const text = dom.append(card, dom.$(`.${OVERLAY_CLASS}__text`));
		const title = dom.append(text, dom.$(`.${OVERLAY_CLASS}__title`));
		title.textContent = localize('computerUse.overlay.title', "V3Code is using your computer");
		this._detailElement = dom.append(text, dom.$(`.${OVERLAY_CLASS}__detail`));

		const button = dom.append(card, dom.$(`button.${OVERLAY_CLASS}__cancel`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = localize('computerUse.overlay.cancelButton', "Stop");
		button.setAttribute('aria-label', localize('computerUse.overlay.cancelAria', "Stop V3Code from using your computer"));

		const hint = dom.append(card, dom.$(`.${OVERLAY_CLASS}__hint`));
		hint.textContent = localize('computerUse.overlay.escHint', "Esc to cancel");

		this._renderDetail();
		dom.append(container, root);
		store.add(toDisposable(() => root.remove()));

		store.add(dom.addDisposableListener(button, dom.EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this._onDidRequestCancel.fire();
		}));

		// Capture phase on the document: Escape must win over whatever has focus, because the point of
		// the key is that it works without the user first having to find the right surface to press it in.
		store.add(dom.addDisposableListener(container.ownerDocument, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode !== KeyCode.Escape) {
				return;
			}
			keyboardEvent.preventDefault();
			keyboardEvent.stopPropagation();
			this._onDidRequestCancel.fire();
		}, true));

		this._renderStatusEntry();
		store.add(toDisposable(() => {
			this._statusEntry?.dispose();
			this._statusEntry = undefined;
			this._detailElement = undefined;
		}));
	}

	/** Unmounts the overlay and removes the status-bar entry. Safe to call when already hidden. */
	hide(): void {
		this._active.clear();
		this._state = {};
	}

	private _renderDetail(): void {
		if (!this._detailElement) {
			return;
		}
		const { appName, detail } = this._state;
		if (detail && appName) {
			this._detailElement.textContent = localize('computerUse.overlay.detailWithApp', "{0} in {1}", detail, appName);
		} else if (detail) {
			this._detailElement.textContent = detail;
		} else if (appName) {
			this._detailElement.textContent = localize('computerUse.overlay.appOnly', "Acting in {0}", appName);
		} else {
			this._detailElement.textContent = '';
		}
	}

	private _renderStatusEntry(): void {
		const appName = this._state.appName;
		const entry: IStatusbarEntry = {
			name: localize('computerUse.status.name', "V3Code Computer Use"),
			text: appName
				? `$(record) ${localize('computerUse.status.textWithApp', "Using {0}", appName)}`
				: `$(record) ${localize('computerUse.status.text', "Using your computer")}`,
			ariaLabel: localize('computerUse.status.aria', "V3Code is using your computer. Press Escape to cancel."),
			tooltip: localize('computerUse.status.tooltip', "V3Code is controlling your computer. Press Escape to cancel."),
			kind: 'warning',
		};
		if (this._statusEntry) {
			this._statusEntry.update(entry);
			return;
		}
		this._statusEntry = this.statusbarService.addEntry(entry, COMPUTER_USE_STATUS_ENTRY_ID, StatusbarAlignment.LEFT, Number.MAX_SAFE_INTEGER);
	}
}
