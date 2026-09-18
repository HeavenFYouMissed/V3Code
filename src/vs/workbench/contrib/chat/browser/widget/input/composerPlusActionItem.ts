/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as dom from '../../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { AICustomizationManagementCommands } from '../../aiCustomization/aiCustomizationManagement.js';
import { V3_ATTACH_TO_COMPOSER_COMMAND_ID } from '../../actions/chatExecuteActions.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';

export interface IComposerPlusDelegate {
	readonly polishPrompt: () => Promise<void>;
}

/** The Codex-style composer + sheet, backed exclusively by existing V3Code commands. */
export class ComposerPlusActionItem extends ChatInputPickerActionViewItem {

	constructor(
		action: MenuItemAction,
		private readonly delegate: IComposerPlusDelegate,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		const addCategory = { label: localize('composerPlus.add', "Add"), order: 0, showHeader: true };
		const improveCategory = { label: localize('composerPlus.improve', "Improve"), order: 1, showHeader: true };
		const createCategory = { label: localize('composerPlus.create', "Create"), order: 2, showHeader: true };
		const commandAction = (id: string, label: string, detail: string, icon: ThemeIcon, category: typeof addCategory, passChatContext = false, hover?: string): IActionWidgetDropdownAction => ({
			...action,
			id,
			label,
			detail,
			icon,
			category,
			checked: false,
			enabled: true,
			tooltip: '',
			hover: hover ? { content: hover } : undefined,
			run: () => passChatContext
				? this.commandService.executeCommand(id, this.pickerOptions.actionContext)
				: this.commandService.executeCommand(id),
		});

		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => [
				commandAction(
					V3_ATTACH_TO_COMPOSER_COMMAND_ID,
					localize('composerPlus.files', "Files and images"),
					localize('composerPlus.files.detail', "Attach from your Mac"),
					Codicon.attach,
					addCategory,
				),
				commandAction(
					'workbench.action.chat.attachContext',
					localize('composerPlus.context', "Project context"),
					localize('composerPlus.context.detail', "Files, symbols, browser, terminal, and more"),
					Codicon.mention,
					addCategory,
					true,
				),
				{
					...action,
					id: 'v3code.chat.polishPrompt',
					label: localize('composerPlus.polish', "Expand prompt"),
					detail: localize('composerPlus.polish.detail', "Turn a rough idea into a complete build brief"),
					icon: Codicon.editSparkle,
					category: improveCategory,
					checked: false,
					enabled: true,
					tooltip: '',
					run: () => this.delegate.polishPrompt(),
				},
				commandAction(
					AICustomizationManagementCommands.CreateNewSkill,
					localize('composerPlus.skill', "New skill"),
					localize('composerPlus.skill.detail', "Fill in a short guide; V3Code writes and opens SKILL.md"),
					Codicon.sparkle,
					createCategory,
					false,
					localize(
						'composerPlus.skill.hover',
						"A skill is reusable guidance the agent loads for matching work.\n\n1. Click New skill.\n2. Fill in the name, when to use it, the steps, and any rules or examples.\n3. Send the message. V3Code creates SKILL.md and opens it for review."
					),
				),
				commandAction(
					AICustomizationManagementCommands.CreateNewAgent,
					localize('composerPlus.agent', "New agent"),
					localize('composerPlus.agent.detail', "Start /create-agent for a specialized mode"),
					Codicon.hubot,
					createCategory,
				),
				commandAction(
					AICustomizationManagementCommands.OpenEditor,
					localize('composerPlus.customize', "Customizations"),
					localize('composerPlus.customize.detail', "Manage agents, skills, prompts, and instructions"),
					Codicon.settingsGear,
					createCategory,
				),
			],
		};

		super(action, {
			actionProvider,
			showItemKeybindings: false,
			reporter: { id: 'V3ComposerPlus', name: 'V3ComposerPlus', includeOptions: true },
			listOptions: { minWidth: 330, detailItemHeight: 44 },
		}, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);
		dom.reset(element, ...renderLabelWithIcons('$(add)'));
		element.classList.add('v3-composer-plus');
		element.setAttribute('aria-label', localize('composerPlus.aria', "Add files or context, polish the prompt, or create a skill or agent"));
		return null;
	}
}
