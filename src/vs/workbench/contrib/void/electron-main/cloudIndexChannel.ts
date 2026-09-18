/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Main-process HTTP transport for V3Index sync. Renderer fetch() hits CORS against
// vscode-file:// origins; Node fetch does not.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';

export type CloudIndexPostParams = {
	endpoint: string;
	workspaceId: string;
	path: string;
	token: string;
	body: unknown;
};

export type CloudIndexPostResult = {
	ok: boolean;
	status: number;
	body: string;
};

export class CloudIndexChannel implements IServerChannel {

	listen(_: unknown, event: string, _arg?: unknown): Event<any> {
		throw new Error(`CloudIndexChannel has no events. Requested: ${event}`);
	}

	async call<T>(_: unknown, command: string, params?: unknown, _cancellationToken?: CancellationToken): Promise<T> {
		if (command !== 'post') {
			throw new Error(`CloudIndexChannel: command "${command}" not recognized.`);
		}
		return this._post(params as CloudIndexPostParams) as T;
	}

	private async _post(params: CloudIndexPostParams): Promise<CloudIndexPostResult> {
		const base = params.endpoint.replace(/\/+$/, '');
		const url = `${base}/v1/ws/${encodeURIComponent(params.workspaceId)}${params.path}`;
		const init = {
			method: 'POST',
			body: JSON.stringify(params.body),
			headers: {
				'authorization': `Bearer ${params.token}`,
				'content-type': 'application/json',
			},
		};
		// Retry CONNECTION-level failures ("fetch failed"): undici reuses keep-alive
		// sockets across the many sequential /chunks of a sync, and when one is closed
		// (idle timeout on Cloudflare's side) the next request on that dead socket
		// throws before it ever reaches the server — verified via server logs, where
		// every request that ARRIVED returned 200. A retry opens a fresh connection.
		// Real HTTP errors (500/404) resolve via res.ok below and are NOT retried here,
		// so the syncer still sees them.
		let lastErr: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(url, init);
				const body = await res.text().catch(() => '');
				return { ok: res.ok, status: res.status, body };
			} catch (err) {
				lastErr = err;
				await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
			}
		}
		throw lastErr;
	}
}
