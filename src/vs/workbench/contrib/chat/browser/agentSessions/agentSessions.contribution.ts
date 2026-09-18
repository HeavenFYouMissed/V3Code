/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// === CHAT SURFACE: AGENTS_SESSIONS_LIST ===
// Engine: NATIVE (list facade). The Sessions list is hosted in its own workbench sidebar
// container. Reads sessions via IChatSessionsService (which the local controller
// backs with IChatService) — it is a UI facade + cache over the SAME session store, not a
// second history store. Selecting a session opens a ChatWidget bound to it. See CHAT_SURFACES_MAP.md.

import './experiments/agentSessionsExperiments.contribution.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';

import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../../../../../platform/quickinput/common/quickAccess.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

import { IAgentSessionsService, AgentSessionsService } from './agentSessionsService.js';
import { LocalAgentsSessionsController } from './localAgentSessionsController.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ISubmenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ArchiveAgentSessionAction, ArchiveAgentSessionSectionAction, UnarchiveAgentSessionAction, OpenAgentSessionInEditorGroupAction, OpenAgentSessionInNewEditorGroupAction, OpenAgentSessionInNewWindowAction, ShowAgentSessionsSidebar, HideAgentSessionsSidebar, ToggleAgentSessionsSidebar, RefreshAgentSessionsViewerAction, FindAgentSessionInViewerAction, MarkAgentSessionUnreadAction, MarkAgentSessionReadAction, FocusAgentSessionsAction, PickAgentSessionAction, ArchiveAllAgentSessionsAction, MarkAllAgentSessionsReadAction, RenameAgentSessionAction, DeleteAgentSessionAction, DeleteAllLocalSessionsAction, MarkAgentSessionSectionReadAction, ToggleShowAgentSessionsAction, UnarchiveAgentSessionSectionAction, PinAgentSessionAction, UnpinAgentSessionAction, CollapseAllAgentSessionSectionsAction } from './agentSessionsActions.js';
import { AgentSessionsQuickAccessProvider, AGENT_SESSIONS_QUICK_ACCESS_PREFIX } from './agentSessionsQuickAccess.js';
import { AgentHostPermissionUiContribution } from './agentHost/agentHostPermissionUiContribution.js';
import './agentHost/agentHostChatInputPicker.contribution.js';

//#region Actions and Menus

registerAction2(FocusAgentSessionsAction);
registerAction2(PickAgentSessionAction);
registerAction2(ArchiveAllAgentSessionsAction);
registerAction2(MarkAllAgentSessionsReadAction);
registerAction2(ArchiveAgentSessionSectionAction);
registerAction2(UnarchiveAgentSessionSectionAction);
registerAction2(MarkAgentSessionSectionReadAction);
registerAction2(CollapseAllAgentSessionSectionsAction);
registerAction2(ArchiveAgentSessionAction);
registerAction2(UnarchiveAgentSessionAction);
registerAction2(PinAgentSessionAction);
registerAction2(UnpinAgentSessionAction);
registerAction2(RenameAgentSessionAction);
registerAction2(DeleteAgentSessionAction);
registerAction2(DeleteAllLocalSessionsAction);
registerAction2(MarkAgentSessionUnreadAction);
registerAction2(MarkAgentSessionReadAction);
registerAction2(OpenAgentSessionInNewWindowAction);
registerAction2(OpenAgentSessionInEditorGroupAction);
registerAction2(OpenAgentSessionInNewEditorGroupAction);
registerAction2(RefreshAgentSessionsViewerAction);
registerAction2(FindAgentSessionInViewerAction);
registerAction2(ShowAgentSessionsSidebar);
registerAction2(HideAgentSessionsSidebar);
registerAction2(ToggleAgentSessionsSidebar);
registerAction2(ToggleShowAgentSessionsAction);


// --- Agent Sessions Toolbar

MenuRegistry.appendMenuItem(MenuId.AgentSessionsToolbar, {
	command: {
		id: 'workbench.action.chat.newChat',
		title: localize2('newAgentSession', "New Chat"),
		icon: Codicon.plus,
	},
	group: 'navigation',
	order: 0,
});

MenuRegistry.appendMenuItem(MenuId.AgentSessionsToolbar, {
	submenu: MenuId.AgentSessionsViewerFilterSubMenu,
	title: localize2('filterAgentSessions', "Filter Agent Sessions"),
	group: 'navigation',
	order: 3,
	icon: Codicon.filter,
} satisfies ISubmenuItem);


//#endregion

//#region Quick Access

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: AgentSessionsQuickAccessProvider,
	prefix: AGENT_SESSIONS_QUICK_ACCESS_PREFIX,
	contextKey: 'inAgentSessionsPicker',
	when: ChatContextKeys.enabled,
	placeholder: localize('agentSessionsQuickAccessPlaceholder', "Search agent sessions by name"),
	helpEntries: [{
		description: localize('agentSessionsQuickAccessHelp', "Show All Agent Sessions"),
		commandId: 'workbench.action.chat.history',
	}]
});

//#endregion

//#region Workbench Contributions

registerWorkbenchContribution2(LocalAgentsSessionsController.ID, LocalAgentsSessionsController, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AgentHostPermissionUiContribution.ID, AgentHostPermissionUiContribution, WorkbenchPhase.BlockRestore);

registerSingleton(IAgentSessionsService, AgentSessionsService, InstantiationType.Delayed);

//#endregion
