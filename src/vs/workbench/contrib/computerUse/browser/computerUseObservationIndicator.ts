/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The "V3Code is watching {app}" indicator, and its status-bar twin.
 *
 * Ambient observation is the one part of computer use that runs with no tool call behind it, so the
 * only thing standing between it and a surveillance feature is that the user can always tell it is
 * happening and always stop it in one click. This surface is therefore not decoration — it is the
 * user-facing half of the safety design, and it holds to three rules:
 *
 * - **No dismiss.** There is a Stop and a Pause, both of which actually stop observing. There is
 *   deliberately no "hide this" affordance, because an indicator the user can silence while capture
 *   continues is worse than no indicator at all: it teaches them that a quiet screen means nothing is
 *   being watched.
 * - **Named, not generic.** It says which application is being observed and whether frames are
 *   included, because "observation active" tells the user nothing they can act on.
 * - **Mounted for the whole session and torn down with it.** {@link ComputerUseObservationIndicator}
 *   is shown by the observation service the moment a session starts and hidden the moment the last one
 *   ends, from the same code path that starts and stops the sampling — so the indicator cannot be
 *   out of step with reality.
 *
 * Like the cancel overlay, the root is `pointer-events: none` and only the card opts back in: the user
 * needs their machine while this is up, and a full-window input trap would be the larger hazard.
 */

import * as dom from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import './media/computerUseObservationIndicator.css';

/**
 * Status-bar entry id. Owned by this module.
 *
 * Distinct from the cancel overlay's entry: the two states are independent — the agent can be acting
 * while observation runs — and collapsing them into one entry would hide whichever arrived second.
 */
const COMPUTER_USE_OBSERVATION_STATUS_ENTRY_ID = 'v3code.computerUse.observing';

/** Root class name; every other selector in the stylesheet is nested under it. */
const INDICATOR_CLASS = 'v3code-computer-use-observation';

/** One application currently being observed, as the indicator needs to describe it. */
export interface ComputerUseObservationIndicatorSession {
	/** Display name of the observed application. */
	readonly appName: string;
	/** True when raster frames are part of what is being collected. Stated explicitly, never implied. */
	readonly includesScreenshots: boolean;
	/** Samples taken so far in this session. */
	readonly samples: number;
	/** Epoch milliseconds at which permission lapses and the session stops itself. */
	readonly permittedUntil: number;
}

/** Everything the indicator renders. */
export interface ComputerUseObservationIndicatorState {
	readonly sessions: readonly ComputerUseObservationIndicatorSession[];
	/** Epoch milliseconds observation is suspended until, when it is suspended. */
	readonly pausedUntil?: number;
	/** Clock reading used to render the remaining time. Injected so the render stays deterministic. */
	readonly nowMs: number;
}

/**
 * The always-visible ambient-observation banner plus its status-bar entry.
 *
 * Owned by the observation service — the only component that knows when a session starts or stops.
 * Instantiate through `IInstantiationService` so the injected services resolve.
 */
export class ComputerUseObservationIndicator extends Disposable {

	private readonly _onDidRequestStop = this._register(new Emitter<void>());
	/**
	 * Fires when the user asks to stop observing entirely.
	 *
	 * The listener must perform a hard stop — no in-flight sample may be retained afterwards — rather
	 * than declining to schedule the next one.
	 */
	readonly onDidRequestStop: Event<void> = this._onDidRequestStop.event;

	private readonly _onDidRequestPause = this._register(new Emitter<void>());
	/** Fires when the user asks to suspend observation without withdrawing any grant. */
	readonly onDidRequestPause: Event<void> = this._onDidRequestPause.event;

	/** Everything created by {@link show}, torn down as one unit by {@link hide}. */
	private readonly _active = this._register(new MutableDisposable<DisposableStore>());

