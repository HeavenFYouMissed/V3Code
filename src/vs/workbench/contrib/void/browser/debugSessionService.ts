/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Browser-side proxy for the Debug mode runtime-evidence sink (electron-main/
// debugCollectorChannel.ts). Mirrors beastService.ts: the renderer never spawns anything,
// it asks the main process over an IChannel.
//
// Two jobs, and both matter:
//   1. Own the session's lifetime — one sink per workspace root, up while a Debug chat is
//      being worked, down when it stops.
//   2. Be the single source of truth for the RUN BOUNDARY. Every user turn in a Debug chat
//      opens a new run, and the model needs to know which evidence belongs to the run it
//      just asked for. Marking that here (rather than asking the model to clear a file with
//      a shell command) removes a whole class of self-inflicted debugging error: the model
//      can compare before/after without ever touching the log.
//
// Failure posture: an unavailable sink never breaks the chat. Debug mode degrades to
// "investigate with the read tools", which is what it was before this existed.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	parseEvidenceLog,
	V3_DEBUG_COLLECTOR_CHANNEL,
	V3_DEBUG_TAIL_LINES,
	V3DebugEvidenceLine,
	V3DebugSessionState,
	V3DebugStartResult,
	V3DebugTailResult,
} from '../common/debugSessionTypes.js';

export const IDebugSessionService = createDecorator<IDebugSessionService>('v3codeDebugSessionService');

export interface IDebugSessionService {
	readonly _serviceBrand: undefined;
	/** Fires when the session starts, stops, or new evidence lands. */
	readonly onDidChange: Event<void>;
	getState(): V3DebugSessionState;
	/**
	 * Bring the sink up for the current workspace. Idempotent. Returns false when there is
	 * no folder open, the workspace is untrusted, or the collector could not start — the
	 * caller must NOT tell the model there is a sink unless this returned true.
	 */
	start(): Promise<boolean>;
	/** Take the sink down. Safe to call when nothing is running. */
	stop(): Promise<void>;
	/**
	 * Open a new run boundary at the current line count. Call once per user turn: evidence
	 * recorded before this mark belongs to the previous run. Refreshes the count from the
	 * sink first, so the mark reflects what is actually on disk rather than the last poll.
	 */
	markRunBoundary(): Promise<void>;
	/** Read the newest evidence. Empty array on any failure. */
	read(): Promise<{ lines: readonly V3DebugEvidenceLine[]; lineCount: number; runMark: number }>;
	/** Empty the evidence file. */
	clear(): Promise<void>;
}

export class DebugSessionService extends Disposable implements IDebugSessionService {

	readonly _serviceBrand: undefined;

