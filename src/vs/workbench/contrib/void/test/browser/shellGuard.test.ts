/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { inspectShellCommand, looksLikeInputPrompt, shellIntegrationScriptFor, stripOutputPrefix } from '../../browser/terminalToolService.js';

suite('shellGuard', () => {

	test('rm -rf: denies root/home/system targets, allows workspace-absolute cleanup', () => {
		const verdictOf = (cmd: string) => inspectShellCommand(cmd).permission;
		assert.deepStrictEqual({
			// catastrophic targets stay denied
			root: verdictOf('rm -rf /'),
			rootGlob: verdictOf('rm -rf /*'),
			home: verdictOf('rm -rf ~'),
			homeSlash: verdictOf('rm -rf ~/'),
			homeVar: verdictOf('rm -rf $HOME'),
			driveRoot: verdictOf('rm -rf C:\\'),
			usersTopLevel: verdictOf('rm -rf /Users'),
			etc: verdictOf('rm -rf /etc'),
			chained: verdictOf('echo hi && rm -rf /'),
			// routine agent cleanup must pass (the old rule denied ANY absolute path)
			nodeModules: verdictOf('rm -rf /Users/daniel/dev/proj/node_modules'),
			tmpDir: verdictOf('rm -rf /tmp/build-cache'),
			homeSubdir: verdictOf('rm -rf ~/dev/scratch/out'),
			relative: verdictOf('rm -rf dist'),
			windowsProj: verdictOf('rm -rf C:\\dev\\proj\\dist'),
		}, {
			root: 'deny',
			rootGlob: 'deny',
			home: 'deny',
			homeSlash: 'deny',
			homeVar: 'deny',
			driveRoot: 'deny',
			usersTopLevel: 'deny',
			etc: 'deny',
			chained: 'deny',
			nodeModules: 'allow',
			tmpDir: 'allow',
			homeSubdir: 'allow',
			relative: 'allow',
			windowsProj: 'allow',
		});
	});

	test('other destructive rules still fire', () => {
		assert.deepStrictEqual([
			inspectShellCommand('git reset --hard origin/main').permission,
			inspectShellCommand('git push --force').permission,
			inspectShellCommand('git clean -fdx').permission,
			inspectShellCommand('npm run build').permission,
		], ['deny', 'deny', 'deny', 'allow']);
	});

});

