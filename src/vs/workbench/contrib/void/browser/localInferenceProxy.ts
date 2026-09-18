/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Renderer-side proxy for the built-in local inference engine (Phase 2). Drives the first-run
 * model download + polls progress over `void-channel-localInference`. Mirrors MemoryService.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export interface ModelDownloadStatus {
	state: 'absent' | 'downloading' | 'ready' | 'error';
	downloadedBytes: number;
	totalBytes: number;
	error?: string;
}

export interface EngineInfo { gpu: string | false; gpuDevices: string[]; }

export interface ILocalInferenceService {
	readonly _serviceBrand: undefined;
	isModelDownloaded(modelName: string): Promise<boolean>;
	ensureModelDownloaded(modelName: string): Promise<void>;
	getDownloadStatus(modelName: string): Promise<ModelDownloadStatus>;
	getEngineInfo(): Promise<EngineInfo>;
}

export const ILocalInferenceService = createDecorator<ILocalInferenceService>('localInferenceService');

class LocalInferenceProxy extends Disposable implements ILocalInferenceService {
	declare readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this.channel = mainProcessService.getChannel('void-channel-localInference');
	}

	isModelDownloaded(modelName: string): Promise<boolean> { return this.channel.call('isModelDownloaded', { modelName }); }
	ensureModelDownloaded(modelName: string): Promise<void> { return this.channel.call('ensureModelDownloaded', { modelName }); }
	getDownloadStatus(modelName: string): Promise<ModelDownloadStatus> { return this.channel.call('getDownloadStatus', { modelName }); }
	getEngineInfo(): Promise<EngineInfo> { return this.channel.call('getEngineInfo', {}); }
}

registerSingleton(ILocalInferenceService, LocalInferenceProxy, InstantiationType.Delayed);
