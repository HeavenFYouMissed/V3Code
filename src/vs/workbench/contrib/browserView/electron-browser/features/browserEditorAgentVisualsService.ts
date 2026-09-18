/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IntervalTimer, timeout } from '../../../../../base/common/async.js';
import { autorun } from '../../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import type { IChatModel } from '../../../chat/common/model/chatModel.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { playwrightInvokeRaw } from '../tools/browserToolHelpers.js';
import {
	AGENT_VIS_BEGIN_ACTIVITY_SCRIPT,
	AGENT_VIS_DRAIN_SCRIPT,
	AGENT_VIS_END_ACTIVITY_SCRIPT,
	AGENT_VIS_HIDE_SCRIPT,
	AGENT_VIS_INJECT_SCRIPT,
	AGENT_VIS_OVERLAY_HIDDEN_CHECK_SCRIPT,
	AGENT_VIS_SHOW_SCRIPT,
	buildAgentVisMoveScript,
	buildAgentVisSharedScript,
} from './browserEditorAgentVisualsScript.js';

export const AgentVisualsEnabledSettingId = 'workbench.browser.agentVisuals';

const DRAIN_INTERVAL_MS = 350;
const CURSOR_ANIM_MS = 220;
const IDLE_BACKSTOP_MS = 8000;

export const IBrowserAgentVisualsService = createDecorator<IBrowserAgentVisualsService>('browserAgentVisualsService');

export interface IBrowserAgentVisualsService {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	setShared(pageId: string, shared: boolean): void;
	beginActivity(pageId: string, sessionResource: URI | undefined): void;
	endActivity(pageId: string): void;
	endAllForSession(sessionResource: URI): void;
	notifyToolCall(pageId: string): void;
	prepareForAction(
		pageId: string,
		sessionResource: URI | undefined,
		sessionId: string,
		playwrightService: IPlaywrightService,
		selector: string | undefined,
		label: string | undefined,
	): Promise<void>;
	moveCursor(pageId: string, x: number, y: number, label?: string): void;
	setStatus(pageId: string, label: string): void;
	hideForToolUse(pageId: string): Promise<void>;
	showAfterToolUse(pageId: string): void;
	checkOverlayHidden(pageId: string): Promise<boolean>;
}

interface PageActivity {
	sessionResource: URI | undefined;
	readonly drain: IntervalTimer;
	readonly modelStore: DisposableStore;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
}

export class BrowserAgentVisualsService extends Disposable implements IBrowserAgentVisualsService {
	declare readonly _serviceBrand: undefined;

