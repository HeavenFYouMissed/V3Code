/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Buffer } from 'node:buffer';
import { decodeFloat16, parseStaticModelTensors } from '../../common/semanticIndex/staticEmbedder.js';
import { POTION_CODE_V1_REPO, POTION_CODE_V2_REPO, STATIC_CODE_REPO, isStaticCodeModel, rawEmbedModelId, staticCodeRepoForIdentity } from '../../common/semanticIndex/staticEmbedModels.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

interface TensorFixture {
	dtype: string;
	shape: number[];
	data: Buffer;
}

function safetensors(tensors: Record<string, TensorFixture>): Buffer {
	let offset = 0;
	const header: Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }> = {};
	const payloads: Buffer[] = [];
	for (const [name, tensor] of Object.entries(tensors)) {
		header[name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [offset, offset + tensor.data.byteLength] };
		offset += tensor.data.byteLength;
		payloads.push(tensor.data);
	}
	const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
	const prefix = Buffer.alloc(8);
	prefix.writeBigUInt64LE(BigInt(headerBytes.byteLength));
	return Buffer.concat([prefix, headerBytes, ...payloads]);
}

suite('static Potion embedder model compatibility', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes IEEE float16 values used by Potion v2', () => {
		assert.strictEqual(decodeFloat16(0x3c00), 1);
		assert.strictEqual(decodeFloat16(0xc000), -2);
		assert.strictEqual(decodeFloat16(0x3800), 0.5);
		assert.ok(Math.abs(decodeFloat16(0x0001) - 5.960464477539063e-8) < 1e-15);
		assert.strictEqual(decodeFloat16(0x7c00), Infinity);
		assert.ok(Number.isNaN(decodeFloat16(0x7e00)));
	});

	test('parses the v2 F16 embeddings-only layout into Float32', () => {
		const f16 = Buffer.alloc(8);
		[0x3c00, 0xc000, 0x3800, 0x0000].forEach((value, i) => f16.writeUInt16LE(value, i * 2));
		const parsed = parseStaticModelTensors(safetensors({
			embeddings: { dtype: 'F16', shape: [2, 2], data: f16 },
		}));
		assert.strictEqual(parsed.mapping, null);
		assert.strictEqual(parsed.weights, null);
		assert.strictEqual(parsed.rows, 2);
		assert.strictEqual(parsed.dim, 2);
		assert.deepStrictEqual(Array.from(parsed.embeddings), [1, -2, 0.5, 0]);
	});

	test('continues to parse the v1 mapping, weights, and F32 layout', () => {
		const mapping = Buffer.alloc(16);
		mapping.writeBigInt64LE(1n, 0);
		mapping.writeBigInt64LE(0n, 8);
		const weights = Buffer.alloc(16);
		weights.writeDoubleLE(0.25, 0);
		weights.writeDoubleLE(2, 8);
		const embeddings = Buffer.alloc(16);
		[1, 2, 3, 4].forEach((value, i) => embeddings.writeFloatLE(value, i * 4));
		const parsed = parseStaticModelTensors(safetensors({
			mapping: { dtype: 'I64', shape: [2], data: mapping },
			weights: { dtype: 'F64', shape: [2], data: weights },
			embeddings: { dtype: 'F32', shape: [2, 2], data: embeddings },
		}));
		assert.deepStrictEqual(Array.from(parsed.mapping!), [1, 0]);
		assert.deepStrictEqual(Array.from(parsed.weights!), [0.25, 2]);
		assert.deepStrictEqual(Array.from(parsed.embeddings), [1, 2, 3, 4]);
	});

	test('routes salted v1 and v2 identities to their exact vector spaces', () => {
		assert.strictEqual(STATIC_CODE_REPO, POTION_CODE_V1_REPO);
		assert.strictEqual(rawEmbedModelId(`${POTION_CODE_V1_REPO}+hdr2`), POTION_CODE_V1_REPO);
		assert.strictEqual(rawEmbedModelId(`${POTION_CODE_V2_REPO}+hdr2`), POTION_CODE_V2_REPO);
		assert.strictEqual(staticCodeRepoForIdentity(`${POTION_CODE_V1_REPO}+hdr2`), POTION_CODE_V1_REPO);
		assert.strictEqual(staticCodeRepoForIdentity(`${POTION_CODE_V2_REPO}+hdr2`), POTION_CODE_V2_REPO);
		assert.strictEqual(staticCodeRepoForIdentity('Qwen/Qwen3-Embedding-0.6B+hdr2'), undefined);
		assert.strictEqual(isStaticCodeModel(POTION_CODE_V1_REPO), true);
		assert.strictEqual(isStaticCodeModel(POTION_CODE_V2_REPO), true);
	});

	test('rejects unsupported embedding dtypes instead of misreading bytes', () => {
		assert.throws(() => parseStaticModelTensors(safetensors({
			embeddings: { dtype: 'BF16', shape: [1, 1], data: Buffer.alloc(2) },
		})), /unsupported embeddings dtype BF16/);
	});
});
