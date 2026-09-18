/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Static (Model2Vec) code-embedding backend - runs in the Node main process.
 *
 * Why: a transformer like MiniLM does a full attention forward-pass per chunk and
 * caps at ~50-100 chunks/sec on CPU. A Model2Vec static model embeds by
 * *tokenize -> weighted-mean of precomputed token vectors* - no attention, no
 * forward pass - hitting 20,000-30,000 chunks/sec on the same CPU (~200-500x).
 * The Potion Code v1 and v2 models are code-specialized and both outperform a
 * general-purpose MiniLM for this low-cost local path. V1 remains the release
 * default until V2 beats the full-corpus V3Code retrieval gate.
 *
 * Inference (verified against model2vec/model.py StaticModel._encode_batch):
 *   ids   = tokenizer(text, add_special_tokens=false)   // drop unk tokens
 *   for t in ids: row = mapping[t]; v += embeddings[row] * weights[t]
 *   out   = mean_over_tokens(v); if normalize: out /= (norm(out) + 1e-32)
 *
 * Assets (HuggingFace, cached under ~/.v3code/models):
 *   v1 model.safetensors -> { mapping: i64[V], weights: f64[V], embeddings: f32[V,D] }
 *   v2 model.safetensors -> { embeddings: f16[V,D] }
 *   tokenizer.json    -> loaded via @xenova/transformers AutoTokenizer
 *   config.json       -> { normalize, ... }
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { promises as fs, existsSync, createWriteStream, unlinkSync } from 'node:fs';
import * as https from 'node:https';
import { STATIC_CODE_REPO } from './staticEmbedModels.js';

const HF_BASE = 'https://huggingface.co';
const DEFAULT_REPO = STATIC_CODE_REPO;
/** model2vec truncates very long inputs to this many tokens. */
const MAX_TOKENS = 512;

interface SafetensorEntry {
	dtype: string;
	shape: number[];
	data_offsets: [number, number];
}

export interface StaticModelTensors {
	mapping: Int32Array | null;
	weights: Float64Array | null;
	embeddings: Float32Array;
	rows: number;
	dim: number;
}

/** IEEE-754 binary16 -> JavaScript number. Exported for a small deterministic
 * regression test: Potion v2 stores its table as F16 while v1 used F32. */
export function decodeFloat16(bits: number): number {
	const sign = (bits & 0x8000) !== 0 ? -1 : 1;
	const exponent = (bits >>> 10) & 0x1f;
	const fraction = bits & 0x03ff;
	if (exponent === 0) {
		if (fraction === 0) return sign < 0 ? -0 : 0;
		return sign * Math.pow(2, -14) * (fraction / 1024);
	}
	if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
	return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function tensorBounds(buf: Buffer, dataStart: number, entry: SafetensorEntry, bytesPerElement: number, name: string): { offset: number; elements: number } {
	const elements = entry.shape.reduce((n, value) => n * value, 1);
	const offset = dataStart + entry.data_offsets[0];
	const end = dataStart + entry.data_offsets[1];
	if (!Number.isSafeInteger(elements) || elements < 0 || offset < dataStart || end < offset || end > buf.byteLength || end - offset !== elements * bytesPerElement) {
		throw new Error(`safetensors: invalid ${name} tensor bounds`);
	}
	return { offset, elements };
}

/** Parse both released Potion layouts. Keeping this pure makes the model-format
 * contract testable without downloading a 30-60MB model in the test suite. */
export function parseStaticModelTensors(buf: Buffer): StaticModelTensors {
	if (buf.byteLength < 8) throw new Error('safetensors: truncated header');
	const headerLen = Number(buf.readBigUInt64LE(0));
	if (!Number.isSafeInteger(headerLen) || headerLen < 2 || 8 + headerLen > buf.byteLength) throw new Error('safetensors: invalid header length');
	const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen)) as Record<string, SafetensorEntry>;
	const dataStart = 8 + headerLen;
	const mappingEntry = header['mapping'];
	const weightsEntry = header['weights'];
	const embeddingsEntry = header['embeddings'];
	if (!embeddingsEntry) throw new Error('safetensors: missing "embeddings" tensor');
	if (embeddingsEntry.shape.length !== 2 || embeddingsEntry.shape[0] < 1 || embeddingsEntry.shape[1] < 1) throw new Error('safetensors: invalid embeddings shape');

	let mapping: Int32Array | null = null;
	if (mappingEntry) {
		if (mappingEntry.dtype !== 'I64' || mappingEntry.shape.length !== 1) throw new Error(`safetensors: unsupported mapping tensor (${mappingEntry.dtype})`);
		const { offset, elements } = tensorBounds(buf, dataStart, mappingEntry, 8, 'mapping');
		mapping = new Int32Array(elements);
		for (let i = 0; i < elements; i++) mapping[i] = Number(buf.readBigInt64LE(offset + i * 8));
	}

	let weights: Float64Array | null = null;
	if (weightsEntry) {
		if (weightsEntry.dtype !== 'F64' || weightsEntry.shape.length !== 1) throw new Error(`safetensors: unsupported weights tensor (${weightsEntry.dtype})`);
		const { offset, elements } = tensorBounds(buf, dataStart, weightsEntry, 8, 'weights');
		weights = new Float64Array(elements);
		for (let i = 0; i < elements; i++) weights[i] = buf.readDoubleLE(offset + i * 8);
	}

	const rows = embeddingsEntry.shape[0];
	const dim = embeddingsEntry.shape[1];
	let embeddings: Float32Array;
	if (embeddingsEntry.dtype === 'F32') {
		const { offset, elements } = tensorBounds(buf, dataStart, embeddingsEntry, 4, 'embeddings');
		const bytes = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + elements * 4);
		embeddings = new Float32Array(bytes);
	} else if (embeddingsEntry.dtype === 'F16') {
		const { offset, elements } = tensorBounds(buf, dataStart, embeddingsEntry, 2, 'embeddings');
		embeddings = new Float32Array(elements);
		for (let i = 0; i < elements; i++) embeddings[i] = decodeFloat16(buf.readUInt16LE(offset + i * 2));
	} else {
		throw new Error(`safetensors: unsupported embeddings dtype ${embeddingsEntry.dtype}`);
	}

	return { mapping, weights, embeddings, rows, dim };
}

function downloadFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const tmp = dest + '.partial';
		const file = createWriteStream(tmp);
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			try { file.close(); } catch { /* noop */ }
			try { unlinkSync(tmp); } catch { /* noop */ }
			reject(err);
		};
		const get = (u: string, redirects: number) => {
			// Wrap https.get: an invalid/relative redirect URL throws SYNCHRONOUSLY
			// inside this response callback, which would otherwise escape as an
			// uncaught main-process exception and hang the download forever.
			try {
				const req = https.get(u, { headers: { 'User-Agent': 'v3code-indexer' } }, res => {
					const status = res.statusCode ?? 0;
					if (status >= 300 && status < 400 && res.headers.location) {
						res.resume();
						if (redirects > 8) { fail(new Error('too many redirects')); return; }
						let next: string;
						try { next = new URL(res.headers.location, u).toString(); } // resolve relative redirects
						catch { fail(new Error(`bad redirect location: ${res.headers.location}`)); return; }
						get(next, redirects + 1);
						return;
					}
					if (status !== 200) { res.resume(); fail(new Error(`HTTP ${status} for ${u}`)); return; }
					res.pipe(file);
					file.on('finish', () => file.close(err => {
						if (err) { fail(err); return; }
						if (settled) return;
						settled = true;
						fs.rename(tmp, dest).then(() => resolve()).catch(reject);
					}));
				});
				req.on('error', fail);
			} catch (err: any) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		};
		get(url, 0);
	});
}

export class StaticEmbedder {
	private mapping: Int32Array | null = null;
	private weights: Float64Array | null = null;
	private embeddings: Float32Array | null = null;
	private embeddingRows = 0;
	private _dim = 0;
	private _normalize = true;
	private tokenizer: any = null;
	private unkTokenId: number | null = null;
	private initPromise: Promise<void> | null = null;

	constructor(
		private readonly repo: string = DEFAULT_REPO,
		private readonly cacheDir: string = join(homedir(), '.v3code', 'models'),
		private readonly loadTransformers: () => Promise<any> = () => import('@xenova/transformers' as any),
	) { }

	get isReady(): boolean { return this.embeddings !== null && this.tokenizer !== null; }
	get dim(): number { return this._dim; }
	get modelId(): string { return this.repo; }

	async init(): Promise<void> {
		if (this.isReady) return;
		if (!this.initPromise) this.initPromise = this.doInit();
		await this.initPromise;
	}

