/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { URI } from '../../../../base/common/uri.js';
import { AppResourcePath, FileAccess } from '../../../../base/common/network.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ITerminalChatService, ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_CHARS, MAX_TERMINAL_INACTIVE_TIME, MAX_TERMINAL_WALL_CLOCK_TIME } from '../common/prompt/prompts.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { timeout } from '../../../../base/common/async.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isReusableTemporaryTerminal, TemporaryTerminalCache, TemporaryTerminalCacheEntry } from './temporaryTerminalCache.js';
import type { IMarker as IXtermMarker } from '@xterm/xterm';

/**
 * Live-buffer poll cadence for an in-flight agent command, ported from Cursor's wait generator
 * (minified `T2y`). Poll fast right after output moves, then back off geometrically while the
 * terminal is quiet so a 10-minute build doesn't spin a 500ms timer for its whole run.
 *
 * Cursor caps its backoff at 5 MINUTES because the same loop also drives its cloud "is this
 * hanging?" check. Ours is only a snapshot keeper, so a 5s cap keeps the captured output fresh
 * enough to be useful at the moment a command times out, at negligible cost.
 */
const TERMINAL_POLL_INITIAL_MS = 500;
const TERMINAL_POLL_BACKOFF = 1.5;
const TERMINAL_POLL_MAX_MS = 5_000;

/**
 * The output produced by the CURRENT command, given the full terminal text captured just before
 * it was sent (`before`) and the full text now (`after`).
 *
 * Why this exists: temporary agent terminals are POOLED and reused across commands in a chat
 * session, so the raw scrollback contains every earlier command's output too. Reading the whole
 * buffer on a timeout therefore returned a pile of unrelated text, and the interactive-prompt
 * detector could match a `[Y/n]` left behind by a PREVIOUS command. This is the fallback used
 * when shell integration gives us no start marker to anchor against.
 *
 * The buffer is a fixed-size ring, so once scrollback evicts lines `after` no longer starts with
 * `before`. In that case re-anchor on the last non-blank baseline line (its LAST occurrence, so a
 * repeated prompt line doesn't anchor too early). If even that is gone, the overlap is
 * unrecoverable and the full text is the honest answer.
 */
export function stripOutputPrefix(before: string, after: string): string {
	if (!before) { return after; }
	if (after.startsWith(before)) { return after.slice(before.length).replace(/^\n+/, ''); }

	const baselineLines = before.split('\n');
	for (let i = baselineLines.length - 1; i >= 0; i--) {
		const anchor = baselineLines[i];
		if (anchor.trim() === '') { continue; }
		const at = after.lastIndexOf(anchor);
		if (at !== -1) { return after.slice(at + anchor.length).replace(/^\n+/, ''); }
		break;
	}
	return after;
}

/**
 * The OSC 633 shell-integration script for a shell executable path, and the verb that sources it,
 * or undefined for a shell with no script (cmd.exe, nushell, dash, tcsh, xonsh...).
 *
 * Kept exported and pure so the shell-name parsing is testable without a live terminal: the
 * executable is a full path that varies by platform (`/bin/zsh`, `C:\...\pwsh.exe`,
 * `/opt/homebrew/bin/fish`), and getting the basename or the `.exe` strip wrong would silently
 * disable the recovery rather than fail loudly.
 *
 * The verb differs by shell family: POSIX shells and PowerShell dot-source, fish uses `source`.
 */
export function shellIntegrationScriptFor(executable: string | undefined): { resource: AppResourcePath; verb: string } | undefined {
	if (!executable) return undefined
	const shell = (executable.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '')
	switch (shell) {
		case 'bash':
			return { resource: 'vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh', verb: '.' }
		case 'zsh':
			return { resource: 'vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh', verb: '.' }
		case 'fish':
			return { resource: 'vs/workbench/contrib/terminal/common/scripts/shellIntegration.fish', verb: 'source' }
		case 'pwsh':
		case 'powershell':
			return { resource: 'vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1', verb: '.' }
		default:
			return undefined
	}
}

/** Strip echoed command + trailing shell prompt from CommandDetection output (upstream BasicExecuteStrategy). */
export function stripTerminalCommandEcho(raw: string, command: string): string {
	let out = raw.replace(/\r/g, '');
	const cmd = command.trim();
	if (cmd) {
		const lines = out.split('\n');
		if (lines.length > 0) {
			const first = lines[0].trim();
			const probe = cmd.length > 48 ? cmd.slice(0, 48) : cmd;
			if (first === cmd || first.endsWith(cmd) || first.includes(probe)) {
				lines.shift();
				out = lines.join('\n');
			}
		}
	}
	out = out.replace(/\n(?:PS [^\n>]*>|[$>] ?)\s*$/i, '').trimEnd();
	return out;
}

/**
 * True when the LAST non-empty line of terminal output looks like an interactive prompt the
 * agent can't answer (password, [Y/n], "press enter", a bare `>` continuation, etc). Scans from
 * the bottom up like Cursor's detector so trailing blank lines don't hide the prompt. Merges
 * V3Code's original patterns with Cursor's k2y set.
 *
 * Two confidence levels because it feeds two different callers:
 *   - `strict` (the FAST early probe): only UNAMBIGUOUS prompt shapes. This fires after just
 *     ~1.2s of quiet, so a loose match (any line ending in `?`) would cut off a command that
 *     merely paused. High-confidence shapes stay reliable at that short a gap.
 *   - non-strict (the POST-TIMEOUT classifier): also the loose catch-alls (trailing `?`,
 *     "are you sure"). Safe there because the full inactivity window has already elapsed — a
 *     line that's been quiet 8s+ is far more likely a real prompt than a mid-command pause.
 */
