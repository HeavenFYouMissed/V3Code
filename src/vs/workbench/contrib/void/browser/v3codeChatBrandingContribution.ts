/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Suppress GitHub Copilot setup agents and sign-in UI — V3Code uses v3code.agent.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';

class V3CodeChatBrandingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeChatBranding';

	constructor(
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
		super();
		this.chatEntitlementService.setForceHidden(true);
		this.chatEntitlementService.markSetupCompleted();
	}
}

registerWorkbenchContribution2(V3CodeChatBrandingContribution.ID, V3CodeChatBrandingContribution, WorkbenchPhase.BlockStartup);