	private async doInit(): Promise<void> {
		const dir = join(this.cacheDir, this.repo.replace('/', '__'));
		await fs.mkdir(dir, { recursive: true });

		const stPath = join(dir, 'model.safetensors');
		if (!existsSync(stPath)) await downloadFile(`${HF_BASE}/${this.repo}/resolve/main/model.safetensors`, stPath);

		// Potion code models L2-normalize (config.normalize:true + a Normalize
		// module). Default true; honour a local config.json only if one exists.
		this._normalize = true;
		try {
			const cfg = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8'));
			this._normalize = cfg.normalize !== false;
		} catch { /* no local config - keep default */ }

		this.parseSafetensors(await fs.readFile(stPath));

		// Tokenizer: transformers.js v2 hard-requires tokenizer_config.json, which
		// this repo doesn't ship (it only has tokenizer.json). Stage tokenizer.json
		// + a synthetic tokenizer_config.json in the {base}/{org}/{model} layout
		// transformers.js expects, then load fully offline. (tokenizer.json alone
		// fully defines the tokenizer; the config just needs to exist.)
		const tkDir = join(this.cacheDir, ...this.repo.split('/'));
		await fs.mkdir(tkDir, { recursive: true });
		const tkJson = join(tkDir, 'tokenizer.json');
		const tkCfg = join(tkDir, 'tokenizer_config.json');
		if (!existsSync(tkJson)) await downloadFile(`${HF_BASE}/${this.repo}/resolve/main/tokenizer.json`, tkJson);
		if (!existsSync(tkCfg)) await fs.writeFile(tkCfg, JSON.stringify({ model_max_length: MAX_TOKENS, clean_up_tokenization_spaces: false }));

		const transformers = await this.loadTransformers();
		transformers.env.localModelPath = this.cacheDir;
		transformers.env.allowRemoteModels = false;
		this.tokenizer = await transformers.AutoTokenizer.from_pretrained(this.repo);
		const unk = (this.tokenizer as any).unk_token_id;
		this.unkTokenId = typeof unk === 'number' ? unk : null;
	}

	private parseSafetensors(buf: Buffer): void {
		const tensors = parseStaticModelTensors(buf);
		this.mapping = tensors.mapping;
		this.weights = tensors.weights;
		this.embeddings = tensors.embeddings;
		this.embeddingRows = tensors.rows;
		this._dim = tensors.dim;
	}

	/** Encode a batch of texts. Synchronous, allocation-light. */
	embed(texts: string[]): Float32Array[] {
		return texts.map(t => this.encodeOne(t));
	}

	private encodeOne(text: string): Float32Array {
		const dim = this._dim;
		const out = new Float32Array(dim);
		if (!this.embeddings || !this.tokenizer) return out;

		const enc = this.tokenizer(text, { add_special_tokens: false });
		const raw = enc?.input_ids?.data ?? enc?.input_ids;
		if (!raw) return out;

		const acc = new Float64Array(dim);
		let count = 0;
		const limit = Math.min(raw.length, MAX_TOKENS);
		for (let k = 0; k < limit; k++) {
			const id = Number(raw[k]);
			if (this.unkTokenId !== null && id === this.unkTokenId) continue;
			if (id < 0 || (this.mapping && id >= this.mapping.length) || (this.weights && id >= this.weights.length)) continue;
			const row = this.mapping ? this.mapping[id] : id;
			if (row < 0 || row >= this.embeddingRows) continue;
			const w = this.weights ? this.weights[id] : 1;
			const base = row * dim;
			for (let d = 0; d < dim; d++) acc[d] += this.embeddings[base + d] * w;
			count++;
		}
		if (count === 0) return out;

		if (this._normalize) {
			let norm = 0;
			for (let d = 0; d < dim; d++) { acc[d] /= count; norm += acc[d] * acc[d]; }
			norm = Math.sqrt(norm) + 1e-32;
			for (let d = 0; d < dim; d++) out[d] = acc[d] / norm;
		} else {
			for (let d = 0; d < dim; d++) out[d] = acc[d] / count;
		}
		return out;
	}

	dispose(): void {
		this.mapping = null;
		this.weights = null;
		this.embeddings = null;
		this.embeddingRows = 0;
		this.tokenizer = null;
		this.initPromise = null;
	}
}
