/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Wire types for the V3Code Resource Monitor (status bar widget + full panel).
 * Snapshots travel over 'void-channel-resourceMonitor' from electron-main, where the
 * process tree is resolved with the SAME enumeration the stock Process Explorer uses
 * (vs/base/node/ps listProcesses) — no forked process logic.
 */

/** One V3Code-owned OS process (flattened from the listProcesses tree). */
export interface ResourceProcessInfo {
	pid: number;
	ppid: number;
	/** Pretty name from ps.ts (e.g. 'window', 'extension-host', 'ptyHost'). */
	name: string;
	cmd: string;
	/** CPU load in percent of one core (ps pcpu semantics). */
	cpuPct: number;
	/** Resident memory in BYTES (ps.ts normalizes % -> bytes on posix). */
	memBytes: number;
}

export interface ResourceSnapshot {
	/** System-wide CPU busy percent since the previous snapshot (os.cpus() delta). 0 on the first sample. */
	systemCpuPct: number;
	systemMemTotalBytes: number;
	systemMemUsedBytes: number;
	/**
	 * macOS only (vm_stat): memory the kernel can reclaim quickly (free + inactive + speculative).
	 * When set, prefer this over `systemMemUsedBytes` for pressure display — on Mac,
	 * `total - freemem` is almost always ~100% because file cache counts as "used".
	 */
	systemMemAvailableBytes?: number;
	/** Logical core count — needed to turn summed per-core loads into a system share. */
	cpuCount: number;
	/** Sum of RSS over every V3Code-owned process. */
	v3RssBytes: number;
	/** Sum of per-core CPU loads over every V3Code-owned process (divide by cpuCount for system share). */
	v3CpuLoadSum: number;
	processes: ResourceProcessInfo[];
	/** ms since epoch, stamped in main. */
	at: number;
}

/** A disk bucket the browser asks main to measure (main adds the global ~/.v3code bucket itself). */
export interface DiskBucketRequest {
	id: string;
	label: string;
	path: string;
}

export interface DiskBucketResult extends DiskBucketRequest {
	/** -1 when the path does not exist or the platform/measure failed. */
	bytes: number;
}

/** Role buckets for the process table (heuristic on cmd + parent chain, computed browser-side). */
export type ResourceBucketId = 'ideCore' | 'extensions' | 'terminals' | 'indexerAi' | 'other';

export const RESOURCE_BUCKET_LABELS: Record<ResourceBucketId, string> = {
	ideCore: 'IDE Core',
	extensions: 'Extensions',
	terminals: 'Terminals',
	indexerAi: 'Indexer & AI',
	other: 'Other',
};

// Thresholds (shared by status bar tint, overview banner, and the table filter).
export const HOT_SYSTEM_CPU_PCT = 80;
export const HOT_V3_RSS_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
export const HIGH_OCCUPANCY_CPU_PCT = 5;
export const HIGH_OCCUPANCY_MEM_BYTES = 200 * 1024 * 1024; // 200 MB

export const RESOURCE_MONITOR_CHANNEL = 'void-channel-resourceMonitor';

// Settings keys (registered in v3codeProductSettings.ts).
export const RM_SETTING_ENABLED = 'v3code.resourceMonitor.enabled';
export const RM_SETTING_INTERVAL_MS = 'v3code.resourceMonitor.updateIntervalMs';
export const RM_SETTING_SHOW_IN_STATUS_BAR = 'v3code.resourceMonitor.showInStatusBar';

export const formatBytes = (bytes: number): string => {
	if (bytes < 0) { return 'n/a'; }
	if (bytes < 1024) { return `${bytes} B`; }
	const kb = bytes / 1024;
	if (kb < 1024) { return `${kb.toFixed(0)} KB`; }
	const mb = kb / 1024;
	if (mb < 1024) { return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`; }
	const gb = mb / 1024;
	return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
};

/** Headline memory pressure % — uses macOS-available bytes when present. */
export const memoryPressurePct = (snap: ResourceSnapshot): number => {
	if (snap.systemMemAvailableBytes !== undefined && snap.systemMemTotalBytes > 0) {
		const used = snap.systemMemTotalBytes - snap.systemMemAvailableBytes;
		return Math.min(100, Math.max(0, (used / snap.systemMemTotalBytes) * 100));
	}
	return snap.systemMemTotalBytes > 0 ? (snap.systemMemUsedBytes / snap.systemMemTotalBytes) * 100 : 0;
};
