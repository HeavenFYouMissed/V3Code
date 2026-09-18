/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/vs/workbench/contrib/void/common/semanticIndex/embedder.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('embedder.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(ts.isClassDeclaration).getText(ast).replace('export class', 'class');
const compiled = ts.transpileModule(`${declaration}\nEmbedder;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ potionFails = false, qwenFails = false } = {}) {
	const calls = [];
	class StaticEmbedder {
		isReady = false;
		dim = 256;
		async init() { calls.push('potion'); if (potionFails) { throw new Error('unavailable'); } this.isReady = true; }
	}
	class LlamaEmbedder {
		isReady = false;
		dim = 1024;
		modelId = 'qwen';
		async init() { calls.push('qwen'); if (qwenFails) { throw new Error('unavailable'); } this.isReady = true; }
	}
	const Embedder = vm.runInNewContext(compiled, {
		StaticEmbedder, LlamaEmbedder, STATIC_CODE_REPO: 'potion',
		qwen3RamOk: () => true, qwen3EmbedModelPresent: () => false,
		homedir: () => '/unused', join: (...parts) => parts.join('/'), mkdir: async () => {},
		console: { log() {}, warn() {} }
	});
	return { Embedder, calls };
}

for (const hint of [undefined, 'minilm', 'jina-code', 'unknown', 'potion-code']) {
	test(`model hint ${hint} resolves safely to Potion`, async () => {
		const { Embedder, calls } = fixture();
		const model = new Embedder({ modelHint: hint });
		await model.init();
		assert.deepEqual(calls, ['potion']);
		assert.equal(model.modelId, 'potion');
	});
}
test('explicit Qwen remains supported', async () => {
	const { Embedder, calls } = fixture();
	const model = new Embedder({ modelHint: 'qwen3-embed' });
	await model.init();
	assert.deepEqual(calls, ['qwen']);
	assert.equal(model.modelId, 'qwen');
});
test('Qwen failure falls back to Potion', async () => {
	const { Embedder, calls } = fixture({ qwenFails: true });
	const model = new Embedder({ modelHint: 'qwen3-embed' });
	await model.init();
	assert.deepEqual(calls, ['qwen', 'potion']);
	assert.equal(model.isReady, true);
});
test('all model failures reject for lexical fallback without importing a retired backend', async () => {
	const { Embedder, calls } = fixture({ qwenFails: true, potionFails: true });
	const model = new Embedder({ modelHint: 'qwen3-embed' });
	await assert.rejects(model.init(), /lexical-only/);
	assert.equal(model.isReady, false);
	assert.deepEqual(calls, ['qwen', 'potion']);
	assert.ok(!source.includes('@xenova/transformers'));
});
