/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AcpLaunchError, AcpProcess, BoundedLineBuffer } from '../../../node/acp/acpProcess.js';

const logService = new NullLogService();

function spawnNode(script: string, extra: Partial<Parameters<typeof AcpProcess.spawn>[0]> = {}): Promise<AcpProcess> {
	return AcpProcess.spawn({ command: process.execPath, args: ['-e', script], cwd: tmpdir(), env: process.env, ...extra }, logService);
}

suite('ACP process – bounded stderr buffer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps at most N lines and drops the oldest first', () => {
		const buffer = new BoundedLineBuffer(10_000, 3);
		buffer.append('a\nb\nc\nd\n');
		assert.strictEqual(buffer.lineCount, 3);
		assert.strictEqual(buffer.toString(), 'b\nc\nd');
	});

	test('keeps at most N bytes across lines', () => {
		const buffer = new BoundedLineBuffer(12, 100);
		buffer.append('12345\n12345\n12345\n');
		assert.ok(buffer.byteCount <= 12, `byteCount ${buffer.byteCount}`);
		assert.strictEqual(buffer.toString(), '12345\n12345');
	});

	test('a single oversized line keeps only its tail', () => {
		const buffer = new BoundedLineBuffer(8, 100);
		buffer.append('x'.repeat(50) + 'TAIL\n');
		assert.strictEqual(buffer.toString(), 'xxxxTAIL');
		buffer.append('y'.repeat(30));
		assert.strictEqual(buffer.toString().length <= 8 + 1 + 8, true);
	});

	test('partial lines are joined across chunks', () => {
		const buffer = new BoundedLineBuffer(1000, 10);
		buffer.append('hel');
		buffer.append('lo\nwor');
		assert.strictEqual(buffer.toString(), 'hello\nwor');
		buffer.append('ld\n');
		assert.strictEqual(buffer.toString(), 'hello\nworld');
	});
});

suite('ACP process – supervisor', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('a missing command is reported as not-found, not as an exit', async () => {
		await assert.rejects(
			AcpProcess.spawn({ command: 'acp-test-command-that-does-not-exist-9f3a', args: [], cwd: tmpdir(), env: process.env }, logService),
			(err: unknown) => err instanceof AcpLaunchError && err.kind === 'not-found' && err.command === 'acp-test-command-that-does-not-exist-9f3a',
		);
	});

	test('stderr is captured with byte and line caps and the newest lines survive', async () => {
		const proc = disposables.add(await spawnNode(`for (let i = 0; i < 500; i++) { console.error('line' + i + ' ' + 'x'.repeat(50)); }`, { stderrMaxBytes: 2048, stderrMaxLines: 20 }));
		const exit = await proc.whenExited();
		assert.strictEqual(exit.code, 0);
		const tail = proc.stderrTail;
		const lines = tail.split('\n');
		assert.ok(lines.length <= 20, `kept ${lines.length} lines`);
		assert.ok(Buffer.byteLength(tail) <= 2048 + 64, `kept ${Buffer.byteLength(tail)} bytes`);
		assert.ok(lines[lines.length - 1].startsWith('line499'), `last line was ${lines[lines.length - 1]}`);
		assert.ok(!tail.includes('line0 '), 'oldest line should have been dropped');
	});

	test('terminate() on a cooperative process reports a signal, never exit code 0', async () => {
		const proc = disposables.add(await spawnNode(`setInterval(() => {}, 1000);`));
		assert.ok(proc.pid !== undefined);
		assert.strictEqual(proc.exited, false);
		const exit = await proc.terminate(2000);
		assert.strictEqual(proc.exited, true);
		assert.strictEqual(exit.code, null);
		assert.strictEqual(exit.signal, 'SIGTERM');
	});

	test('terminate() force-kills a process that ignores SIGTERM', async () => {
		const proc = disposables.add(await spawnNode(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');`));
		// Wait until the script has installed its handler; SIGTERM before that would still kill it.
		await new Promise<void>(resolve => proc.stdout.once('data', () => resolve()));
		let fired = 0;
		disposables.add(proc.onDidExit(() => fired++));
		const exit = await proc.terminate(300);
		assert.strictEqual(exit.code, null);
		assert.strictEqual(exit.signal, 'SIGKILL');
		assert.strictEqual(fired, 1);
		assert.deepStrictEqual(proc.exitInfo, exit);
	});

	test('terminate() after exit returns the recorded exit', async () => {
		const proc = disposables.add(await spawnNode(`process.exit(3);`));
		const first = await proc.whenExited();
		assert.strictEqual(first.code, 3);
		assert.deepStrictEqual(await proc.terminate(), first);
	});

	test('stdout is a readable pipe and stdin a writable pipe', async () => {
		const proc = disposables.add(await spawnNode(`process.stdin.on('data', d => { process.stdout.write('echo:' + d); process.exit(0); });`));
		const chunks: Buffer[] = [];
		proc.stdout.on('data', (c: Buffer) => chunks.push(c));
		proc.stdin.write('ping\n');
		await proc.whenExited();
		assert.strictEqual(Buffer.concat(chunks).toString(), 'echo:ping\n');
	});
});
