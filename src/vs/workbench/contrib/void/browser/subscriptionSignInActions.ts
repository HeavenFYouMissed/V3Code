/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sign-in commands for the subscription lanes that authenticate through a vendor CLI.
 *
 * None of these providers take an API key, so the Settings card cannot just focus an input.
 * Instead it opens an integrated terminal and runs the vendor's login command, which walks the
 * user through the browser OAuth flow and writes the credential store that the matching
 * *SubscriptionAuth module reads live in the main process.
 *
 * Grok has its own module (grokSignInActions.ts) that predates this one.
 */

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const CLAUDE_SIGN_IN_COMMAND_ID = 'v3code.claude.signIn';
export const COPILOT_SIGN_IN_COMMAND_ID = 'v3code.copilot.signIn';
export const GEMINI_SIGN_IN_COMMAND_ID = 'v3code.gemini.signIn';
export const OPENAI_PLAN_SIGN_IN_COMMAND_ID = 'v3code.openaiPlan.signIn';

/** Opens a named terminal and runs a login command in it. */
const runSignInCommand = async (
	accessor: ServicesAccessor,
	opts: { terminalName: string; command: string; logTag: string },
): Promise<void> => {
	const terminalService = accessor.get(ITerminalService);
	const logService = accessor.get(ILogService);
	try {
		const instance = await terminalService.createTerminal({ config: { name: opts.terminalName } });
		terminalService.setActiveInstance(instance);
		await terminalService.revealActiveTerminal();
		await terminalService.focusInstance(instance);
		instance.sendText(opts.command, true);
	} catch (e) {
		logService.error(`[${opts.logTag}] failed to open terminal for \`${opts.command}\``, e);
		throw e;
	}
};

CommandsRegistry.registerCommand(CLAUDE_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor) => {
	// `claude` opens the TUI; the user then runs /login inside it. There is no one-shot
	// non-interactive login, so the terminal has to stay in the foreground for the OAuth round
	// trip. (`claude setup-token` is the headless alternative, but it prints a token the user
	// would have to place themselves, which is a worse first-run experience.)
	await runSignInCommand(accessor, {
		terminalName: 'Claude Sign-in',
		command: 'claude',
		logTag: 'claude-signin',
	});
});

CommandsRegistry.registerCommand(COPILOT_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor) => {
	await runSignInCommand(accessor, {
		terminalName: 'Copilot Sign-in',
		command: 'copilot login',
		logTag: 'copilot-signin',
	});
});

CommandsRegistry.registerCommand(GEMINI_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor) => {
	// gemini-cli has no non-interactive login subcommand: the user runs `gemini` and picks
	// "Sign in with Google" in the TUI, which opens the browser and writes oauth_creds.json.
	await runSignInCommand(accessor, {
		terminalName: 'Gemini Sign-in',
		command: 'gemini',
		logTag: 'gemini-signin',
	});
});

CommandsRegistry.registerCommand(OPENAI_PLAN_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor) => {
	// ChatGPT Plus/Pro plan lane. Bare `codex login` (its only subcommand is `status`) walks the
	// browser OAuth round trip and writes ~/.codex/auth.json, which openaiPlanSubscriptionAuth.ts
	// reads live in the main process. There is no API key to paste for this lane, and `--with-api-key`
	// would switch the account to billed-per-token — deliberately NOT used here.
	await runSignInCommand(accessor, {
		terminalName: 'ChatGPT Sign-in',
		command: 'codex login',
		logTag: 'openai-plan-signin',
	});
});
