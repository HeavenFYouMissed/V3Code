/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { $, addStandardDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatCollapsibleContentPart } from '../../chat/browser/widget/chatContentParts/chatCollapsibleContentPart.js';
import { IChatContentPartRenderContext } from '../../chat/browser/widget/chatContentParts/chatContentParts.js';
import { V3_DEBUG_IDLE_POLL_INTERVAL_MS, V3_DEBUG_POLL_INTERVAL_MS, V3DebugSessionPhase } from '../common/debugSessionTypes.js';
import { debugGroupTitle, planEvidencePanel, V3EvidenceLineViewModel, V3EvidencePanelViewModel } from '../common/v3DebugTranscript.js';
import { IDebugSessionService } from './debugSessionService.js';

export const V3_DEBUG_LIVE_STATUS_CLASS = 'v3-chat-live-status';

/**
 * Disclosure wrapper for a run of consecutive successful Debug operations. It owns no tool
 * state: the chat list renderer moves the existing tool cards into `listElement` and back out,
 * so each card keeps rendering itself. Reuses the native collapsible chrome and its
 * `.chat-used-context-list` collapse rule.
 */
export class V3DebugToolGroupPart extends ChatCollapsibleContentPart {
	private readonly _onDidChangeExpansion = this._register(new Emitter<boolean>());
	/** Fires only for user-driven changes after the group is on screen (never for the seed). */
	readonly onDidChangeExpansion: Event<boolean> = this._onDidChangeExpansion.event;

	private _listElement: HTMLElement | undefined;
	private _seeded = false;
	private _memberIds: readonly string[];

	constructor(
		memberIds: readonly string[],
		private readonly initiallyExpanded: boolean,
		context: IChatContentPartRenderContext,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(debugGroupTitle(memberIds.length), context, undefined, hoverService, configurationService);
		this._memberIds = memberIds;
		this._register(autorun(reader => {
			const expanded = this.expanded.read(reader);
			if (this._listElement) {
				this._onDidChangeExpansion.fire(expanded);
			}
		}));
	}

	get memberIds(): readonly string[] {
		return this._memberIds;
	}

	setMembers(memberIds: readonly string[]): void {
		this._memberIds = memberIds;
		this.setTitle(debugGroupTitle(memberIds.length));
	}

	/** The container the renderer moves member cards into (created eagerly with the disclosure). */
	get listElement(): HTMLElement {
		this.domNode.classList.add('v3-debug-tool-group');
		return this._listElement!;
	}

	protected override isExpanded(): boolean {
		if (!this._seeded) {
			this._seeded = true;
			return this.initiallyExpanded;
		}
		return super.isExpanded();
	}

	protected override shouldInitEarly(): boolean {
		return true;
	}

	protected override initContent(): HTMLElement {
		this._listElement = $('.chat-used-context-list.v3-debug-tool-group-list');
		return this._listElement;
	}

	hasSameContent(): boolean {
		return false;
	}
}

/**
 * Keeps exactly one polite live region at the end of `container`. The element stays mounted
 * while the response is active so screen readers announce changes.
 *
 * `active` is passed in rather than inferred from the text: the sheen is a claim that the
 * machine is doing something, and it used to run on ANY non-empty text — so an animated
 * "Waiting for your answer" or "1 operation awaiting your approval" claimed activity at the
 * exact moments nothing was running. Only real work animates.
 */
export function updateV3DebugLiveStatus(container: HTMLElement, existing: HTMLElement | undefined, text: string, active: boolean): HTMLElement {
	let status = existing;
	if (!status || status.parentElement !== container) {
		status?.remove();
		status = $(`.${V3_DEBUG_LIVE_STATUS_CLASS}`, { 'aria-live': 'polite', 'aria-atomic': 'true', role: 'status' });
		container.appendChild(status);
	} else if (container.lastElementChild !== status) {
		container.appendChild(status); // parts are appended after it: keep it last
	}
	if (status.textContent !== text) {
		status.textContent = text;
	}
	status.classList.toggle('v3-sheen', active && text.length > 0);
	return status;
}

export function removeV3DebugLiveStatus(existing: HTMLElement | undefined): undefined {
	existing?.remove();
	return undefined;
}

export const V3_DEBUG_EVIDENCE_CLASS = 'v3-debug-evidence';

