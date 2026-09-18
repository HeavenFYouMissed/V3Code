/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Registered in app.ts — spawns the beast sidecar (the Rust code index built in
// the V3Index repo) per command, the same way ripgrep is spawned by the search
// service. The renderer talks to it through IBeastService (browser/beastService.ts).
// Pure plumbing — no ranking behavior lives here (Phase A of
// docs/v3index-beast-packet/WIRING-PLAN.md).
//
// Index dbs live OUTSIDE every workspace (~/.v3code/beastdb/<hash>): the
// editor's own file watcher must never observe beast's index writes, and no
// .beast/ directory ever appears in the user's repo.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { realpathSync, mkdirSync, renameSync } from 'node:fs';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BeastHit, parseBeastHits } from '../common/beastTypes.js';

/** Executable name — Windows needs the extension for spawn to resolve it. */
const BEAST_EXE = process.platform === 'win32' ? 'beast.exe' : 'beast';

/**
 * Where beast lives, in priority order.
 *
 * The BUNDLED copy has to come first and has to exist: beast ships inside the
 * app, and until it did, the only copy on any machine was one a developer had
 * built with scripts/build-beast.sh into ~/.v3code/bin. That made the sidecar
 * work on the machine that built the release and be absent for every user —
 * invisible here, dark everywhere else.
 *
 * The home-directory path is kept as a fallback so a locally built beast still
 * wins for development, and so an older install keeps working after an upgrade.
 */
function resolveBundledBeast(): string | undefined {
	// process.resourcesPath is Contents/Resources (darwin) or resources\ (win32);
	// undefined when running from source, where the home-dir copy is the dev path.
	const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	if (!resources) { return undefined; }
	const bundled = join(resources, 'beast', BEAST_EXE);
	return existsSync(bundled) ? bundled : undefined;
}

const HOME_BIN = join(homedir(), '.v3code', 'bin', BEAST_EXE);
const DEFAULT_BIN = resolveBundledBeast() ?? HOME_BIN;
const DB_ROOT = join(homedir(), '.v3code', 'beastdb');

/** Searches answer in ~ms; the timeout only guards a wedged spawn. */
const SEARCH_TIMEOUT_MS = 5_000;
/** Full index of a large repo is ~15-20s on the mac this was tuned on; leave
 *  generous headroom. Windows gets 15 minutes: the index is wipe-and-rebuild and
 *  re-reads every file, which Windows disks + Defender real-time scanning make
 *  2-5x slower — a Defender-OFF test box already exceeded 180s, and a kill
 *  mid-index throws the partial db away, so a too-small budget turns into an
 *  endless rebuild loop that never completes. */
const INDEX_TIMEOUT_MS = process.platform === 'win32' ? 900_000 : 180_000;
const VERSION_TIMEOUT_MS = 5_000;

/** A workspace db dir under DB_ROOT is exactly a 16-hex-char sha1 prefix (see
 *  dbPathFor) — pruning only ever considers names matching this, so nothing
 *  outside ~/.v3code/beastdb (and nothing hand-placed inside it) can be deleted. */
const DB_DIR_NAME = /^[0-9a-f]{16}$/;
/** Prune runs once, this long after launch: windows are open by then and the
 *  first beast calls have marked their dbs live. */
const PRUNE_DELAY_MS = 120_000;
/** Each index db is on the order of hundreds of MB; nothing ever deleted them,
 *  so ~/.v3code/beastdb grew without bound (measured: 3.1GB across 12 dirs).
 *  Keep the newest PRUNE_MAX_DBS dirs; drop dirs beyond the cap or untouched
 *  for PRUNE_STALE_DAYS — conservative on purpose, a pruned index rebuilds
 *  itself in seconds on the next open of that workspace. */
const PRUNE_MAX_DBS = 12;
const PRUNE_STALE_DAYS = 60;

function dbPathFor(workspaceRoot: string): string {
	// Canonicalize before hashing: a symlinked or case-variant open of the same
	// folder must land on the SAME db, or index and memory silently split.
	let canonical = workspaceRoot;
	try { canonical = realpathSync.native(workspaceRoot); } catch { /* keep raw */ }
	if (process.platform === 'darwin' || process.platform === 'win32') {
		canonical = canonical.toLowerCase();
	}
	const h = createHash('sha1').update(canonical).digest('hex').slice(0, 16);
	const db = join(DB_ROOT, h);
	// One-time migration: dbs keyed on the raw path (pre-canonicalization).
	if (!existsSync(db)) {
		const legacyH = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 16);
		const legacy = join(DB_ROOT, legacyH);
		if (legacyH !== h && existsSync(legacy)) {
			try {
				renameSync(legacy, db);
				const legacyMem = legacy + '.memory.jsonl';
				if (existsSync(legacyMem)) { renameSync(legacyMem, db + '.memory.jsonl'); }
			} catch { /* next index run recreates */ }
		}
	}
	return db;
}

