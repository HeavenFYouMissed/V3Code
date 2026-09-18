/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// V3Code: execute the real scheduler with deterministic delay and eager-idle clocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/vs/workbench/contrib/void/browser/memoryIndexScheduler.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('scheduler.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(ts.isClassDeclaration).getText(ast).replace('export class', 'class');
const compiled = ts.transpileModule(`${declaration}\nMemoryIndexScheduler;`, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

function fixture({ fail = false, workspace = true } = {}) {
	let now = 0;
	const timers = new Set();
	const idle = new Set();
	let calls = 0;
	class Disposable {
		items = [];
		_register(item) { this.items.push(item); return item; }
		dispose() { for (const item of this.items) { item.dispose(); } }
	}
	class MutableDisposable {
		set value(item) { this.current?.dispose(); this.current = item; }
		clear() { this.value = undefined; }
		dispose() { this.clear(); }
	}
	const Scheduler = vm.runInNewContext(compiled, {
		Disposable, MutableDisposable, IMemoryService() {},
		disposableTimeout(fn, delay) {
			const item = { fn, at: now + delay, dispose() { timers.delete(item); } };
			timers.add(item); return item;
		},
		runWhenGlobalIdle(fn) {
			const item = { fn, dispose() { idle.delete(item); } };
			idle.add(item); return item;
		}
	});
	const scheduler = new Scheduler({
		hasWorkspace: workspace,
		async backfillMemoryFacts() { calls++; if (fail) { throw new Error('offline'); } },
		async listMemorySessionIds() { return ['one']; },
		async rebuildArchivePages() {}, async drainMemoryIndex() {}
	});
	async function advance(ms) {
		now += ms;
		for (const item of [...timers]) { if (item.at <= now) { timers.delete(item); item.fn(); } }
		for (const item of [...idle]) { idle.delete(item); item.fn(); }
		for (let i = 0; i < 12; i++) { await Promise.resolve(); }
	}
	return { scheduler, advance, timers, idle, calls: () => calls, next: () => Math.min(...[...timers].map(t => t.at - now)) };
}

test('idle availability never bypasses initial or recurring minimum delay', async () => {
	const f = fixture();
	await f.advance(4_999); assert.equal(f.calls(), 0);
	await f.advance(1); assert.equal(f.calls(), 1);
	for (let i = 0; i < 100; i++) { await f.advance(0); }
	assert.equal(f.calls(), 1);
	await f.advance(29_999); assert.equal(f.calls(), 1);
	await f.advance(1); assert.equal(f.calls(), 2);
});

test('failed slices wait for exponential backoff', async () => {
	const f = fixture({ fail: true });
	await f.advance(5_000); assert.equal(f.next(), 10_000);
	await f.advance(10_000); assert.equal(f.next(), 20_000);
	assert.equal(f.calls(), 2);
});

test('ten minutes of idle time remains bounded to twenty slices', async () => {
	const f = fixture();
	for (let second = 0; second < 600; second++) { await f.advance(1_000); }
	assert.equal(f.calls(), 20);
	f.scheduler.dispose();
	await f.advance(60_000);
	assert.equal(f.calls(), 20);
});

test('missing workspace waits and disposal cancels scheduled work', async () => {
	const f = fixture({ workspace: false });
	await f.advance(5_000); assert.equal(f.next(), 30_000);
	f.scheduler.dispose(); await f.advance(60_000);
	assert.equal(f.calls(), 0); assert.equal(f.timers.size, 0); assert.equal(f.idle.size, 0);
});
