/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { findExecutable } from '../../../../base/node/processes.js';
import { IProcessEnvironment, isWindows } from '../../../../base/common/platform.js';
import { join } from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	IV3CodeRemoteStartOptions,
	IV3CodeRemoteState,
	V3CODE_REMOTE_DEFAULT_SERVER_URL,
	V3CODE_REMOTE_DEFAULT_WEBAPP_URL,
	VGO_ALREADY_PAIRED_MARKER,
	VGO_PAIRING_URL_PREFIX,
	VGO_QR_BLOCK_BEGIN,
	VGO_QR_BLOCK_END,
} from '../common/remoteTypes.js';

/**
 * Owns the `vgo` pairing subprocess for the whole app.
 *
 * The CLI is the source of truth for pairing: it dials the relay, does the key
 * exchange and stores credentials. This service only starts it in a mode that prints
 * a pairing URL instead of drawing its own terminal UI, watches its output, and turns
 * that into a status the editor can render.
 */
export class V3CodeRemoteMainService {

	private readonly _onDidChangeState = new Emitter<IV3CodeRemoteState>();
	readonly onDidChangeState: Event<IV3CodeRemoteState> = this._onDidChangeState.event;

	private _state: IV3CodeRemoteState = { status: 'idle' };
	private _process: ChildProcessWithoutNullStreams | undefined;

	/**
	 * Credentials live in `homeDir` rather than ~/.happy, so the editor never fights a CLI
	 * the user runs by hand.
	 *
	 * `resolveShellEnv` exists because a GUI-launched app does not inherit the user's login
	 * shell environment: on macOS it gets launchd's minimal PATH, so a `vgo` installed by
	 * Homebrew (/opt/homebrew/bin) or npm is invisible and the spawn fails ENOENT on a
	 * binary the user demonstrably has and can run in any terminal. The terminal and agent
	 * host already resolve the login shell for the same reason; pairing now does too.
	 */
	constructor(
		private readonly homeDir: string,
		private readonly resolveShellEnv?: () => Promise<typeof process.env>,
	) { }

	get state(): IV3CodeRemoteState {
		return this._state;
	}

	private setState(next: IV3CodeRemoteState): void {
		this._state = next;
		this._onDidChangeState.fire(next);
	}

