/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Browser-side proxy for the beast sidecar (electron-main/beastChannel.ts) —
// mirrors semanticEmbedProxy.ts. Failure posture (WIRING-PLAN A6): binary
// missing / spawn error / bad JSON → log ONCE, disable for the session, and
// always answer with an empty result — semantic_search must never break
// because the sidecar is unhappy.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BeastHit, BeastImpacted, BeastMemoryNote, BeastSymbolTag } from '../common/beastTypes.js';

export type { BeastHit, BeastImpacted, BeastMemoryNote, BeastSymbolTag } from '../common/beastTypes.js';

/** Re-indexes triggered by the watcher's reconcile are throttled to this. */
const MIN_REINDEX_INTERVAL_MS = 5 * 60_000;

/** Observable sidecar state for the status bar / UI. */
export interface BeastState {
	/** 'unknown' until the first availability probe resolves. */
	phase: 'unknown' | 'unavailable' | 'idle' | 'indexing' | 'dark';
	version?: string;
	lastIndex?: { at: number; tookMs: number; ok: boolean; summary: string };
}

export const IBeastService = createDecorator<IBeastService>('v3codeBeastService');

export interface IBeastService {
	readonly _serviceBrand: undefined;
	/** Sidecar lifecycle state (for the status bar). */
	readonly onDidChangeState: Event<void>;
	getState(): BeastState;
	/** false when disabled by config, no workspace, binary missing, or tripped for the session. */
	isAvailable(): Promise<boolean>;
	/** Kick a full index of the current workspace. Throttled unless `force`
	 *  (manual rebuild). Fire-and-forget friendly — never throws. */
	indexWorkspace(opts?: { force?: boolean }): Promise<void>;
	/** Trigram search over the beast index. Empty array on any failure. */
	search(query: string, k?: number): Promise<BeastHit[]>;
	/** Tree-sitter tag lookup: where is NAME defined / who references it. */
	symbolLookup(name: string, opts?: { defsOnly?: boolean }): Promise<BeastSymbolTag[]>;
	/** Blast radius: what depends (transitively) on a file or symbol. */
	trace(target: string, opts?: { depth?: number }): Promise<BeastImpacted[]>;
	/** Anchor a memory note to files/symbols (re-saving re-confirms it). Null on failure. */
	remember(text: string, opts?: { files?: string[]; symbols?: string[] }): Promise<BeastMemoryNote | null>;
	/** Delete a note by exact text or sidecar id — the editor's forget MUST
	 *  reach the sidecar or deleted notes resurface via the graph pull forever. */
	forget(opts: { text?: string; id?: number }): Promise<number>;
	/** Recall notes: by text, or graph-pulled from a file/symbol seed (`near`). */
	recall(opts: { query?: string; near?: string; depth?: number; k?: number }): Promise<BeastHit[]>;
}

