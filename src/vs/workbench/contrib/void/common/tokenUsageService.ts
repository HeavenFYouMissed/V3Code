/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Token usage tracking for V3Code (BYOK meter + future hosted-plan seam).
 *
 * Live per-session totals are in-memory; daily buckets persist across restarts via
 * IStorageService (APPLICATION scope). All LLM callers record through
 * ILLMMessageService.sendLLMMessage() — the single transport choke point.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { OverridesOfModel, ProviderName } from './voidSettingsTypes.js';
import { getModelCapabilities } from './modelCapabilities.js';

export interface TokenUsageRecord {
	sessionId: string;
	providerName: ProviderName;
	/** The model the user selected (settings key, e.g. 'Opus Hybrid'). */
	modelName: string;
	/** The model that actually served the request when the transport knows it. */
	wireModelName?: string;
	overridesOfModel?: OverridesOfModel;
	promptTokens: number;
	completionTokens: number;
	promptCacheHitTokens?: number;
	promptCacheWriteTokens?: number;
	promptCacheWrite1hTokens?: number;
}

export interface ModelUsageTotals {
	providerName: ProviderName;
	modelName: string;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	unpriced?: boolean;
}

export interface UsageTotals {
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	hasUnpricedUsage: boolean;
	byModel: ModelUsageTotals[];
}

export interface DailyUsageBucket {
	date: string;
	providerName: ProviderName;
	modelName: string;
	promptTokens: number;
	completionTokens: number;
	promptCacheHitTokens: number;
	promptCacheWriteTokens: number;
	costUsd: number;
	requestCount: number;
}

export interface DailyUsageSnapshot {
	date: string;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
}

export interface UsageAllowance {
	used: number;
	limit: number;
	unit: 'tokens' | 'requests' | 'credits';
	resetsLabel?: string;
}

export interface IUsageAllowanceProvider {
	getAllowance(providerName: ProviderName, modelName: string): UsageAllowance | null;
	readonly onDidChangeAllowance?: Event<void>;
}

export interface ITokenUsageService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeUsage: Event<void>;
	recordUsage(rec: TokenUsageRecord): void;
	getSessionUsage(sessionId: string): UsageTotals;
	getAllTimeTotals(): UsageTotals;
	resetSession(sessionId: string): void;
	getDailyHistory(days: number): DailyUsageSnapshot[];
	getRangeTotals(days: number): UsageTotals;
	getDailyBucketsForRange(days: number): DailyUsageBucket[];
	registerAllowanceProvider(provider: IUsageAllowanceProvider): IDisposable;
	getAllowance(providerName: ProviderName, modelName: string): UsageAllowance | null;
}

export const ITokenUsageService = createDecorator<ITokenUsageService>('voidTokenUsageService');

const STORAGE_KEY = 'v3code.tokenUsageHistory.v1';
const HISTORY_RETENTION_DAYS = 365;
const PERSIST_DEBOUNCE_MS = 2000;

const modelKey = (providerName: ProviderName, modelName: string) => `${providerName}::${modelName}`;
const dailyBucketKey = (date: string, providerName: ProviderName, modelName: string) => `${date}::${providerName}::${modelName}`;

const localDateString = (d = new Date()): string => {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
};

export const COST_SAFETY_MARGIN = 1.05;

export type ModelCostRates = {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
	unpriced?: true;
};

export type TurnTokenCounts = {
	promptTokens: number;
	completionTokens: number;
	cacheHitTokens?: number;
	cacheWriteTokens?: number;
	cacheWrite1hTokens?: number;
};

export const calcTurnCostUsd = (cost: ModelCostRates | undefined, t: TurnTokenCounts): number => {
	if (!cost || cost.unpriced) { return 0; }
	const hit = Math.max(0, t.cacheHitTokens ?? 0);
	const writeTotal = Math.max(0, t.cacheWriteTokens ?? 0);
	const write1h = Math.min(writeTotal, Math.max(0, t.cacheWrite1hTokens ?? 0));
	const write5m = writeTotal - write1h;
	const miss = Math.max(0, t.promptTokens - hit - writeTotal);
	const cacheReadRate = cost.cache_read ?? cost.input;
	const cacheWrite5mRate = cost.cache_write ?? cost.input;
	const cacheWrite1hRate = cost.input * 2;
	const raw = (miss * cost.input + hit * cacheReadRate + write5m * cacheWrite5mRate + write1h * cacheWrite1hRate + t.completionTokens * cost.output) / 1_000_000;
	return raw * COST_SAFETY_MARGIN;
};

interface PersistedUsageHistory {
	version: 1;
	buckets: DailyUsageBucket[];
}