export class BeastChannel implements IServerChannel {

	/** One index run per workspace at a time; concurrent asks coalesce onto it. */
	private readonly indexInFlight = new Map<string, Promise<{ ok: boolean; tookMs: number; summary: string }>>();

	/** Db dir names touched by any call this session — never prune these. */
	private readonly liveDbNames = new Set<string>();

	constructor(
		private readonly getOpenWorkspaceRoots: () => string[],
		private readonly logService: ILogService,
	) {
		setTimeout(() => { void this._pruneStaleDbs(); }, PRUNE_DELAY_MS);
	}

	/** Single choke point for workspace → db resolution: every use marks the db
	 *  live so startup pruning can never take the db of a workspace in use. */
	private _dbFor(workspaceRoot: string): string {
		const db = dbPathFor(workspaceRoot);
		this.liveDbNames.add(basename(db));
		return db;
	}

	/**
	 * Startup disk hygiene for ~/.v3code/beastdb (see PRUNE_MAX_DBS). Protected,
	 * in belt-and-braces order: dbs of currently open windows, dbs touched this
	 * session, and anything not a plain hash-named directory directly under
	 * DB_ROOT (symlinks are never followed, so nothing outside the root is
	 * reachable). The .memory.jsonl sidecar is deliberately NOT pruned with its
	 * index when it holds notes: it is user data (remember/recall), it is KBs
	 * against the index's hundreds of MB, and it re-attaches to the same hash
	 * when the workspace is reopened — only an empty sidecar is removed.
	 */
	private async _pruneStaleDbs(): Promise<void> {
		try {
			const protectedNames = new Set(this.liveDbNames);
			for (const root of this.getOpenWorkspaceRoots()) {
				protectedNames.add(basename(dbPathFor(root)));
			}
			const entries = await readdir(DB_ROOT, { withFileTypes: true }).catch(() => null);
			if (!entries) { return; } // no beastdb yet — nothing to prune
			const dirs: { name: string; lastUsedMs: number }[] = [];
			for (const entry of entries) {
				if (!entry.isDirectory() || !DB_DIR_NAME.test(entry.name)) { continue; }
				// Recency = the newer of the dir itself and its completion marker
				// (beast index is wipe-and-rebuild, so both track real use).
				let lastUsedMs = 0;
				try { lastUsedMs = (await stat(join(DB_ROOT, entry.name))).mtimeMs; } catch { /* stat raced a delete — treat as oldest */ }
				try { lastUsedMs = Math.max(lastUsedMs, (await stat(join(DB_ROOT, entry.name, 'beast-meta.json'))).mtimeMs); } catch { /* partial db — dir mtime stands */ }
				dirs.push({ name: entry.name, lastUsedMs });
			}
			dirs.sort((a, b) => b.lastUsedMs - a.lastUsedMs); // newest-first retention
			const staleBeforeMs = Date.now() - PRUNE_STALE_DAYS * 24 * 60 * 60 * 1000;
			let pruned = 0;
			for (let i = 0; i < dirs.length; i++) {
				const { name, lastUsedMs } = dirs[i];
				if (i < PRUNE_MAX_DBS && lastUsedMs >= staleBeforeMs) { continue; } // retained: within cap and fresh
				if (protectedNames.has(name)) { continue; } // open or used this session — never delete
				const target = join(DB_ROOT, name);
				if (!target.startsWith(DB_ROOT + sep)) { continue; } // unreachable (hash-name regex has no separators) — kept as a hard stop
				try {
					await rm(target, { recursive: true, force: true });
					pruned++;
					const reason = i >= PRUNE_MAX_DBS ? `beyond the ${PRUNE_MAX_DBS}-db cap` : `untouched for ${PRUNE_STALE_DAYS}+ days`;
					this.logService.info(`[v3code-beast] pruned index db ${name} (${reason}; the index rebuilds on the next open of that workspace)`);
				} catch (err) {
					this.logService.warn(`[v3code-beast] could not prune index db ${name}: ${err instanceof Error ? err.message : String(err)}`);
					continue;
				}
				const sidecar = target + '.memory.jsonl';
				try {
					const s = await stat(sidecar);
					if (s.size === 0) {
						await rm(sidecar, { force: true });
					} else {
						this.logService.info(`[v3code-beast] kept memory sidecar ${basename(sidecar)} (${s.size} bytes of notes — user data)`);
					}
				} catch { /* no sidecar */ }
			}
			if (pruned > 0) {
				this.logService.info(`[v3code-beast] beastdb prune done: removed ${pruned} of ${dirs.length} index dbs under ${DB_ROOT}`);
			}
		} catch (err) {
			this.logService.warn(`[v3code-beast] beastdb prune skipped: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`BeastChannel has no events. Requested: ${event}`);
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		if (command === 'version') { return this._version(params ?? {}); }
		if (command === 'index') { return this._index(params); }
		if (command === 'search') { return this._search(params); }
		if (command === 'symbol') { return this._symbol(params); }
		if (command === 'trace') { return this._trace(params); }
		if (command === 'remember') { return this._remember(params); }
		if (command === 'forget') { return this._forget(params); }
		if (command === 'recall') { return this._recall(params); }
		throw new Error(`BeastChannel: command "${command}" not recognized.`);
	}

	private _bin(params: { binPath?: string }): string {
		const configured = params.binPath || DEFAULT_BIN;
		// A path copied from macOS notes has no extension. Rather than report "binary missing"
		// at a path the user can plainly see is occupied by beast.exe, accept the .exe sibling —
		// but only when the extensionless path really is absent, so an explicit choice still wins.
		if (process.platform === 'win32' && !existsSync(configured) && !/\.[^\\/.]+$/.test(configured)) {
			const withExe = `${configured}.exe`;
			if (existsSync(withExe)) { return withExe; }
		}
		return configured;
	}

	/** Health probe — the CLI has no `status` subcommand, `--version` is the contract. */
	private async _version(params: { binPath?: string }): Promise<{ available: boolean; version?: string }> {
		const bin = this._bin(params);
		if (!existsSync(bin)) { return { available: false }; }
		try {
			const r = await this._run(bin, ['--version'], undefined, VERSION_TIMEOUT_MS);
			return { available: r.code === 0, version: r.stdout.trim() };
		} catch {
			return { available: false };
		}
	}

	private _index(params: { workspaceRoot: string; binPath?: string }): Promise<{ ok: boolean; tookMs: number; summary: string }> {
		const { workspaceRoot } = params;
		const existing = this.indexInFlight.get(workspaceRoot);
		if (existing) { return existing; }
		const run = (async () => {
			const t0 = Date.now();
			const r = await this._run(
				this._bin(params),
				['index', workspaceRoot, '--db', this._dbFor(workspaceRoot)],
				workspaceRoot,
				INDEX_TIMEOUT_MS,
			);
			// beast index has no --json; the human summary tail is diagnostic-only.
			const summary = (r.code === 0 ? r.stdout : r.stderr).trim().split('\n').slice(-6).join('\n');
			return { ok: r.code === 0, tookMs: Date.now() - t0, summary };
		})().finally(() => this.indexInFlight.delete(workspaceRoot));
		this.indexInFlight.set(workspaceRoot, run);
		return run;
	}

	private async _search(params: { workspaceRoot: string; query: string; k?: number; binPath?: string }): Promise<BeastHit[]> {
		const db = this._dbFor(params.workspaceRoot);
		// beast writes beast-meta.json LAST, after the tantivy commit — its presence
		// is the true completion marker. Gating on the bare dir let a timeout-killed
		// PARTIAL index through: search then exited non-zero ("no index at ..."),
		// which tripped the session kill switch and showed "Beast off" until restart.
		if (!existsSync(join(db, 'beast-meta.json'))) { return []; } // not indexed (or interrupted mid-index) — empty result, never an error
		const args = ['search', params.query, '--k', String(params.k ?? 10), '--db', db, '--json'];
		const r = await this._run(this._bin(params), args, params.workspaceRoot, SEARCH_TIMEOUT_MS);
		if (r.code !== 0) {
			throw new Error(`beast search exited ${r.code}: ${r.stderr.slice(0, 400)}`);
		}
		return parseBeastHits(r.stdout);
	}

	/** Shared shape for the JSON-lines subcommands added for Phase C: run, fail
	 *  loudly on non-zero exit, and hand back one parsed object per stdout line. */
	private async _jsonLines(params: { workspaceRoot: string; binPath?: string }, args: string[], timeoutMs: number): Promise<any[]> {
		const db = this._dbFor(params.workspaceRoot);
		// Memory commands work WITHOUT an index (notes live beside the db dir);
		// a remember before the first index run must not be silently dropped.
		const memoryCmd = args[0] === 'remember' || args[0] === 'forget' || (args[0] === 'recall' && !args.includes('--near'));
		// Same completion-marker gate as _search: a partial (killed mid-index) db
		// must read as not-indexed rather than exit non-zero and trip the kill switch.
		if (!existsSync(join(db, 'beast-meta.json')) && !memoryCmd) { return []; } // not indexed yet
		if (memoryCmd) { try { mkdirSync(DB_ROOT, { recursive: true }); } catch { /* exists */ } }
		const r = await this._run(this._bin(params), [...args, '--db', db, '--json'], params.workspaceRoot, timeoutMs);
		if (r.code !== 0) {
			throw new Error(`beast ${args[0]} exited ${r.code}: ${r.stderr.slice(0, 400)}`);
		}
		const out: any[] = [];
		for (const line of r.stdout.split('\n')) {
			const t = line.trim();
			if (!t) { continue; }
			try { out.push(JSON.parse(t)); } catch { /* non-JSON noise line — skip */ }
		}
		return out;
	}

	private _symbol(params: { workspaceRoot: string; name: string; defsOnly?: boolean; binPath?: string }): Promise<any[]> {
		const args = ['symbol', params.name, ...(params.defsOnly ? ['--defs'] : [])];
		return this._jsonLines(params, args, SEARCH_TIMEOUT_MS);
	}

	private _trace(params: { workspaceRoot: string; target: string; depth?: number; binPath?: string }): Promise<any[]> {
		const args = ['trace', params.target, '--depth', String(params.depth ?? 2)];
		return this._jsonLines(params, args, SEARCH_TIMEOUT_MS);
	}

	private async _remember(params: { workspaceRoot: string; text: string; files?: string[]; symbols?: string[]; binPath?: string }): Promise<any | null> {
		const args = ['remember', params.text];
		for (const f of params.files ?? []) { args.push('--file', f); }
		for (const s of params.symbols ?? []) { args.push('--symbol', s); }
		const notes = await this._jsonLines(params, args, SEARCH_TIMEOUT_MS);
		return notes[0] ?? null;
	}

	private async _forget(params: { workspaceRoot: string; text?: string; id?: number; binPath?: string }): Promise<{ deleted: number }> {
		const args = ['forget'];
		if (params.id !== undefined) { args.push('--id', String(params.id)); }
		if (params.text) { args.push('--text', params.text); }
		const out = await this._jsonLines(params, args, SEARCH_TIMEOUT_MS);
		return out[0] ?? { deleted: 0 };
	}

	private _recall(params: { workspaceRoot: string; query?: string; near?: string; depth?: number; k?: number; binPath?: string }): Promise<any[]> {
		const args = ['recall', params.query ?? ''];
		if (params.near) { args.push('--near', params.near); }
		if (params.depth !== undefined) { args.push('--depth', String(params.depth)); }
		if (params.k !== undefined) { args.push('--k', String(params.k)); }
		return this._jsonLines(params, args, SEARCH_TIMEOUT_MS);
	}

	private _run(bin: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			let settled = false;
			const killer = setTimeout(() => {
				if (settled) { return; }
				settled = true;
				try { child.kill('SIGKILL'); } catch { /* already gone */ }
				reject(new Error(`beast ${args[0]} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			child.stdout.on('data', d => { stdout += d; });
			child.stderr.on('data', d => { stderr += d; });
			child.on('error', err => {
				if (settled) { return; }
				settled = true;
				clearTimeout(killer);
				reject(err);
			});
			child.on('close', code => {
				if (settled) { return; }
				settled = true;
				clearTimeout(killer);
				resolve({ code, stdout, stderr });
			});
		});
	}
}