export class BeastService extends Disposable implements IBeastService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;
	/** A6 kill switch: first spawn/parse failure disables beast for the session. */
	private _tripped = false;
	private _availability: Promise<boolean> | null = null;
	private _lastIndexAt = 0;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private _state: BeastState = { phase: 'unknown' };
	getState(): BeastState { return this._state; }
	private _setState(patch: Partial<BeastState>): void {
		this._state = { ...this._state, ...patch };
		this._onDidChangeState.fire();
	}

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = mainProcessService.getChannel('void-channel-beast');
		this._register(this.workspace.onDidChangeWorkspaceFolders(() => {
			this._lastIndexAt = 0;
			this._setState({ phase: this._root() ? 'idle' : 'unknown', lastIndex: undefined });
		}));
	}

	/** Beast v1 accepts one root. Disable its optional vote in multi-root windows
	 * instead of letting a silently first-root-only corpus bias complete local hits. */
	private _root(): string | null {
		const folders = this.workspace.getWorkspace().folders;
		if (folders.length !== 1) { return null; }
		const f = folders[0];
		return f?.uri?.fsPath ?? null;
	}

	private _enabled(): boolean {
		return this.configService.getValue<boolean>('v3code.semanticIndex.beastEnabled') !== false;
	}

	private _binPath(): string | undefined {
		return this.configService.getValue<string>('v3code.semanticIndex.beastBinaryPath') || undefined;
	}

	async isAvailable(): Promise<boolean> {
		if (this._tripped || !this._enabled() || !this._root()) { return false; }
		if (!this._availability) {
			this._availability = this.channel.call<{ available: boolean; version?: string }>('version', { binPath: this._binPath() })
				.then(v => {
					if (v.available) {
						this.logService.info(`[v3code-beast] sidecar available (${v.version ?? 'unknown version'})`);
						this._setState({ phase: this._state.phase === 'indexing' ? 'indexing' : 'idle', version: v.version });
					} else {
						this.logService.info('[v3code-beast] sidecar binary not found — channel stays dark (install to ~/.v3code/bin/beast or set v3code.semanticIndex.beastBinaryPath)');
						this._setState({ phase: 'unavailable' });
					}
					return v.available;
				})
				.catch(() => false);
		}
		return this._availability;
	}

	async indexWorkspace(opts?: { force?: boolean }): Promise<void> {
		const root = this._root();
		if (!root || !(await this.isAvailable())) { return; }
		if (this._root() !== root) { return; }
		if (!opts?.force && Date.now() - this._lastIndexAt < MIN_REINDEX_INTERVAL_MS) { return; }
		this._lastIndexAt = Date.now();
		this._setState({ phase: 'indexing' });
		try {
			const r = await this.channel.call<{ ok: boolean; tookMs: number; summary: string }>('index', { workspaceRoot: root, binPath: this._binPath() });
			if (this._root() !== root) { return; }
			if (r.ok) {
				this.logService.info(`[v3code-beast] indexed ${root} in ${(r.tookMs / 1000).toFixed(1)}s`);
				this._setState({ phase: 'idle', lastIndex: { at: Date.now(), tookMs: r.tookMs, ok: true, summary: r.summary } });
			} else {
				this._setState({ lastIndex: { at: Date.now(), tookMs: r.tookMs, ok: false, summary: r.summary } });
				this._trip(`index failed: ${r.summary}`);
			}
		} catch (e: any) {
			if (this._root() !== root) { return; }
			const msg = String(e?.message ?? e);
			// A TIMEOUT on a huge repo is not a broken sidecar — tripping the kill
			// switch made beast permanently dark on exactly the repos it's for
			// (audit #10). Log it and let the next throttled attempt retry; only
			// real spawn/protocol failures trip the session.
			if (/timed out/i.test(msg)) {
				this.logService.warn(`[v3code-beast] index timed out — will retry on the next reconcile (repo may be very large): ${msg}`);
				this._setState({ phase: 'idle', lastIndex: { at: Date.now(), tookMs: 0, ok: false, summary: msg } });
			} else {
				this._trip(`index error: ${msg}`);
			}
		}
	}

	async search(query: string, k = 10): Promise<BeastHit[]> {
		return this._call<BeastHit[]>('search', { query, k }, []);
	}

	async symbolLookup(name: string, opts?: { defsOnly?: boolean }): Promise<BeastSymbolTag[]> {
		return this._call<BeastSymbolTag[]>('symbol', { name, defsOnly: opts?.defsOnly }, []);
	}

	async trace(target: string, opts?: { depth?: number }): Promise<BeastImpacted[]> {
		return this._call<BeastImpacted[]>('trace', { target, depth: opts?.depth }, []);
	}

	async remember(text: string, opts?: { files?: string[]; symbols?: string[] }): Promise<BeastMemoryNote | null> {
		return this._call<BeastMemoryNote | null>('remember', { text, files: opts?.files?.map(f => this._rel(f)), symbols: opts?.symbols }, null);
	}

	async forget(opts: { text?: string; id?: number }): Promise<number> {
		const r = await this._call<{ deleted: number }>('forget', { text: opts.text, id: opts.id }, { deleted: 0 });
		return r.deleted;
	}

	async recall(opts: { query?: string; near?: string; depth?: number; k?: number }): Promise<BeastHit[]> {
		return this._call<BeastHit[]>('recall', { query: opts.query, near: opts.near ? this._rel(opts.near) : undefined, depth: opts.depth, k: opts.k }, []);
	}

	/** Normalize any caller-shaped path (absolute fsPath, backslashes) to the
	 *  workspace-relative POSIX form the sidecar indexes — the single choke
	 *  point that keeps anchors and recall seeds in ONE path universe. An
	 *  absolute seed that never matched the index was one of the reasons the
	 *  editor's graph pull silently returned nothing. */
	private _rel(p: string): string {
		let out = p.replace(/\\/g, '/');
		const root = this._root()?.replace(/\\/g, '/');
		if (root && out.startsWith(root)) {
			out = out.slice(root.length).replace(/^\//, '');
		}
		return out;
	}

	/** Shared guard for every query command: workspace + config + kill switch,
	 *  and any channel failure trips the session and answers the fallback. */
	private async _call<T>(command: string, params: object, fallback: T): Promise<T> {
		const root = this._root();
		if (!root || this._tripped || !this._enabled()) { return fallback; }
		try {
			const result = await this.channel.call<T>(command, { workspaceRoot: root, ...params, binPath: this._binPath() });
			// A request may finish after the user changed projects. Never return the
			// prior workspace's symbols, search hits, or memories into the new turn.
			return this._root() === root ? result : fallback;
		} catch (e: any) {
			const msg = String(e?.message ?? e);
			// A slow command (timeout) is NOT a broken sidecar: tripping here
			// silently killed search fusion + symbol/trace/memory for the whole
			// session the first time one recall ran long (audit finding). Only
			// spawn/protocol failures take the channel dark.
			if (/timed out/i.test(msg)) {
				this.logService.warn(`[v3code-beast] ${command} timed out — degrading this call only`);
				return fallback;
			}
			this._trip(`${command} error: ${msg}`);
			return fallback;
		}
	}

	private _trip(msg: string): void {
		if (this._tripped) { return; }
		this._tripped = true;
		this.logService.warn(`[v3code-beast] disabled for this session — ${msg}`);
		this._setState({ phase: 'dark' });
	}
}

registerSingleton(IBeastService, BeastService, InstantiationType.Delayed);
