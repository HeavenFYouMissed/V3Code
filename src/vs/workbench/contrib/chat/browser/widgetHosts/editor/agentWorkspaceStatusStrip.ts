/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import * as nls from '../../../../../../nls.js';
import { ITurboDraftService, TurboDraftSession } from '../../../../void/browser/turboDraftService.js';
import { IV3CodeRemoteService } from '../../../../void/browser/v3RemoteService.js';

/**
 * Human wording for each Turbo Draft phase. Deliberately short: this reads as a status
 * light in the corner of a pane, not a progress log.
 */
const PHASE_LABEL: Partial<Record<string, string>> = {
	reading: nls.localize('turbo.phase.reading', "reading"),
	recognizing: nls.localize('turbo.phase.recognizing', "recognizing"),
	findingRelated: nls.localize('turbo.phase.findingRelated', "relating"),
	organizing: nls.localize('turbo.phase.organizing', "organizing"),
	restructuring: nls.localize('turbo.phase.restructuring', "restructuring"),
	validating: nls.localize('turbo.phase.validating', "validating"),
	repairing: nls.localize('turbo.phase.repairing', "repairing"),
	creatingTabs: nls.localize('turbo.phase.creatingTabs', "opening"),
	verifying: nls.localize('turbo.phase.verifying', "verifying"),
	autoFixing: nls.localize('turbo.phase.autoFixing', "fixing"),
};

/** Phases where the light should read as finished rather than busy. */
const SETTLED_PHASES = new Set(['ready', 'completed', 'noChanges', 'sourceChanged', 'cancelled', 'error']);

/**
 * The two ambient lights in the corner of the Agent Workspace: Turbo Draft on the left,
 * V-Go on the right.
 *
 * Both stay dim on purpose. This is peripheral vision - you should be able to tell at a
 * glance whether something is running without it competing with the work. Turbo rolls
 * through its real phases while drafting and settles to a hunk count; V-Go is a single
 * dot that lights when a phone is paired. Neither invents state: if a service reports
 * nothing, the light is simply off.
 */
export class AgentWorkspaceStatusStrip extends Disposable {

	private readonly turboEl: HTMLElement;
	private readonly turboLabel: HTMLElement;
	private readonly vgoEl: HTMLElement;

	constructor(
		parent: HTMLElement,
		@ITurboDraftService private readonly turboDraftService: ITurboDraftService,
		@IV3CodeRemoteService private readonly remoteService: IV3CodeRemoteService,
	) {
		super();

		const root = append(parent, $('.agent-workspace-status-strip'));

		this.turboEl = append(root, $('button.agent-workspace-status-chip.is-turbo')) as HTMLButtonElement;
		(this.turboEl as HTMLButtonElement).type = 'button';
		append(this.turboEl, $('span.agent-workspace-status-key')).textContent = 'T';
		this.turboLabel = append(this.turboEl, $('span.agent-workspace-status-label'));

		// A draft whose review panel got dismissed is otherwise unreachable - the work is
		// still there and still pending, but there is no way back to it. The light is the
		// obvious thing to press, so make it the way back.
		this._register(addDisposableListener(this.turboEl, EventType.CLICK, () => {
			if (this.turboDraftService.getSession()) {
				this.turboDraftService.openDetails();
			}
		}));

		this.vgoEl = append(root, $('.agent-workspace-status-chip.is-vgo'));
		append(this.vgoEl, $('span.agent-workspace-status-key')).textContent = 'V';

		this._register(this.turboDraftService.onDidChangeSession(session => this.renderTurbo(session)));
		this._register(this.remoteService.onDidChangeState(() => this.renderVgo()));

		this.renderTurbo(this.turboDraftService.getSession());
		this.renderVgo();
	}

	private renderTurbo(session: TurboDraftSession | undefined): void {
		clearNode(this.turboLabel);

		if (!session || session.phase === 'idle') {
			this.turboEl.classList.remove('is-active', 'is-settled');
			this.turboEl.title = nls.localize('turbo.idle', "Turbo Draft — idle");
			return;
		}

		const settled = SETTLED_PHASES.has(session.phase);
		this.turboEl.classList.toggle('is-active', !settled);
		this.turboEl.classList.toggle('is-settled', settled);

		// While drafting, show the phase. Once settled, the useful number is how much is
		// waiting on the developer, not which stage produced it.
		if (settled) {
			const pending = session.pendingHunks;
			this.turboLabel.textContent = pending > 0
				? nls.localize('turbo.pending', "{0} to review", pending)
				: nls.localize('turbo.done', "done");
		} else {
			this.turboLabel.textContent = PHASE_LABEL[session.phase] ?? session.phase;
		}

		this.turboEl.title = nls.localize(
			'turbo.tooltip',
			"Turbo Draft · {0} · {1} accepted, {2} rejected, {3} pending — click to reopen the review",
			session.modelLabel, session.acceptedHunks, session.rejectedHunks, session.pendingHunks
		);
	}

	private renderVgo(): void {
		const status = this.remoteService.state.status;
		const connected = status === 'connected';
		const pairing = status === 'pairing';

		this.vgoEl.classList.toggle('is-active', connected);
		this.vgoEl.classList.toggle('is-pending', pairing);
		this.vgoEl.title = connected
			? nls.localize('vgo.connected', "V-Go — a phone is driving this editor")
			: pairing
				? nls.localize('vgo.pairing', "V-Go — waiting for a phone to pair")
				: nls.localize('vgo.idle', "V-Go — not connected");
	}
}
