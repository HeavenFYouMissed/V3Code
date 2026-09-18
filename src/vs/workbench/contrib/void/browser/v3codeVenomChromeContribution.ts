/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { V3CODE_CHROME_VENOM_ANIMATIONS_KEY } from '../browser/v3codeProductSettings.js';

const V3_VENOM_DISABLED_CLASS = 'v3-venom-disabled';

function syncVenomDisabledClass(enabled: boolean): void {
	const body = mainWindow.document.body;
	if (!body) {
		return;
	}
	if (enabled) {
		body.classList.remove(V3_VENOM_DISABLED_CLASS);
	} else {
		body.classList.add(V3_VENOM_DISABLED_CLASS);
	}
}

class V3CodeVenomChromeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeVenomChrome';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const reduceMotion = mainWindow.matchMedia('(prefers-reduced-motion: reduce)');
		// Venom motion shows only when the user hasn't turned it off AND the OS isn't
		// asking for reduced motion (accessibility / photosensitivity).
		const apply = () => {
			const settingOn = this.configurationService.getValue<boolean>(V3CODE_CHROME_VENOM_ANIMATIONS_KEY) !== false;
			syncVenomDisabledClass(settingOn && !reduceMotion.matches);
		};
		apply();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(V3CODE_CHROME_VENOM_ANIMATIONS_KEY)) {
				apply();
			}
		}));
		const onReduceMotionChange = () => apply();
		reduceMotion.addEventListener('change', onReduceMotionChange);
		this._register(toDisposable(() => reduceMotion.removeEventListener('change', onReduceMotionChange)));
	}
}

registerWorkbenchContribution2(V3CodeVenomChromeContribution.ID, V3CodeVenomChromeContribution, WorkbenchPhase.AfterRestored);
