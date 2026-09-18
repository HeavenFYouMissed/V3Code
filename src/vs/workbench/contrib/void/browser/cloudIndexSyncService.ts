/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { CloudIndexQueryResult, CloudSyncResult } from '../common/cloudIndex/cloudIndexProtocol.js';

export type CloudIndexSyncPhase = 'off' | 'idle' | 'syncing' | 'error' | 'paused';

export type CloudIndexSyncUiState = {
	enabled: boolean;
	readOnly: boolean;
	phase: CloudIndexSyncPhase;
	workspaceId: string;
	changedFilesTotal: number;
	filesProcessed: number;
	chunksUploaded: number;
	chunksPerSecond: number;
	startedAt: number | undefined;
	lastResult: CloudSyncResult | undefined;
	consecutiveFailures: number;
	nextSyncAt: number | undefined;
};

export const defaultCloudIndexSyncUiState = (): CloudIndexSyncUiState => ({
	enabled: false,
	readOnly: false,
	phase: 'off',
	workspaceId: '',
	changedFilesTotal: 0,
	filesProcessed: 0,
	chunksUploaded: 0,
	chunksPerSecond: 0,
	startedAt: undefined,
	lastResult: undefined,
	consecutiveFailures: 0,
	nextSyncAt: undefined,
});

export const ICloudIndexSyncService = createDecorator<ICloudIndexSyncService>('cloudIndexSyncService');

export interface ICloudIndexSyncService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<CloudIndexSyncUiState>;
	getState(): CloudIndexSyncUiState;
	setState(patch: Partial<CloudIndexSyncUiState>): void;
	registerSyncNow(fn: () => Promise<CloudSyncResult | undefined>): void;
	registerRetrieve(fn: (query: string, options: { topK?: number; files?: string[] }) => Promise<CloudIndexQueryResult | undefined>): void;
	/** Query the currently provisioned shared base. Undefined means local-only. */
	retrieve(query: string, options: { topK?: number; files?: string[] }): Promise<CloudIndexQueryResult | undefined>;
	/** Manual sync — resets backoff and runs immediately. */
	syncNow(): Promise<CloudSyncResult | undefined>;
	resetBackoff(): void;
}

export class CloudIndexSyncService extends Disposable implements ICloudIndexSyncService {
	readonly _serviceBrand: undefined;

	private _state: CloudIndexSyncUiState = defaultCloudIndexSyncUiState();
	private readonly _onDidChangeState = this._register(new Emitter<CloudIndexSyncUiState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _syncNowFn: (() => Promise<CloudSyncResult | undefined>) | undefined;
	private _retrieveFn: ((query: string, options: { topK?: number; files?: string[] }) => Promise<CloudIndexQueryResult | undefined>) | undefined;

	registerSyncNow(fn: () => Promise<CloudSyncResult | undefined>): void {
		this._syncNowFn = fn;
	}

	registerRetrieve(fn: (query: string, options: { topK?: number; files?: string[] }) => Promise<CloudIndexQueryResult | undefined>): void {
		this._retrieveFn = fn;
	}

	retrieve(query: string, options: { topK?: number; files?: string[] }): Promise<CloudIndexQueryResult | undefined> {
		return this._retrieveFn ? this._retrieveFn(query, options) : Promise.resolve(undefined);
	}

	getState(): CloudIndexSyncUiState {
		return this._state;
	}

	setState(patch: Partial<CloudIndexSyncUiState>): void {
		this._state = { ...this._state, ...patch };
		this._onDidChangeState.fire(this._state);
	}

	resetBackoff(): void {
		this.setState({ consecutiveFailures: 0, phase: this._state.enabled ? 'idle' : 'off', nextSyncAt: undefined });
	}

	async syncNow(): Promise<CloudSyncResult | undefined> {
		if (!this._syncNowFn) {
			return undefined;
		}
		this.resetBackoff();
		return this._syncNowFn();
	}
}

registerSingleton(ICloudIndexSyncService, CloudIndexSyncService, InstantiationType.Delayed);
