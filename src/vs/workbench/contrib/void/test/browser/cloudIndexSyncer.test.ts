/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CloudSyncHost, CloudIndexSyncer, cloudContributionBlock, cloudSyncFiles, computeCloudManifestRoot, isCloudVectorCompatible } from '../../browser/semanticIndex/cloudIndexSyncer.js';
import { CloudWireChunk } from '../../common/cloudIndex/cloudIndexProtocol.js';

suite('cloud index / sync repair', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('manifest roots are deterministic and content sensitive', async () => {
		const first = await computeCloudManifestRoot({ 'src/b.ts': 'b', 'src/a.ts': 'a' });
		const reordered = await computeCloudManifestRoot({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
		const changed = await computeCloudManifestRoot({ 'src/a.ts': 'a2', 'src/b.ts': 'b' });
		assert.strictEqual(first, '637803dbf29d628752978d96a3379a3e1a643cf2450d0fa0f1ceba10e4c8c8af');
		assert.strictEqual(first, reordered);
		assert.notStrictEqual(first, changed);
	});

	test('vectors-only manifests track Qwen backfill coverage', () => {
		const snapshot = {
			files: { 'src/app.ts': 'file-hash-1' },
			chunksForFile: () => [],
			vectorCountForFile: () => 3,
		};
		assert.strictEqual(isCloudVectorCompatible('Qwen/Qwen3-Embedding-0.6B-GGUF@Q8_0+hdr2'), true);
		assert.deepStrictEqual(cloudSyncFiles(snapshot, 'vectors-only', 'Qwen/Qwen3-Embedding-0.6B-GGUF@Q8_0+hdr2'), {
			'src/app.ts': 'file-hash-1:v3q8:3',
		});
		assert.deepStrictEqual(cloudSyncFiles(snapshot, 'vectors-only', 'potion-base-8M+hdr2'), {
			'src/app.ts': 'file-hash-1:v3q8:0',
		});
		assert.deepStrictEqual(cloudSyncFiles(snapshot, 'ephemeral', 'potion-base-8M+hdr2'), {
			'src/app.ts': 'file-hash-1',
		});
	});

	test('potion vectors-only contribution fails closed before any cloud request', async () => {
		let snapshotReads = 0;
		const requests: string[] = [];
		const host: CloudSyncHost = {
			endpoint: 'https://index.invalid', token: 'test-token', workspaceId: 'repo-potion', privacyMode: 'vectors-only',
			getSnapshot: () => { snapshotReads++; return { files: { 'src/app.ts': 'source-hash' }, chunksForFile: () => [] }; },
			getRecentEditRanks: () => ({}),
			getEmbedIdentity: () => 'minishlab/potion-code-16M+hdr2',
			log: () => undefined,
			postJson: async path => { requests.push(path); return {}; },
		};

		assert.strictEqual(cloudContributionBlock('full', 'minishlab/potion-code-16M+hdr2'), undefined);
		const result = await new CloudIndexSyncer(host).syncNow();
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.failureCode, 'incompatible-vector-space');
		assert.match(result.error ?? '', /Local search and shared cloud retrieval still work/);
		assert.strictEqual(snapshotReads, 0);
		assert.deepStrictEqual(requests, []);
	});

	test('full mode lets a potion client send source for server-side embedding', async () => {
		const chunk: CloudWireChunk = {
			id: 'chunk-full', casKey: 'cas-full', file: 'src/app.ts', startLine: 1, endLine: 2,
			kind: 'function', name: 'run', language: 'typescript', scored: true,
			content: 'export function run() { return true; }', tokens: ['export', 'function', 'run'],
			vectorQ8: 'AQ==', vectorScale: 0.1, vectorSpace: 'qwen3-embedding-0.6b+hdr2',
		};
		const requests: Array<{ path: string; body: any }> = [];
		const host: CloudSyncHost = {
			endpoint: 'https://index.invalid', token: 'test-token', workspaceId: 'repo-full', privacyMode: 'full',
			getSnapshot: () => ({ files: { 'src/app.ts': 'source-hash' }, chunksForFile: () => [chunk] }),
			getRecentEditRanks: () => ({}),
			getEmbedIdentity: () => 'minishlab/potion-code-16M+hdr2',
			log: () => undefined,
			postJson: async (path, body) => {
				requests.push({ path, body });
				if (path === '/sync/begin') return { syncId: 'sync-full', changedFiles: ['src/app.ts'], removedFiles: [] };
				if (path === '/chunks/check') return { known: [] };
				return {};
			},
		};

		const result = await new CloudIndexSyncer(host).syncNow();
		assert.strictEqual(result.ok, true);
		const upload = requests.find(request => request.path === '/chunks' && request.body.chunks.length > 0)!.body;
		assert.strictEqual(upload.chunks[0].content, chunk.content);
		assert.strictEqual(upload.chunks[0].vectorQ8, undefined);
		assert.strictEqual(upload.chunks[0].vectorScale, undefined);
	});

	test('server changedFiles always triggers upload and complete reconciliation', async () => {
		const chunk: CloudWireChunk = {
			id: 'chunk-1', casKey: 'cas-1', file: 'src/app.ts', startLine: 1, endLine: 3,
			kind: 'function', name: 'run', language: 'typescript', scored: true,
			content: 'export function run() {}', tokens: ['export', 'function', 'run'],
		};
		const requests: Array<{ path: string; body: unknown }> = [];
		const host: CloudSyncHost = {
			endpoint: 'https://index.invalid',
			token: 'test-token',
			workspaceId: 'repo-1',
			privacyMode: 'full',
			getSnapshot: () => ({
				files: { 'src/app.ts': 'file-hash-1' },
				chunksForFile: file => file === 'src/app.ts' ? [chunk] : [],
			}),
			getRecentEditRanks: () => ({}),
			getEmbedIdentity: () => 'test-space',
			log: () => undefined,
			postJson: async (path, body) => {
				requests.push({ path, body });
				if (path === '/sync/begin') {
					return { syncId: 'sync-1', changedFiles: ['src/app.ts'], removedFiles: [] };
				}
				if (path === '/chunks/check') {
					return { known: [] };
				}
				return {};
			},
		};

		const result = await new CloudIndexSyncer(host).syncNow();

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.changedFiles, 1);
		assert.strictEqual(result.uploadedChunks, 1);
		const beginRequest = requests.find(request => request.path === '/sync/begin')?.body as { manifestRoot?: string };
		assert.match(beginRequest.manifestRoot ?? '', /^[a-f0-9]{64}$/);
		const uploads = requests.filter(request => request.path === '/chunks');
		assert.strictEqual(uploads.length, 2, 'one data batch plus one finalization request');
		const data = uploads[0].body as { chunks: CloudWireChunk[]; fileChunkIds: Record<string, string[]>; done: boolean };
		assert.deepStrictEqual(data.chunks.map(item => item.id), ['chunk-1']);
		assert.deepStrictEqual(data.fileChunkIds, { 'src/app.ts': ['chunk-1'] });
		assert.strictEqual(data.done, false);
		const done = uploads[1].body as { fileHashes: Record<string, string>; done: boolean };
		assert.deepStrictEqual(done.fileHashes, { 'src/app.ts': 'file-hash-1' });
		assert.strictEqual(done.done, true);
	});

	test('vectors-only upload strips source and carries compatible local Qwen vectors', async () => {
		const chunk: CloudWireChunk = {
			id: 'chunk-q8', casKey: 'cas-q8', file: 'src/private.ts', startLine: 1, endLine: 4,
			kind: 'function', name: 'privateFlow', language: 'typescript', scored: true,
			content: 'export function privateFlow() { return secret; }', tokens: ['private', 'flow', 'secret'],
			vectorQ8: 'AQ==', vectorScale: 0.1, vectorSpace: 'qwen3-embedding-0.6b+hdr2',
		};
		const requests: Array<{ path: string; body: any }> = [];
		const host: CloudSyncHost = {
			endpoint: 'https://index.invalid', token: 'test-token', workspaceId: 'repo-q8', privacyMode: 'vectors-only',
			getSnapshot: () => ({
				files: { 'src/private.ts': 'source-hash' },
				chunksForFile: () => [chunk],
				vectorCountForFile: () => 1,
			}),
			getRecentEditRanks: () => ({}),
			getEmbedIdentity: () => 'Qwen/Qwen3-Embedding-0.6B-GGUF@Q8_0+hdr2',
			log: () => undefined,
			postJson: async (path, body) => {
				requests.push({ path, body });
				if (path === '/sync/begin') return { syncId: 'sync-q8', changedFiles: ['src/private.ts'], removedFiles: [] };
				if (path === '/chunks/check') return { known: [] };
				return {};
			},
		};

		const result = await new CloudIndexSyncer(host).syncNow();
		assert.strictEqual(result.ok, true);
		const begin = requests.find(request => request.path === '/sync/begin')!.body;
		assert.deepStrictEqual(begin.files, { 'src/private.ts': 'source-hash:v3q8:1' });
		const upload = requests.find(request => request.path === '/chunks' && request.body.chunks.length > 0)!.body;
		assert.strictEqual(upload.chunks[0].content, undefined);
		assert.deepStrictEqual(upload.chunks[0].tokens, ['private', 'flow', 'secret']);
		assert.strictEqual(upload.chunks[0].vectorQ8, 'AQ==');
		assert.deepStrictEqual(upload.fileHashes, { 'src/private.ts': 'source-hash:v3q8:1' });
	});

	test('ephemeral upload carries source for cloud embedding but strips local vectors', async () => {
		const chunk: CloudWireChunk = {
			id: 'chunk-voyage', casKey: 'cas-voyage', file: 'src/search.ts', startLine: 1, endLine: 4,
			kind: 'function', name: 'rankCode', language: 'typescript', scored: true,
			content: 'export function rankCode() { return rerank(); }', tokens: ['rank', 'code', 'rerank'],
			vectorQ8: 'AQ==', vectorScale: 0.1, vectorSpace: 'qwen3-embedding-0.6b+hdr2',
		};
		const requests: Array<{ path: string; body: any }> = [];
		const host: CloudSyncHost = {
			endpoint: 'https://index.invalid', token: 'test-token', workspaceId: 'repo-voyage', privacyMode: 'ephemeral',
			getSnapshot: () => ({ files: { 'src/search.ts': 'source-hash' }, chunksForFile: () => [chunk] }),
			getRecentEditRanks: () => ({}),
			getEmbedIdentity: () => 'potion-base-8M+hdr2',
			log: () => undefined,
			postJson: async (path, body) => {
				requests.push({ path, body });
				if (path === '/sync/begin') return { syncId: 'sync-voyage', changedFiles: ['src/search.ts'], removedFiles: [] };
				if (path === '/chunks/check') return { known: [] };
				return {};
			},
		};

		const result = await new CloudIndexSyncer(host).syncNow();
		assert.strictEqual(result.ok, true);
		const check = requests.find(request => request.path === '/chunks/check')!.body;
		assert.strictEqual(check.have[0].wantsVector, true);
		const upload = requests.find(request => request.path === '/chunks' && request.body.chunks.length > 0)!.body;
		assert.strictEqual(upload.chunks[0].content, chunk.content);
		assert.strictEqual(upload.chunks[0].vectorQ8, undefined);
		assert.strictEqual(upload.chunks[0].vectorScale, undefined);
		assert.deepStrictEqual(upload.fileHashes, { 'src/search.ts': 'source-hash' });
	});
});
