/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/agentSessionsViewPane.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IChatWidgetService } from '../chat.js';
import { AgentSessionsControl } from './agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from './agentSessionsFilter.js';

export const AgentSessionsViewId = 'workbench.panel.chat.sessions';
export const AgentSessionsViewContainerId = 'workbench.view.v3code.agentSessions';

export class AgentSessionsViewPane extends ViewPane {

	private sessionsControl: AgentSessionsControl | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super({ ...options, titleMenuId: MenuId.AgentSessionsToolbar }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.classList.add('agent-sessions-workbench-view');

		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewerFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Capped,
			overrideExclude: session => {
				const folders = this.workspaceContextService.getWorkspace().folders;
				if (!folders.length) {
					return undefined;
				}

				const workingDirectoryPath = session.metadata?.workingDirectoryPath;
				if (!workingDirectoryPath) {
					return true;
				}

				const workingDirectory = URI.file(workingDirectoryPath);
				return !folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(workingDirectory, folder.uri));
			},
		}));
		const controlContainer = append(parent, $('.agent-sessions-workbench-list'));
		const control = this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, controlContainer, {
			source: 'agentSessionsViewPane',
			filter,
			disableHover: true,
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			getHoverPosition: () => HoverPosition.RIGHT,
			trackActiveEditorSession: () => true,
			useStatusOnlyIcons: true,
			overrideSessionOpenOptions: openEvent => ({
				...openEvent,
				editorOptions: { ...openEvent.editorOptions, preserveFocus: false }
			}),
		}));

		control.setVisible(this.isBodyVisible());
		this._register(this.onDidChangeBodyVisibility(visible => control.setVisible(visible)));
		this._register(this.hostService.onDidChangeFocus(hasFocus => {
			if (hasFocus) {
				control.refresh();
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => control.update()));
		this._register(Event.runAndSubscribe(this.chatWidgetService.onDidChangeFocusedSession, () => {
			const resource = this.chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource;
			if (resource) {
				control.reveal(resource);
			} else {
				control.clearFocus();
			}
		}));

	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.sessionsControl?.layout(height, width);
	}

	override focus(): void {
		super.focus();
		this.sessionsControl?.focus();
	}

	refresh(): void {
		this.sessionsControl?.refresh();
	}

	find(): void {
		this.sessionsControl?.openFind();
	}

	getFocusedSessions() {
		return this.sessionsControl?.getFocus() ?? [];
	}
}
