/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as os from 'os';
import { execFile } from 'child_process';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { listProcesses } from '../../../../base/node/ps.js';
import { ProcessItem } from '../../../../base/common/processes.js';
import { DiskBucketRequest, DiskBucketResult, ResourceProcessInfo, ResourceSnapshot } from '../common/resourceMonitorTypes.js';

/** Minimum ms between real process enumerations — multiple windows share this channel, and spawning ps more often than this buys nothing. */
const SNAPSHOT_MIN_INTERVAL_MS = 1_500;
/** du can crawl a model directory with GBs of files — cache sizes and refresh lazily. */
const DISK_CACHE_TTL_MS = 60_000;
const DU_TIMEOUT_MS = 15_000;

/** Cumulative os.cpus() times, for busy-percent deltas between snapshots. */
type CpuTimes = { idle: number; total: number };

function readCpuTimes(): CpuTimes {
	let idle = 0; let total = 0;
	for (const cpu of os.cpus()) {
		idle += cpu.times.idle;
		total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
	}
	return { idle, total };
}

/** `du -sk <path>` — fast native directory size on darwin/linux. Resolves -1 on any failure (missing path, timeout, win32). */
function directorySizeBytes(path: string): Promise<number> {
	if (process.platform === 'win32') {
		// macOS-first per the spec; Windows parity can follow with a PowerShell measure.
		return Promise.resolve(-1);
	}
	return new Promise(resolve => {
		// SECURITY: execFile (no shell) with the path as a literal argument, so a directory
		// named with shell metacharacters (e.g. `$(cmd)`) cannot inject. du's own stderr
		// (permission-denied noise the old `2>/dev/null` swallowed) is ignored via the err path.
		execFile('du', ['-sk', path], { timeout: DU_TIMEOUT_MS }, (err, stdout) => {
			if (err) { resolve(-1); return; }
			const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
			resolve(Number.isFinite(kb) ? kb * 1024 : -1);
		});
	});
}

function readMacMemoryAvailableBytes(): Promise<number | undefined> {
	if (process.platform !== 'darwin') {
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		execFile('vm_stat', [], { timeout: 3_000 }, (err, stdout) => {
			if (err) { resolve(undefined); return; }
			let pageSize = 4096;
			const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
			if (pageSizeMatch) {
				pageSize = parseInt(pageSizeMatch[1], 10) || pageSize;
			}
			const pages: Record<string, number> = {};
			for (const line of stdout.split('\n')) {
				const m = line.match(/^(.+?):\s+(\d+)/);
				if (m) { pages[m[1].trim()] = parseInt(m[2], 10); }
			}
			const reclaimable = (pages['Pages free'] ?? 0)
				+ (pages['Pages inactive'] ?? 0)
				+ (pages['Pages speculative'] ?? 0);
			resolve(reclaimable * pageSize);
		});
	});
}

export class ResourceMonitorChannel implements IServerChannel {

	private _prevCpu: CpuTimes = readCpuTimes();
	private _lastSnapshot: ResourceSnapshot | undefined;
	private _snapshotInflight: Promise<ResourceSnapshot> | undefined;
	private readonly _diskCache = new Map<string, { bytes: number; at: number }>();

	listen(): never { throw new Error('ResourceMonitorChannel: no events'); }

	async call(_: unknown, command: string, arg?: { buckets?: DiskBucketRequest[] }): Promise<any> {
		if (command === 'snapshot') { return this._snapshot(); }
		if (command === 'disk') { return this._disk(arg?.buckets ?? []); }
		throw new Error(`ResourceMonitorChannel: unknown command ${command}`);
	}

	private async _snapshot(): Promise<ResourceSnapshot> {
		// Serve the cached snapshot while fresh; de-dupe concurrent callers onto one ps run.
		if (this._lastSnapshot && Date.now() - this._lastSnapshot.at < SNAPSHOT_MIN_INTERVAL_MS) {
			return this._lastSnapshot;
		}
		if (this._snapshotInflight) { return this._snapshotInflight; }
		this._snapshotInflight = this._takeSnapshot().finally(() => { this._snapshotInflight = undefined; });
		return this._snapshotInflight;
	}

	private async _takeSnapshot(): Promise<ResourceSnapshot> {
		const cpuNow = readCpuTimes();
		const dTotal = cpuNow.total - this._prevCpu.total;
		const dIdle = cpuNow.idle - this._prevCpu.idle;
		const systemCpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
		this._prevCpu = cpuNow;

		const totalBytes = os.totalmem();
		const usedBytes = totalBytes - os.freemem();
		const systemMemAvailableBytes = await readMacMemoryAvailableBytes();

		// Same enumeration as the stock Process Explorer — the whole V3Code process tree
		// rooted at the main process (renderer windows, extension hosts, GPU, pty host,
		// utility processes, and anything they spawned).
		const processes: ResourceProcessInfo[] = [];
		let v3RssBytes = 0;
		let v3CpuLoadSum = 0;
		try {
			const root = await listProcesses(process.pid);
			const walk = (item: ProcessItem) => {
				processes.push({ pid: item.pid, ppid: item.ppid, name: item.name, cmd: item.cmd, cpuPct: item.load, memBytes: item.mem });
				v3RssBytes += item.mem;
				v3CpuLoadSum += item.load;
				for (const child of item.children ?? []) { walk(child); }
			};
			walk(root);
		} catch { /* ps unavailable — ship the system stats alone rather than failing the poll */ }

		this._lastSnapshot = {
			systemCpuPct,
			systemMemTotalBytes: totalBytes,
			systemMemUsedBytes: usedBytes,
			systemMemAvailableBytes,
			cpuCount: os.cpus().length || 1,
			v3RssBytes,
			v3CpuLoadSum,
			processes,
			at: Date.now(),
		};
		return this._lastSnapshot;
	}

	private async _disk(requested: DiskBucketRequest[]): Promise<{ buckets: DiskBucketResult[] }> {
		// Main owns the global bucket (browser can't know the OS home dir); the browser
		// passes workspace-relative and logs buckets.
		const all: DiskBucketRequest[] = [
			{ id: 'global', label: 'Global V3Code data (~/.v3code)', path: join(os.homedir(), '.v3code') },
			...requested,
		];
		const buckets = await Promise.all(all.map(async (b): Promise<DiskBucketResult> => {
			const cached = this._diskCache.get(b.path);
			if (cached && Date.now() - cached.at < DISK_CACHE_TTL_MS) {
				return { ...b, bytes: cached.bytes };
			}
			const bytes = await directorySizeBytes(b.path);
			this._diskCache.set(b.path, { bytes, at: Date.now() });
			return { ...b, bytes };
		}));
		return { buckets };
	}
}
