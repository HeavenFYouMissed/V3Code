/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Keep sidebar chat on local V3Code sessions so Ask/Plan/Agent mode switching works.
 * Non-local agent session types lock the widget and VS Code hides the mode picker.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { getChatSessionType } from '../../chat/common/model/chatUri.js';
import { IChatWidget, IChatWidgetService } from '../../chat/browser/chat.js';
import { localChatSessionType } from '../../chat/common/chatSessionsService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

class V3CodeChatInputContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeChatInput';

	constructor(
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IProductService productService: IProductService,
	) {
		super();

		if (productService.defaultChatAgent?.extensionId !== 'v3code.v3code') {
			return;
		}

		for (const widget of this.chatWidgetService.getAllWidgets()) {
			this.trackWidget(widget);
		}

		this._register(this.chatWidgetService.onDidAddWidget(widget => this.trackWidget(widget)));
	}

	private trackWidget(widget: IChatWidget): void {
		const ensureLocalUnlock = () => {
			const sessionResource = widget.viewModel?.model.sessionResource;
			if (!sessionResource) {
				return;
			}
			const sessionType = getChatSessionType(sessionResource);
			if (!sessionType || sessionType === localChatSessionType) {
				widget.unlockFromCodingAgent();
			}
		};

		this._register(widget.onDidChangeViewModel(() => ensureLocalUnlock()));
		ensureLocalUnlock();
	}
}

registerWorkbenchContribution2(V3CodeChatInputContribution.ID, V3CodeChatInputContribution, WorkbenchPhase.AfterRestored);
