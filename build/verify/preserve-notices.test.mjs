import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedNotice, notices } from './preserve-notices.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const header = '/* Copyright 2026 Example.\n * Licensed under MIT.\n */';
test('ordinary implementation changes preserve notices', () => {
	assert.equal(changedNotice('a.ts', header + '\nconst a=1;', header + '\nconst a=2;'), false);
});
test('removal and ownership replacement are rejected', () => {
	assert.equal(changedNotice('a.ts', header, ''), true);
	assert.equal(changedNotice('a.ts', header, header.replace('Example', 'Someone Else')), true);
});
test('license prose is protected beyond keyword lines', () => {
	assert.equal(changedNotice('a.ts', header, header.replace('MIT', 'Apache-2.0')), true);
});
test('shell, line and HTML notices are recognized', () => {
	for (const text of ['#!/bin/sh\n# Copyright Example\n# Terms here\n', '// SPDX-License-Identifier: MIT\n// terms\n', '<!-- Copyright Example\nterms -->']) {
		assert.equal(notices('a', text).length, 1);
		assert.equal(changedNotice('a', text, ''), true);
	}
});
test('license and notice files are protected in entirety', () => {
	for (const file of ['LICENSE', 'LICENSE.txt', 'NOTICE.md', 'x/COPYING']) {
		assert.equal(changedNotice(file, 'terms', 'changed'), true);
	}
});
test('new preceding comments do not erase notices', () => {
	assert.equal(changedNotice('a.ts', header, '/* introduction */\n' + header), false);
});
test('moving notice into executable text does not count as preserving a header', () => {
	assert.equal(changedNotice('a.ts', header, 'const x=1;\n' + header), true);
});
test('unattributed original file is not automatically cleared', () => {
	assert.deepEqual(notices('a.ts', 'const x=1;'), []);
});

for (const mode of ['removed', 'same-pr-exception', 'trusted-exception', 'implementation']) {
	test(`Git integration: ${mode}`, () => {
		const dir = mkdtempSync(join(tmpdir(), 'v3-notice-test-'));
		const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
		const before = header + '\nconst x=1;\n';
		const after = mode === 'implementation' ? header + '\nconst x=2;\n' : 'const x=1;\n';
		const sha = text => createHash('sha256').update(text).digest('hex');
		const exception = JSON.stringify({ exceptions: [{ path: 'a.ts', beforeSha256: sha(before), afterSha256: sha(after), reason: 'fixture', evidence: 'fixture review' }] });
		try {
			run('init', '-q');
			run('config', 'user.email', 'fixture@example.invalid');
			run('config', 'user.name', 'Test');
			run('config', 'core.hooksPath', '/dev/null');
			mkdirSync(join(dir, '.github'));
			writeFileSync(join(dir, 'a.ts'), before);
			writeFileSync(join(dir, '.github/header-exceptions.json'), mode === 'trusted-exception' ? exception : '{"exceptions":[]}');
			run('add', '.'); run('commit', '-qm', 'base');
			const base = run('rev-parse', 'HEAD');
			writeFileSync(join(dir, 'a.ts'), after);
			if (mode === 'same-pr-exception') writeFileSync(join(dir, '.github/header-exceptions.json'), exception);
			run('add', '.'); run('commit', '-qm', 'change');
			const result = spawnSync(process.execPath, [resolve('build/verify/preserve-notices.mjs'), base, 'HEAD'], { cwd: dir, encoding: 'utf8' });
			assert.equal(result.status, ['trusted-exception', 'implementation'].includes(mode) ? 0 : 1, result.stderr);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}
