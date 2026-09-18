/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IVibeModeService } from './vibeModeService.js';

const CATEGORY = localize2('v3code.category', 'V3Code');

/**
 * VIBE/DEV mode toggle action.
 * Keybinding: Ctrl+Shift+V (V for Vibe)
 * Switches between fullscreen agent panel (VIBE) and normal editor (DEV).
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'v3code.toggleVibeMode',
			title: localize2('v3code.toggleVibeMode', 'V3Code: Toggle VIBE Mode'),
			category: CATEGORY,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
				secondary: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Backslash],
				weight: 200,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const vibeService = accessor.get(IVibeModeService);
		vibeService.toggle();
	}
});

/**
 * Enter VIBE mode directly.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'v3code.enterVibeMode',
			title: localize2('v3code.enterVibeMode', 'V3Code: Enter VIBE Mode'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const vibeService = accessor.get(IVibeModeService);
		await vibeService.enterVibe();
	}
});

/**
 * Exit VIBE mode directly.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'v3code.exitVibeMode',
			title: localize2('v3code.exitVibeMode', 'V3Code: Exit VIBE Mode'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const vibeService = accessor.get(IVibeModeService);
		await vibeService.exitVibe();
	}
});
