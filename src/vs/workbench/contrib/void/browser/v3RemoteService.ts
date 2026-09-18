/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IV3CodeRemoteStartOptions, IV3CodeRemoteState } from '../common/remoteTypes.js';

export const IV3CodeRemoteService = createDecorator<IV3CodeRemoteService>('v3codeRemoteService');

export interface IV3CodeRemoteService {
	readonly _serviceBrand: undefined;
	readonly state: IV3CodeRemoteState;
	readonly onDidChangeState: Event<IV3CodeRemoteState>;
	/** Begin pairing (or report that this machine is already paired). */
	start(options?: IV3CodeRemoteStartOptions): Promise<IV3CodeRemoteState>;
	/** Stop the pairing subprocess. */
	stop(): Promise<void>;
}

/**
 * Renderer proxy for remote / mobile pairing.
 *
 * The subprocess and every piece of pairing state live in the main process, so all
 * windows observe one machine-wide status rather than each starting their own CLI.
 */
class V3CodeRemoteService extends Disposable implements IV3CodeRemoteService {
	readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	private readonly _onDidChangeState = this._register(new Emitter<IV3CodeRemoteState>());
	readonly onDidChangeState: Event<IV3CodeRemoteState> = this._onDidChangeState.event;

	private _state: IV3CodeRemoteState = { status: 'idle' };
	get state(): IV3CodeRemoteState { return this._state; }

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = mainProcessService.getChannel('void-channel-remote');
		this._register(this.channel.listen<IV3CodeRemoteState>('onDidChangeState')(next => {
			this._state = next;
			this._onDidChangeState.fire(next);
		}));
	}

	async start(options: IV3CodeRemoteStartOptions = {}): Promise<IV3CodeRemoteState> {
		const state = await this.channel.call<IV3CodeRemoteState>('start', options);
		this._state = state;
		return state;
	}

	async stop(): Promise<void> {
		await this.channel.call('stop');
	}
}

registerSingleton(IV3CodeRemoteService, V3CodeRemoteService, InstantiationType.Delayed);