/**
 * The inline runtime-evidence panel: the sink's tail, live, inside the Debug response.
 *
 * This is the half of Debug mode the user can see. Without it the model reads the evidence file
 * and asserts what it found, and the user has nothing but the model's word for it — which is
 * exactly the failure the sink exists to remove. With it, evidence visibly arrives as it lands.
 *
 * It polls rather than being pushed: the sink is a separate process behind an IPC channel, so
 * there is nothing to subscribe to. The cadence follows the response's own state — fast while
 * the model is still streaming, slow once it has stopped, because the sink deliberately outlives
 * the turn (the user reproduces after the model stops talking, and that is when evidence lands).
 *
 * It never asserts activity it did not observe. 'Live' means a sink is up right now; 'Waiting'
 * means one is up with nothing recorded yet, and that is shown as waiting rather than as work.
 */
export class V3DebugEvidencePanel extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _badge: HTMLElement;
	private readonly _summary: HTMLElement;
	private readonly _hint: HTMLElement;
	private readonly _footer: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _copyAction: HTMLButtonElement;
	private readonly _openAction: HTMLButtonElement;
	private readonly _clearAction: HTMLButtonElement;

	private readonly _timer = new IntervalTimer();
	/** The cadence the timer is armed at. `undefined` means it is not polling at all. */
	private _armedInterval: number | undefined;
	private _lastSignature = '';
	private _lastPhase: V3DebugSessionPhase | undefined;
	private _instrumentLine: string | undefined;
	private _logPath: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly isComplete: () => boolean,
		private readonly onDidChangeHeight: () => void,
		@IDebugSessionService private readonly session: IDebugSessionService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this._badge = $('span.v3-debug-evidence-badge');
		// The summary is the one thing worth announcing: it changes when the counts change,
		// which is rare. The line list is deliberately silent — announcing every line of a log
		// would bury the rest of the transcript in a screen reader.
		this._summary = $('.v3-debug-evidence-summary', { role: 'status', 'aria-live': 'polite' });
		this._hint = $('.v3-debug-evidence-hint');
		this._footer = $('.v3-debug-evidence-footer');
		this._list = $('.v3-debug-evidence-lines', { role: 'list' });

		this._copyAction = $<HTMLButtonElement>('button.v3-debug-evidence-action', { type: 'button', title: localize('v3debug.evidence.copyTitle', "Copy a one-line fetch() to paste into the running app") }, localize('v3debug.evidence.copy', "Copy line"));
		this._openAction = $<HTMLButtonElement>('button.v3-debug-evidence-action', { type: 'button', title: localize('v3debug.evidence.openTitle', "Open the evidence file") }, localize('v3debug.evidence.open', "Open log"));
		this._clearAction = $<HTMLButtonElement>('button.v3-debug-evidence-action', { type: 'button', title: localize('v3debug.evidence.clearTitle', "Empty the evidence file. Lines from the previous run are lost.") }, localize('v3debug.evidence.clear', "Clear"));
		this._register(addStandardDisposableListener(this._copyAction, EventType.CLICK, () => { void this._copyInstrumentLine(); }));
		this._register(addStandardDisposableListener(this._openAction, EventType.CLICK, () => this._openLogFile()));
		this._register(addStandardDisposableListener(this._clearAction, EventType.CLICK, () => { void this._clearEvidence(); }));

		this._domNode = $('.v3-debug-evidence', undefined,
			$('.v3-debug-evidence-header', undefined,
				this._badge,
				this._summary,
				$('.v3-debug-evidence-actions', undefined, this._copyAction, this._openAction, this._clearAction),
			),
			this._hint,
			this._list,
			this._footer,
		);
		container.appendChild(this._domNode);

		// Starting, stopping and the run boundary all arrive here, so the panel needs no timer of
		// its own while no sink exists.
		this._register(this.session.onDidChange(() => this.update()));
		this.update();
	}

	/** The element the renderer positions in the response. The panel owns exactly one node. */
	get domNode(): HTMLElement {
		return this._domNode;
	}

	/**
	 * Called by the chat list renderer on every transcript reconcile. Cheap by construction: it
	 * reacts to a phase change and to the cadence the response's state implies, and does nothing
	 * when neither moved. Reconcile runs on every streamed diff, so anything more expensive here
	 * would be paid thousands of times per response.
	 */
	update(): void {
		if (this._store.isDisposed) {
			return;
		}
		const phase = this.session.getState().phase;
		if (phase !== this._lastPhase) {
			this._lastPhase = phase;
			void this.refreshNow();
		}
		this._arm();
	}

	/** Read the sink tail once and render it. Public so tests can await a settled panel. */
	async refreshNow(): Promise<void> {
		if (this._store.isDisposed) {
			return;
		}
		const state = this.session.getState();
		if (state.phase !== 'running') {
			// The phase goes through unchanged: 'starting' and 'off' are different claims and the
			// panel renders them differently, so flattening them here would undo the distinction.
			this._render(planEvidencePanel({ phase: state.phase, reason: state.reason, lines: [], lineCount: 0, runMark: 0 }));
			return;
		}
		const read = await this.session.read();
		if (this._store.isDisposed) {
			return;
		}
		// Re-read: a read is async and the workspace can change underneath it.
		const config = this.session.getState().config;
		this._render(planEvidencePanel({
			phase: 'running',
			endpoint: config?.endpoint,
			sessionId: config?.sessionId,
			logPath: config?.logPath,
			lines: read.lines,
			lineCount: read.lineCount,
			runMark: read.runMark,
		}));
	}

	private _arm(): void {
		if (this._store.isDisposed) {
			return;
		}
		if (this.session.getState().phase !== 'running') {
			this._armedInterval = undefined;
			this._timer.cancel();
			return;
		}
		const interval = this.isComplete() ? V3_DEBUG_IDLE_POLL_INTERVAL_MS : V3_DEBUG_POLL_INTERVAL_MS;
		if (this._armedInterval === interval) {
			// Re-arming an already-correct timer restarts its clock, and reconcile fires far more
			// often than the interval — so resetting here would starve the poll entirely.
			return;
		}
		this._armedInterval = interval;
		this._timer.cancelAndSet(() => { void this.refreshNow(); }, interval);
	}

	private _render(view: V3EvidencePanelViewModel): void {
		const signature = JSON.stringify(view);
		if (signature === this._lastSignature) {
			return; // identical content: firing the height listener here would be pure churn
		}
		this._lastSignature = signature;

		this._domNode.dataset.v3Tone = view.tone;
		this._badge.textContent = view.badge;
		this._summary.textContent = view.summary;
		this._setText(this._hint, view.hint);
		this._setText(this._footer, view.footer);

		const rows: HTMLElement[] = [];
		let divided = !view.hasEarlier;
		for (const line of view.lines) {
			if (!divided && line.isThisRun) {
				rows.push($('.v3-debug-evidence-divider', undefined, localize('v3debug.evidence.divider', "this run")));
				divided = true;
			}
			rows.push(this._renderLine(line));
		}
		this._list.replaceChildren(...rows);

		this._instrumentLine = view.instrumentLine;
		this._logPath = view.logPath;
		this._copyAction.hidden = !view.instrumentLine;
		// The sink creates the file on its first write, so before that there is nothing to open
		// and offering it anyway is how a user gets a "file not found" dialog.
		this._openAction.hidden = !view.logPath || view.lines.length === 0;
		this._clearAction.hidden = view.tone !== 'live';

		this.onDidChangeHeight();
	}

	private _renderLine(line: V3EvidenceLineViewModel): HTMLElement {
		const body = $('.v3-debug-evidence-body', undefined,
			$('span.v3-debug-evidence-message', undefined, line.message),
		);
		const meta: (HTMLElement | string)[] = [];
		if (line.location) {
			meta.push($('span.v3-debug-evidence-location', undefined, line.location));
		}
		if (line.hypothesisId) {
			meta.push($('span.v3-debug-evidence-hypothesis', undefined, line.hypothesisId));
		}
		if (meta.length) {
			body.appendChild($('span.v3-debug-evidence-meta', undefined, ...meta));
		}
		if (line.data) {
			body.appendChild($('code.v3-debug-evidence-data', undefined, line.data));
		}
		const row = $('.v3-debug-evidence-line', { role: 'listitem' },
			$('span.v3-debug-evidence-index', undefined, String(line.index)),
			body,
		);
		if (!line.isThisRun) {
			row.classList.add('v3-earlier');
		}
		return row;
	}

	private _setText(element: HTMLElement, text: string | undefined): void {
		element.textContent = text ?? '';
		element.hidden = !text;
	}

	private async _copyInstrumentLine(): Promise<void> {
		if (!this._instrumentLine) {
			return;
		}
		await this.clipboardService.writeText(this._instrumentLine);
	}

	private _openLogFile(): void {
		if (!this._logPath) {
			return;
		}
		void this.openerService.open(URI.file(this._logPath));
	}

	private async _clearEvidence(): Promise<void> {
		await this.session.clear();
		await this.refreshNow();
	}

	override dispose(): void {
		this._timer.cancel();
		this._domNode.remove();
		super.dispose();
	}
}
