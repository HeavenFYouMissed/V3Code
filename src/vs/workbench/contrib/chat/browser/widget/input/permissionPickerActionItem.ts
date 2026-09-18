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
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { ChatConfiguration, ChatPermissionLevel } from '../../../common/constants.js';
import { IChatSessionProviderOptionItem, SessionType } from '../../../common/chatSessionsService.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { maybeConfirmElevatedPermissionLevel } from '../../../common/chatPermissionWarnings.js';

export interface IExtensionPermissionState {
	/** Stable identifier for the contributing chat session type, used to namespace action ids. */
	readonly sessionType: string;
	readonly groupId: string;
	readonly items: readonly IChatSessionProviderOptionItem[];
	readonly selectedId: string | undefined;
}

export interface IPermissionPickerDelegate {
	readonly currentPermissionLevel: IObservable<ChatPermissionLevel>;
	readonly setPermissionLevel: (level: ChatPermissionLevel) => void;
	/**
	 * When defined and returns a non-empty state, the picker shows the extension-contributed
	 * items in place of the built-in {@link ChatPermissionLevel} items.
	 */
	readonly getExtensionPermissions?: () => IExtensionPermissionState | undefined;
	readonly setExtensionPermission?: (groupId: string, item: IChatSessionProviderOptionItem) => void;
}

