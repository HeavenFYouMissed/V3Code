/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../chat/browser/chat.js';
import { V3_MULTITASK_MODE_NAME } from '../common/v3MultitaskMode.js';
import { IV3NativeNoticeService } from './v3NativeNoticeService.js';

/**
 * What happens when a background worker reports while its native chat session is idle.
 *
 * The report itself waits at the notice board and is drained at the start of the next turn.
 * This contribution decides whether that next turn is started FOR the user:
 *   - 'multitask' (default): a Multitask (foreman) session wakes itself - one short board
 *     message is sent as the user, the foreman reads the reports, reconciles, dispatches the
 *     next phase. Plain Agent sessions only get a one-line composer hint.
 *   - 'always': every agent session wakes.
 *   - 'never': hint only.
 * Guards, in order: never while a request is in progress (mid-turn reports are delivered
 * with the next tool result anyway); never over a draft the user is typing; several workers
 * finishing close together wake once (1.5 s coalescing); at most WAKE_BUDGET wakes per
 * session per WAKE_BUDGET_WINDOW_MS so a dispatch/finish loop cannot run unattended forever.
 */

export const V3_WAKE_IDLE_PARENT_KEY = 'v3code.subagents.wakeIdleParent';
type WakeMode = 'multitask' | 'always' | 'never';

const WAKE_COALESCE_MS = 1500;
const WAKE_BUDGET = 8;
const WAKE_BUDGET_WINDOW_MS = 10 * 60_000;
const WAKE_MESSAGE = '[Board] Background agents reported back. Read their reports above, reconcile at the board, and continue the plan.';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'v3code',
	type: 'object',
	properties: {
		[V3_WAKE_IDLE_PARENT_KEY]: {
			type: 'string',
			enum: ['multitask', 'always', 'never'],
			default: 'multitask',
			scope: ConfigurationScope.APPLICATION,
			description: localize('v3code.subagents.wakeIdleParent', "When a background agent reports back while its chat is idle: wake a Multitask (foreman) chat automatically, wake every agent chat, or only show a hint in the composer."),
		},
	},
});

class V3NativeNoticeHintContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3NativeNoticeHint';

	private readonly pendingWakes = this._register(new DisposableMap<string>());
	private readonly wakeTimes = new Map<string, number[]>();

	constructor(
		@IV3NativeNoticeService notices: IV3NativeNoticeService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(notices.onDidPush(({ key }) => this.onNotice(key)));
	}

	private onNotice(key: string): void {
		let resource: URI;
		try { resource = URI.parse(key); } catch { return; }
		const widget = this.chatWidgetService.getWidgetBySessionResource(resource);
		const model = widget?.viewModel?.model;
		if (!widget || !model || model.requestInProgress.get()) {
			return; // mid-turn: delivered with the next tool result
		}
		if (this.shouldWake(widget)) {
			this.scheduleWake(key, resource);
			return;
		}
		this.hint(widget);
	}

	private shouldWake(widget: IChatWidget): boolean {
		const mode = this.configurationService.getValue<WakeMode>(V3_WAKE_IDLE_PARENT_KEY) ?? 'multitask';
		if (mode === 'never') { return false; }
		if (mode === 'always') { return true; }
		const last = widget.viewModel?.model.getRequests().at(-1);
		return last?.modeInfo?.modeName?.toLowerCase() === V3_MULTITASK_MODE_NAME.toLowerCase();
	}

	private scheduleWake(key: string, resource: URI): void {
		if (this.pendingWakes.has(key)) { return; } // coalesce: one wake for a burst of reports
		const handle = setTimeout(() => {
			this.pendingWakes.deleteAndDispose(key);
			this.wake(key, resource);
		}, WAKE_COALESCE_MS);
		this.pendingWakes.set(key, { dispose: () => clearTimeout(handle) });
	}

	private wake(key: string, resource: URI): void {
		const widget = this.chatWidgetService.getWidgetBySessionResource(resource);
		const model = widget?.viewModel?.model;
		if (!widget || !model || model.requestInProgress.get()) { return; }
		if (widget.getInput().trim()) {
			this.hint(widget); // the user is mid-thought: never send over a draft
			return;
		}
		const now = Date.now();
		const recent = (this.wakeTimes.get(key) ?? []).filter(t => now - t < WAKE_BUDGET_WINDOW_MS);
		if (recent.length >= WAKE_BUDGET) {
			this.logService.warn(`[V3Code] foreman wake budget exhausted for ${key}; leaving a hint instead`);
			this.hint(widget, localize('v3code.backgroundNotice.budget', "Background agents keep reporting back. Send a message to continue; automatic wake-ups are paused for a few minutes."));
			return;
		}
		recent.push(now);
		this.wakeTimes.set(key, recent);
		widget.acceptInput(WAKE_MESSAGE, { noCommandDetection: true }).catch(error => {
			this.logService.error('[V3Code] foreman wake failed', error);
			this.hint(widget);
		});
	}

	private hint(widget: IChatWidget, message = localize('v3code.backgroundNotice', "A background agent reported back. Send your next message to pick up its result.")): void {
		widget.inputPart.showV3BackgroundNotice(message);
	}
}

registerWorkbenchContribution2(V3NativeNoticeHintContribution.ID, V3NativeNoticeHintContribution, WorkbenchPhase.AfterRestored);