	private readonly _activities = new Map<string, PageActivity>();
	private readonly _sharedPages = new Set<string>();
	private readonly _sessionLifecycle = new Map<string, DisposableStore>();

	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IChatService private readonly chatService: IChatService,
		@IAgentNetworkFilterService private readonly agentNetworkFilterService: IAgentNetworkFilterService,
	) {
		super();

		this._register(this.chatService.onDidDisposeSession(e => {
			for (const resource of e.sessionResources) {
				this.endAllForSession(resource);
				this._sessionLifecycle.get(resource.toString())?.dispose();
				this._sessionLifecycle.delete(resource.toString());
			}
		}));

		this._register(this.chatService.onDidCreateModel(model => {
			this._ensureSessionLifecycle(model.sessionResource, model);
		}));
	}

	isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(AgentVisualsEnabledSettingId) !== false;
	}

	setShared(pageId: string, shared: boolean): void {
		if (shared) {
			this._sharedPages.add(pageId);
		} else {
			this._sharedPages.delete(pageId);
		}
		void this._syncSharedState(pageId);
	}

	beginActivity(pageId: string, sessionResource: URI | undefined): void {
		if (!this.isEnabled()) {
			return;
		}
		if (this._activities.has(pageId)) {
			const existing = this._activities.get(pageId)!;
			if (sessionResource) {
				existing.sessionResource = sessionResource;
			}
			return;
		}

		const drain = new IntervalTimer();
		const modelStore = new DisposableStore();
		const activity: PageActivity = { sessionResource, drain, modelStore, idleTimer: undefined };
		this._activities.set(pageId, activity);

		if (sessionResource) {
			this._ensureSessionLifecycle(sessionResource);
		}

		void this._mount(pageId, activity);
		drain.cancelAndSet(() => { void this._drain(pageId); }, DRAIN_INTERVAL_MS);
		this._resetIdleBackstop(pageId);
	}

	endActivity(pageId: string): void {
		const activity = this._activities.get(pageId);
		if (!activity) {
			return;
		}
		this._activities.delete(pageId);
		activity.drain.cancel();
		if (activity.idleTimer) {
			clearTimeout(activity.idleTimer);
		}
		activity.modelStore.dispose();
		void this._execScript(pageId, AGENT_VIS_END_ACTIVITY_SCRIPT);
	}

	endAllForSession(sessionResource: URI): void {
		for (const [pageId, activity] of this._activities) {
			if (activity.sessionResource?.toString() === sessionResource.toString()) {
				this.endActivity(pageId);
			}
		}
	}

	notifyToolCall(pageId: string): void {
		this._resetIdleBackstop(pageId);
	}

	async prepareForAction(
		pageId: string,
		sessionResource: URI | undefined,
		sessionId: string,
		playwrightService: IPlaywrightService,
		selector: string | undefined,
		label: string | undefined,
	): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}
		this.beginActivity(pageId, sessionResource);
		if (!selector) {
			return;
		}
		try {
			const bounds = await playwrightInvokeRaw(
				playwrightService,
				sessionId,
				pageId,
				async (page, sel) => {
					const locator = page.locator(sel);
					const inMain = await locator.evaluate(() => {
						const view = document.defaultView;
						return !!view && view === view.top;
					}).catch(() => false);
					if (!inMain) {
						return undefined;
					}
					return locator.boundingBox();
				},
				selector,
			);
			if (bounds && typeof bounds.x === 'number' && typeof bounds.y === 'number') {
				const cx = bounds.x + bounds.width / 2;
				const cy = bounds.y + bounds.height / 2;
				this.moveCursor(pageId, cx, cy, label);
				await timeout(CURSOR_ANIM_MS);
			}
		} catch (err) {
			this.logService.trace('[AgentVisuals] prepareForAction skipped', err);
		}
		this.notifyToolCall(pageId);
	}

	moveCursor(pageId: string, x: number, y: number, label?: string): void {
		if (!this.isEnabled()) {
			return;
		}
		void this._execScript(pageId, buildAgentVisMoveScript(x, y, label));
	}

	setStatus(pageId: string, label: string): void {
		if (!this.isEnabled()) {
			return;
		}
		const safe = JSON.stringify(label);
		void this._execScript(pageId, `(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.setStatus(${safe});}})()`);
	}

	async hideForToolUse(pageId: string): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}
		await this._execScript(pageId, AGENT_VIS_HIDE_SCRIPT);
	}

	showAfterToolUse(pageId: string): void {
		if (!this.isEnabled()) {
			return;
		}
		void this._execScript(pageId, AGENT_VIS_SHOW_SCRIPT);
	}

	async checkOverlayHidden(pageId: string): Promise<boolean> {
		if (!this.isEnabled()) {
			return true;
		}
		try {
			const out = await this._execScript(pageId, AGENT_VIS_OVERLAY_HIDDEN_CHECK_SCRIPT);
			return out === true;
		} catch {
			return true;
		}
	}

	private async _mount(pageId: string, activity: PageActivity): Promise<void> {
		const model = await this._resolveModel(pageId);
		if (!model || !this._activities.has(pageId)) {
			return;
		}
		if (!this._canMount(model)) {
			return;
		}
		activity.modelStore.add(model.onDidChangeLoadingState(e => {
			if (e.loading) {
				this.endActivity(pageId);
			}
		}));
		// SPA route changes (did-navigate-in-page) don't flip loading state but DO reset/replace
		// the page DOM, leaving the injected overlay stale — tear down here too (it re-mounts on
		// the next agent action, same as the full-navigation path above).
		activity.modelStore.add(model.onDidNavigate(() => {
			this.endActivity(pageId);
		}));
		await this._execScriptOnModel(model, AGENT_VIS_INJECT_SCRIPT);
		await this._execScriptOnModel(model, AGENT_VIS_BEGIN_ACTIVITY_SCRIPT);
	}

	private async _syncSharedState(pageId: string): Promise<void> {
		const model = await this._resolveModel(pageId);
		if (!model) {
			return;
		}

		if (this._sharedPages.has(pageId)) {
			if (!this._canMount(model)) {
				return;
			}
			await this._execScriptOnModel(model, AGENT_VIS_INJECT_SCRIPT);
		}

		await this._execScriptOnModel(model, buildAgentVisSharedScript(this._sharedPages.has(pageId)));
	}

	private _canMount(model: IBrowserViewModel): boolean {
		const url = model.url;
		if (!url || url === 'about:blank' || model.error) {
			return false;
		}
		try {
			return this.agentNetworkFilterService.isUriAllowed(URI.parse(url));
		} catch {
			return false;
		}
	}

	private async _drain(pageId: string): Promise<void> {
		const activity = this._activities.get(pageId);
		if (!activity) {
			return;
		}
		const raw = await this._execScript(pageId, AGENT_VIS_DRAIN_SCRIPT);
		if (typeof raw !== 'string' || !raw) {
			return;
		}
		let queue: { type?: string }[];
		try {
			queue = JSON.parse(raw).map((s: string) => JSON.parse(s));
		} catch {
			return;
		}
		for (const msg of queue) {
			if (msg.type === 'stop') {
				const resource = activity.sessionResource;
				if (resource) {
					void this.chatService.cancelCurrentRequestForSession(resource, 'browserAgentVisStop');
				}
				this.endActivity(pageId);
			}
		}
	}

	private _resetIdleBackstop(pageId: string): void {
		const activity = this._activities.get(pageId);
		if (!activity) {
			return;
		}
		if (activity.idleTimer) {
			clearTimeout(activity.idleTimer);
		}
		activity.idleTimer = setTimeout(() => this.endActivity(pageId), IDLE_BACKSTOP_MS);
	}

	/** Tear down overlay when the chat session leaves an active agent turn (complete, error, cancel, awaiting_user). */
	private _ensureSessionLifecycle(sessionResource: URI, modelHint?: IChatModel): void {
		const key = sessionResource.toString();
		if (this._sessionLifecycle.has(key)) {
			return;
		}
		const model = modelHint ?? this.chatService.getSession(sessionResource);
		if (!model) {
			return;
		}
		const store = new DisposableStore();
		this._sessionLifecycle.set(key, store);
		this._register(store);
		store.add(autorun(reader => {
			if (model.requestNeedsInput.read(reader)) {
				this.endAllForSession(sessionResource);
				return;
			}
			if (!model.hasActiveRequest.read(reader)) {
				this.endAllForSession(sessionResource);
			}
		}));
		store.add(model.onDidDispose(() => {
			this.endAllForSession(sessionResource);
			store.dispose();
			this._sessionLifecycle.delete(key);
		}));
	}

	private async _resolveModel(pageId: string): Promise<IBrowserViewModel | undefined> {
		try {
			return await this.browserViewWorkbenchService.getKnownBrowserViews().get(pageId)?.resolve();
		} catch {
			return undefined;
		}
	}

	private async _execScript(pageId: string, script: string): Promise<unknown> {
		const model = await this._resolveModel(pageId);
		if (!model) {
			return undefined;
		}
		return this._execScriptOnModel(model, script);
	}

	private async _execScriptOnModel(model: IBrowserViewModel, script: string): Promise<unknown> {
		try {
			return await model.executeScript(script);
		} catch (err) {
			this.logService.trace('[AgentVisuals] executeScript failed', err);
			return undefined;
		}
	}
}

registerSingleton(IBrowserAgentVisualsService, BrowserAgentVisualsService, InstantiationType.Delayed);
