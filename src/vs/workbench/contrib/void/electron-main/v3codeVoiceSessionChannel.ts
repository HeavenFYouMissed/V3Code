/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { buildV3VoiceSessionConfig } from '../common/v3codeVoiceSessionConfig.js';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const MAX_SDP_BYTES = 128 * 1024;

export type V3VoiceByokSessionRequest = Readonly<{ apiKey: string; offerSdp: string }>;
export type V3VoiceByokSessionResult = Readonly<{ answerSdp: string }>;

export function normalizeV3VoiceOfferSdp(raw: string): string {
	const sdp = raw.trimStart().replace(/[\r\n]+$/, '');
	return sdp ? `${sdp}\r\n` : '';
}

function buildMultipartBody(sdp: string): { boundary: string; body: string } {
	const boundary = `----v3code-realtime-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
	const body = [
		`--${boundary}`,
		'Content-Disposition: form-data; name="sdp"',
		'Content-Type: application/sdp',
		'',
		sdp,
		`--${boundary}`,
		'Content-Disposition: form-data; name="session"',
		'Content-Type: application/json',
		'',
		JSON.stringify(buildV3VoiceSessionConfig()),
		`--${boundary}--`,
		'',
	].join('\r\n');
	return { boundary, body };
}

function upstreamError(status: number): Error {
	if (status === 401 || status === 403) {
		return new Error('OpenAI rejected that API key. Check the key and try again.');
	}
	if (status === 429) {
		return new Error('OpenAI rate limit or account budget reached. Check your OpenAI API account and try again.');
	}
	return new Error(`OpenAI could not start V Voice (HTTP ${status}).`);
}

/**
 * Makes the documented Realtime WebRTC unified-interface exchange in Electron main.
 * The user's key crosses only the renderer/main IPC boundary and goes directly to
 * OpenAI; it is never sent to the V3Code hub and is never logged here.
 */
export class V3CodeVoiceSessionChannel implements IServerChannel {
	listen(): never { throw new Error('V3CodeVoiceSessionChannel: no events'); }

	async call(_: unknown, command: string, arg?: Partial<V3VoiceByokSessionRequest>): Promise<any> {
		if (command !== 'createByokSession') {
			throw new Error(`V3CodeVoiceSessionChannel: unknown command ${command}`);
		}
		const apiKey = String(arg?.apiKey ?? '').trim();
		const offerSdp = normalizeV3VoiceOfferSdp(String(arg?.offerSdp ?? ''));
		if (apiKey.length < 20) {
			throw new Error('Enter a valid OpenAI API key to start V Voice.');
		}
		if (!offerSdp.startsWith('v=') || Buffer.byteLength(offerSdp) > MAX_SDP_BYTES) {
			throw new Error('V Voice could not create a valid local audio session.');
		}

		const { boundary, body } = buildMultipartBody(offerSdp);
		let response: Response;
		try {
			response = await fetch(OPENAI_REALTIME_CALLS_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
				},
				body,
				signal: AbortSignal.timeout(20_000),
			});
		} catch {
			throw new Error('Could not reach OpenAI to start V Voice. Check your connection and try again.');
		}
		if (!response.ok) {
			// Do not surface the upstream body: provider errors can echo request metadata.
			throw upstreamError(response.status);
		}
		const answerSdp = normalizeV3VoiceOfferSdp(await response.text());
		if (!answerSdp.startsWith('v=')) {
			throw new Error('OpenAI returned an invalid voice session response.');
		}
		return { answerSdp };
	}
}
