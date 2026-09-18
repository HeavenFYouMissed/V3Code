/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CasEntry, CasStore } from '../../browser/semanticIndex/casStore.js';

/** Minimal IndexedDB stand-in: a real Map behind the same request/transaction
 *  shape CasStore drives, so the store's own key derivation runs unmodified.
 *  Only the storage engine is substituted — never the logic under test. */
function fakeDatabase() {
	const data = new Map<string, unknown>();
	const keysRead: string[] = [];
	const keysWritten: string[] = [];

	const request = <T>(run: () => T) => {
		const req: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
		queueMicrotask(() => { req.result = run(); req.onsuccess?.(); });
		return req;
	};

	const db = {
		transaction() {
			const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
				objectStore: () => ({
					get: (key: string) => request(() => { keysRead.push(key); return data.get(key); }),
					put: (value: unknown, key: string) => request(() => { keysWritten.push(key); data.set(key, value); return undefined; }),
				}),
			};
			queueMicrotask(() => tx.oncomplete?.());
			return tx;
		},
		close() { /* no cached-connection teardown needed for a fake */ },
	};

	return { db, data, keysRead, keysWritten };
}

function entry(name: string): CasEntry {
	return {
		chunks: [{
			startLine: 1, endLine: 4, kind: 'function', name,
			language: 'typescript', contentHash: 'hash-abc', scored: true,
		}],
		modelId: 'test-embedder',
		dim: 8,
	};
}

suite('semanticIndex / CAS reuse across a path re-key', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('entries are addressed by content hash alone, never by path or root alias', async () => {
		const fake = fakeDatabase();
		const cas = new CasStore(async () => fake.db as unknown as IDBDatabase, 'store', 3);

		await cas.putEntries([['hash-abc', entry('doWork')]], 1000);

		// Every persisted key must carry the content hash and no path segment:
		// this is what lets a v1 -> v2 alias change re-key without re-embedding.
		assert.ok(fake.keysWritten.length > 0);
		for (const key of fake.keysWritten) {
			assert.ok(key.includes('hash-abc'), `key should be content-addressed: ${key}`);
			assert.ok(!key.includes('@roots'), `key must not embed a root alias: ${key}`);
			assert.ok(!key.includes('src/'), `key must not embed a path: ${key}`);
		}

		const hit = await cas.get('hash-abc');
		assert.ok(hit, 'a stored entry must be retrievable by content hash');
		assert.strictEqual(hit!.chunks[0].name, 'doWork');
		assert.strictEqual(hit!.modelId, 'test-embedder');

		cas.dispose();
	});

	test('a file that moves from a v1 key to a v2 key still hits the same cache entry', async () => {
		const fake = fakeDatabase();
		const cas = new CasStore(async () => fake.db as unknown as IDBDatabase, 'store', 3);

		// Indexed once while the file was keyed '@roots/2-api/src/index.ts' (v1)...
		await cas.putEntries([['content-hash-1', entry('handler')]], 1000);
		const beforeKeys = [...fake.keysWritten];

		// ...and looked up after the v2 re-key moved it to '@roots/api-1a2b3c4d/src/index.ts'.
		// The lookup takes only the content hash, so the alias change is irrelevant.
		const afterRekey = await cas.get('content-hash-1');
		assert.ok(afterRekey, 'the re-keyed path must still hit the cached chunks + vectors');
		assert.strictEqual(afterRekey!.chunks.length, 1);
		assert.strictEqual(afterRekey!.modelId, 'test-embedder', 'vectors survive the re-key');

		// No new entry was written: the transition costs a re-walk, not a re-embed.
		assert.deepStrictEqual(fake.keysWritten, beforeKeys);

		cas.dispose();
	});

	test('branch tags are namespaced by workspace key, so a folder-set edit cannot evict another set', async () => {
		const fake = fakeDatabase();
		const cas = new CasStore(async () => fake.db as unknown as IDBDatabase, 'store', 3);

		await cas.writeBranchTag('ws-app-api', 'main', ['hash-a', 'hash-b'], 1000);
		await cas.writeBranchTag('ws-app-only', 'main', ['hash-a'], 1000);

		const tagKeys = fake.keysWritten.filter(key => key.startsWith('t::'));
		assert.strictEqual(tagKeys.length, 2);
		assert.notStrictEqual(tagKeys[0], tagKeys[1], 'distinct folder sets must not share a tag key');

		cas.dispose();
	});
});