	/**
	 * Start pairing, or report that this machine is already paired.
	 *
	 * Resolves as soon as the outcome is known - a URL to show, or "already paired" -
	 * rather than waiting for the phone, because the caller needs to render the QR
	 * while the CLI keeps waiting in the background.
	 */
	async start(options: IV3CodeRemoteStartOptions = {}): Promise<IV3CodeRemoteState> {
		if (this._process) {
			return this._state; // one CLI per app; the existing run already has the answer
		}

		const cli = options.cliPath ?? 'vgo';
		// Resolve the login shell first so PATH matches what the user sees in a terminal.
		// Best-effort: if it fails or times out we still try the spawn, because a machine
		// where vgo IS on the app's PATH should not lose pairing over a shell probe.
		let shellEnv: typeof process.env | undefined;
		try { shellEnv = await this.resolveShellEnv?.(); }
		catch { /* keep process.env */ }

		const spawnEnv = {
			...process.env,
			...shellEnv,
			HAPPY_SERVER_URL: options.serverUrl ?? V3CODE_REMOTE_DEFAULT_SERVER_URL,
			HAPPY_WEBAPP_URL: options.webappUrl ?? V3CODE_REMOTE_DEFAULT_WEBAPP_URL,
			HAPPY_HOME_DIR: this.homeDir,
		};
		const webappUrl = spawnEnv.HAPPY_WEBAPP_URL;

		// `vgo` installed by npm is a vgo.cmd shim on Windows, and a bare name never resolved
		// here, so pairing reported "could not find the V-Go CLI" on machines where vgo runs
		// fine in the user's own terminal. Resolve through PATHEXT using the env we are about
		// to spawn with, so the lookup searches the same PATH the spawn would. Falling back to
		// the bare name preserves the previous behaviour (and its error) when nothing resolves.
		// `--mobile` (not `--web`): the phone pairs with the `vgo://terminal?…` deep link.
		// The web-auth URL is a different QR that transfers an ACCOUNT between devices, and
		// a phone that scans it never links this machine.
		const args = ['auth', 'login', '--mobile'];
		const resolvedCli = await findExecutable(cli, undefined, undefined, spawnEnv as IProcessEnvironment) ?? cli;

		const child = this.spawnCli(resolvedCli, args, spawnEnv);
		this._process = child;
		this.setState({ status: 'pairing', webappUrl });

		return await new Promise<IV3CodeRemoteState>(resolve => {
			let settled = false;
			const settle = (state: IV3CodeRemoteState) => {
				if (settled) { return; }
				settled = true;
				this.setState(state);
				resolve(state);
			};

			// stdout arrives in arbitrary chunks, so buffer and only consume whole lines.
			// The URL line comes first, then the QR rows between their fences; we settle
			// once we have both, or on the fence close if the QR is all we get.
			let stdout = '';
			let pairingUrl: string | undefined;
			let qrRows: string[] | undefined;
			let insideQr = false;

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				stdout += chunk;
				const lines = stdout.split('\n');
				stdout = lines.pop() ?? '';
				for (const line of lines) {
					const text = line.trim();

					if (insideQr) {
						if (text === VGO_QR_BLOCK_END) {
							insideQr = false;
							settle({ status: 'pairing', pairingUrl, qrRows, webappUrl });
						} else {
							// Do NOT trim: leading spaces are part of the QR's quiet zone.
							(qrRows ??= []).push(line.replace(/\s+$/, ''));
						}
						continue;
					}

					if (text === VGO_QR_BLOCK_BEGIN) {
						insideQr = true;
						qrRows = [];
					} else if (text.startsWith(VGO_PAIRING_URL_PREFIX)) {
						pairingUrl = text.slice(VGO_PAIRING_URL_PREFIX.length).trim();
					} else if (text === VGO_ALREADY_PAIRED_MARKER) {
						// Paired is not online: fall through to the exit handler, which starts
						// the daemon. Settling `connected` here showed a green panel while the
						// phone still listed the machine as offline.
						settle({ status: 'registering', webappUrl });
					}
				}
			});

			let stderr = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => { stderr += chunk; });

			child.on('error', err => {
				this._process = undefined;
				// "spawn vgo ENOENT" reads as "you don't have it", which is usually wrong —
				// it means the CLI was not on the PATH THIS PROCESS searched, and a GUI
				// launch does not get the shell's PATH. Name both possibilities and the one
				// command that tells them apart, instead of echoing an errno.
				const notOnPath = (err as NodeJS.ErrnoException).code === 'ENOENT';
				settle({
					status: 'error',
					message: notOnPath
						? `Could not find the V-Go CLI ("${cli}"). Run "which ${cli}" in a terminal: if it prints a path, V3Code could not see it because an app launched from the dock does not inherit your shell's PATH — starting V3Code from that terminal will find it. If it prints nothing, install the V-Go CLI first.`
						: `Could not start the V-Go CLI ("${cli}"). ${err.message}`,
				});
			});

