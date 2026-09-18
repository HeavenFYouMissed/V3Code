/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { CloudIndexPostParams, CloudIndexPostResult } from '../electron-main/cloudIndexChannel.js';

export const ICloudIndexTransportService = createDecorator<ICloudIndexTransportService>('cloudIndexTransportService');

export interface ICloudIndexTransportService {
	readonly _serviceBrand: undefined;
	postJson(endpoint: string, workspaceId: string, token: string, path: string, body: unknown): Promise<unknown>;
}

export class CloudIndexTransportService extends Disposable implements ICloudIndexTransportService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-cloudIndex');
	}

	async postJson(endpoint: string, workspaceId: string, token: string, path: string, body: unknown): Promise<unknown> {
		const params: CloudIndexPostParams = { endpoint, workspaceId, path, token, body };
		const result = await this.channel.call('post', params) as CloudIndexPostResult;
		if (!result.ok) {
			const snippet = result.body ? `: ${result.body.slice(0, 200)}` : '';
			throw new Error(`${path} → HTTP ${result.status}${snippet}`);
		}
		if (!result.body) {
			return {};
		}
		try {
			return JSON.parse(result.body);
		} catch {
			return result.body;
		}
	}
}

registerSingleton(ICloudIndexTransportService, CloudIndexTransportService, InstantiationType.Delayed);
