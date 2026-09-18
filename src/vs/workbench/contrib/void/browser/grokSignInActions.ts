/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Grok (Plan) sign-in command.
 *
 * The Grok (Plan) provider authenticates with the subscription token that the `grok` CLI writes
 * to ~/.grok/auth.json after `grok login` (browser OAuth). There is no in-app key to paste, so the
 * Settings sign-in card triggers this command: it opens an integrated terminal and runs
 * `grok login`, which walks the user through the OAuth flow and writes the token file that
 * grokSubscriptionAuth.ts reads live in the main process.
 */

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const GROK_SIGN_IN_COMMAND_ID = 'v3code.grok.signIn';

CommandsRegistry.registerCommand(GROK_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor) => {
	const terminalService = accessor.get(ITerminalService);
	const logService = accessor.get(ILogService);
	try {
		const instance = await terminalService.createTerminal({ config: { name: 'Grok Sign-in' } });
		terminalService.setActiveInstance(instance);
		await terminalService.revealActiveTerminal();
		await terminalService.focusInstance(instance);
		instance.sendText('grok login', true);
	} catch (e) {
		logService.error('[grok-signin] failed to open terminal for `grok login`', e);
		throw e;
	}
});