			child.on('exit', code => {
				this._process = undefined;
				if (code === 0) {
					// The CLI exits 0 once a phone has approved (or was already paired).
					// Credentials alone are invisible to the phone: the daemon is what
					// registers the machine on the relay and keeps it online, so start it
					// before claiming success.
					const registering: IV3CodeRemoteState = { status: 'registering', webappUrl };
					this.setState(registering);
					settle(registering);
					this.startDaemon(resolvedCli, spawnEnv, webappUrl);
					return;
				}
				const message = stderr.trim() || `The V-Go CLI exited with code ${code}.`;
				this.setState({ status: 'error', message });
				settle({ status: 'error', message });
			});
		});
	}

	/**
	 * Bring the machine daemon up after pairing. `vgo daemon start` spawns the real
	 * daemon detached and exits 0 once it is healthy, so this child is short-lived and
	 * the daemon itself outlives the editor — which is the point: the phone should see
	 * this machine whenever it is on, not only while a pairing panel is open.
	 *
	 * Runs with the SAME env as pairing: the daemon must dial the relay the phone uses,
	 * and read the credentials pairing just wrote into our HAPPY_HOME_DIR.
	 */
	private startDaemon(resolvedCli: string, spawnEnv: IProcessEnvironment, webappUrl: string): void {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnCli(resolvedCli, ['daemon', 'start'], spawnEnv);
		} catch (err) {
			this.setState({
				status: 'error',
				message: `Paired, but the machine could not come online: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}
		this._process = child;

		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });

		child.on('error', err => {
			this._process = undefined;
			this.setState({
				status: 'error',
				message: `Paired, but the machine could not come online: ${err.message}`,
			});
		});

		child.on('exit', code => {
			this._process = undefined;
			if (code === 0) {
				this.setState({ status: 'connected', webappUrl });
				return;
			}
			this.setState({
				status: 'error',
				message: stderr.trim() || `Paired, but the machine could not come online (daemon start exited with code ${code}).`,
			});
		});
	}

	/**
	 * Resolving the path is necessary but NOT sufficient on Windows: since the
	 * CVE-2024-27980 fix, Node refuses to spawn a .cmd/.bat with shell:false at all — it
	 * throws EINVAL even when handed the full, correct path (measured on Windows 11 /
	 * Node 22). Turning shell:true on would fix the launch and reintroduce exactly what
	 * shell:false exists to prevent, since the CLI path is user-configurable. So invoke
	 * the interpreter explicitly, the same way cross-spawn does: cmd.exe with verbatim
	 * arguments and the batch path quoted by us. A Windows path cannot contain a double
	 * quote, so quoting it is sufficient — nothing here is passed through a shell parser
	 * that could re-split it. The arguments are fixed literals with no metacharacters.
	 */
	private spawnCli(resolvedCli: string, args: string[], spawnEnv: IProcessEnvironment): ChildProcessWithoutNullStreams {
		const isWindowsBatchFile = isWindows && /\.(cmd|bat)$/i.test(resolvedCli);
		return isWindowsBatchFile
			? spawn(
				process.env['ComSpec'] || 'cmd.exe',
				['/d', '/s', '/c', `""${resolvedCli}" ${args.join(' ')}"`],
				{
					env: spawnEnv,
					shell: false,
					windowsVerbatimArguments: true,
				},
			)
			: spawn(resolvedCli, args, {
				env: spawnEnv,
				// No shell: the CLI may be a user-configured path, and a shell would let a
				// path containing metacharacters run arbitrary commands.
				shell: false,
			});
	}

	/** Stop the pairing subprocess. Safe to call when nothing is running. */
	async stop(): Promise<void> {
		const child = this._process;
		this._process = undefined;
		if (child) {
			child.kill();
		}
		this.setState({ status: 'idle' });
	}

	dispose(): void {
		this._process?.kill();
		this._process = undefined;
		this._onDidChangeState.dispose();
	}
}

export class V3CodeRemoteChannel implements IServerChannel {

	private readonly service: V3CodeRemoteMainService;

	constructor(userDataPath: string, resolveShellEnv?: () => Promise<typeof process.env>) {
		this.service = new V3CodeRemoteMainService(join(userDataPath, 'v3code-remote'), resolveShellEnv);
	}

	listen(_: unknown, event: string): Event<any> {
		if (event === 'onDidChangeState') {
			return this.service.onDidChangeState;
		}
		throw new Error(`[V3CodeRemoteChannel] unknown event: ${event}`);
	}

	async call(_: unknown, command: string, arg?: unknown): Promise<any> {
		switch (command) {
			case 'start': return this.service.start((arg ?? {}) as IV3CodeRemoteStartOptions);
			case 'stop': return this.service.stop();
			case 'getState': return this.service.state;
			default: throw new Error(`[V3CodeRemoteChannel] unknown command: ${command}`);
		}
	}
}