suite('looksLikeInputPrompt', () => {

	test('detects interactive prompts at the tail (loose mode)', () => {
		const prompts = [
			'Password: ',
			"Enter passphrase for key '/home/x/.ssh/id_rsa':",
			'Are you sure you want to continue? [Y/n] ',
			'Proceed? (y/N)',
			'Overwrite existing file? (yes/no)',
			'Press ENTER to continue',
			'press any key to continue . . .',
			'> ',
			'Do you want to continue installing? [Y/n]',
			'What is your name?',
			'Are you sure?',
		];
		for (const p of prompts) {
			assert.strictEqual(looksLikeInputPrompt(p), true, `expected prompt: ${JSON.stringify(p)}`);
		}
	});

	test('does not fire on normal completed output', () => {
		const normal = [
			'git push origin main\nEnumerating objects: 5, done.',
			'npm install\nadded 120 packages in 3s',
			'Build complete.\n\n',
			'ready - started server on 0.0.0.0:3000',
			'',
			'  ',
		];
		for (const n of normal) {
			assert.strictEqual(looksLikeInputPrompt(n), false, `expected NOT a prompt: ${JSON.stringify(n)}`);
		}
	});

	test('scans past trailing blank lines to the real last line', () => {
		assert.strictEqual(looksLikeInputPrompt('Password:\n\n\n'), true);
		assert.strictEqual(looksLikeInputPrompt('all done\n\n\n'), false);
	});

	test('strict mode only matches unambiguous prompts (fast probe safety)', () => {
		// High-confidence shapes fire in strict mode
		assert.strictEqual(looksLikeInputPrompt('Password: ', { strict: true }), true);
		assert.strictEqual(looksLikeInputPrompt('Continue? [Y/n]', { strict: true }), true);
		assert.strictEqual(looksLikeInputPrompt('Press enter to continue', { strict: true }), true);
		assert.strictEqual(looksLikeInputPrompt('> ', { strict: true }), true);
		// Loose catch-alls must NOT fire in strict mode — a command that merely paused after
		// printing a line ending in '?' would otherwise be cut off after ~1.2s.
		assert.strictEqual(looksLikeInputPrompt('Compiling module foo?', { strict: true }), false);
		assert.strictEqual(looksLikeInputPrompt('Are you sure', { strict: true }), false);
		// ...but they DO fire in the default (post-timeout) mode
		assert.strictEqual(looksLikeInputPrompt('Compiling module foo?'), true);
	});

	test('stripOutputPrefix isolates the current command on a pooled terminal', () => {
		// The common case: terminal reused within a chat session, previous output still present.
		assert.strictEqual(
			stripOutputPrefix('$ git status\nclean', '$ git status\nclean\n$ ls\nfoo.txt'),
			'$ ls\nfoo.txt'
		);
		// No baseline (fresh terminal / xterm not yet rendered) — everything belongs to us.
		assert.strictEqual(stripOutputPrefix('', 'everything'), 'everything');
		// Command printed nothing yet.
		assert.strictEqual(stripOutputPrefix('same', 'same'), '');
	});

	test('stripOutputPrefix re-anchors when scrollback evicted the baseline', () => {
		// xterm's buffer is a fixed-size ring: once the top scrolls away `after` no longer starts
		// with `before`, so a naive startsWith check would hand back the entire buffer.
		assert.strictEqual(stripOutputPrefix('line1\nline2\nline3', 'line2\nline3\nNEW'), 'NEW');
		// Trailing blank lines in the baseline must be skipped to find a real anchor.
		assert.strictEqual(stripOutputPrefix('prompt$\n\n', 'zzz\nprompt$\n\nNEW'), 'NEW');
		// A repeated anchor line must match its LAST occurrence, or output gets duplicated.
		assert.strictEqual(stripOutputPrefix('$', 'a\n$\nb\n$'), '');
		// Unrecoverable overlap: return the full text rather than silently dropping output.
		assert.strictEqual(stripOutputPrefix('gone', 'totally different'), 'totally different');
	});

	test('shellIntegrationScriptFor maps real executable paths to their OSC 633 script', () => {
		// The executable is a full path, and its shape varies by platform/install — basename
		// parsing must survive all of them or the recovery silently never runs.
		const resourceOf = (exe: string) => shellIntegrationScriptFor(exe)?.resource;
		assert.ok(resourceOf('/bin/bash')?.endsWith('shellIntegration-bash.sh'));
		assert.ok(resourceOf('/bin/zsh')?.endsWith('shellIntegration-rc.zsh'));
		assert.ok(resourceOf('/opt/homebrew/bin/fish')?.endsWith('shellIntegration.fish'));
		// Windows: backslash separators AND a .exe suffix, both of which must be stripped.
		assert.ok(resourceOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe')?.endsWith('shellIntegration.ps1'));
		assert.ok(resourceOf('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')?.endsWith('shellIntegration.ps1'));
		// Case-insensitive: Windows paths are not reliably lowercase.
		assert.ok(resourceOf('C:\\Program Files\\Git\\bin\\Bash.EXE')?.endsWith('shellIntegration-bash.sh'));
	});

	test('shellIntegrationScriptFor declines shells with no script instead of guessing', () => {
		// Returning a wrong script would inject garbage into the user's live shell, so every
		// unknown shell must fail closed and fall back to timeout-based reads.
		assert.strictEqual(shellIntegrationScriptFor('C:\\Windows\\System32\\cmd.exe'), undefined);
		assert.strictEqual(shellIntegrationScriptFor('/usr/bin/nu'), undefined);
		assert.strictEqual(shellIntegrationScriptFor('/bin/dash'), undefined);
		assert.strictEqual(shellIntegrationScriptFor('/bin/tcsh'), undefined);
		// No executable at all (shellLaunchConfig not populated yet).
		assert.strictEqual(shellIntegrationScriptFor(undefined), undefined);
		assert.strictEqual(shellIntegrationScriptFor(''), undefined);
	});

	test('shellIntegrationScriptFor uses the right sourcing verb per shell family', () => {
		// fish has no dot-source operator; POSIX shells and PowerShell do. Getting this backwards
		// produces a command-not-found on every recovery attempt.
		assert.strictEqual(shellIntegrationScriptFor('/bin/bash')?.verb, '.');
		assert.strictEqual(shellIntegrationScriptFor('/bin/zsh')?.verb, '.');
		assert.strictEqual(shellIntegrationScriptFor('/usr/bin/pwsh')?.verb, '.');
		assert.strictEqual(shellIntegrationScriptFor('/usr/bin/fish')?.verb, 'source');
	});

});
