/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Main-process owner of the Debug mode runtime-evidence sink.
//
// Registered in app.ts; the renderer talks to it through IDebugSessionService
// (browser/debugSessionService.ts) — the same shape as beastChannel/IBeastService.
//
// Why this lives in the main process at all: the renderer has no child_process (and should
// not). Runtime evidence has to come from a real listening socket bound on the user's
// machine, and only the main process can start one.
//
// Lifecycle: one sink per workspace root, started when a Debug chat begins, stopped when it
// ends. The child is unref'd so a wedged collector can never block the editor from quitting,
// and the collector independently exits after two idle hours as a backstop.

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	isUsableDebugSessionId,
	V3_DEBUG_COLLECTOR_PORT,
	V3_DEBUG_LOG_DIR_NAME,
	V3DebugSessionConfig,
	V3DebugStartResult,
	V3DebugTailResult,
} from '../common/debugSessionTypes.js';
import { V3_DEBUG_COLLECTOR_SOURCE, V3_DEBUG_COLLECTOR_SOURCE_VERSION } from './debugCollectorSource.js';

/** Materialized script location. User data, not the workspace — never in anyone's repo. */
const COLLECTOR_DIR = join(homedir(), '.v3code', 'debug');
const COLLECTOR_SCRIPT = join(COLLECTOR_DIR, `evidence-sink-v${V3_DEBUG_COLLECTOR_SOURCE_VERSION}.cjs`);

/** How long the collector gets to print its handshake before we call the start failed. */
const HANDSHAKE_TIMEOUT_MS = 6_000;
/** Grace period after asking the collector to stop by itself, before we kill it. */
const SHUTDOWN_GRACE_MS = 900;

interface LiveSession {
	readonly config: V3DebugSessionConfig;
	readonly child: ChildProcess;
}

export class DebugCollectorChannel implements IServerChannel, IDisposable {

	/** One live sink per workspace root. */
	private readonly sessions = new Map<string, LiveSession>();

	constructor(private readonly logService: ILogService) { }

	listen(_: unknown, event: string): Event<never> {
		throw new Error(`DebugCollectorChannel has no events. Requested: ${event}`);
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		if (command === 'start') { return this._start(params?.workspaceRoot); }
		if (command === 'stop') { return this._stop(params?.workspaceRoot); }
		if (command === 'status') { return this._status(params?.workspaceRoot); }
		if (command === 'tail') { return this._tail(params?.workspaceRoot, params?.lines); }
		if (command === 'clear') { return this._clear(params?.workspaceRoot); }
		throw new Error(`DebugCollectorChannel: command "${command}" not recognized.`);
	}

	/**
	 * Kill every live sink on the way out.
	 *
	 * The children are unref'd, which is what lets the editor quit without waiting on them —
	 * but that also means an editor quit with a Debug chat open would otherwise leave a sink
	 * process holding its port until its two-hour idle timeout. It is killed here instead of
	 * being relied on to notice.
	 *
	 * `_shutdownChild` sends SIGTERM synchronously before its first await, so firing it
	 * without awaiting still delivers the signal during shutdown. The collector's own idle
	 * exit remains the backstop for a hard kill that never reaches this code.
	 */
	dispose(): void {
		for (const session of this.sessions.values()) {
			void this._shutdownChild(session);
		}
		this.sessions.clear();
	}

	private _root(workspaceRoot: unknown): string | null {
		return typeof workspaceRoot === 'string' && workspaceRoot.length > 0 ? workspaceRoot : null;
	}

