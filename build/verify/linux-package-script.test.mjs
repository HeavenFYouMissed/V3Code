/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const helperPath = join(repoRoot, 'scripts/v3-linux-release-paths.sh');
const packageScript = readFileSync(join(repoRoot, 'scripts/v3-package-linux.sh'), 'utf8');
const commit = 'a'.repeat(40);
const forceLinuxAssertions = process.env['V3_FORCE_LINUX_PACKAGE_TESTS'] === '1';
const linuxOnly = process.platform === 'linux' || forceLinuxAssertions
	? {}
	: { skip: `Linux-only package safety assertions (host: ${process.platform})` };

function validatePaths(repo, requestedRoot, home) {
	const script = `
set -euo pipefail
source "$1"
v3_linux_release_paths "$2" "$3" x64 "$4"
printf '%s\n%s\n%s\n' "$V3_LINUX_SAFE_RELEASES_ROOT" "$RELEASE_ROOT" "$TREE_DIR"
`;
	return spawnSync('bash', ['-c', script, 'v3-linux-path-test', helperPath, repo, requestedRoot, commit], {
		encoding: 'utf8',
		env: { ...process.env, HOME: home }
	});
}

test('default and explicit Linux release roots stay below the task-specific release base', linuxOnly, () => {
	const scratch = mkdtempSync(join(tmpdir(), 'v3-linux-release-paths.'));
	try {
		const repo = join(scratch, 'repo');
		const home = join(scratch, 'home');
		const safeBase = join(repo, '.build/releases');
		mkdirSync(safeBase, { recursive: true });
		mkdirSync(home);

		const defaultResult = validatePaths(repo, '', home);
		assert.equal(defaultResult.status, 0, defaultResult.stderr);
		assert.deepEqual(defaultResult.stdout.trim().split('\n'), [
			realpathSync(join(repo, '.build/releases')),
			join(realpathSync(join(repo, '.build/releases')), commit),
			join(realpathSync(join(repo, '.build/releases')), commit, 'VSCode-linux-x64')
		]);

		const explicitRoot = join(repo, '.build/releases/review-task');
		const explicitResult = validatePaths(repo, explicitRoot, home);
		assert.equal(explicitResult.status, 0, explicitResult.stderr);
		const canonicalExplicitRoot = join(realpathSync(safeBase), 'review-task');
		assert.equal(explicitResult.stdout.trim().split('\n')[1], canonicalExplicitRoot);
		assert.equal(explicitResult.stdout.trim().split('\n')[2], join(canonicalExplicitRoot, 'VSCode-linux-x64'));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('broad, traversing, and symlinked Linux release roots are rejected', linuxOnly, () => {
	const scratch = mkdtempSync(join(tmpdir(), 'v3-linux-release-reject.'));
	try {
		const repo = join(scratch, 'repo');
		const home = join(scratch, 'home');
		const safeBase = join(repo, '.build/releases');
		mkdirSync(safeBase, { recursive: true });
		mkdirSync(home);

		for (const unsafe of ['/', repo, home, safeBase, join(safeBase, '../../escaped')]) {
			const result = validatePaths(repo, unsafe, home);
			assert.notEqual(result.status, 0, `unexpectedly accepted ${unsafe}`);
		}

		const linkedRoot = join(safeBase, 'root-link');
		symlinkSync('/', linkedRoot, 'dir');
		assert.notEqual(validatePaths(repo, linkedRoot, home).status, 0);

		const linkedTreeRoot = join(safeBase, 'linked-tree');
		mkdirSync(linkedTreeRoot);
		symlinkSync('/', join(linkedTreeRoot, 'VSCode-linux-x64'), 'dir');
		assert.notEqual(validatePaths(repo, linkedTreeRoot, home).status, 0);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('Xvfb smoke isolates shared data and validates TREE_DIR before recursive cleanup', linuxOnly, () => {
	assert.match(packageScript, /--shared-data-dir="\$SMOKE_ROOT\/shared-data"/);
	assert.match(packageScript, /--user-data-dir="\$SMOKE_ROOT\/user-data"/);
	assert.match(packageScript, /--extensions-dir="\$SMOKE_ROOT\/extensions"/);

	const guardIndex = packageScript.indexOf('v3_linux_release_paths');
	const cleanupIndex = packageScript.indexOf('rm -rf "$TREE_DIR"');
	assert.ok(guardIndex >= 0, 'package script must invoke the release path guard');
	assert.ok(cleanupIndex > guardIndex, 'TREE_DIR must be validated before recursive cleanup');
});
