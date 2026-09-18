/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code chrome defaults applied once at workbench restore:
 * - Hide native VS Code accounts avatar (v3-profile-btn replaces it)
 * - Hide Copilot "Sign In" status-bar entry (V3Code has its own account stub)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { isAccountsActionVisible, setAccountsActionVisible } from '../../../browser/parts/globalCompositeBar.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';

class V3ChromeStartupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3ChromeStartup';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
		super();
		if (isAccountsActionVisible(this.storageService)) {
			setAccountsActionVisible(this.storageService, false);
		}
		this.ensureCopilotSignInHidden();

		// AccountPolicyGateContribution also runs at AfterRestored and calls
		// setForceHidden(false) when the org gate is inactive — re-apply our hide.
		this._register(this.chatEntitlementService.onDidChangeSentiment(() => {
			this.ensureCopilotSignInHidden();
		}));
	}

	private ensureCopilotSignInHidden(): void {
		if (!this.chatEntitlementService.sentiment.hidden) {
			this.chatEntitlementService.setForceHidden(true);
		}
	}
}

registerWorkbenchContribution2(V3ChromeStartupContribution.ID, V3ChromeStartupContribution, WorkbenchPhase.AfterRestored);
