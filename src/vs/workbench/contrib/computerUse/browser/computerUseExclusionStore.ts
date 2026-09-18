/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Applications the user has excluded from computer use.
 *
 * A deny-list, deliberately, and it replaced an allow-list. Enabling computer use is one decision the
 * user makes once: they are telling the agent it may drive their machine. Asking again per application
 * re-litigates a settled question, and it costs more than it looks — a narrow grant produces a dead
 * end the model cannot resolve (it is refused, cannot say why, and the remedy is buried in settings),
 * whereas the "risk" of broad access is exactly what the user already chose.
 *
 * So nothing here grants anything, and the empty state permits everything. What it offers is an escape
 * hatch for the one case that is genuinely specific rather than categorical: *this* application, on
 * *my* machine, I would rather it never touched — a password manager, a banking app. Nobody has to opt
 * in; anyone can opt out.
 *
 * All persistence sits behind {@link IComputerUseExclusionStorage} so the logic in
 * {@link ComputerUseExclusionStore} is unit-testable without a workbench.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * Application-scoped: the JSON array of {@link ComputerUseExclusionRecord}.
 *
 * Owned exclusively by this module. Application scope rather than workspace scope because an exclusion
 * is about a native application on this machine, which has nothing to do with which folder is open.
 */
export const COMPUTER_USE_EXCLUSIONS_STORAGE_KEY = 'v3code.computerUse.excludedApps';

/** One excluded application. */
export interface ComputerUseExclusionRecord {
	/** Bundle identifier on macOS, executable name on Windows. Compared case-insensitively. */
	readonly appId: string;
	/** Display name at exclusion time, so the list reads as names rather than identifiers. */
	readonly appName: string;
	/** Epoch milliseconds the exclusion was added. */
	readonly excludedAt: number;
}

/** Identifiers differ in case and punctuation across the two platforms; compare them normalized. */
function normalizeAppId(appId: string): string {
	return appId.trim().toLowerCase();
}

function isExclusionRecord(candidate: unknown): candidate is ComputerUseExclusionRecord {
	if (typeof candidate !== 'object' || candidate === null) {
		return false;
	}
	const record = candidate as Partial<ComputerUseExclusionRecord>;
	return (
		typeof record.appId === 'string' && record.appId.length > 0 &&
		typeof record.appName === 'string' &&
		typeof record.excludedAt === 'number' && Number.isFinite(record.excludedAt)
	);
}

/**
 * The only persistence surface the store touches.
 *
 * Narrow on purpose: a test supplies an in-memory implementation and exercises the semantics with no
 * storage service, no profiles, and no async.
 */
export interface IComputerUseExclusionStorage {
	/** All persisted records. Returns empty when nothing is stored or the payload is corrupt. */
	read(): readonly ComputerUseExclusionRecord[];
	/** Replaces the persisted set. An empty set removes the key entirely. */
	write(records: readonly ComputerUseExclusionRecord[]): void;
}

/**
 * {@link IComputerUseExclusionStorage} backed by `IStorageService` at application scope.
 *
 * A corrupt or hand-edited payload reads as "no exclusions" rather than throwing. Note that this fails
 * *permissive*, which is the opposite of the usual instinct and is the right call here: the alternative
 * is that a malformed byte silently blocks an application the user never excluded, which they would
 * experience as the feature being broken with no way to diagnose it.
 */
export class StorageServiceComputerUseExclusionStorage implements IComputerUseExclusionStorage {

	constructor(private readonly storageService: IStorageService) { }

	read(): readonly ComputerUseExclusionRecord[] {
		const raw = this.storageService.get(COMPUTER_USE_EXCLUSIONS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter(isExclusionRecord);
		} catch {
			return [];
		}
	}

	write(records: readonly ComputerUseExclusionRecord[]): void {
		if (records.length === 0) {
			this.storageService.remove(COMPUTER_USE_EXCLUSIONS_STORAGE_KEY, StorageScope.APPLICATION);
			return;
		}
		this.storageService.store(
			COMPUTER_USE_EXCLUSIONS_STORAGE_KEY,
			JSON.stringify(records),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}
}

export const IComputerUseExclusionStore = createDecorator<IComputerUseExclusionStore>('computerUseExclusionStore');

/** Exclude, re-include, list and query applications the user has put out of bounds. */
export interface IComputerUseExclusionStore {
	readonly _serviceBrand: undefined;

	/** Fires after any change, so UI listing the exclusions can re-render. */
	readonly onDidChangeExclusions: Event<void>;

	/** Every exclusion, most recent first. */
	list(): readonly ComputerUseExclusionRecord[];

	/**
	 * Whether this application is excluded.
	 *
	 * The only question the gate asks. `false` for everything by default, which is the point.
	 */
	isExcluded(appId: string): boolean;

	/** Excludes an application. Idempotent — re-excluding refreshes the timestamp. */
	exclude(app: { readonly id: string; readonly name: string }): ComputerUseExclusionRecord;

	/** Removes one exclusion. Returns true when one was actually present. */
	include(appId: string): boolean;

	/** Removes every exclusion. */
	clear(): void;
}

/**
 * Exclusion bookkeeping, free of any workbench dependency.
 *
 * Construct with an {@link IComputerUseExclusionStorage}; the workbench binding is
 * {@link WorkbenchComputerUseExclusionStore} below.
 */
export class ComputerUseExclusionStore extends Disposable implements IComputerUseExclusionStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeExclusions = this._register(new Emitter<void>());
	readonly onDidChangeExclusions: Event<void> = this._onDidChangeExclusions.event;

	/** Mirror of the persisted set, so reads never hit storage or re-parse. */
	private _records: ComputerUseExclusionRecord[];

	constructor(private readonly storage: IComputerUseExclusionStorage) {
		super();
		this._records = [...this.storage.read()];
	}

	list(): readonly ComputerUseExclusionRecord[] {
		return [...this._records].sort((a, b) => b.excludedAt - a.excludedAt);
	}

	isExcluded(appId: string): boolean {
		const wanted = normalizeAppId(appId);
		return this._records.some(record => normalizeAppId(record.appId) === wanted);
	}

	exclude(app: { readonly id: string; readonly name: string }): ComputerUseExclusionRecord {
		const record: ComputerUseExclusionRecord = {
			appId: app.id,
			appName: app.name,
			excludedAt: Date.now(),
		};
		const wanted = normalizeAppId(app.id);
		this._records = this._records.filter(existing => normalizeAppId(existing.appId) !== wanted);
		this._records.push(record);
		this._flush();
		return record;
	}

	include(appId: string): boolean {
		const wanted = normalizeAppId(appId);
		const before = this._records.length;
		this._records = this._records.filter(record => normalizeAppId(record.appId) !== wanted);
		if (this._records.length === before) {
			return false;
		}
		this._flush();
		return true;
	}

	clear(): void {
		if (this._records.length === 0) {
			return;
		}
		this._records = [];
		this._flush();
	}

	private _flush(): void {
		this.storage.write(this._records);
		this._onDidChangeExclusions.fire();
	}
}

/** The workbench-bound store, persisting through `IStorageService`. */
export class WorkbenchComputerUseExclusionStore extends ComputerUseExclusionStore {
	constructor(@IStorageService storageService: IStorageService) {
		super(new StorageServiceComputerUseExclusionStorage(storageService));
	}
}

registerSingleton(IComputerUseExclusionStore, WorkbenchComputerUseExclusionStore, InstantiationType.Delayed);