	private readonly channel: IChannel;
	private _state: V3DebugSessionState = { phase: 'idle', runMark: 0, lineCount: 0 };
	/** Serializes start/stop so two rapid Debug chats cannot spawn two sinks. */
	private _lifecycle: Promise<unknown> = Promise.resolve();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = mainProcessService.getChannel(V3_DEBUG_COLLECTOR_CHANNEL);
		this._register(this.workspace.onDidChangeWorkspaceFolders(() => {
			// The old root's sink belongs to the old workspace. Drop it and let the next
			// Debug turn start one for whatever is open now.
			void this._enqueue(async () => {
				await this._stopFor(this._state.config?.workspaceRoot);
				this._setState({ phase: 'idle', config: undefined, runMark: 0, lineCount: 0, reason: undefined });
			});
		}));
	}

	getState(): V3DebugSessionState { return this._state; }

	private _setState(patch: Partial<V3DebugSessionState>): void {
		this._state = { ...this._state, ...patch };
		this._onDidChange.fire();
	}

	/** One workspace folder, like beast: a debug session is scoped to a single root. */
	private _root(): string | null {
		const folders = this.workspace.getWorkspace().folders;
		if (folders.length !== 1) { return null; }
		return folders[0]?.uri?.fsPath ?? null;
	}

	private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this._lifecycle.then(fn, fn);
		this._lifecycle = next.catch(() => undefined);
		return next;
	}

	async start(): Promise<boolean> {
		return this._enqueue(async () => {
			const root = this._root();
			if (!root) {
				this._setState({ phase: 'unavailable', reason: 'Open a single folder to collect runtime evidence.', config: undefined });
				return false;
			}
			// The gate that makes the rest safe: a sink is a listening socket and a file
			// writer, and neither belongs in a workspace the user has not trusted.
			if (!this.trustService.isWorkspaceTrusted()) {
				this._setState({ phase: 'unavailable', reason: 'Debug mode is off in an untrusted workspace. Trust this folder to collect runtime evidence.', config: undefined });
				this.logService.info('[v3code-debug] runtime-evidence sink refused: workspace is not trusted');
				return false;
			}
			if (this._state.phase === 'running' && this._state.config?.workspaceRoot === root) {
				return true;
			}
			this._setState({ phase: 'starting', reason: undefined });
			try {
				const result = await this.channel.call<V3DebugStartResult>('start', { workspaceRoot: root });
				// The workspace can change while the sink is coming up.
				if (this._root() !== root) {
					await this.channel.call('stop', { workspaceRoot: root }).catch(() => undefined);
					this._setState({ phase: 'idle', config: undefined, runMark: 0, lineCount: 0 });
					return false;
				}
				if (!result.ok) {
					this._setState({ phase: 'unavailable', reason: result.reason, config: undefined });
					return false;
				}
				this._setState({ phase: 'running', config: result.config, runMark: 0, lineCount: 0, reason: undefined });
				this.logService.info(`[v3code-debug] runtime-evidence sink listening on 127.0.0.1:${result.config.port} (session ${result.config.sessionId})`);
				return true;
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				this._setState({ phase: 'unavailable', reason, config: undefined });
				this.logService.warn(`[v3code-debug] could not reach the evidence-sink channel: ${reason}`);
				return false;
			}
		});
	}

	async stop(): Promise<void> {
		return this._enqueue(async () => {
			await this._stopFor(this._state.config?.workspaceRoot);
			if (this._state.phase !== 'unavailable') {
				this._setState({ phase: 'idle', config: undefined, runMark: 0, lineCount: 0 });
			}
		});
	}

	private async _stopFor(root: string | undefined): Promise<void> {
		if (!root) { return; }
		try {
			await this.channel.call('stop', { workspaceRoot: root });
		} catch (err) {
			// A sink we cannot stop is a leak, not a failure the user should see. The
			// collector's own idle timeout is the backstop.
			this.logService.warn(`[v3code-debug] could not stop the evidence sink for ${root}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async markRunBoundary(): Promise<void> {
		if (this._state.phase !== 'running') { return; }
		const root = this._state.config?.workspaceRoot;
		if (!root) { return; }
		try {
			// Refresh before marking: using the last polled count would put the boundary
			// behind evidence that has already landed, and the model would read the previous
			// run's lines as its own.
			const result = await this.channel.call<V3DebugTailResult>('tail', { workspaceRoot: root, lines: 1 });
			if (this._root() !== root) { return; }
			this._setState({ runMark: result.lineCount, lineCount: result.lineCount });
		} catch {
			this._setState({ runMark: this._state.lineCount });
		}
	}

	async read(): Promise<{ lines: readonly V3DebugEvidenceLine[]; lineCount: number; runMark: number }> {
		const root = this._state.config?.workspaceRoot;
		const empty = { lines: [] as readonly V3DebugEvidenceLine[], lineCount: this._state.lineCount, runMark: this._state.runMark };
		if (this._state.phase !== 'running' || !root) { return empty; }
		try {
			const result = await this.channel.call<V3DebugTailResult>('tail', { workspaceRoot: root, lines: V3_DEBUG_TAIL_LINES });
			if (this._root() !== root) { return empty; }
			if (result.lineCount !== this._state.lineCount) {
				this._setState({ lineCount: result.lineCount });
			}
			return {
				lines: parseEvidenceLog(result.lines, Math.max(0, this._state.runMark - Math.max(0, result.lineCount - V3_DEBUG_TAIL_LINES))),
				lineCount: result.lineCount,
				runMark: this._state.runMark,
			};
		} catch (err) {
			this.logService.warn(`[v3code-debug] could not read evidence: ${err instanceof Error ? err.message : String(err)}`);
			return empty;
		}
	}

	async clear(): Promise<void> {
		const root = this._state.config?.workspaceRoot;
		if (!root) { return; }
		try {
			await this.channel.call('clear', { workspaceRoot: root });
			this._setState({ lineCount: 0, runMark: 0 });
		} catch { /* the next read simply shows the previous evidence */ }
	}
}

registerSingleton(IDebugSessionService, DebugSessionService, InstantiationType.Delayed);
