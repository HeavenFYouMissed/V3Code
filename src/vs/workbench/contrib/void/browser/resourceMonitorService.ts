/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Browser-side resource monitor: polls the electron-main channel on a configurable
 * interval and exposes the latest snapshot (plus role bucketing) to the status bar
 * widget and the full panel. Process enumeration itself lives in main and reuses the
 * stock Process Explorer machinery — this service only classifies and distributes.
 */

import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DiskBucketRequest, DiskBucketResult, RESOURCE_MONITOR_CHANNEL, ResourceBucketId, ResourceProcessInfo, ResourceSnapshot, RM_SETTING_ENABLED, RM_SETTING_INTERVAL_MS } from '../common/resourceMonitorTypes.js';

export interface IResourceMonitorService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSnapshot: import('../../../../base/common/event.js').Event<ResourceSnapshot>;
	/** Latest snapshot, or undefined before the first poll completes. */
	readonly snapshot: ResourceSnapshot | undefined;
	/** Force a poll now (panel open, manual refresh). */
	refreshNow(): Promise<ResourceSnapshot | undefined>;
	/** Measure disk buckets (main adds the global ~/.v3code bucket itself; results are cached main-side). */
	getDiskUsage(buckets: DiskBucketRequest[]): Promise<DiskBucketResult[]>;
	/** Role bucket for a process, with parent-chain inheritance for shells and extension children. */
	classify(processes: ResourceProcessInfo[]): Map<number, ResourceBucketId>;
}

export const IResourceMonitorService = createDecorator<IResourceMonitorService>('ResourceMonitorService');

const DEFAULT_INTERVAL_MS = 2_500;
const MIN_INTERVAL_MS = 1_000;

class ResourceMonitorService extends Disposable implements IResourceMonitorService {
	_serviceBrand: undefined;

	private readonly _onDidChangeSnapshot = this._register(new Emitter<ResourceSnapshot>());
	readonly onDidChangeSnapshot = this._onDidChangeSnapshot.event;

	private _snapshot: ResourceSnapshot | undefined;
	get snapshot() { return this._snapshot; }

	private readonly _timer = this._register(new MutableDisposable());

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._syncTimer();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(RM_SETTING_ENABLED) || e.affectsConfiguration(RM_SETTING_INTERVAL_MS)) {
				this._syncTimer();
			}
		}));
	}

	private _syncTimer(): void {
		const enabled = this.configurationService.getValue<boolean>(RM_SETTING_ENABLED) !== false;
		if (!enabled) {
			this._timer.value = undefined;
			return;
		}
		const rawInterval = Number(this.configurationService.getValue(RM_SETTING_INTERVAL_MS)) || DEFAULT_INTERVAL_MS;
		const intervalMs = Math.max(MIN_INTERVAL_MS, rawInterval);
		const handle = setInterval(() => { void this.refreshNow(); }, intervalMs);
		this._timer.value = toDisposable(() => clearInterval(handle));
		void this.refreshNow();
	}

	async refreshNow(): Promise<ResourceSnapshot | undefined> {
		try {
			const channel = this.mainProcessService.getChannel(RESOURCE_MONITOR_CHANNEL);
			const snapshot = await channel.call<ResourceSnapshot>('snapshot');
			this._snapshot = snapshot;
			this._onDidChangeSnapshot.fire(snapshot);
			return snapshot;
		} catch {
			// Main channel unavailable (e.g. web) — leave the last snapshot in place.
			return this._snapshot;
		}
	}

	async getDiskUsage(buckets: DiskBucketRequest[]): Promise<DiskBucketResult[]> {
		const channel = this.mainProcessService.getChannel(RESOURCE_MONITOR_CHANNEL);
		const { buckets: results } = await channel.call<{ buckets: DiskBucketResult[] }>('disk', { buckets });
		return results;
	}

	classify(processes: ResourceProcessInfo[]): Map<number, ResourceBucketId> {
		const byPid = new Map(processes.map(p => [p.pid, p]));
		const result = new Map<number, ResourceBucketId>();

		const own = (p: ResourceProcessInfo): ResourceBucketId | undefined => {
			const cmd = p.cmd.toLowerCase();
			const name = p.name.toLowerCase();
			// Strongest signals first: AI/indexer child processes regardless of parent.
			if (/ollama|llama[-.]?(server|cpp)|onnxruntime|v3-embed|semantic[-_]?index/.test(cmd)) { return 'indexerAi'; }
			if (cmd.includes('--type=extensionhost') || name.includes('extension-host') || cmd.includes('extensionhost')) { return 'extensions'; }
			if (name.includes('ptyhost') || cmd.includes('--type=ptyhost') || cmd.includes('ptyhost')) { return 'terminals'; }
			if (cmd.includes('--type=gpu-process') || cmd.includes('--type=renderer') || cmd.includes('--type=zygote')
				|| name.includes('shared-process') || name.includes('watcher') || cmd.includes('crashpad')) { return 'ideCore'; }
			return undefined;
		};

		const resolve = (p: ResourceProcessInfo, depth = 0): ResourceBucketId => {
			const cached = result.get(p.pid);
			if (cached) { return cached; }
			let bucket = own(p);
			if (!bucket && depth < 16) {
				const parent = byPid.get(p.ppid);
				if (parent) {
					// Shells under the pty host and language servers under the extension
					// host belong to their parent's bucket, not 'other'.
					const parentBucket = resolve(parent, depth + 1);
					if (parentBucket === 'terminals' || parentBucket === 'extensions' || parentBucket === 'indexerAi') {
						bucket = parentBucket;
					} else if (parent.ppid === parent.pid || !byPid.has(parent.ppid)) {
						// Direct child of the root main process with no signal of its own.
						bucket = undefined;
					}
				} else {
					// The root (main) process itself.
					bucket = 'ideCore';
				}
			}
			const final: ResourceBucketId = bucket ?? 'other';
			result.set(p.pid, final);
			return final;
		};

		for (const p of processes) { resolve(p); }
		return result;
	}
}

registerSingleton(IResourceMonitorService, ResourceMonitorService, InstantiationType.Delayed);
