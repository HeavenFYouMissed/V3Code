/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mergeFederatedIndexHits, verifiedCloudContent, verifiedCloudSpan } from '../../common/cloudIndex/federatedIndex.js';
import { contentHash, contentHash64 } from '../../common/semanticIndex/hashing.js';
import { Hit } from '../../common/semanticIndex/semanticIndexTypes.js';

function hit(id: string, content: string, weak = false): Hit {
	return {
		chunk: { id, file: `${id}.ts`, startLine: 1, endLine: 2, kind: 'function', name: id, language: 'typescript', contentHash: id },
		content,
		score: 1,
		signals: weak ? { weak: 1 } : {},
	};
}

suite('federated cloud index', () => {
	test('verifies current and legacy cloud content hashes', () => {
		const content = 'export function charge() {\n\treturn true;\n}';
		assert.strictEqual(verifiedCloudContent(contentHash64(content), ['stale', content]), content);
		assert.strictEqual(verifiedCloudContent(contentHash(content), [content]), content);
		assert.strictEqual(verifiedCloudContent(contentHash64(content), ['stale']), undefined);
		assert.strictEqual(verifiedCloudContent('not-a-cas-key', [content]), undefined);
	});

	test('returns the exact CRLF representation named by the cloud CAS key', () => {
		const raw = 'if (ready) {\r\n\treturn run();\r\n}';
		const normalized = raw.replace(/\r\n/g, '\n');
		assert.strictEqual(verifiedCloudSpan(contentHash64(raw), raw, 1, 3), raw);
		assert.strictEqual(verifiedCloudSpan(contentHash64(normalized), raw, 1, 3), normalized);
	});

	test('drops stale and invalid working-tree pointers', () => {
		const snapshot = 'function oldName() {\n\treturn 1;\n}';
		const current = 'function newName() {\n\treturn 2;\n}';
		const casKey = contentHash64(snapshot);
		assert.strictEqual(verifiedCloudSpan(casKey, current, 1, 3), undefined);
		assert.strictEqual(verifiedCloudSpan(casKey, snapshot, 0, 3), undefined);
		assert.strictEqual(verifiedCloudSpan(casKey, snapshot, 1, 4), undefined);
	});

	test('consensus outranks either independent channel', () => {
		const merged = mergeFederatedIndexHits([hit('local', 'local'), hit('shared', 'fresh')], [hit('cloud', 'cloud'), hit('shared', 'old')], 5);
		assert.strictEqual(merged[0].chunk.id, 'shared');
		assert.strictEqual(merged[0].content, 'fresh');
		assert.strictEqual(merged[0].signals.local, 1);
		assert.strictEqual(merged[0].signals.cloud, 1);
	});

	test('keeps local content when a shared snapshot is stale', () => {
		const merged = mergeFederatedIndexHits([hit('same', 'unsaved edit')], [hit('same', 'old snapshot')], 5);
		assert.strictEqual(merged[0].content, 'unsaved edit');
	});

	test('keeps weak results in a contiguous tail and obeys topK', () => {
		const merged = mergeFederatedIndexHits([hit('weak-local', 'x', true)], [hit('strong-cloud', 'y')], 1);
		assert.deepStrictEqual(merged.map(item => item.chunk.id), ['strong-cloud']);
	});
});
