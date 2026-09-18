/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	COMPUTER_USE_APP_TIERS,
	ComputerUseAppTier,
	classifyComputerUseApp,
	describeTierAdvice,
	isSelfApp,
} from '../../common/computerUseAppTiers.js';

suite('ComputerUse - app classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies V3Code itself', () => {
		const ids = ['dev.v3code.code', 'V3Code', 'code-oss-dev'];
		assert.deepStrictEqual(
			ids.map(id => classifyComputerUseApp({ id })),
			['self', 'self', 'self'],
		);
	});

	test('classifies browsers, including channel variants', () => {
		const ids = [
			'com.apple.Safari',
			'com.google.Chrome',
			'com.google.Chrome.canary',
			'org.mozilla.firefox',
			'com.microsoft.edgemac',
			'msedge.exe',
			'chrome.exe',
			'com.brave.Browser',
			'company.thebrowser.Browser',
			'com.operasoftware.Opera',
			'vivaldi.exe',
		];
		assert.deepStrictEqual(
			ids.map(id => classifyComputerUseApp({ id })),
			ids.map(() => 'read'),
		);
	});

	test('classifies terminals and IDEs', () => {
		const ids = [
			'com.apple.Terminal',
			'com.googlecode.iterm2',
			'dev.warp.Warp-Stable',
			'com.mitchellh.ghostty',
			'org.alacritty',
			'net.kovidgoyal.kitty',
			'com.github.wez.wezterm',
			'WindowsTerminal.exe',
			'powershell.exe',
			'com.microsoft.VSCode',
			'com.exafunction.windsurf',
			'com.sublimetext.4',
			'dev.zed.Zed',
			'com.apple.dt.Xcode',
			'com.jetbrains.intellij',
			'devenv.exe',
			'org.gnu.Emacs',
		];
		assert.deepStrictEqual(
			ids.map(id => classifyComputerUseApp({ id })),
			ids.map(() => 'click'),
		);
	});

	test('falls back to the display name when a bundle id is opaque', () => {
		// Cursor ships as com.todesktop.<hash>, which says nothing on its own.
		assert.deepStrictEqual(
			[
				classifyComputerUseApp({ id: 'com.todesktop.230313mzl4w4u92' }),
				classifyComputerUseApp({ id: 'com.todesktop.230313mzl4w4u92', name: 'Cursor' }),
			],
			['full', 'click'],
		);
	});

	test('classifies anything unrecognised as full', () => {
		assert.strictEqual(classifyComputerUseApp({ id: 'com.example.SomeApp', name: 'Some App' }), 'full');
	});

	test('isSelfApp is the only classification with a mechanical consequence', () => {
		// It decides whether V3Code stays out of its own screenshots — a feedback-loop guard, not a
		// permission. Everything else the classifier produces is text for the consent dialog.
		assert.deepStrictEqual(
			[
				isSelfApp({ id: 'dev.v3code.code' }),
				isSelfApp({ id: 'com.apple.Terminal' }),
				isSelfApp({ id: 'com.google.Chrome' }),
			],
			[true, false, false],
		);
	});

	test('advice is offered for the two cases with a better dedicated tool, and nowhere else', () => {
		// Browsers have the browser tools; terminals have run_command. For anything else there is nothing
		// useful to say, and inventing a warning would train the user to dismiss the dialog unread.
		assert.deepStrictEqual(
			(['read', 'click', 'full', 'self'] as ComputerUseAppTier[]).map(t => describeTierAdvice(t) !== undefined),
			[true, true, false, false],
		);
	});

	test('the classifier exposes no way to refuse an action', () => {
		// The guard for the whole design. Enabling computer use is the user's decision to make once; this
		// module classifies and explains, and must never regain the ability to overrule that. If a future
		// change reintroduces an allow/deny-shaped export here, this fails and a reviewer has to justify it.
		const surface = Object.keys({ classifyComputerUseApp, isSelfApp, describeTierAdvice, COMPUTER_USE_APP_TIERS });
		assert.deepStrictEqual(
			surface.filter(name => /allow|permit|forbid|refus|deny|denie|scope|grant/i.test(name)),
			[],
		);
	});
});