class TokenUsageService extends Disposable implements ITokenUsageService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeUsage = this._register(new Emitter<void>());
	readonly onDidChangeUsage = this._onDidChangeUsage.event;

	private readonly _bySession = new Map<string, Map<string, ModelUsageTotals>>();
	private readonly _dailyBuckets = new Map<string, DailyUsageBucket>();

	private _allowanceProvider: IUsageAllowanceProvider | undefined;
	private _allowanceListener: IDisposable | undefined;
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._loadHistory();
		this._register(toDisposable(() => {
			if (this._persistTimer) {
				clearTimeout(this._persistTimer);
				this._persistTimer = undefined;
			}
			this._flushHistory();
		}));
	}

	private _loadHistory(): void {
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
			if (!raw) { return; }
			const parsed = JSON.parse(raw) as PersistedUsageHistory;
			if (parsed?.version !== 1 || !Array.isArray(parsed.buckets)) { return; }
			const cutoff = this._cutoffDate(HISTORY_RETENTION_DAYS);
			for (const b of parsed.buckets) {
				if (!b?.date || b.date < cutoff) { continue; }
				this._dailyBuckets.set(dailyBucketKey(b.date, b.providerName, b.modelName), { ...b });
			}
		} catch {
			// corrupt store — start fresh
		}
	}

	private _cutoffDate(days: number): string {
		const d = new Date();
		d.setDate(d.getDate() - days + 1);
		return localDateString(d);
	}

	private _schedulePersist(): void {
		if (this._persistTimer) { return; }
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			this._flushHistory();
		}, PERSIST_DEBOUNCE_MS);
	}

	private _flushHistory(): void {
		const cutoff = this._cutoffDate(HISTORY_RETENTION_DAYS);
		const buckets: DailyUsageBucket[] = [];
		for (const b of this._dailyBuckets.values()) {
			if (b.date >= cutoff) {
				buckets.push(b);
			}
		}
		this.storageService.store(STORAGE_KEY, JSON.stringify({ version: 1, buckets } satisfies PersistedUsageHistory), StorageScope.APPLICATION, StorageTarget.USER);
	}

	recordUsage(rec: TokenUsageRecord): void {
		if (!rec.promptTokens && !rec.completionTokens) { return; }

		let modelName = rec.modelName;
		let caps: ReturnType<typeof getModelCapabilities> | undefined;
		try {
			if (rec.wireModelName && rec.wireModelName !== rec.modelName) {
				const wireCaps = getModelCapabilities(rec.providerName, rec.wireModelName, rec.overridesOfModel);
				if (!wireCaps.isUnrecognizedModel) {
					modelName = rec.wireModelName;
					caps = wireCaps;
				}
			}
			caps = caps ?? getModelCapabilities(rec.providerName, rec.modelName, rec.overridesOfModel);
		} catch {
			caps = undefined;
		}

		const cost = caps?.cost;
		const unpriced = !cost || !!cost.unpriced;
		const turnCost = calcTurnCostUsd(cost, {
			promptTokens: rec.promptTokens,
			completionTokens: rec.completionTokens,
			cacheHitTokens: rec.promptCacheHitTokens,
			cacheWriteTokens: rec.promptCacheWriteTokens,
			cacheWrite1hTokens: rec.promptCacheWrite1hTokens,
		});

		let byModel = this._bySession.get(rec.sessionId);
		if (!byModel) { byModel = new Map(); this._bySession.set(rec.sessionId, byModel); }
		const key = modelKey(rec.providerName, modelName);
		const prev = byModel.get(key);
		if (prev) {
			prev.promptTokens += rec.promptTokens;
			prev.completionTokens += rec.completionTokens;
			prev.costUsd += turnCost;
			prev.unpriced = prev.unpriced || unpriced;
		} else {
			byModel.set(key, {
				providerName: rec.providerName,
				modelName,
				promptTokens: rec.promptTokens,
				completionTokens: rec.completionTokens,
				costUsd: turnCost,
				unpriced,
			});
		}

		const today = localDateString();
		const dKey = dailyBucketKey(today, rec.providerName, modelName);
		const hit = rec.promptCacheHitTokens ?? 0;
		const write = rec.promptCacheWriteTokens ?? 0;
		const dPrev = this._dailyBuckets.get(dKey);
		if (dPrev) {
			dPrev.promptTokens += rec.promptTokens;
			dPrev.completionTokens += rec.completionTokens;
			dPrev.promptCacheHitTokens += hit;
			dPrev.promptCacheWriteTokens += write;
			dPrev.costUsd += turnCost;
			dPrev.requestCount += 1;
		} else {
			this._dailyBuckets.set(dKey, {
				date: today,
				providerName: rec.providerName,
				modelName,
				promptTokens: rec.promptTokens,
				completionTokens: rec.completionTokens,
				promptCacheHitTokens: hit,
				promptCacheWriteTokens: write,
				costUsd: turnCost,
				requestCount: 1,
			});
		}

		this._schedulePersist();
		this._onDidChangeUsage.fire();
	}

	private _sum(models: Iterable<ModelUsageTotals>): UsageTotals {
		const byModel = [...models];
		let promptTokens = 0, completionTokens = 0, costUsd = 0, hasUnpricedUsage = false;
		for (const m of byModel) {
			promptTokens += m.promptTokens;
			completionTokens += m.completionTokens;
			costUsd += m.costUsd;
			hasUnpricedUsage = hasUnpricedUsage || !!m.unpriced;
		}
		return { promptTokens, completionTokens, costUsd, hasUnpricedUsage, byModel };
	}

	getSessionUsage(sessionId: string): UsageTotals {
		const byModel = this._bySession.get(sessionId);
		return this._sum(byModel ? byModel.values() : []);
	}

	getAllTimeTotals(): UsageTotals {
		const merged = new Map<string, ModelUsageTotals>();
		for (const byModel of this._bySession.values()) {
			for (const [key, m] of byModel) {
				const acc = merged.get(key);
				if (acc) {
					acc.promptTokens += m.promptTokens;
					acc.completionTokens += m.completionTokens;
					acc.costUsd += m.costUsd;
					acc.unpriced = acc.unpriced || m.unpriced;
				} else {
					merged.set(key, { ...m });
				}
			}
		}
		return this._sum(merged.values());
	}

	getDailyHistory(days: number): DailyUsageSnapshot[] {
		const clamped = Math.max(1, Math.min(days, HISTORY_RETENTION_DAYS));
		const cutoff = this._cutoffDate(clamped);
		const byDate = new Map<string, DailyUsageSnapshot>();
		for (const b of this._dailyBuckets.values()) {
			if (b.date < cutoff) { continue; }
			const snap = byDate.get(b.date);
			if (snap) {
				snap.promptTokens += b.promptTokens;
				snap.completionTokens += b.completionTokens;
				snap.costUsd += b.costUsd;
			} else {
				byDate.set(b.date, {
					date: b.date,
					promptTokens: b.promptTokens,
					completionTokens: b.completionTokens,
					costUsd: b.costUsd,
				});
			}
		}
		const out: DailyUsageSnapshot[] = [];
		const start = new Date();
		start.setDate(start.getDate() - (clamped - 1));
		for (let i = 0; i < clamped; i++) {
			const d = new Date(start);
			d.setDate(start.getDate() + i);
			const date = localDateString(d);
			out.push(byDate.get(date) ?? { date, promptTokens: 0, completionTokens: 0, costUsd: 0 });
		}
		return out;
	}

	getRangeTotals(days: number): UsageTotals {
		const clamped = Math.max(1, Math.min(days, HISTORY_RETENTION_DAYS));
		const cutoff = this._cutoffDate(clamped);
		const merged = new Map<string, ModelUsageTotals>();
		for (const b of this._dailyBuckets.values()) {
			if (b.date < cutoff) { continue; }
			const key = modelKey(b.providerName, b.modelName);
			const acc = merged.get(key);
			if (acc) {
				acc.promptTokens += b.promptTokens;
				acc.completionTokens += b.completionTokens;
				acc.costUsd += b.costUsd;
			} else {
				merged.set(key, {
					providerName: b.providerName,
					modelName: b.modelName,
					promptTokens: b.promptTokens,
					completionTokens: b.completionTokens,
					costUsd: b.costUsd,
				});
			}
		}
		return this._sum(merged.values());
	}

	resetSession(sessionId: string): void {
		if (this._bySession.delete(sessionId)) { this._onDidChangeUsage.fire(); }
	}

	registerAllowanceProvider(provider: IUsageAllowanceProvider): IDisposable {
		this._allowanceProvider = provider;
		this._allowanceListener?.dispose();
		this._allowanceListener = provider.onDidChangeAllowance?.(() => this._onDidChangeUsage.fire());
		this._onDidChangeUsage.fire();
		return toDisposable(() => {
			if (this._allowanceProvider === provider) {
				this._allowanceProvider = undefined;
				this._allowanceListener?.dispose();
				this._allowanceListener = undefined;
				this._onDidChangeUsage.fire();
			}
		});
	}

	getAllowance(providerName: ProviderName, modelName: string): UsageAllowance | null {
		return this._allowanceProvider?.getAllowance(providerName, modelName) ?? null;
	}

	getDailyBucketsForRange(days: number): DailyUsageBucket[] {
		const clamped = Math.max(1, Math.min(days, HISTORY_RETENTION_DAYS));
		const cutoff = this._cutoffDate(clamped);
		return [...this._dailyBuckets.values()].filter(b => b.date >= cutoff);
	}
}

registerSingleton(ITokenUsageService, TokenUsageService, InstantiationType.Delayed);
