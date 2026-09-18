/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Browser-side proxy that calls the EvalSandboxChannel in the main process over
// IPC. Mirrors semanticEmbedProxy.ts → SemanticEmbedChannel pattern. Lets the
// renderer (where tools execute) run a JS/TS snippet in an isolated node:vm and
// get back logs / return value / error — behavior verification without a build.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export interface EvalSandboxResult {
	logs: string[];
	result: string | undefined;
	error: string | null;
	tsStripped: boolean;
	durationMs: number;
}

export const IEvalSandboxService = createDecorator<IEvalSandboxService>('evalSandboxService');

export interface IEvalSandboxService {
	readonly _serviceBrand: undefined;
	run(code: string, timeoutMs?: number): Promise<EvalSandboxResult>;
}

export class EvalSandboxService extends Disposable implements IEvalSandboxService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-evalSandbox');
	}

	async run(code: string, timeoutMs?: number): Promise<EvalSandboxResult> {
		return this.channel.call('run', { code, timeoutMs });
	}
}

registerSingleton(IEvalSandboxService, EvalSandboxService, InstantiationType.Delayed);
