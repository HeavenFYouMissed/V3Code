/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * IPC channel for the built-in local autocomplete engine (Phase 2). The renderer drives the
 * first-run model download + polls progress through this. Registered in app.ts as
 * `void-channel-localInference`; the renderer talks to it via the LocalInferenceProxy.
 * Mirrors MemoryChannel.
 */

import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureModelDownloaded, getDownloadStatus, isModelDownloaded, getEngineInfo } from './localInference/localModelDownloader.js';

export class LocalInferenceChannel implements IServerChannel {

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`LocalInferenceChannel has no events. Requested: ${event}`);
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		const modelName = params?.modelName as string;
		switch (command) {
			case 'isModelDownloaded':
				return isModelDownloaded(modelName);
			case 'ensureModelDownloaded':
				void ensureModelDownloaded(modelName); // fire-and-forget; renderer polls getDownloadStatus
				return;
			case 'getDownloadStatus':
				return getDownloadStatus(modelName);
			case 'getEngineInfo':
				return getEngineInfo();
			default:
				throw new Error(`LocalInferenceChannel: command "${command}" not recognized.`);
		}
	}
}
