/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { MenuId } from '../../platform/actions/common/actions.js';

/**
 * Menu IDs for the Agent Sessions workbench layout.
 */
export const Menus = {
	ChatBarTitle: new MenuId('ChatBarTitle'),
	/** Left cluster in the chat top veil (sidebar toggle). */
	ChatBarChromeLeft: new MenuId('ChatBarChromeLeft'),
	/** Right cluster in the chat top veil (maximize + workplace toggle). */
	ChatBarChromeRight: new MenuId('ChatBarChromeRight'),
	CommandCenter: new MenuId('SessionsCommandCenter'),
	CommandCenterCenter: new MenuId('SessionsCommandCenterCenter'),
	TitleBarContext: new MenuId('SessionsTitleBarContext'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	TitleBarSessionTitle: new MenuId('SessionsTitleBarSessionTitle'),
	TitleBarSessionMenu: new MenuId('SessionsTitleBarSessionMenu'),
	TitleBarRightLayout: new MenuId('SessionsTitleBarRightLayout'),
	MobileTitleBarCenter: new MenuId('SessionsMobileTitleBarCenter'),
	PanelTitle: new MenuId('SessionsPanelTitle'),
	SidebarTitle: new MenuId('SessionsSidebarTitle'),
	SidebarSessionsHeader: new MenuId('SessionsSidebarSessionsHeader'),
	AuxiliaryBarTitle: new MenuId('SessionsAuxiliaryBarTitle'),
	SidebarFooter: new MenuId('SessionsSidebarFooter'),
	SidebarCustomizations: new MenuId('SessionsSidebarCustomizations'),
	SidebarAgentHost: new MenuId('SessionsSidebarAgentHost'),
	AccountMenu: new MenuId('SessionsAccountMenu'),
	GoMenu: new MenuId('SessionsGoMenu'),
	AgentFeedbackEditorContent: new MenuId('AgentFeedbackEditorContent'),

	/** The "+" dropdown at the end of the right-block tab bar. */
	RightBlockAdd: new MenuId('SessionsRightBlockAdd'),

	NewSessionConfig: new MenuId('NewSessions.SessionConfigMenu'),
	NewSessionControl: new MenuId('NewSessions.SessionControlMenu'),
	NewSessionRepositoryConfig: new MenuId('NewSessions.RepositoryConfigMenu'),
	SessionWorkspaceManage: new MenuId('Sessions.SessionWorkspaceManage'),
} as const;
