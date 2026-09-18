/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Image generation over Grok / xAI for the `generate_image` agent tool. Runs in the MAIN
 * process (Node) so the HTTPS call to api.x.ai isn't blocked by renderer CORS — same reason
 * LLM calls and web search live here. The renderer passes the xAI key (from Settings) + prompt,
 * we POST to xAI's images endpoint and hand back the base64 image bytes; the renderer writes the
 * file into the workspace. Registered in app.ts as `void-channel-imageGen`.
 */

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';

export interface GenerateImageResult {
	/** Base64-encoded image bytes (JPEG — xAI's grok-2-image returns JPEG). */
	b64: string;
}

// Default xAI image model when the caller/settings don't specify one. grok-imagine-image-quality
// is xAI's current recommended image model (grok-2-image still works as an alternative).
const DEFAULT_IMAGE_MODEL = 'grok-imagine-image-quality';

/** POST to xAI's OpenAI-compatible image endpoint and return the base64 image. Throws a clear,
 *  user-facing message on a missing key or an API error so the agent can relay it. */
async function generateImageGrok(apiKey: string, prompt: string, model: string): Promise<GenerateImageResult> {
	if (!apiKey) {
		throw new Error('No Grok (xAI) API key is set. Add one in Settings under "Grok (xAI)" to generate images.');
	}
	if (!prompt.trim()) {
		throw new Error('generate_image requires a non-empty prompt.');
	}
	const modelName = model.trim() || DEFAULT_IMAGE_MODEL;

	let res: Response;
	try {
		res = await fetch('https://api.x.ai/v1/images/generations', {
			method: 'POST',
			signal: AbortSignal.timeout(120_000), // image gen can take a while
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
			body: JSON.stringify({ model: modelName, prompt, response_format: 'b64_json', n: 1 }),
		});
	} catch (e) {
		throw new Error(`Could not reach the Grok image API: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Grok image API error ${res.status}: ${text.slice(0, 300)}`);
	}

	const json = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> };
	const first = json?.data?.[0];

	if (first?.b64_json) { return { b64: first.b64_json }; }

	// Fallback: some responses return a URL instead of inline base64 — fetch + encode it.
	if (first?.url) {
		const imgRes = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
		if (!imgRes.ok) { throw new Error(`Could not download the generated image (${imgRes.status}).`); }
		const buf = Buffer.from(await imgRes.arrayBuffer());
		return { b64: buf.toString('base64') };
	}

	throw new Error('Grok image API returned no image data.');
}

export class ImageGenChannel implements IServerChannel {
	listen(): never { throw new Error('ImageGenChannel: no events'); }

	async call(_: unknown, command: string, arg?: { apiKey?: string; prompt?: string; model?: string }): Promise<any> {
		if (command !== 'generateImage') { throw new Error(`ImageGenChannel: unknown command ${command}`); }
		return generateImageGrok(String(arg?.apiKey ?? ''), String(arg?.prompt ?? ''), String(arg?.model ?? ''));
	}
}
