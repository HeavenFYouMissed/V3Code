/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IExternalAgentsService } from '../common/externalAgentsService.js';
import './externalAgentsService.js';
import { EXTERNAL_AGENT_PICKER_ID } from './externalAgentPicker.js';
import { v3AgentMark } from '../../chat/browser/agentSessions/agentSessions.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: EXTERNAL_AGENT_PICKER_ID,
			title: localize2('externalAgents.pick', "Choose Chat Agent"),
			icon: v3AgentMark,
			menu: [{ id: MenuId.ChatInput, group: 'navigation', order: 1.9, when: ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat) }],
		});
	}
	run(): void { }
});

export const V3CODE_EXTERNAL_AGENTS_OPEN_CHAT_ACTION_ID = 'v3code.externalAgents.openChat';
export const V3CODE_EXTERNAL_AGENTS_OPEN_SETTINGS_ACTION_ID = 'v3code.externalAgents.openSettings';
export const V3CODE_EXTERNAL_AGENTS_REFRESH_ACTION_ID = 'v3code.externalAgents.refreshRegistry';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3CODE_EXTERNAL_AGENTS_OPEN_CHAT_ACTION_ID,
			title: localize2('externalAgents.openChat', "External Agents: Open Chat"),
			f1: false,
		});
	}
	async run(accessor: ServicesAccessor, id?: string, position?: 'sidebar' | 'editor'): Promise<boolean> {
		if (typeof id !== 'string') {
			return false;
		}
		return accessor.get(IExternalAgentsService).openChat(id, position === 'editor' ? 'editor' : 'sidebar');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3CODE_EXTERNAL_AGENTS_OPEN_SETTINGS_ACTION_ID,
			title: localize2('externalAgents.openSettings', "External Agents: Manage"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IExternalAgentsService).openSettings();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3CODE_EXTERNAL_AGENTS_REFRESH_ACTION_ID,
			title: localize2('externalAgents.refresh', "External Agents: Refresh Registry"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IExternalAgentsService).refreshFromRegistry();
	}
});
