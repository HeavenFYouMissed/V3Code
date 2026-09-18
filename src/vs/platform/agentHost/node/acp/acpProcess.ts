/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as cp from 'child_process';
import type { Readable, Writable } from 'stream';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { findExecutable, killTree } from '../../../../base/node/processes.js';
import { ILogService } from '../../../log/common/log.js';

export interface IAcpProcessOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Upper bound of retained stderr, in bytes. Default 64 KiB. */
	readonly stderrMaxBytes?: number;
	/** Upper bound of retained stderr, in lines. Default 200. */
	readonly stderrMaxLines?: number;
}

export interface IAcpProcessExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

export type AcpLaunchFailureKind = 'not-found' | 'spawn-failed';

/** Thrown by {@link AcpProcess.spawn} when the agent could not be started. */
export class AcpLaunchError extends Error {
	constructor(readonly kind: AcpLaunchFailureKind, readonly command: string, message: string) {
		super(message);
		this.name = 'AcpLaunchError';
	}
}

const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const DEFAULT_STDERR_MAX_LINES = 200;

/**
 * Bounded stderr sink: keeps at most N bytes and M lines of the most recent
 * output so a chatty or misbehaving agent can never grow host memory.
 */
export class BoundedLineBuffer {
	private readonly _lines: string[] = [];
	private _bytes = 0;
	private _partial = '';

	constructor(private readonly _maxBytes: number, private readonly _maxLines: number) { }

	append(chunk: string): void {
		const text = this._partial + chunk;
		const parts = text.split(/\r?\n/);
		this._partial = parts.pop() ?? '';
		for (const line of parts) {
			this._push(line);
		}
		if (this._partial.length > this._maxBytes) {
			// A single line larger than the whole budget: keep its tail only.
			this._partial = this._partial.slice(-this._maxBytes);
		}
	}

	private _push(line: string): void {
		const bytes = Buffer.byteLength(line, 'utf8') + 1;
		this._lines.push(line);
		this._bytes += bytes;
		while (this._lines.length > this._maxLines || (this._bytes > this._maxBytes && this._lines.length > 1)) {
			const dropped = this._lines.shift()!;
			this._bytes -= Buffer.byteLength(dropped, 'utf8') + 1;
		}
		if (this._bytes > this._maxBytes && this._lines.length === 1) {
			const only = this._lines[0].slice(-this._maxBytes);
			this._lines[0] = only;
			this._bytes = Buffer.byteLength(only, 'utf8') + 1;
		}
	}

	get lineCount(): number {
		return this._lines.length + (this._partial ? 1 : 0);
	}

	get byteCount(): number {
		return this._bytes + Buffer.byteLength(this._partial, 'utf8');
	}

	toString(): string {
		return this._partial ? [...this._lines, this._partial].join('\n') : this._lines.join('\n');
	}
}

/**
 * Supervises one external agent subprocess. Never uses `shell: true`; the
 * command is resolved against `PATH` with {@link findExecutable} (which
 * honours `PATHEXT` on Windows) so a missing program is reported as
 * "not found" instead of a cryptic exit.
 */
export class AcpProcess extends Disposable {

	static async spawn(options: IAcpProcessOptions, logService: ILogService): Promise<AcpProcess> {
		const resolved = await findExecutable(options.command, options.cwd, undefined, options.env);
		if (!resolved) {
			throw new AcpLaunchError('not-found', options.command, `Command not found: ${options.command}`);
		}
		const child = cp.spawn(resolved, [...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
			windowsHide: true,
		});
		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => { cleanup(); resolve(); };
			const onError = (err: NodeJS.ErrnoException) => {
				cleanup();
				const kind: AcpLaunchFailureKind = err.code === 'ENOENT' ? 'not-found' : 'spawn-failed';
				reject(new AcpLaunchError(kind, options.command, `Failed to start ${options.command}: ${err.message}`));
			};
			const cleanup = () => {
				child.off('spawn', onSpawn);
				child.off('error', onError);
			};
			child.once('spawn', onSpawn);
			child.once('error', onError);
		});
		return new AcpProcess(child, resolved, options, logService);
	}

	private readonly _onDidExit = this._register(new Emitter<IAcpProcessExit>());
	readonly onDidExit: Event<IAcpProcessExit> = this._onDidExit.event;

	private readonly _stderr: BoundedLineBuffer;
	private _exit: IAcpProcessExit | undefined;
	private readonly _exited: Promise<IAcpProcessExit>;

	private constructor(
		private readonly _child: cp.ChildProcess,
		readonly resolvedCommand: string,
		options: IAcpProcessOptions,
		private readonly _logService: ILogService,
	) {
		super();
		this._stderr = new BoundedLineBuffer(options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES, options.stderrMaxLines ?? DEFAULT_STDERR_MAX_LINES);
		this._child.stderr!.setEncoding('utf8');
		this._child.stderr!.on('data', (chunk: string) => this._stderr.append(chunk));
		this._exited = new Promise<IAcpProcessExit>(resolve => {
			this._child.once('exit', (code, signal) => {
				this._exit = { code, signal };
				this._onDidExit.fire(this._exit);
				resolve(this._exit);
			});
		});
		// Late spawn errors (EPIPE on a dead stdin, etc.) must not crash the host.
		this._child.on('error', err => this._logService.warn(`[ACP] ${resolvedCommand} process error: ${err.message}`));
		this._child.stdin!.on('error', err => this._logService.trace(`[ACP] ${resolvedCommand} stdin error: ${err.message}`));
	}

	get pid(): number | undefined {
		return this._child.pid;
	}

	get stdin(): Writable {
		return this._child.stdin!;
	}

	get stdout(): Readable {
		return this._child.stdout!;
	}

	/** Bounded tail of stderr, for diagnostics surfaced to the user. */
	get stderrTail(): string {
		return this._stderr.toString();
	}

	get exited(): boolean {
		return this._exit !== undefined;
	}

	get exitInfo(): IAcpProcessExit | undefined {
		return this._exit;
	}

	whenExited(): Promise<IAcpProcessExit> {
		return this._exited;
	}

	/**
	 * Stops the agent and its descendants: closes stdin, sends SIGTERM,
	 * waits up to `graceMs`, then force-kills the whole process tree.
	 */
	async terminate(graceMs = 2000): Promise<IAcpProcessExit> {
		if (this._exit) {
			return this._exit;
		}
		try {
			this._child.stdin?.end();
		} catch {
			// ignore
		}
		try {
			this._child.kill('SIGTERM');
		} catch {
			// ignore
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), graceMs); });
		const exit = await Promise.race([this._exited, grace]);
		clearTimeout(timer);
		if (exit) {
			return exit;
		}
		await this._forceKill();
		return this._exited;
	}

	private async _forceKill(): Promise<void> {
		const pid = this._child.pid;
		if (pid !== undefined) {
			try {
				await killTree(pid, true);
				return;
			} catch (err) {
				this._logService.trace(`[ACP] killTree failed for pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		try {
			this._child.kill('SIGKILL');
		} catch {
			// ignore
		}
	}

	override dispose(): void {
		if (!this._exit) {
			void this.terminate();
		}
		super.dispose();
	}
}
