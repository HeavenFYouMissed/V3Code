/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Agent-surface hygiene for V3 (Vibe) mode.
 *
 * The browser is the one surface that should follow the agent: it pops up while the
 * agent works a page, and it should go away when the agent is done — agents never tidy
 * what they open, so left alone the window fills with stale browser tabs and Chat never
 * gets the window back. This contribution remembers which browser editors appeared
 * WHILE an agent turn was running and closes them when the last running turn ends, but
 * only in V3 mode and only while the user is on the Flow surface (a Browser surface the
 * user chose explicitly is theirs, not the agent's). Closing the last one lets the
 * Flow rubber band (v3SoloTabs) hand the window back to Chat.
 *
 * Terminals and files deliberately do NOT follow the agent — it uses them constantly,
 * and opening/closing them per use would make the UI look like a ride.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IChatThreadService } from './chatThreadService.js';

class V3AgentSurfaceHygieneContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3AgentSurfaceHygiene';

	/** Browser editors first seen while an agent turn was running — the agent's. */
	private readonly _agentOpened = new WeakSet<EditorInput>();
	/** Every browser editor we have classified, so a user-opened one is never reclassified. */
	private readonly _seen = new WeakSet<EditorInput>();
	private readonly _runningNativeSessions = new Set<string>();
	private readonly _runningSidebarThreads = new Set<string>();
	/** Per-turn observers, tracked so disposing the contribution mid-turn cannot leak them. */
	private readonly _turnWatchers = this._register(new DisposableStore());

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Native chat (the V3 Flow surface): a submitted request marks its session running
		// until the model's requestInProgress observable drops.
		this._register(this.chatService.onDidSubmitRequest(({ chatSessionResource }) => {
			const model = this.chatService.getSession(chatSessionResource);
			if (!model) { return; }
			const key = chatSessionResource.toString();
			this._runningNativeSessions.add(key);
			this._classifyBrowsers();
			const store = new DisposableStore();
			this._turnWatchers.add(store);
			store.add(autorun(reader => {
				if (!model.requestInProgress.read(reader)) {
					this._runningNativeSessions.delete(key);
					this._turnWatchers.delete(store); // deletes AND disposes
					this._onTurnEnded();
				}
			}));
		}));

		// Sidebar engine (React chat threads + their background subagents).
		this._register(this.chatThreadService.onDidChangeStreamState(({ threadId }) => {
			const running = !!this.chatThreadService.streamState[threadId]?.isRunning;
			const wasRunning = this._runningSidebarThreads.has(threadId);
			if (running) {
				this._runningSidebarThreads.add(threadId);
				this._classifyBrowsers();
			} else if (wasRunning) {
				this._runningSidebarThreads.delete(threadId);
				this._onTurnEnded();
			}
		}));

		this._register(this.editorService.onDidVisibleEditorsChange(() => this._classifyBrowsers()));
		this._register(this.editorService.onDidActiveEditorChange(() => this._classifyBrowsers()));
	}

	private get _anyTurnRunning(): boolean {
		return this._runningNativeSessions.size > 0 || this._runningSidebarThreads.size > 0;
	}

	/** Classify each browser editor the first time it is seen: agent's if a turn was running. */
	private _classifyBrowsers(): void {
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (!(editor instanceof BrowserEditorInput) || this._seen.has(editor)) { continue; }
				this._seen.add(editor);
				if (this._anyTurnRunning) { this._agentOpened.add(editor); }
			}
		}
	}

	private _onTurnEnded(): void {
		if (this._anyTurnRunning) { return; }
		const v3Mode = this.contextKeyService.getContextKeyValue<boolean>('v3code.agentMode') === true;
		const surface = this.contextKeyService.getContextKeyValue<string>('v3code.soloSurface');
		// Only in V3, and only while the user is resting on Flow — a Browser/Editor/Terminal
		// surface the user selected is theirs to close.
		if (!v3Mode || surface !== 'flow') { return; }
		let closed = 0;
		for (const group of this.editorGroupsService.groups) {
			for (const editor of [...group.editors]) {
				if (editor instanceof BrowserEditorInput && this._agentOpened.has(editor)) {
					closed += 1;
					void group.closeEditor(editor).catch(err => this.logService.warn('[v3AgentSurfaceHygiene] could not close agent browser', err));
				}
			}
		}
		if (closed > 0) { this.logService.info(`[v3AgentSurfaceHygiene] agent turn ended; closed ${closed} agent-opened browser editor(s)`); }
	}
}

registerWorkbenchContribution2(V3AgentSurfaceHygieneContribution.ID, V3AgentSurfaceHygieneContribution, WorkbenchPhase.AfterRestored);
