/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Workbench singleton around NativeNoticeQueue. Written by the legacy thread store when a
 * system notification is addressed to a thread it does not own (a native chat session);
 * read by the native chat agent for its own session key. See nativeNoticeQueue.ts.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { NativeNotice, NativeNoticeQueue } from '../common/nativeNoticeQueue.js';

export interface IV3NativeNoticeService {
	readonly _serviceBrand: undefined;
	/** Fires with the session key whenever a notice is parked; the native surface may use
	 *  it to show a one-line hint while the user is idle. */
	readonly onDidPush: Event<{ key: string }>;
	push(key: string, content: string, source: NativeNotice['source']): void;
	drain(key: string): NativeNotice[];
	pending(key: string): number;
	clear(key: string): void;
}

export const IV3NativeNoticeService = createDecorator<IV3NativeNoticeService>('v3NativeNoticeService');

export class V3NativeNoticeService extends Disposable implements IV3NativeNoticeService {
	declare readonly _serviceBrand: undefined;
	private readonly _queue = new NativeNoticeQueue();
	private readonly _onDidPush = this._register(new Emitter<{ key: string }>());
	readonly onDidPush = this._onDidPush.event;

	push(key: string, content: string, source: NativeNotice['source']): void {
		this._queue.push(key, content, source);
		this._onDidPush.fire({ key });
	}
	drain(key: string): NativeNotice[] { return this._queue.drain(key); }
	pending(key: string): number { return this._queue.pending(key); }
	clear(key: string): void { this._queue.clear(key); }
}

registerSingleton(IV3NativeNoticeService, V3NativeNoticeService, InstantiationType.Delayed);
