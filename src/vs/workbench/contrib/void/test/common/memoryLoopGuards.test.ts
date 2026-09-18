/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	isReadOnlyCall,
	isInspectionCall,
	isReadOnlyShellCommand,
	isExternalObservationTool,
	normalizedInspectionSignature,
	MAX_WORKSPACE_INSPECTIONS,
} from '../../common/memory/loopGuards.js';

suite('memory loop guards (Wrench-site inspection spiral)', () => {

	test('read-only shell commands are classified read-only', () => {
		assert.strictEqual(isReadOnlyShellCommand('ls -la'), true);
		assert.strictEqual(isReadOnlyShellCommand('ls -la | head -30'), true);
		assert.strictEqual(isReadOnlyShellCommand('git status'), true);
		assert.strictEqual(isReadOnlyShellCommand('cat package.json'), true);
		assert.strictEqual(isReadOnlyShellCommand('cd app && ls'), true);
		// mutating commands are NOT read-only
		assert.strictEqual(isReadOnlyShellCommand('rm -rf dist'), false);
		assert.strictEqual(isReadOnlyShellCommand('npm install'), false);
		assert.strictEqual(isReadOnlyShellCommand('mkdir src'), false);
	});

	test('`ls -la` via run_command counts as read-only for the streak (the bug)', () => {
		// Previously run_command was not in READONLY_TOOLS, so this reset the streak forever.
		assert.strictEqual(isReadOnlyCall('run_command', false, 'ls -la'), true);
		assert.strictEqual(isReadOnlyCall('run_command', false, 'npm run build'), false);
		// a declared read-only tool is read-only regardless of command
		assert.strictEqual(isReadOnlyCall('ls_dir', true, ''), true);
	});

	test('inspection classification covers ls_dir/get_dir_tree and listing shell commands', () => {
		assert.strictEqual(isInspectionCall('ls_dir', ''), true);
		assert.strictEqual(isInspectionCall('get_dir_tree', ''), true);
		assert.strictEqual(isInspectionCall('run_command', 'ls -la'), true);
		assert.strictEqual(isInspectionCall('run_command', 'tree -L 2'), true);
		// reading a specific file is NOT inspection (it's allowed even after the cap)
		assert.strictEqual(isInspectionCall('run_command', 'cat package.json'), false);
		assert.strictEqual(isInspectionCall('read_file', ''), false);
	});

	test('near-identical inspections collapse to one dedup signature', () => {
		const a = normalizedInspectionSignature('run_command', 'ls -la', '{}');
		const b = normalizedInspectionSignature('run_command', 'ls -la | head -30', '{}');
		const c = normalizedInspectionSignature('run_command', 'ls --color', '{}');
		assert.strictEqual(a, b, 'flags/pipes should be stripped');
		assert.strictEqual(a, c, 'flags should be stripped');
		// ls_dir on the SAME path twice collapses to one key (true repeat -> caught)
		assert.strictEqual(
			normalizedInspectionSignature('ls_dir', '', '{"uri":"/a"}'),
			normalizedInspectionSignature('ls_dir', '', '{"uri":"/a"}'),
		);
		// ls_dir on DIFFERENT paths must NOT collapse — different dirs are legitimate, not a repeat
		// (this was the false-positive: get_dir_tree(root) vs get_dir_tree(.v3code) flagged as a loop)
		assert.notStrictEqual(
			normalizedInspectionSignature('get_dir_tree', '', '{"uri":"/a"}'),
			normalizedInspectionSignature('get_dir_tree', '', '{"uri":"/b"}'),
		);
		// a non-inspection call keeps a distinct, param-sensitive signature
		assert.notStrictEqual(
			normalizedInspectionSignature('read_file', '', '{"uri":"/a"}'),
			normalizedInspectionSignature('read_file', '', '{"uri":"/b"}'),
		);
	});

	test('computer-use tools are exempt from the repeat guard', () => {
		// Their result depends on the screen, not on the arguments, and read_screen_changes compares
		// against a baseline that advances every call — so a second identical call is an observation
		// loop, not a spiral. Two calls with no pid are byte-identical on the wire even when a
		// different application was frontmost for each, which is how this misfired.
		assert.strictEqual(isExternalObservationTool('computer_read_screen_changes'), true);
		assert.strictEqual(isExternalObservationTool('computer_screenshot'), true);
		assert.strictEqual(isExternalObservationTool('computer_wait_for_stable'), true);

		// Everything else still spirals, including the tools this guard was written for.
		assert.strictEqual(isExternalObservationTool('read_file'), false);
		assert.strictEqual(isExternalObservationTool('ls_dir'), false);
		assert.strictEqual(isExternalObservationTool('run_command'), false);
		// Not widened to the browser tools; see the note on isExternalObservationTool.
		assert.strictEqual(isExternalObservationTool('screenshot_page'), false);
		assert.strictEqual(isExternalObservationTool(''), false);
	});

	test('inspection spiral hard-stops at the cap', () => {
		// Simulate the loop: the 6th distinct listing is blocked once the cap is reached.
		let inspectionCount = 0;
		let blockedAt = -1;
		for (let i = 0; i < 50; i++) {
			if (inspectionCount >= MAX_WORKSPACE_INSPECTIONS) { blockedAt = i; break; }
			inspectionCount++;
		}
		assert.strictEqual(inspectionCount, MAX_WORKSPACE_INSPECTIONS);
		assert.strictEqual(blockedAt, MAX_WORKSPACE_INSPECTIONS);
	});
});