	private _statusEntry: IStatusbarEntryAccessor | undefined;
	private _titleElement: HTMLElement | undefined;
	private _detailElement: HTMLElement | undefined;
	private _pauseButton: HTMLButtonElement | undefined;
	private _state: ComputerUseObservationIndicatorState = { sessions: [], nowMs: 0 };

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
	}

	/** True while the indicator is mounted. */
	get isVisible(): boolean {
		return this._active.value !== undefined;
	}

	/**
	 * Mounts the indicator, or updates it in place when already mounted.
	 *
	 * Idempotent so a sample landing every few seconds updates the counter rather than remounting the
	 * banner, which would make it flicker and read as unreliable.
	 */
	show(state: ComputerUseObservationIndicatorState): void {
		this._state = state;
		if (this._active.value) {
			this._render();
			return;
		}

		const store = new DisposableStore();
		this._active.value = store;

		const container = this.layoutService.activeContainer;
		const root = dom.$(`.${INDICATOR_CLASS}`);
		root.setAttribute('role', 'status');
		root.setAttribute('aria-live', 'polite');

		const card = dom.append(root, dom.$(`.${INDICATOR_CLASS}__card`));
		dom.append(card, dom.$(`.${INDICATOR_CLASS}__eye`));

		const text = dom.append(card, dom.$(`.${INDICATOR_CLASS}__text`));
		this._titleElement = dom.append(text, dom.$(`.${INDICATOR_CLASS}__title`));
		this._detailElement = dom.append(text, dom.$(`.${INDICATOR_CLASS}__detail`));

		const pause = dom.append(card, dom.$(`button.${INDICATOR_CLASS}__pause`)) as HTMLButtonElement;
		pause.type = 'button';
		pause.textContent = localize('computerUse.observation.indicator.pause', "Pause");
		pause.setAttribute('aria-label', localize('computerUse.observation.indicator.pauseAria', "Pause ambient observation"));
		this._pauseButton = pause;

		const stop = dom.append(card, dom.$(`button.${INDICATOR_CLASS}__stop`)) as HTMLButtonElement;
		stop.type = 'button';
		stop.textContent = localize('computerUse.observation.indicator.stop', "Stop watching");
		stop.setAttribute('aria-label', localize('computerUse.observation.indicator.stopAria', "Stop ambient observation"));

		this._render();
		dom.append(container, root);
		store.add(toDisposable(() => root.remove()));

		store.add(dom.addDisposableListener(pause, dom.EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this._onDidRequestPause.fire();
		}));

		store.add(dom.addDisposableListener(stop, dom.EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this._onDidRequestStop.fire();
		}));

		store.add(toDisposable(() => {
			this._statusEntry?.dispose();
			this._statusEntry = undefined;
			this._titleElement = undefined;
			this._detailElement = undefined;
			this._pauseButton = undefined;
		}));
	}

	/** Unmounts the indicator and removes the status-bar entry. Safe to call when already hidden. */
	hide(): void {
		this._active.clear();
		this._state = { sessions: [], nowMs: 0 };
	}

	private _render(): void {
		this._renderBanner();
		this._renderStatusEntry();
	}

	private _renderBanner(): void {
		if (!this._titleElement || !this._detailElement) {
			return;
		}
		this._titleElement.textContent = this._title();
		this._detailElement.textContent = this._detail();
		if (this._pauseButton) {
			// Hidden rather than disabled while paused: a Pause button that does nothing invites a second
			// press and a bug report, whereas its absence says the state is already what it would produce.
			this._pauseButton.style.display = this._isPaused() ? 'none' : '';
		}
	}

	private _isPaused(): boolean {
		const { pausedUntil, nowMs } = this._state;
		return pausedUntil !== undefined && nowMs < pausedUntil;
	}

	private _title(): string {
		if (this._isPaused()) {
			return localize('computerUse.observation.indicator.pausedTitle', "V3Code has paused watching your screen");
		}
		const names = this._state.sessions.map(session => session.appName);
		if (names.length === 1) {
			return localize('computerUse.observation.indicator.titleOne', "V3Code is watching {0}", names[0]);
		}
		if (names.length > 1) {
			return localize('computerUse.observation.indicator.titleMany', "V3Code is watching {0} applications", names.length);
		}
		return localize('computerUse.observation.indicator.titleNone', "V3Code ambient observation is on");
	}

	private _detail(): string {
		if (this._isPaused()) {
			return localize('computerUse.observation.indicator.pausedDetail', "Nothing is being recorded until you resume.");
		}
		const sessions = this._state.sessions;
		const withFrames = sessions.some(session => session.includesScreenshots);
		const samples = sessions.reduce((total, session) => total + session.samples, 0);
		const remainingMinutes = this._remainingMinutes();
		const what = withFrames
			? localize('computerUse.observation.indicator.whatFrames', "screen contents and screenshots")
			: localize('computerUse.observation.indicator.whatTree', "screen contents");
		if (remainingMinutes === undefined) {
			return localize('computerUse.observation.indicator.detail', "Recording {0} — {1} samples so far.", what, samples);
		}
		return localize(
			'computerUse.observation.indicator.detailWithTime',
			"Recording {0} — {1} samples so far, stopping in {2} min.",
			what, samples, remainingMinutes,
		);
	}

	/** Whole minutes until the earliest session expires, or `undefined` when nothing is running. */
	private _remainingMinutes(): number | undefined {
		let earliest: number | undefined;
		for (const session of this._state.sessions) {
			if (earliest === undefined || session.permittedUntil < earliest) {
				earliest = session.permittedUntil;
			}
		}
		if (earliest === undefined) {
			return undefined;
		}
		return Math.max(0, Math.ceil((earliest - this._state.nowMs) / 60_000));
	}

	private _renderStatusEntry(): void {
		const paused = this._isPaused();
		const names = this._state.sessions.map(session => session.appName);
		const text = paused
			? `$(debug-pause) ${localize('computerUse.observation.status.textPaused', "Watching paused")}`
			: names.length === 1
				? `$(eye) ${localize('computerUse.observation.status.textOne', "Watching {0}", names[0])}`
				: `$(eye) ${localize('computerUse.observation.status.textMany', "Watching {0} apps", Math.max(1, names.length))}`;
		const entry: IStatusbarEntry = {
			name: localize('computerUse.observation.status.name', "V3Code Ambient Observation"),
			text,
			ariaLabel: paused
				? localize('computerUse.observation.status.ariaPaused', "V3Code ambient observation is paused.")
				: localize('computerUse.observation.status.aria', "V3Code is watching your screen. Select to stop."),
			tooltip: this._detail(),
			// Warning rather than prominent: this is a state the user should notice every time, and the
			// warning colour is the strongest thing the status bar can say without being an error.
			kind: 'warning',
			command: undefined,
		};
		if (this._statusEntry) {
			this._statusEntry.update(entry);
			return;
		}
		this._statusEntry = this.statusbarService.addEntry(
			entry,
			COMPUTER_USE_OBSERVATION_STATUS_ENTRY_ID,
			StatusbarAlignment.LEFT,
			Number.MAX_SAFE_INTEGER - 1,
		);
	}
}