export function looksLikeInputPrompt(text: string, opts?: { strict?: boolean }): boolean {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].replace(/\r$/, '');
		if (line.trim() === '') { continue; }
		const s = line.trim();
		const highConfidence = (
			s === '>' ||
			/(?:password|passphrase)[^\n]*[:?]\s*$/i.test(s) ||
			/\[\s*[Yy]\s*\/\s*[Nn]\s*\]\s*$/.test(s) ||
			/\(\s*(?:[Yy]\s*\/\s*[Nn]|yes\/no)\s*\)\s*$/i.test(s) ||
			/(?:press\s+(?:enter|return)|press\s+any\s+key)\b/i.test(s)
		);
		if (opts?.strict) { return highConfidence; }
		return (
			highConfidence ||
			/\b(?:are you sure|ok to proceed|do you want to continue|overwrite\?)\b/i.test(s) ||
			/\?\s*$/.test(s)
		);
	}
	return false;
}

type ShellGuardDecision = { permission: 'allow' } | { permission: 'deny'; reason: string };

const SHELL_GUARD_RULES: Array<{ re: RegExp; reason: string }> = [
	{ re: /\bgit\s+reset\b[^\n;&|]*\s--hard\b/i, reason: 'git reset --hard can discard user work' },
	{ re: /\bgit\s+clean\b[^\n;&|]*-[a-z]*f[a-z]*d[a-z]*x?[a-z]*\b/i, reason: 'git clean -fd/-fdx can delete untracked files' },
	{ re: /\bgit\s+push\b[^\n;&|]*\s--force(?:-with-lease)?\b/i, reason: 'force-push requires explicit user approval' },
	// Deny only genuinely catastrophic targets: bare root (/ or /*), home (~, $HOME), drive
	// roots (C:\), and top-level system dirs. Workspace-absolute paths like
	// `rm -rf /Users/x/proj/node_modules` are routine agent cleanup and must pass.
	{ re: /\brm\s+-[^\n;&|]*r[^\n;&|]*f[^\n;&|]*\s+["']?(?:\/(?:\s|$|\*)|~\/?(?:\s|$|\*)|\$HOME\/?(?:\s|$|\*)|[A-Za-z]:[\\/]?["']?(?:\s|$)|\/(?:usr|etc|bin|sbin|lib|var|opt|home|Users|System|Library|Windows)\/?["']?(?:\s|$|[;&|]))/i, reason: 'recursive force delete against a root/home/system path is destructive' },
	{ re: /\bRemove-Item\b[^\n;&|]*(?:-Recurse\b[^\n;&|]*-Force|-Force\b[^\n;&|]*-Recurse)/i, reason: 'Remove-Item -Recurse -Force is destructive' },
	{ re: /\brmdir\b[^\n;&|]*(?:\/s\b|-r\b|--recursive\b)/i, reason: 'recursive directory removal is destructive' },
	{ re: /\bformat\s+[A-Za-z]:/i, reason: 'formatting a drive is destructive' },
	{ re: /\bshutdown\b[^\n;&|]*\/[rs]\b/i, reason: 'shutdown/restart is outside agent scope' },
];

