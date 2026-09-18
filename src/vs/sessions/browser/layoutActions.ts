/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { alert } from '../../base/browser/ui/aria/aria.js';
import { Codicon } from '../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { localize, localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { Menus } from './menus.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../platform/keybinding/common/keybindingsRegistry.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { AuxiliaryBarVisibleContext, IsAuxiliaryWindowContext, IsWindowAlwaysOnTopContext, MainEditorAreaVisibleContext, PanelVisibleContext, SideBarVisibleContext } from '../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { SessionsWelcomeVisibleContext } from '../common/contextkeys.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { BrowserViewCommandId } from '../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { mainWindow } from '../../base/browser/window.js';

/**
 * Command/container ids referenced by the "+" menu. Kept as literals because
 * import layering forbids reaching into vs/workbench/contrib or
 * vs/sessions/contrib from this layer:
 * - OpenSessionInTerminalAction (sessions terminal contribution)
 * - CHANGES_VIEW_CONTAINER_ID (sessions changes contrib)
 * - SESSIONS_FILES_CONTAINER_ID (sessions files contrib)
 */
const OPEN_SESSION_TERMINAL_COMMAND_ID = 'agentSession.openInTerminal';
const CHANGES_VIEW_CONTAINER_ID = 'workbench.view.agentSessions.changesContainer';
const SESSIONS_FILES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.filesContainer';

// Register Icons
const panelCloseIcon = registerIcon('agent-panel-close', Codicon.close, localize('agentPanelCloseIcon', "Icon to close the panel."));
const sidebarToggleClosedIcon = registerIcon('agent-sidebar-toggle-closed', Codicon.layoutSidebarLeftOff, localize('agentSidebarToggleClosedIcon', "Icon for the sessions sidebar when closed."));
const sidebarToggleOpenIcon = registerIcon('agent-sidebar-toggle-open', Codicon.layoutSidebarLeft, localize('agentSidebarToggleOpenIcon', "Icon for the sessions sidebar when open."));

class ToggleSidebarVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleSidebarVisibility';

	constructor() {
		super({
			id: ToggleSidebarVisibilityAction.ID,
			title: localize2('toggleSidebar', 'Toggle Primary Side Bar Visibility'),
			icon: sidebarToggleClosedIcon,
			toggled: {
				condition: SideBarVisibleContext,
				icon: sidebarToggleOpenIcon,
			},
			metadata: {
				description: localize('openAndCloseSidebar', 'Open/Show and Close/Hide Sidebar'),
			},
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyB
			},
			menu: [
				{
					id: Menus.TitleBarLeftLayout,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated())
				},
				{
					// Cursor-style: park the sessions toggle in the chat top veil
					// while the rail is open. When collapsed, the floating
					// reopen chrome owns the single toggle (avoid duplicates).
					id: Menus.ChatBarChromeLeft,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SideBarVisibleContext)
				},
				{
					// Also on the legacy ChatBarTitle menu for any other chrome hosts.
					id: Menus.ChatBarTitle,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SideBarVisibleContext)
				},
				{
					// Only when the rail is collapsed — powers the floating reopen chrome.
					// Never while the sidebar is open (that was the duplicate-icon bug).
					id: Menus.SidebarTitle,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SideBarVisibleContext.toNegated())
				},
				{
					id: Menus.TitleBarContext,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated())
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isCurrentlyVisible = layoutService.isVisible(Parts.SIDEBAR_PART);

		layoutService.setPartHidden(isCurrentlyVisible, Parts.SIDEBAR_PART);

		// Announce visibility change to screen readers
		const alertMessage = isCurrentlyVisible
			? localize('sidebarHidden', "Primary Side Bar hidden")
			: localize('sidebarVisible', "Primary Side Bar shown");
		alert(alertMessage);
	}
}

class ToggleSecondarySidebarVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleSecondarySidebarVisibility';

	constructor() {
		super({
			id: ToggleSecondarySidebarVisibilityAction.ID,
			title: localize2('toggleSecondarySidebar', 'Toggle Secondary Side Bar Visibility'),
			icon: panelCloseIcon,
			metadata: {
				description: localize('openAndCloseSecondarySidebar', 'Open/Show and Close/Hide Secondary Side Bar'),
			},
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: Menus.TitleBarContext,
					order: 1,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated())
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isCurrentlyVisible = layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		layoutService.setPartHidden(isCurrentlyVisible, Parts.AUXILIARYBAR_PART);

		// Announce visibility change to screen readers
		const alertMessage = isCurrentlyVisible
			? localize('secondarySidebarHidden', "Secondary Side Bar hidden")
			: localize('secondarySidebarVisible', "Secondary Side Bar shown");
		alert(alertMessage);
	}
}

class TogglePanelVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentTogglePanelVisibility';

	constructor() {
		super({
			id: TogglePanelVisibilityAction.ID,
			title: localize2('togglePanel', 'Toggle Panel Visibility'),
			category: Categories.View,
			f1: true,
			icon: panelCloseIcon,
			menu: [
				{
					id: Menus.PanelTitle,
					group: 'navigation',
					order: 2,
					when: IsAuxiliaryWindowContext.toNegated()
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.PANEL_PART), Parts.PANEL_PART);
	}
}

class ShowBrowserAction extends Action2 {
	static readonly ID = 'sessions.rightBlock.showBrowser';

	constructor() {
		super({
			id: ShowBrowserAction.ID,
			title: localize2('showBrowser', 'Browser'),
			icon: Codicon.globe,
			category: Categories.View,
			f1: true,
			menu: [{
				id: MenuId.EditorTitleStart,
				group: 'navigation',
				order: 1,
				when: IsAuxiliaryWindowContext.toNegated()
			}]
		});
	}

	run(accessor: ServicesAccessor): Promise<unknown> {
		const contextKeyService = accessor.get(IContextKeyService);
		if (contextKeyService.getContextKeyValue<boolean>('v3code.agentMode') === true) {
			const layoutService = accessor.get(IWorkbenchLayoutService);
			// The title-bar Browser button is available in both IDE and V3 Flow. In
			// Flow it used to bypass v3SoloTabs and inherit whatever panel state was
			// left behind by Terminal, producing Browser-over-Terminal and then a huge
			// Terminal when the browser editor closed. Normalize the temporary
			// workplace before opening Browser while leaving the Agents rail intact.
			if (layoutService.isAuxiliaryBarMaximized()) {
				layoutService.setAuxiliaryBarMaximized(false);
			}
			if (layoutService.isPanelMaximized()) {
				layoutService.toggleMaximizedPanel();
			}
			layoutService.setPartHidden(true, Parts.PANEL_PART);
			layoutService.setPartHidden(false, Parts.EDITOR_PART);
		}
		return accessor.get(ICommandService).executeCommand(BrowserViewCommandId.Open);
	}
}

/**
 * Toggles the attached Changes/Files rail in the right block with the given
 * view container active. The rail sits under the shared tab strip beside the
 * active workplace preview. Clicking the already-active pill closes it.
 */
class ShowAttachedContainerAction extends Action2 {
	constructor(id: string, title: ReturnType<typeof localize2>, private readonly containerId: string) {
		super({
			id,
			title,
			category: Categories.View,
			f1: true,
			toggled: ContextKeyExpr.and(
				AuxiliaryBarVisibleContext,
				ContextKeyExpr.equals('activeAuxiliary', containerId),
			),
			menu: [{
				id: MenuId.EditorTitle,
				group: 'navigation',
				// After the tabs and the "+" — pinned toward the right end
				// of the strip, like Cursor's Changes/Files pills.
				order: id.endsWith('showChanges') ? 90 : 91,
				when: IsAuxiliaryWindowContext.toNegated()
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const paneCompositeService = accessor.get(IPaneCompositePartService);

		if (layoutService.isVisible(Parts.PANEL_PART)) {
			layoutService.setPartHidden(true, Parts.PANEL_PART);
		}

		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await paneCompositeService.openPaneComposite(this.containerId, ViewContainerLocation.AuxiliaryBar, true);
	}
}

class ShowTerminalAction extends Action2 {
	static readonly ID = 'sessions.rightBlock.showTerminal';

	constructor() {
		super({
			id: ShowTerminalAction.ID,
			title: localize2('showTerminal', 'Terminal'),
			category: Categories.View,
			f1: true,
			toggled: ContextKeyExpr.equals('sessionsTerminalViewVisible', true),
			menu: [{
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 89,
				when: IsAuxiliaryWindowContext.toNegated()
			}]
		});
	}

	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(OPEN_SESSION_TERMINAL_COMMAND_ID);
	}
}

class ToggleWorkplaceStageVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleWorkplaceStageVisibility';

	constructor() {
		super({
			id: ToggleWorkplaceStageVisibilityAction.ID,
			title: localize2('toggleWorkplaceStage', 'Toggle Workplace Stage'),
			icon: Codicon.layoutSidebarRightOff,
			toggled: {
				condition: ContextKeyExpr.or(
					MainEditorAreaVisibleContext,
					PanelVisibleContext,
					AuxiliaryBarVisibleContext,
				)!,
				icon: Codicon.layoutSidebarRight,
			},
			metadata: {
				description: localize('openAndCloseWorkplace', 'Show or hide the Workplace stage (Browser / Terminal / Files)'),
			},
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: Menus.ChatBarChromeRight,
					group: 'navigation',
					order: 10,
					when: IsAuxiliaryWindowContext.toNegated()
				},
				{
					id: Menus.ChatBarTitle,
					group: 'navigation',
					order: 10,
					when: IsAuxiliaryWindowContext.toNegated()
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const workplaceVisible = layoutService.isVisible(Parts.EDITOR_PART, mainWindow)
			|| layoutService.isVisible(Parts.PANEL_PART)
			|| layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		if (workplaceVisible) {
			// Hide every workplace surface. Order matters only for state;
			// desktop no longer force-reopens the editor via fallback.
			layoutService.setPartHidden(true, Parts.PANEL_PART);
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			layoutService.setPartHidden(true, Parts.EDITOR_PART);
		} else {
			layoutService.setPartHidden(false, Parts.EDITOR_PART);
		}
	}
}

class MaximizeChatOverWorkplaceAction extends Action2 {

	static readonly ID = 'workbench.action.agentMaximizeChatOverWorkplace';

	constructor() {
		super({
			id: MaximizeChatOverWorkplaceAction.ID,
			title: localize2('maximizeChatOverWorkplace', 'Expand Chat Over Workplace'),
			icon: Codicon.screenFull,
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: Menus.ChatBarChromeRight,
					group: 'navigation',
					order: 9,
					when: IsAuxiliaryWindowContext.toNegated()
				},
				{
					id: Menus.ChatBarTitle,
					group: 'navigation',
					order: 9,
					when: IsAuxiliaryWindowContext.toNegated()
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const workplaceVisible = layoutService.isVisible(Parts.EDITOR_PART, mainWindow)
			|| layoutService.isVisible(Parts.PANEL_PART)
			|| layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		// Maximize = always collapse workplace so chat takes the stage.
		// (Toggle is the open/close control next to it.)
		if (workplaceVisible) {
			layoutService.setPartHidden(true, Parts.PANEL_PART);
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			layoutService.setPartHidden(true, Parts.EDITOR_PART);
		}
	}
}

class ShowChangesAction extends ShowAttachedContainerAction {
	static readonly ID = 'sessions.rightBlock.showChanges';
	constructor() {
		super(ShowChangesAction.ID, localize2('showChanges', 'Changes'), CHANGES_VIEW_CONTAINER_ID);
	}
}

class ShowFilesAction extends ShowAttachedContainerAction {
	static readonly ID = 'sessions.rightBlock.showFiles';
	constructor() {
		super(ShowFilesAction.ID, localize2('showFiles', 'Files'), SESSIONS_FILES_CONTAINER_ID);
	}
}

registerAction2(ToggleSidebarVisibilityAction);
registerAction2(ToggleSecondarySidebarVisibilityAction);
registerAction2(TogglePanelVisibilityAction);
registerAction2(ToggleWorkplaceStageVisibilityAction);
registerAction2(MaximizeChatOverWorkplaceAction);
registerAction2(ShowBrowserAction);
registerAction2(ShowTerminalAction);
registerAction2(ShowChangesAction);
registerAction2(ShowFilesAction);

// --- Leading "+" (Cursor left-rail launcher) + trailing mode pills ----------
// Browser globe and "+" live LEFT of tabs (MenuId.EditorTitleStart). Terminal /
// Changes / Files stay on the right end of the strip.

MenuRegistry.appendMenuItem(MenuId.EditorTitleStart, {
	submenu: Menus.RightBlockAdd,
	title: localize('rightBlockAdd', "Open in Panel"),
	icon: Codicon.plus,
	group: 'navigation',
	order: 2,
	when: IsAuxiliaryWindowContext.toNegated()
});

// Keep a trailing "+" as well for discoverability next to mode pills.
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	submenu: Menus.RightBlockAdd,
	title: localize('rightBlockAdd', "Open in Panel"),
	icon: Codicon.plus,
	group: 'navigation',
	order: 92,
	when: IsAuxiliaryWindowContext.toNegated()
});
MenuRegistry.appendMenuItem(Menus.RightBlockAdd, {
	command: {
		id: 'workbench.action.quickOpen',
		title: localize('rightBlockAdd.file', "File"),
		icon: Codicon.file
	},
	group: '1_content',
	order: 1
});

MenuRegistry.appendMenuItem(Menus.RightBlockAdd, {
	command: {
		id: ShowTerminalAction.ID,
		title: localize('rightBlockAdd.terminal', "Terminal"),
		icon: Codicon.terminal
	},
	group: '1_content',
	order: 2
});

MenuRegistry.appendMenuItem(Menus.RightBlockAdd, {
	command: {
		id: ShowBrowserAction.ID,
		title: localize('rightBlockAdd.browser', "Browser"),
		icon: Codicon.globe
	},
	group: '1_content',
	order: 3
});

MenuRegistry.appendMenuItem(Menus.RightBlockAdd, {
	command: {
		id: ShowChangesAction.ID,
		title: localize('rightBlockAdd.changes', "Changes"),
		icon: Codicon.diffMultiple
	},
	group: '2_views',
	order: 1
});

MenuRegistry.appendMenuItem(Menus.RightBlockAdd, {
	command: {
		id: ShowFilesAction.ID,
		title: localize('rightBlockAdd.files', "Files"),
		icon: Codicon.files
	},
	group: '2_views',
	order: 2
});

// Floating window controls: always-on-top
MenuRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
	command: {
		id: 'workbench.action.toggleWindowAlwaysOnTop',
		title: localize('toggleWindowAlwaysOnTop', "Toggle Always on Top"),
		icon: Codicon.pin,
		toggled: {
			condition: IsWindowAlwaysOnTopContext,
			icon: Codicon.pinned,
		},
	},
	when: IsAuxiliaryWindowContext,
	group: 'navigation',
	order: 0
});
