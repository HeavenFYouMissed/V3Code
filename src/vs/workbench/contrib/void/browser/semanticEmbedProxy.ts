/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Browser-side proxy that calls the SemanticEmbedChannel in the main process
// over IPC. Mirrors sendLLMMessageService.ts → LLMMessageChannel pattern.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export const ISemanticEmbedService = createDecorator<ISemanticEmbedService>('semanticEmbedService');

export interface ISemanticEmbedService {
	readonly _serviceBrand: undefined;
	/** `kind: 'query'` lets asymmetric models (Qwen3) apply their query instruct-prefix. */
	embed(texts: string[], kind?: 'doc' | 'query'): Promise<Float32Array[]>;
	/** Embed in the PREVIOUS (potion static) space — dual-space retrieval while a
	 *  model-swap backfill is in flight. Throws when the static model can't load. */
	embedStatic(texts: string[], modelId?: string): Promise<Float32Array[]>;
	getModelInfo(): Promise<{ modelId: string; dim: number; isReady: boolean }>;
	init(opts?: { modelHint?: string; cacheDir?: string; mirrorHost?: string }): Promise<void>;
	/** Local cross-encoder scores (order-only semantics). Throws on failure — callers must fall back. */
	rerank(query: string, docs: string[], allowDownload?: boolean): Promise<number[]>;
	getRerankInfo(): Promise<{ isReady: boolean; modelPresent: boolean }>;
}

export class SemanticEmbedService extends Disposable implements ISemanticEmbedService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-semanticEmbed');
	}

	async init(opts?: { modelHint?: string; cacheDir?: string; mirrorHost?: string }): Promise<void> {
		await this.channel.call('init', opts);
	}

	async embed(texts: string[], kind?: 'doc' | 'query'): Promise<Float32Array[]> {
		const buf: VSBuffer = await this.channel.call('embed', { texts, kind });
		return this._unpackVectors(buf);
	}

	async embedStatic(texts: string[], modelId?: string): Promise<Float32Array[]> {
		const buf: VSBuffer = await this.channel.call('embedStatic', { texts, modelId });
		return this._unpackVectors(buf);
	}

	/** Main process returns raw bytes: [uint32 count][uint32 dim][float32 data]. */
	private _unpackVectors(buf: VSBuffer): Float32Array[] {
		const bytes = buf.buffer;
		if (bytes.byteLength < 8) return [];
		const header = new DataView(bytes.buffer, bytes.byteOffset, 8);
		const count = header.getUint32(0, true);
		const dim = header.getUint32(4, true);
		if (count === 0 || dim === 0) return [];
		// Copy the float region into a fresh (4-byte-aligned) buffer before viewing.
		const floatBytes = bytes.slice(8, 8 + count * dim * 4);
		const floats = new Float32Array(floatBytes.buffer, floatBytes.byteOffset, count * dim);
		const out: Float32Array[] = [];
		for (let i = 0; i < count; i++) out.push(floats.slice(i * dim, (i + 1) * dim));
		return out;
	}

	async getModelInfo(): Promise<{ modelId: string; dim: number; isReady: boolean }> {
		return this.channel.call('getModelInfo');
	}

	async rerank(query: string, docs: string[], allowDownload?: boolean): Promise<number[]> {
		return this.channel.call('rerank', { query, docs, allowDownload });
	}

	async getRerankInfo(): Promise<{ isReady: boolean; modelPresent: boolean }> {
		return this.channel.call('getRerankInfo');
	}
}

registerSingleton(ISemanticEmbedService, SemanticEmbedService, InstantiationType.Delayed);