/** Internal beforeShellExecution guard: deterministic policy before text reaches the PTY. */
export function inspectShellCommand(command: string): ShellGuardDecision {
	const normalized = command.replace(/`/g, '').replace(/\s+/g, ' ').trim();
	for (const rule of SHELL_GUARD_RULES) {
		if (rule.re.test(normalized)) {
			return { permission: 'deny', reason: rule.reason };
		}
	}
	return { permission: 'allow' };
}

export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	listPersistentTerminalIds(): string[];
	runCommand(command: string, opts:
		| { type: 'persistent', persistentTerminalId: string, chatTerminalToolSessionId?: string }
		| { type: 'temporary', cwd: string | null, terminalId: string, chatSessionId?: string, chatTerminalToolSessionId?: string, inactivityTimeoutSec?: number }
		// | { type: 'apply', terminalId: string }
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string, resolveReason: TerminalResolveReason }> }>;

	focusPersistentTerminal(terminalId: string): Promise<void>
	persistentTerminalExists(terminalId: string): boolean

	readTerminal(terminalId: string): Promise<string>

	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>
	killPersistentTerminal(terminalId: string): Promise<void>

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined
}
export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');



// function isCommandComplete(output: string) {
// 	// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
// 	const completionMatch = output.match(/\]633;D(?:;(\d+))?/)
// 	if (!completionMatch) { return false }
// 	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
// 	return { exitCode: 0 }
// }


export const persistentTerminalNameOfId = (id: string) => {
	if (id === '1') return 'V3Code Agent'
	return `V3Code Agent (${id})`
}
export const idOfPersistentTerminalName = (name: string) => {
	if (name === 'V3Code Agent') return '1'

	const match = name.match(/V3Code Agent \((\d+)\)/)
	if (!match) return null
	// match[1] is a STRING; Number.isInteger(string) is ALWAYS false, so every terminal
	// except id '1' was never recognized here and never cleaned up on exit. Parse first.
	const n = Number(match[1])
	if (Number.isInteger(n) && n >= 1) return match[1]
	return null
}

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private readonly reusableTemporaryTerminals = new TemporaryTerminalCache<ITerminalInstance>()
	private readonly reusableTemporaryEntryOfTerminal = new Map<ITerminalInstance, TemporaryTerminalCacheEntry<ITerminalInstance>>()
	/**
	 * Terminals that already had the manual shell-integration source attempted. WeakSet so a
	 * disposed terminal is collected without bookkeeping; pooled terminals are reused across many
	 * commands and a shell that cannot be helped must not re-pay the recovery on every command.
	 */
	private readonly forceSourcedTerminals = new WeakSet<ITerminalInstance>()

	private _shouldRevealTerminalForAgent(): boolean {
		const v3Mode = this.contextKeyService.getContextKeyValue<boolean>('v3code.agentMode') === true
		return !(v3Mode && !this.layoutService.isVisible(Parts.PANEL_PART))
	}

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalChatService private readonly terminalChatService: ITerminalChatService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		// runs on ALL terminals for simplicity
		const initializeTerminal = (terminal: ITerminalInstance) => {
			// when exit, remove. The onExit handler returns a Disposable that MUST be tracked
			// by the service — otherwise every run_command call leaks one (visible in DevTools as
			// "[LEAKED DISPOSABLE] ... at TerminalInstance._event [as onExit] ... at initializeTerminal").
			// Over a long agent session those leaks accumulate GC pressure and cause the chat to
			// freeze / drop streamed deltas. Register on the service's disposable store, then
			// no-op the inner dispose call (it self-disposes via the registration) so we don't
			// double-dispose.
			const d = this._register(terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title)
				if (terminalId !== null && (terminalId in this.persistentTerminalInstanceOfId)) delete this.persistentTerminalInstanceOfId[terminalId]
				const reusableEntry = this.reusableTemporaryEntryOfTerminal.get(terminal)
				if (reusableEntry) this._discardReusableTemporaryTerminal(reusableEntry, true)
				d.dispose()
			}))
		}


		// initialize any terminals that are already open
		for (const terminal of terminalService.instances) {
			const proposedTerminalId = idOfPersistentTerminalName(terminal.title)
			if (proposedTerminalId) this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal

			initializeTerminal(terminal)
		}

		this._register(
			terminalService.onDidCreateInstance(terminal => {
				// Re-adopt persistent terminals that reconnect AFTER service construction —
				// window reload restores terminals asynchronously, so the constructor scan
				// misses them and their advertised IDs would dangle.
				const proposedTerminalId = idOfPersistentTerminalName(terminal.title)
				if (proposedTerminalId && !(proposedTerminalId in this.persistentTerminalInstanceOfId)) {
					this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal
				}
				initializeTerminal(terminal)
			})
		)

		this._register(toDisposable(() => {
			for (const terminal of this.reusableTemporaryTerminals.clear()) {
				this.reusableTemporaryEntryOfTerminal.delete(terminal)
				this._clearTemporaryTerminalAliases(terminal)
				if (!terminal.isDisposed) terminal.dispose()
			}
		}))

	}


	listPersistentTerminalIds() {
		return Object.keys(this.persistentTerminalInstanceOfId)
	}

	getValidNewTerminalId(): string {
		// {1 2 3} # size 3, new=4
		// {1 3 4} # size 3, new=2
		// 1 <= newTerminalId <= n + 1
		const n = Object.keys(this.persistentTerminalInstanceOfId).length;
		if (n === 0) return '1'

		for (let i = 1; i <= n + 1; i++) {
			const potentialId = i + '';
			if (!(potentialId in this.persistentTerminalInstanceOfId)) return potentialId;
		}
		throw new Error('This should never be reached by pigeonhole principle');
	}


	private async _createTerminal(props: { cwd: string | null, config: ICreateTerminalOptions['config'], hidden?: boolean }) {
		const { cwd: override_cwd, config, hidden } = props;

		const cwd: URI | string | undefined = override_cwd ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: config && 'name' in config ? config.name : undefined,
				forceShellIntegration: true,
				hideFromUser: hidden ? true : undefined,
				// Copy any other properties from the provided config
				...config,
			},
			// Skip profile check to ensure the terminal is created quickly
			skipContributedProfileCheck: true,
		};

		const terminal = await this.terminalService.createTerminal(options)

		// // when a new terminal is created, there is an initial command that gets run which is empty, wait for it to end before returning
		// const disposables: IDisposable[] = []
		// const waitForMount = new Promise<void>(res => {
		// 	let data = ''
		// 	const d = terminal.onData(newData => {
		// 		data += newData
		// 		if (isCommandComplete(data)) { res() }
		// 	})
		// 	disposables.push(d)
		// })
		// const waitForTimeout = new Promise<void>(res => { setTimeout(() => { res() }, 5000) })

		// await Promise.any([waitForMount, waitForTimeout,])
		// disposables.forEach(d => d.dispose())

		return terminal

	}

	createPersistentTerminal: ITerminalToolService['createPersistentTerminal'] = async ({ cwd }) => {
		const terminalId = this.getValidNewTerminalId();
		const config = { name: persistentTerminalNameOfId(terminalId), title: persistentTerminalNameOfId(terminalId) }
		const terminal = await this._createTerminal({ cwd, config, })
		this.persistentTerminalInstanceOfId[terminalId] = terminal
		return terminalId
	}

	async killPersistentTerminal(terminalId: string) {
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`);
		terminal.dispose()
		delete this.persistentTerminalInstanceOfId[terminalId]
		return
	}

	persistentTerminalExists(terminalId: string): boolean {
		return terminalId in this.persistentTerminalInstanceOfId
	}


	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.temporaryTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}

	private _temporaryCacheCwd(cwd: string | null): { resource: URI; key: string } | undefined {
		// Relative paths are valid terminal inputs, but they are not stable cache identities: their
		// meaning depends on the process that launches the shell. Keep those calls ephemeral.
		if (cwd !== null && !isAbsolute(cwd)) return undefined
		const resource = cwd === null
			? this.workspaceContextService.getWorkspace().folders[0]?.uri
			: URI.file(cwd)
		if (!resource) return undefined
		return { resource, key: extUriBiasedIgnorePathCase.getComparisonKey(resource) }
	}

	private _temporaryCacheKey(sessionId: string, cwdKey: string): string {
		return JSON.stringify([sessionId, cwdKey])
	}

	private async _currentTerminalCwdKey(terminal: ITerminalInstance): Promise<string | undefined> {
		try {
			const resource = await terminal.getCwdResource()
			return resource ? extUriBiasedIgnorePathCase.getComparisonKey(resource) : undefined
		} catch {
			return undefined
		}
	}

	private _clearTemporaryTerminalAlias(terminalId: string, terminal: ITerminalInstance): void {
		if (this.temporaryTerminalInstanceOfId[terminalId] === terminal) {
			delete this.temporaryTerminalInstanceOfId[terminalId]
		}
	}

	private _clearTemporaryTerminalAliases(terminal: ITerminalInstance): void {
		for (const [terminalId, aliasedTerminal] of Object.entries(this.temporaryTerminalInstanceOfId)) {
			if (aliasedTerminal === terminal) delete this.temporaryTerminalInstanceOfId[terminalId]
		}
	}

	private _trackReusableTemporaryTerminal(entry: TemporaryTerminalCacheEntry<ITerminalInstance>): void {
		this.reusableTemporaryEntryOfTerminal.set(entry.value, entry)
		const disposeListener = this._register(entry.value.onDisposed(() => {
			this.reusableTemporaryTerminals.discard(entry)
			this.reusableTemporaryEntryOfTerminal.delete(entry.value)
			this._clearTemporaryTerminalAliases(entry.value)
			disposeListener.dispose()
		}))
	}

	private _disposeTemporaryTerminal(terminal: ITerminalInstance): void {
		this._clearTemporaryTerminalAliases(terminal)
		if (!terminal.isDisposed) terminal.dispose()
	}

	private _discardReusableTemporaryTerminal(entry: TemporaryTerminalCacheEntry<ITerminalInstance>, dispose: boolean): void {
		const terminal = this.reusableTemporaryTerminals.discard(entry)
		if (!terminal) return
		this.reusableTemporaryEntryOfTerminal.delete(terminal)
		this._clearTemporaryTerminalAliases(terminal)
		if (dispose && !terminal.isDisposed) terminal.dispose()
	}

	private _disposeEvictedTemporaryTerminals(terminals: readonly ITerminalInstance[]): void {
		for (const terminal of terminals) {
			this.reusableTemporaryEntryOfTerminal.delete(terminal)
			this._disposeTemporaryTerminal(terminal)
		}
	}


	focusPersistentTerminal: ITerminalToolService['focusPersistentTerminal'] = async (terminalId) => {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		this.terminalService.setActiveInstance(terminal)
		await this.terminalService.focusActiveInstance()
	}




	/**
	 * Full scrollback of one terminal, ANSI-stripped and NOT length-capped.
	 *
	 * Split out of `readTerminal` because the live poller and the pre-command baseline must
	 * compare exact text: `readTerminal`'s middle-ellipsis truncation would corrupt both the
	 * prefix match in `stripOutputPrefix` and the change detection in the poll loop.
	 */
	private _readTerminalBuffer(terminal: ITerminalInstance): string {
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}
		// Collect lines from the buffer iterator (oldest to newest)
		const lines: string[] = [];
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}
		return removeAnsiEscapeCodes(lines.join('\n'));
	}

	/**
	 * Polls a read function on a geometric backoff, keeping the newest non-empty snapshot.
	 *
	 * This is the resilience half of the upgrade: output is captured CONTINUOUSLY while a command
	 * runs, so a result no longer depends on the one `onCommandFinished` payload arriving intact.
	 * When that marker is missed or reports empty (the "swallowed output" failure), the last poll
	 * still holds what the command actually printed.
	 */
	private _startOutputPoller(read: () => string | undefined): { latest: () => string; dispose: () => void } {
		let latest = '';
		let delay = TERMINAL_POLL_INITIAL_MS;
		let stopped = false;
		let id: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			if (stopped) { return; }
			const text = read();
			if (text !== undefined && text !== latest) {
				latest = text;
				// Output moved — go back to the fast cadence so a chatty command stays current.
				delay = TERMINAL_POLL_INITIAL_MS;
			} else {
				delay = Math.min(delay * TERMINAL_POLL_BACKOFF, TERMINAL_POLL_MAX_MS);
			}
			id = setTimeout(tick, delay);
		};
		id = setTimeout(tick, delay);
		return {
			latest: () => latest,
			dispose: () => { stopped = true; if (id !== undefined) { clearTimeout(id); } },
		};
	}

	readTerminal: ITerminalToolService['readTerminal'] = async (terminalId) => {
		// Try persistent first, then temporary
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}

		let result = this._readTerminalBuffer(terminal);

		if (result.length > MAX_TERMINAL_CHARS) {
			const half = MAX_TERMINAL_CHARS / 2;
			result = result.slice(0, half) + '\n...\n' + result.slice(result.length - half);
		}

		return result
	};

	private async _waitForCommandDetectionCapability(terminal: ITerminalInstance, waitMs = 10_000) {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) return cmdCap

		const disposables: IDisposable[] = []

		const waitTimeout = timeout(waitMs)
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>((res) => {
			disposables.push(
				terminal.capabilities.onDidAddCapability((e) => {
					if (e.id === TerminalCapability.CommandDetection) res(e.capability)
				})
			)
		})

		const capability = await Promise.any([waitTimeout, waitForCapability])
			.finally(() => { disposables.forEach((d) => d.dispose()) })

		return capability ?? undefined
	}

	/**
	 * The `source`/dot command that manually loads VS Code's OSC 633 shell-integration script for
	 * this terminal's shell, or undefined when the shell has no script (cmd.exe, nushell, dash...).
	 *
	 * This is the SAME contract the CLI advertises via `code --locate-shell-integration-path`, so
	 * the scripts are written to be safe when sourced by hand: they self-guard on
	 * `VSCODE_SHELL_INTEGRATION` to avoid recursing, and skip their injection-only rc/ZDOTDIR
	 * fixups because `VSCODE_INJECTION` is not set on this path.
	 *
	 * Leading space is deliberate: under `HISTCONTROL=ignorespace` it keeps this bookkeeping
	 * command out of the user's shell history.
	 *
	 * Known gap: bash/git-bash on Windows gets a `C:\...` path it cannot source. Agent terminals
	 * resolve the default profile (pwsh on Windows), so that is an edge case, and it fails closed —
	 * the source is a harmless no-op and the timeout-based reads apply exactly as before.
	 */
	private _shellIntegrationSourceCommand(terminal: ITerminalInstance): string | undefined {
		const script = shellIntegrationScriptFor(terminal.shellLaunchConfig?.executable)
		if (!script) return undefined
		try {
			const fsPath = FileAccess.asFileUri(script.resource).fsPath
			if (!fsPath) return undefined
			return ` ${script.verb} "${fsPath}"`
		} catch {
			return undefined
		}
	}

	/**
	 * Last-resort recovery when shell integration never attached: source the OSC 633 script into
	 * the live shell, then give the capability a short window to appear.
	 *
	 * Needed even though agent terminals pass `forceShellIntegration: true` — that flag bypasses
	 * only ONE of the injection bail-outs (`isFeatureTerminal`). Injection still declines when the
	 * `terminal.integrated.shellIntegration.enabled` setting is off (it is policy-restrictable, so
	 * an org can disable it), when the profile carries custom shell args (`UnsupportedArgs` — the
	 * shell IS bash and the script DOES exist, injection just gives up), or on an unsupported
	 * shell. Previously every one of those degraded to timeout-scraped output for the whole
	 * session. Cursor's agent terminal recovers here; now so does ours.
	 *
	 * Attempted at most once per terminal (pooled terminals are reused across commands, and a
	 * shell that cannot be helped must not re-pay this cost on every command).
	 */
	private async _forceSourceShellIntegration(terminal: ITerminalInstance) {
		if (this.forceSourcedTerminals.has(terminal)) return undefined
		this.forceSourcedTerminals.add(terminal)

		const sourceCommand = this._shellIntegrationSourceCommand(terminal)
		if (!sourceCommand) return undefined

		try {
			await terminal.sendText(sourceCommand, true)
		} catch {
			return undefined // terminal died mid-recovery; normal timeout paths still apply
		}

		// The script emits its OSC 633 sequences on the NEXT prompt — which the sourcing command
		// itself produces — so this resolves fast when it works at all. The window is deliberately
		// short: a long one would re-pay dead air on shells sourcing genuinely cannot help.
		return this._waitForCommandDetectionCapability(terminal, 3_000)
	}

	runCommand: ITerminalToolService['runCommand'] = async (command, params) => {
		await this.terminalService.whenConnected;

		const guard = inspectShellCommand(command);
		if (guard.permission === 'deny') {
			return {
				interrupt: () => { /* blocked before terminal execution */ },
				resPromise: Promise.resolve({
					result: `Shell command blocked before execution: ${guard.reason}.\nCommand was not sent to the terminal. Ask the user for explicit approval or choose a safer command.`,
					resolveReason: { type: 'done', exitCode: 126 },
				}),
			};
		}

		const { type } = params
		const isPersistent = type === 'persistent'
		const chatTerminalToolSessionId = 'chatTerminalToolSessionId' in params ? params.chatTerminalToolSessionId : undefined

		let terminal: ITerminalInstance | undefined
		let reusableEntry: TemporaryTerminalCacheEntry<ITerminalInstance> | undefined
		const disposables: IDisposable[] = []

		if (isPersistent) { // BG process
			const { persistentTerminalId } = params
			terminal = this.persistentTerminalInstanceOfId[persistentTerminalId];
			if (!terminal) throw new Error(`Persistent terminal ${persistentTerminalId} no longer exists (it was closed or the window reloaded). Call open_persistent_terminal to create a new one.`);
		}
		else {
			const { cwd } = params
			const cacheCwd = params.chatSessionId ? this._temporaryCacheCwd(cwd) : undefined
			const cacheKey = params.chatSessionId && cacheCwd
				? this._temporaryCacheKey(params.chatSessionId, cacheCwd.key)
				: undefined

			if (cacheKey) {
				const candidate = this.reusableTemporaryTerminals.get(cacheKey)
				if (candidate && !candidate.busy) {
					const actualCwdKey = await this._currentTerminalCwdKey(candidate.value)
					const reusable = isReusableTemporaryTerminal({
						isDisposed: candidate.value.isDisposed,
						hasExited: candidate.value.exitReason !== undefined || candidate.value.exitCode !== undefined,
						expectedCwdKey: candidate.cwdKey,
						actualCwdKey,
					})
					if (reusable && this.reusableTemporaryTerminals.tryAcquire(candidate)) {
						terminal = candidate.value
						reusableEntry = candidate
					} else if (!reusable && !candidate.busy) {
						this._discardReusableTemporaryTerminal(candidate, true)
					}
				}
			}

			if (!terminal) {
				// Agent terminals must never block on interactive prompts or pagers — the model
				// can't answer them. Persistent terminals keep the user's normal environment.
				// This set mirrors the headless agent-host path (agentHostTerminalManager) and
				// Cursor's agent terminal, so the interactive lane stops dead-airing on the
				// prompts those two already suppress:
				//   - PAGER/GIT_PAGER/GH_PAGER='' disable paging in git/gh/less/most CLIs. Empty
				//     string is safer than 'cat' (which isn't on the Windows PATH).
				//   - GIT_TERMINAL_PROMPT=0 stops git credential prompts.
				//   - npm_config_yes / PIP_NO_INPUT / COMPOSER_NO_INTERACTION auto-answer the
				//     three package managers that most often stall an agent at a [y/N].
				//   - DEBIAN_FRONTEND=noninteractive stops apt/dpkg config prompts.
				// Deliberately NOT setting CI=true: neither reference path sets it, and it
				// silently changes test-runner/build behavior (watch vs single-run, output).
				const nonInteractiveEnv = {
					GIT_TERMINAL_PROMPT: '0',
					GIT_PAGER: '',
					GH_PAGER: '',
					PAGER: '',
					npm_config_yes: 'true',
					PIP_NO_INPUT: '1',
					COMPOSER_NO_INTERACTION: '1',
					DEBIAN_FRONTEND: 'noninteractive',
				}
				// Use location: Panel so xterm initializes (hidden terminals lack a DOM, blocking shell integration).
				// Agent terminals are transient so a reload cannot restore stale pooled shells as user tabs.
				// No `executable` override: agent terminals resolve the user's default profile, the
				// same shell open_persistent_terminal gets (PowerShell on Windows). Forcing Git Bash
				// here made bash pre-expand PowerShell syntax ($_ and friends) and turned `2>nul`
				// into a literal file named `nul`.
				terminal = await this._createTerminal({
					cwd: cwd,
					config: { hideFromUser: false, isTransient: true, env: nonInteractiveEnv },
					hidden: false,
				})

				if (cacheKey && cacheCwd && params.chatSessionId) {
					reusableEntry = this.reusableTemporaryTerminals.addBusy(cacheKey, params.chatSessionId, cacheCwd.key, terminal)
					if (reusableEntry) this._trackReusableTemporaryTerminal(reusableEntry)
					// A concurrent invocation may have claimed this key while terminal creation awaited.
					// This terminal remains an isolated spillover and is disposed after its command.
				}
			}
			this.temporaryTerminalInstanceOfId[params.terminalId] = terminal
		}
		if (!terminal) throw new Error('Failed to create or reuse a terminal for this command.')

		if (chatTerminalToolSessionId) {
			this.terminalChatService.registerTerminalInstanceWithToolSession(chatTerminalToolSessionId, terminal)
		}

		// Wait for shell integration (CommandDetection) to attach instead of blind delay.
		// Falls back gracefully — if it times out we still proceed and rely on inactivity-based
		// timeout. Waited ONCE here and reused below: the old second await re-paid the full 10s
		// capability timeout on shells where integration never mounts (20s dead air per command).
		// Wait for injected shell integration. When it never attaches, recover the way Cursor's
		// agent terminal does — manually source the OSC 633 script — instead of degrading to
		// timeout-scraped output for the rest of this terminal's life.
		// Agent-owned terminals only. A persistent terminal belongs to the user and may already be
		// hosting a foreground process (a dev server), where an extra send would land on THAT
		// process's stdin rather than a shell prompt.
		let cmdCap = await this._waitForCommandDetectionCapability(terminal)
		if (!cmdCap && !isPersistent) {
			cmdCap = await this._forceSourceShellIntegration(terminal)
		}

		const interrupt = () => {
			if (!isPersistent) {
				this._clearTemporaryTerminalAlias(params.terminalId, terminal)
				if (reusableEntry) this._discardReusableTemporaryTerminal(reusableEntry, true)
				else this._disposeTemporaryTerminal(terminal)
			} else {
				// Stop the running command but KEEP the user's terminal — disposing it here
				// destroyed dev servers and left the advertised terminal ID dangling. Disposal
				// is kill_persistent_terminal's job, not the stop button's.
				void terminal.sendText('\x03', false)
			}
		}

		const waitForResult = async () => {
			if (isPersistent) {
				// Route output to the terminal about to run. In V3 (Vibe) mode with the panel
				// hidden, do NOT focus it: focusing reveals the terminal panel on every agent
				// command, and for the people Vibe is for that reads as the UI convulsing.
				// The browser is the surface that follows the agent; the terminal stays where
				// the user left it (IDE mode / an already-visible panel keep the old reveal).
				this.terminalService.setActiveInstance(terminal)
				if (this._shouldRevealTerminalForAgent()) {
					await this.terminalService.focusActiveInstance()
				}
			}
			let result: string = ''
			let resolveReason: TerminalResolveReason | undefined

			// Prefer the structured command-detection capability when available

			// Adapt command for the active shell profile (shell-type detection).
			// The command is sent verbatim: no shell-specific wrapping. Wrapping it in a bash
			// script previously corrupted PowerShell commands, because bash performed parameter
			// expansion on `$_`/`$env:X`/`$(...)` before PowerShell ever saw the text.
			const shellPath = (terminal.shellLaunchConfig?.executable ?? '').toLowerCase()
			const isCmd = /\\cmd\.exe$|\/cmd$/.test(shellPath)
			const commandToSend = isCmd ? `${command}\r` : command

			// Snapshot the scrollback BEFORE sending. Temporary agent terminals are pooled and
			// reused within a chat session, so without this baseline every fallback read returns
			// the previous commands' output too. Taken before send so nothing of ours is in it.
			let baseline = ''
			try { baseline = this._readTerminalBuffer(terminal) } catch { /* xterm not rendered yet — baseline stays empty */ }

			// Marker captured when the shell reports OUR command started. When present it is the
			// exact anchor for this command's output and beats the text-diff baseline; the
			// baseline remains the fallback for shells with no integration.
			let commandStartMarker: IXtermMarker | undefined
			if (cmdCap) {
				const startListener = cmdCap.onCommandStarted(() => {
					if (commandStartMarker) return
					commandStartMarker = cmdCap.currentCommand?.commandExecutedMarker ?? cmdCap.currentCommand?.commandStartMarker
				})
				disposables.push(startListener)
			}

			// Read this command's output only: prefer the marker anchor, fall back to diffing
			// against the pre-send baseline. Returns undefined (not '') when the buffer isn't
			// readable, so the poller can tell "nothing yet" from "genuinely empty".
			const readCurrentCommandOutput = (): string | undefined => {
				try {
					const xterm = terminal.xterm
					if (!xterm) return undefined
					// A marker whose line is -1 has been disposed (scrolled out of the ring
					// buffer); getContentsAsText throws on it, so fall through to the baseline.
					if (commandStartMarker && commandStartMarker.line !== -1) {
						return removeAnsiEscapeCodes(xterm.getContentsAsText(commandStartMarker))
					}
					return stripOutputPrefix(baseline, this._readTerminalBuffer(terminal))
				} catch {
					return undefined
				}
			}

			// Live poll for the whole life of the command. This is the streaming half of the
			// Cursor port: it keeps a continuously-refreshed snapshot so a result never depends
			// solely on the single onCommandFinished payload arriving intact.
			const poller = this._startOutputPoller(readCurrentCommandOutput)
			disposables.push(toDisposable(() => poller.dispose()))

			const waitUntilDone = new Promise<void>(resolve => {
				if (!cmdCap) {
					// No shell integration — rely on inactivity + wall-clock timeouts
					return
				}
				const l = cmdCap.onCommandFinished(cmd => {
					if (resolveReason) return // already resolved
					// exitCode stays undefined when integration didn't report one — the
					// stringifier says so instead of faking a success code.
					resolveReason = { type: 'done', exitCode: cmd.exitCode ?? undefined };
					result = stripTerminalCommandEcho(cmd.getOutput() ?? '', commandToSend)
					// THE swallowed-output fix. `getOutput()` can legitimately return '' when the
					// command printed nothing — but it ALSO returns ''/null when marker placement
					// raced the output (integration attaching late, a redraw moving the anchor).
					// Those were indistinguishable, so real output silently vanished. The live
					// poller is an independent witness: if it captured text the marker didn't,
					// trust the poller. A genuinely silent command leaves both empty, so this
					// never invents output.
					if (!result.trim()) {
						const polled = stripTerminalCommandEcho(poller.latest(), commandToSend)
						if (polled.trim()) { result = polled }
					}
					l.dispose()
					resolve()
				})
				disposables.push(l)
			})

			// A temporary terminal can disappear before shell integration emits
			// onCommandFinished (profile launch failure, renderer cleanup, user close, or PTY
			// exit). Without this race the tool card remains "Running" until the 120-second
			// wall-clock fallback even though no shell process exists anymore.
			let terminalEndedBeforeCommandDetection = false
			const waitUntilTerminalEnded = new Promise<void>(resolve => {
				const finish = (exit: number | undefined) => {
					if (resolveReason) return
					terminalEndedBeforeCommandDetection = true
					resolveReason = { type: 'done', exitCode: exit }
					resolve()
				}
				const exitDisposable = terminal.onExit(exit => {
					finish(typeof exit === 'number' ? exit : undefined)
				})
				const disposedDisposable = terminal.onDisposed(() => {
					finish(typeof terminal.exitCode === 'number' ? terminal.exitCode : undefined)
				})
				disposables.push(exitDisposable, disposedDisposable)
			})


			// Bracketed paste for multiline commands (matches upstream BasicExecuteStrategy):
			// wraps the text in ESC[200~ … ESC[201~ so the shell treats it as pasted
			// literal text and does NOT re-interpret backslashes/quotes/newlines through its line
			// editor. This — not pre-escaping — is why pasted multiline PowerShell stays intact.
			// cmd.exe keeps its \r-terminated path (no bracketed-paste support).
			const forceBracketedPaste = !isCmd && /[\r\n]/.test(commandToSend)

			// send the command now that listeners are attached
			await terminal.sendText(commandToSend, !isCmd, forceBracketedPaste)

			const inactiveSec = (!isPersistent && 'inactivityTimeoutSec' in params && params.inactivityTimeoutSec != null)
				? params.inactivityTimeoutSec
				: MAX_TERMINAL_INACTIVE_TIME;

			const waitUntilInterrupt = isPersistent ?
				// timeout after X seconds
				new Promise<void>((res) => {
					setTimeout(() => {
						if (resolveReason) return
						resolveReason = { type: 'timeout', timeoutSec: MAX_TERMINAL_BG_COMMAND_TIME, cause: 'handoff' };
						res()
					}, MAX_TERMINAL_BG_COMMAND_TIME * 1000)
				})
				// inactivity-based timeout
				: new Promise<void>(res => {
					let globalTimeoutId: ReturnType<typeof setTimeout>;
					const resetTimer = () => {
						clearTimeout(globalTimeoutId);
						globalTimeoutId = setTimeout(() => {
							if (resolveReason) return

							resolveReason = { type: 'timeout', timeoutSec: inactiveSec, cause: 'inactivity' };
							res();
						}, inactiveSec * 1000);
					};

					const dTimeout = terminal.onData(() => { resetTimer(); });
					disposables.push(dTimeout, toDisposable(() => clearTimeout(globalTimeoutId)));
					resetTimer();
				})

				// Wall-clock safety net — prevents infinite hangs when shell integration is missing
				// and the command keeps producing output (resetting the inactivity timer). Must not
				// undercut an explicit timeout_seconds request: the tool advertises up to 600s, so a
				// 300s build with timeout_seconds=300 cannot be killed at the default 120s cap.
				const wallSec = Math.max(MAX_TERMINAL_WALL_CLOCK_TIME, inactiveSec * 2)
				const waitUntilWallClock = new Promise<void>(res => {
					const wallId = setTimeout(() => {
						if (resolveReason) return
						resolveReason = { type: 'timeout', timeoutSec: wallSec, cause: 'wall_clock' }
						res()
					}, wallSec * 1000)
					disposables.push(toDisposable(() => clearTimeout(wallId)))
				})

				// FAST input-prompt probe (interactive lane only). A command sitting at a prompt
				// emits its prompt text then goes silent — indistinguishable from inactivity until
				// the full `inactiveSec` window (default 8s) elapses, which is dead air the user
				// watches. Instead, ~1.2s after output goes quiet, peek at the buffer: if the tail
				// is an UNAMBIGUOUS prompt (password / [Y/n] / press-enter / bare `>`), resolve now
				// as "waiting for input" so the agent gets told to re-run non-interactively fast.
				// Persistent (background) commands are exempt — they're expected to sit running.
				// Uses strict matching so a command that merely paused isn't cut off prematurely.
				const PROMPT_PROBE_QUIET_MS = 1200
				const waitUntilInputPrompt = isPersistent ? new Promise<void>(() => { }) : new Promise<void>(res => {
					let probeId: ReturnType<typeof setTimeout> | undefined
					const schedule = () => {
						clearTimeout(probeId)
						probeId = setTimeout(() => {
							if (resolveReason) return
							// Anchored to THIS command. Reading the whole scrollback here would let
							// a `[Y/n]` left behind by an earlier command on a pooled terminal
							// abort a perfectly healthy run.
							const tail = readCurrentCommandOutput()
							if (tail === undefined) {
								return // buffer not ready yet — a later onData tick reschedules
							}
							if (looksLikeInputPrompt(tail, { strict: true })) {
								resolveReason = { type: 'timeout', timeoutSec: inactiveSec, cause: 'inactivity', mightBeWaitingForInput: true }
								res()
							}
						}, PROMPT_PROBE_QUIET_MS)
					}
					const dProbe = terminal.onData(() => { schedule() })
					disposables.push(dProbe, toDisposable(() => clearTimeout(probeId)))
					schedule()
				})

				// wait for result
				await Promise.any([waitUntilDone, waitUntilTerminalEnded, waitUntilInterrupt, waitUntilWallClock, waitUntilInputPrompt])
					.finally(() => disposables.forEach(d => d.dispose()))



			// read result if timed out, since we didn't get it from CommandDetection
			if (resolveReason?.type === 'timeout') {
				// Read THIS command's output, not the whole scrollback. The old path read the
				// entire buffer, which on a pooled/reused terminal handed back every earlier
				// command's output as if it belonged to this one — and let a stale `[Y/n]` from a
				// previous command trip the interactive-prompt classifier below.
				const anchored = readCurrentCommandOutput() ?? poller.latest()
				if (anchored.trim()) {
					result = stripTerminalCommandEcho(anchored, commandToSend)
				} else {
					try {
						const terminalId = isPersistent ? params.persistentTerminalId : params.terminalId
						// The raw PTY buffer carries the same shell echo + trailing prompt the
						// CommandDetection path strips at its resolve site — strip here too, or
						// timed-out results ship double noise.
						result = stripTerminalCommandEcho(await this.readTerminal(terminalId), commandToSend)
					} catch {
						// xterm buffer might not be available (e.g. terminal not yet rendered)
						result = '(terminal output unavailable)'
					}
				}
				// A command sitting at an interactive prompt looks exactly like inactivity —
				// detect the common prompt shapes so the tool result says "waiting for input,
				// re-run non-interactively" instead of suggesting a persistent terminal.
				if (looksLikeInputPrompt(result)) {
					resolveReason.mightBeWaitingForInput = true
				}
			}
			else if (terminalEndedBeforeCommandDetection && !result) {
				// A terminal that died mid-command often can't be read at all (xterm torn down),
				// so try the poller's last snapshot first — it was captured while the process was
				// still alive and is frequently the ONLY surviving record of what it printed.
				const polled = poller.latest()
				if (polled.trim()) {
					result = stripTerminalCommandEcho(polled, commandToSend)
				} else {
					try {
						const terminalId = isPersistent ? params.persistentTerminalId : params.terminalId
						result = stripTerminalCommandEcho(await this.readTerminal(terminalId), commandToSend)
					} catch {
						result = '(terminal ended before command output was captured)'
					}
				}
			}

			if (!resolveReason) throw new Error('Unexpected internal error: Promise.any should have resolved with a reason.')

			if (!isPersistent) {
				this._clearTemporaryTerminalAlias(params.terminalId, terminal)
				const actualCwdKey = reusableEntry && resolveReason.type === 'done'
					? await this._currentTerminalCwdKey(terminal)
					: undefined
				const reusableEntryForRelease = reusableEntry
					&& resolveReason.type === 'done'
					&& isReusableTemporaryTerminal({
						isDisposed: terminal.isDisposed,
						hasExited: terminal.exitReason !== undefined || terminal.exitCode !== undefined,
						expectedCwdKey: reusableEntry.cwdKey,
						actualCwdKey,
					})
					? reusableEntry
					: undefined
				if (reusableEntryForRelease) {
					this._disposeEvictedTemporaryTerminals(this.reusableTemporaryTerminals.release(reusableEntryForRelease))
				} else if (reusableEntry) {
					this._discardReusableTemporaryTerminal(reusableEntry, true)
				} else {
					this._disposeTemporaryTerminal(terminal)
				}
			}

			// NO synthetic `$ <command>` prefix here: this raw result feeds PARSERS
			// (git_status trim, session_diff/workspace_delta porcelain readers), which
			// ingested the prefix as data (phantom 'it --no-pager status --porcelain'
			// files). The chat-facing header lives in the run_command stringifier,
			// where it is presentation — added AFTER taming so it also survives the
			// tail cut on long outputs.
			result = removeAnsiEscapeCodes(result)
			// trim
			if (result.length > MAX_TERMINAL_CHARS) {
				const half = MAX_TERMINAL_CHARS / 2
				result = result.slice(0, half)
					+ '\n...\n'
					+ result.slice(result.length - half, Infinity)
			}

			return { result, resolveReason }

		}
		const resPromise = waitForResult().catch(error => {
			// Creation/setup/send failures do not produce a normal resolve reason, but they must not
			// strand an owned temporary terminal or its per-invocation alias.
			if (!isPersistent) interrupt()
			throw error
		})

		return {
			interrupt,
			resPromise,
		}
	}


}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
