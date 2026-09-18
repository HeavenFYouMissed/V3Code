/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * What kind of application this is.
 *
 * A *classification*, and nothing more. Nothing in this module refuses an action, and no caller may
 * use it to. Computer use is one decision the user makes once — enabling it means telling the agent it
 * may drive their machine — and having made it they are not interrogated per application.
 *
 * Two things are built on top of the classification, neither of them a gate:
 * - {@link isSelfApp}, so V3Code's own windows stay out of its own screenshots. That prevents a
 *   feedback loop, which is a quality bug, not a permission question.
 * - {@link describeTierAdvice}, one line the consent dialog can show so the user's single decision is
 *   an informed one.
 */
export type ComputerUseAppTier =
	/** A browser. V3Code's browser tools read the DOM directly, which beats clicking pixels. */
	| 'read'
	/** A terminal or an editor. `run_command` shows a command before it runs; keystrokes cannot. */
	| 'click'
	/** Anything else. */
	| 'full'
	/** V3Code itself. */
	| 'self';

/** Bundle identifiers and executable names that identify V3Code itself. */
const SELF_IDENTIFIERS: readonly string[] = [
	'dev.v3code.code',
	'v3code',
	'code-oss-dev',
];

/**
 * Browsers, matched on identifier fragments.
 *
 * Fragments rather than exact ids because channel variants proliferate — `com.google.Chrome.beta`,
 * `com.google.Chrome.canary`, `msedge.exe`, `microsoft-edge-dev` — and a list of exact names would
 * silently stop matching on the next variant.
 */
const BROWSER_FRAGMENTS: readonly string[] = [
	'chrome',
	'chromium',
	'safari',
	'firefox',
	'msedge',
	'microsoft-edge',
	'microsoftedge',
	'com.microsoft.edgemac',
	'brave',
	'opera',
	'vivaldi',
	'arc',
	'company.thebrowser',
	'orion',
	'duckduckgo',
];

/** Terminal emulators and IDEs, matched on identifier fragments. */
const TERMINAL_AND_IDE_FRAGMENTS: readonly string[] = [
	// Terminals
	'terminal',
	'iterm',
	'warp',
	'ghostty',
	'alacritty',
	'kitty',
	'wezterm',
	'hyper',
	'tabby',
	'powershell',
	'windowsterminal',
	'conemu',
	'cmd.exe',
	'wt.exe',
	// Editors and IDEs
	'visualstudiocode',
	'vscode',
	'vscodium',
	'cursor',
	'windsurf',
	'sublime',
	'zed',
	'xcode',
	'androidstudio',
	'jetbrains',
	'intellij',
	'pycharm',
	'webstorm',
	'goland',
	'clion',
	'rider',
	'rubymine',
	'phpstorm',
	'datagrip',
	'devenv.exe',
	'emacs',
	'macvim',
	'neovide',
	'nvim',
	'vim',
];

/** Normalizes an identifier for fragment matching: lower-cased, punctuation stripped. */
function normalizeIdentifier(identifier: string): string {
	return identifier.toLowerCase().replace(/[\s_-]+/g, '');
}

/** True when any fragment appears in the normalized identifier. */
function matchesAnyFragment(identifier: string, fragments: readonly string[]): boolean {
	const normalized = normalizeIdentifier(identifier);
	return fragments.some(fragment => normalized.includes(normalizeIdentifier(fragment)));
}

/**
 * Classifies an application into a {@link ComputerUseAppTier}.
 *
 * Both identifiers are consulted so the same classifier works on either platform: `id` is the bundle
 * identifier on macOS and the executable name on Windows, and `name` is the display name, which
 * catches the cases where a bundle id is uninformative (Cursor ships as `com.todesktop.<hash>`).
 */
export function classifyComputerUseApp(app: { readonly id: string; readonly name?: string }): ComputerUseAppTier {
	const candidates = [app.id, app.name ?? ''].filter(candidate => candidate.length > 0);

	if (candidates.some(candidate => matchesAnyFragment(candidate, SELF_IDENTIFIERS))) {
		return 'self';
	}
	if (candidates.some(candidate => matchesAnyFragment(candidate, BROWSER_FRAGMENTS))) {
		return 'read';
	}
	if (candidates.some(candidate => matchesAnyFragment(candidate, TERMINAL_AND_IDE_FRAGMENTS))) {
		return 'click';
	}
	return 'full';
}

/**
 * Whether an application is V3Code itself.
 *
 * The one classification with a mechanical consequence: V3Code's own windows are excluded from
 * screenshots by default, because an agent that sees its own output reads it back and loses track of
 * the task. A quality guard, not a permission — it changes what is in a picture, not what is allowed.
 */
export function isSelfApp(app: { readonly id: string; readonly name?: string }): boolean {
	return classifyComputerUseApp(app) === 'self';
}

/**
 * One line of guidance for the consent dialog, or `undefined` when there is nothing worth saying.
 *
 * Purely informational, and deliberately phrased as "there is a better tool for this" rather than as
 * a warning — because for these two cases that is the true statement. The agent reaching for the
 * mouse in a browser or a terminal is usually the worse path, and it is still allowed.
 */
export function describeTierAdvice(tier: ComputerUseAppTier): string | undefined {
	switch (tier) {
		case 'read':
			return 'In browsers, V3Code\'s browser tools read the page structure directly and act on stable element references, which is more reliable than clicking pixels.';
		case 'click':
			return 'In terminals and editors, run_command shows you a command before it runs, which synthetic keystrokes cannot.';
		default:
			return undefined;
	}
}

/** Every tier, for exhaustive iteration in tests. */
export const COMPUTER_USE_APP_TIERS: readonly ComputerUseAppTier[] = ['read', 'click', 'full', 'self'];