	/**
	 * Write the collector to disk if it is absent or stale. Keyed by a version constant and
	 * also compared by content, so an upgraded build replaces it while a re-launch of
	 * unchanged code does not touch the filesystem.
	 */
	private _materializeCollector(): string {
		let current: string | undefined;
		try {
			current = readFileSync(COLLECTOR_SCRIPT, 'utf8');
		} catch { /* absent — write it */ }
		if (current !== V3_DEBUG_COLLECTOR_SOURCE) {
			mkdirSync(COLLECTOR_DIR, { recursive: true });
			writeFileSync(COLLECTOR_SCRIPT, V3_DEBUG_COLLECTOR_SOURCE, 'utf8');
			this.logService.info(`[v3code-debug] materialized evidence sink v${V3_DEBUG_COLLECTOR_SOURCE_VERSION} at ${COLLECTOR_SCRIPT}`);
		}
		return COLLECTOR_SCRIPT;
	}

	/**
	 * Spawn the sink and wait for its handshake.
	 *
	 * ELECTRON_RUN_AS_NODE is load-bearing: in the main process `process.execPath` is the
	 * EDITOR BINARY, so spawning it naively opens a second editor instead of running a Node
	 * script. This env flag makes that same binary behave as plain Node.
	 */
	private _spawnCollector(root: string, sessionId: string): Promise<LiveSession> {
		return new Promise((resolve, reject) => {
			const script = this._materializeCollector();
			const logDir = join(root, V3_DEBUG_LOG_DIR_NAME);
			let child: ChildProcess;
			try {
				child = spawn(process.execPath, [
					script,
					'--port', String(V3_DEBUG_COLLECTOR_PORT),
					'--log-dir', logDir,
					'--session-id', sessionId,
				], {
					env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
					cwd: root,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			// Never let the collector hold the editor open at quit.
			child.unref();

			let settled = false;
			let stdout = '';
			let stderr = '';
			const timer = setTimeout(() => {
				if (settled) { return; }
				settled = true;
				try { child.kill(); } catch { /* already gone */ }
				reject(new Error(`the evidence sink did not report ready within ${HANDSHAKE_TIMEOUT_MS}ms${stderr ? ` — ${stderr.trim().slice(0, 300)}` : ''}`));
			}, HANDSHAKE_TIMEOUT_MS);

			const finish = (fn: () => void) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				fn();
			};

			child.stdout?.on('data', (chunk: Buffer) => {
				stdout += String(chunk);
				const line = stdout.split('\n').find(l => l.startsWith('V3DEBUG_READY '));
				if (!line) { return; }
				finish(() => {
					let parsed: Record<string, unknown>;
					try {
						parsed = JSON.parse(line.slice('V3DEBUG_READY '.length));
					} catch (err) {
						reject(new Error(`the evidence sink handshake was not valid JSON: ${String(err)}`));
						return;
					}
					const port = typeof parsed.port === 'number' ? parsed.port : -1;
					const endpoint = typeof parsed.ingestUrl === 'string' ? parsed.ingestUrl : '';
					const logPath = typeof parsed.logFile === 'string' ? parsed.logFile : '';
					// Validate what we are about to hand the model. A sink whose endpoint is
					// wrong is worse than no sink: the model would instrument against nothing and
					// report a clean run.
					if (!endpoint.startsWith('http://127.0.0.1:') || !logPath || port <= 0) {
						reject(new Error(`the evidence sink reported an unusable endpoint (${endpoint || 'none'})`));
						return;
					}
					resolve({
						child,
						config: {
							sessionId,
							endpoint,
							logPath,
							configPath: join(logDir, `collector-${sessionId}.json`),
							port,
							workspaceRoot: root,
							startedAt: Date.now(),
						},
					});
				});
			});
			child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
			child.on('error', (err) => finish(() => reject(err)));
			child.on('exit', (code) => finish(() => reject(new Error(`the evidence sink exited during startup (code ${code ?? 'null'})`))));
		});
	}

	/** Idempotent: starting an already-running workspace returns the existing session. */
	private async _start(workspaceRoot: unknown): Promise<V3DebugStartResult> {
		const root = this._root(workspaceRoot);
		if (!root) {
			return { ok: false, reason: 'No workspace folder is open, so there is nowhere to collect runtime evidence.' };
		}
		const existing = this.sessions.get(root);
		if (existing) {
			return { ok: true, config: existing.config };
		}
		const sessionId = randomBytes(8).toString('hex');
		if (!isUsableDebugSessionId(sessionId)) {
			// Unreachable for a hex id, kept because the id becomes a filename and a silent
			// regression here would be a path bug, not a cosmetic one.
			return { ok: false, reason: 'Generated an unusable session id.' };
		}
		try {
			// The child handle MUST land in the map with the config: a session whose handle is
			// dropped looks started but can never be stopped, and the sink would outlive the
			// chat that owns it until its idle timeout fired.
			const session = await this._spawnCollector(root, sessionId);
			this.sessions.set(root, session);
			return { ok: true, config: session.config };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[v3code-debug] could not start the evidence sink for ${root}: ${reason}`);
			return { ok: false, reason };
		}
	}

	private async _stop(workspaceRoot: unknown): Promise<{ ok: boolean }> {
		const root = this._root(workspaceRoot);
		if (!root) { return { ok: false }; }
		const session = this.sessions.get(root);
		if (!session) { return { ok: true }; }
		this.sessions.delete(root);
		await this._shutdownChild(session);
		return { ok: true };
	}

	/**
	 * Ask the collector to stop on its own first: it marks its config file `stopped`, which
	 * is what tells a later crash-recovery pass that this sink is finished rather than
	 * abandoned. SIGTERM does not stop a child process on Windows, so the kill is only a
	 * fallback for a collector that ignores the request.
	 */
	private async _shutdownChild(session: LiveSession): Promise<void> {
		const child = session.child;
		if (!child) { return; }
		const alive = child.exitCode === null && !child.killed;
		if (!alive) { return; }
		try {
			child.kill('SIGTERM');
		} catch { /* already gone */ }
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
			child.once('exit', () => { clearTimeout(timer); resolve(); });
		});
		try {
			if (child.exitCode === null && !child.killed) { child.kill('SIGKILL'); }
		} catch { /* already gone */ }
	}

	private _status(workspaceRoot: unknown): { running: boolean; lineCount: number } {
		const root = this._root(workspaceRoot);
		const session = root ? this.sessions.get(root) : undefined;
		if (!root || !session) { return { running: false, lineCount: 0 }; }
		return { running: true, lineCount: this._countLines(session.config.logPath) };
	}

	/**
	 * Read the evidence file. Reading it here rather than letting the renderer fetch the
	 * loopback URL keeps the log out of the page's CSP and CORS world entirely, and means a
	 * tail can never be blocked by a policy that has nothing to do with debugging.
	 */
	private _tail(workspaceRoot: unknown, lines?: number): V3DebugTailResult {
		const root = this._root(workspaceRoot);
		const session = root ? this.sessions.get(root) : undefined;
		if (!root || !session) { return { lines: '', lineCount: 0, running: false }; }
		let text = '';
		try {
			if (existsSync(session.config.logPath)) {
				text = readFileSync(session.config.logPath, 'utf8');
			}
		} catch (err) {
			this.logService.warn(`[v3code-debug] could not read evidence at ${session.config.logPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const all = text.split('\n').filter(l => l.trim().length > 0);
		const limit = typeof lines === 'number' && lines > 0 ? lines : all.length;
		return {
			lines: all.slice(-limit).join('\n'),
			lineCount: all.length,
			running: true,
		};
	}

	private _clear(workspaceRoot: unknown): { ok: boolean } {
		const root = this._root(workspaceRoot);
		const session = root ? this.sessions.get(root) : undefined;
		if (!session) { return { ok: false }; }
		try {
			writeFileSync(session.config.logPath, '', 'utf8');
			return { ok: true };
		} catch (err) {
			this.logService.warn(`[v3code-debug] could not clear evidence: ${err instanceof Error ? err.message : String(err)}`);
			return { ok: false };
		}
	}

	private _countLines(logPath: string): number {
		try {
			if (!existsSync(logPath)) { return 0; }
			return readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim().length > 0).length;
		} catch {
			return 0;
		}
	}
}