/** Sanitize a free-form id segment so it is safe to embed in a stable action identifier. */
function sanitizeIdSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class PermissionPickerActionItem extends ChatInputPickerActionViewItem {

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose: Event<void> = this._onDidDispose.event;

	constructor(
		action: MenuItemAction,
		private readonly delegate: IPermissionPickerDelegate,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IOpenerService openerService: IOpenerService,
		@IStorageService storageService: IStorageService,
	) {
		const isAutoApprovePolicyRestricted = () => configurationService.inspect<boolean>(ChatConfiguration.GlobalAutoApprove).policyValue === false;
		const isAutopilotEnabled = () => configurationService.getValue<boolean>(ChatConfiguration.AutopilotEnabled) !== false;
		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => {
				// If the active session contributes its own permission items, surface those instead
				// of the built-in Default/AutoApprove/Autopilot levels.
				const ext = delegate.getExtensionPermissions?.();
				if (ext && ext.items.length > 0) {
					const sessionTypeSeg = sanitizeIdSegment(ext.sessionType);
					const groupSeg = sanitizeIdSegment(ext.groupId);
					return ext.items.map(item => ({
						...action,
						id: `chat.permissions.ext.${sessionTypeSeg}.${groupSeg}.${sanitizeIdSegment(item.id)}`,
						label: item.name,
						detail: item.description,
						icon: item.icon,
						checked: ext.selectedId === item.id,
						enabled: !item.locked,
						tooltip: item.locked ? localize('permissions.ext.locked', "This option is locked") : '',
						hover: item.description ? { content: item.description } : undefined,
						run: async () => {
							delegate.setExtensionPermission?.(ext.groupId, item);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction));
				}
				const currentLevel = delegate.currentPermissionLevel.get();
				const policyRestricted = isAutoApprovePolicyRestricted();
				const actions: IActionWidgetDropdownAction[] = [
					{
						...action,
						id: 'chat.permissions.default',
						label: localize('permissions.default', "Ask for approval"),
						detail: localize('permissions.default.subtext', "Pause before tools take actions that need approval"),
						icon: ThemeIcon.fromId(Codicon.shield.id),
						checked: currentLevel === ChatPermissionLevel.Default,
						tooltip: '',
						hover: {
							content: localize('permissions.default.description', "Use configured approval settings"),
						},
						run: async () => {
							delegate.setPermissionLevel(ChatPermissionLevel.Default);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction,
					{
						...action,
						id: 'chat.permissions.autoApprove',
						label: localize('permissions.autoApprove', "Approve for me"),
						detail: localize('permissions.autoApprove.subtext', "Auto-approve tool calls unless policy blocks them"),
						icon: ThemeIcon.fromId(Codicon.warning.id),
						checked: currentLevel === ChatPermissionLevel.AutoApprove,
						enabled: !policyRestricted,
						tooltip: policyRestricted ? localize('permissions.autoApprove.policyDisabled', "Disabled by enterprise policy") : '',
						hover: {
							content: policyRestricted
								? localize('permissions.autoApprove.policyDescription', "Disabled by enterprise policy")
								: localize('permissions.autoApprove.description', "Auto-approve all tool calls and retry on errors"),
						},
						run: async () => {
							if (!await maybeConfirmElevatedPermissionLevel(ChatPermissionLevel.AutoApprove, this.dialogService, storageService)) {
								return;
							}
							delegate.setPermissionLevel(ChatPermissionLevel.AutoApprove);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction,
				];
				if (isAutopilotEnabled()) {
					actions.push({
						...action,
						id: 'chat.permissions.autopilot',
						label: localize('permissions.autopilot', "Autopilot (Preview)"),
						detail: localize('permissions.autopilot.subtext', "Autonomously iterates from start to finish"),
						icon: ThemeIcon.fromId(Codicon.rocket.id),
						checked: currentLevel === ChatPermissionLevel.Autopilot,
						enabled: !policyRestricted,
						tooltip: policyRestricted ? localize('permissions.autopilot.policyDisabled', "Disabled by enterprise policy") : '',
						hover: {
							content: policyRestricted
								? localize('permissions.autopilot.policyDescription', "Disabled by enterprise policy")
								: localize('permissions.autopilot.description', "Auto-approve all tool calls and continue until the task is done"),
						},
						run: async () => {
							if (!await maybeConfirmElevatedPermissionLevel(ChatPermissionLevel.Autopilot, this.dialogService, storageService)) {
								return;
							}
							delegate.setPermissionLevel(ChatPermissionLevel.Autopilot);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					} satisfies IActionWidgetDropdownAction);
				}
				return actions;
			}
		};

		super(action, {
			actionProvider,
			actionBarActions: [{
				id: 'chat.permissions.learnMore',
				label: localize('permissions.learnMore', "Learn more about permissions"),
				tooltip: localize('permissions.learnMore', "Learn more about permissions"),
				class: undefined,
				enabled: true,
				run: async () => {
					const ext = delegate.getExtensionPermissions?.();
					const url = ext?.sessionType === SessionType.ClaudeCode
						? 'https://code.claude.com/docs/en/permission-modes#available-modes'
						: 'https://code.visualstudio.com/docs/copilot/agents/agent-tools#_permission-levels';
					await openerService.open(URI.parse(url));
				}
			}],
			reporter: { id: 'ChatPermissionPicker', name: 'ChatPermissionPicker', includeOptions: true },
			listOptions: { minWidth: 255, detailItemHeight: 44 },
		}, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);

		const ext = this.delegate.getExtensionPermissions?.();
		let label: string;
		const level = this.delegate.currentPermissionLevel.get();

		const labelElements = [];
		// V3Code: full-width composers use readable labels; only narrow composers
		// collapse to the compact D/B/A state mark. Extension-contributed permission
		// groups keep their original icon + name.
		let v3State: 'default' | 'bypass' | 'auto' | undefined;
		if (ext && ext.items.length > 0) {
			const selected = ext.items.find(i => i.id === ext.selectedId)
				?? ext.items.find(i => i.default)
				?? ext.items[0];
			const icon: ThemeIcon = selected.icon ?? Codicon.lock;
			label = selected.name;
			labelElements.push(...renderLabelWithIcons(`$(${icon.id})`));
			labelElements.push(dom.$('span.chat-input-picker-label', undefined, label));
		} else {
			let letter: string;
			let shortLabel: string;
			let icon: ThemeIcon;
			switch (level) {
				case ChatPermissionLevel.Autopilot:
					letter = 'A';
					shortLabel = localize('permissions.autopilot.shortLabel', "Autopilot");
					icon = Codicon.rocket;
					v3State = 'auto';
					label = localize('permissions.autopilot.label', "Autopilot (Preview)");
					break;
				case ChatPermissionLevel.AutoApprove:
					letter = 'B';
					shortLabel = localize('permissions.autoApprove.shortLabel', "Approve");
					icon = Codicon.shield;
					v3State = 'bypass';
					label = localize('permissions.autoApprove.label', "Approve for me");
					break;
				default:
					letter = 'D';
					shortLabel = localize('permissions.default.shortLabel', "Ask");
					icon = Codicon.shield;
					v3State = 'default';
					label = localize('permissions.default.label', "Ask for approval");
					break;
			}
			if (this.pickerOptions.compact.get()) {
				labelElements.push(dom.$('span.chat-input-picker-label.v3-perm-letter', undefined, letter));
			} else {
				labelElements.push(...renderLabelWithIcons(`$(${icon.id})`));
				labelElements.push(dom.$('span.chat-input-picker-label.v3-perm-readable', undefined, shortLabel));
			}
		}

		dom.reset(element, ...labelElements);
		element.classList.toggle('warning', !ext && level === ChatPermissionLevel.Autopilot);
		element.classList.toggle('info', !ext && level === ChatPermissionLevel.AutoApprove);
		// V3Code pastel state classes (consumed by void.css).
		element.classList.toggle('v3-perm-default', v3State === 'default');
		element.classList.toggle('v3-perm-bypass', v3State === 'bypass');
		element.classList.toggle('v3-perm-auto', v3State === 'auto');

		// Hovering the single letter should still explain the current level.
		element.title = label;
		element.setAttribute('aria-label', localize('permissions.ariaLabel', "Permission picker, {0}", label));
		return null;
	}

	public refresh(): void {
		if (this.element) {
			this.renderLabel(this.element);
		}
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._onDidDispose.fire();
		super.dispose();
	}
}
