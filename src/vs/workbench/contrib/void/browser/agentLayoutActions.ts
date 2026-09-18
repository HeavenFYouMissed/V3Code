/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IAgentLayoutService } from './agentLayoutService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

export const TOGGLE_UNIFIED_SIDEBAR_ID = 'workbench.action.toggleUnifiedSidebar';
export const TOGGLE_UNIFIED_SIDEBAR_KEYBOARD_ID = 'workbench.action.toggleUnifiedSidebarFromKeyboard';
export const SHOW_UNIFIED_SIDEBAR_ID = 'workbench.action.showUnifiedSidebar';
export const HIDE_UNIFIED_SIDEBAR_ID = 'workbench.action.hideUnifiedSidebar';
export const MAXIMIZE_CHAT_SIZE_ID = 'workbench.action.maximizeChatSize';

class ToggleUnifiedSidebarAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_UNIFIED_SIDEBAR_ID,
			title: localize2('toggleAgentsSideBar', "Toggle Agents Side Bar"),
			f1: true,
			category: localize2('view', "View"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAgentLayoutService).toggleAgentsSidebar();
	}
}

class ShowUnifiedSidebarAction extends Action2 {
	constructor() {
		super({
			id: SHOW_UNIFIED_SIDEBAR_ID,
			title: localize2('showAgentsSideBar', "Show Agents Side Bar"),
			f1: true,
			category: localize2('view', "View"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAgentLayoutService).showAgentsSidebar(true);
	}
}

class HideUnifiedSidebarAction extends Action2 {
	constructor() {
		super({
			id: HIDE_UNIFIED_SIDEBAR_ID,
			title: localize2('hideAgentsSideBar', "Hide Agents Side Bar"),
			f1: true,
			category: localize2('view', "View"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAgentLayoutService).hideAgentsSidebar();
	}
}

class ToggleUnifiedSidebarFromKeyboardAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_UNIFIED_SIDEBAR_KEYBOARD_ID,
			title: localize2('toggleAgentsSideBarKeyboard', "Toggle Agents Side Bar"),
			f1: false,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyU,
				weight: KeybindingWeight.WorkbenchContrib + 600,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAgentLayoutService).toggleAgentsSidebar();
	}
}

class MaximizeChatSizeAction extends Action2 {
	constructor() {
		super({
			id: MAXIMIZE_CHAT_SIZE_ID,
			title: localize2('maximizeChatSize', "Maximize Chat Size"),
			f1: true,
			category: localize2('view', "View"),
			// Keybinding only — do NOT put on MenuId.ViewTitle (it was leaking onto every view).
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyE,
				weight: KeybindingWeight.WorkbenchContrib + 600,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const layout = accessor.get(IWorkbenchLayoutService);
		const agentLayout = accessor.get(IAgentLayoutService);
		const maximized = layout.isAuxiliaryBarMaximized();
		if (maximized) {
			layout.setAuxiliaryBarMaximized(false);
			return;
		}
		layout.setAuxiliaryBarMaximized(true, {
			skipHideSidebar: true,
			skipHideUnifiedSidebar: agentLayout.agentsSidebarVisible,
			skipHidePanel: true,
		});
	}
}

registerAction2(ToggleUnifiedSidebarAction);
registerAction2(ToggleUnifiedSidebarFromKeyboardAction);
registerAction2(ShowUnifiedSidebarAction);
registerAction2(HideUnifiedSidebarAction);
registerAction2(MaximizeChatSizeAction);
