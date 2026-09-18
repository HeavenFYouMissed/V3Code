/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * External agents strip for the Agents rail: one chip per enabled agent
 * that speaks the Agent Client Protocol (ACP), sitting above the Turbo dock.
 * Hidden entirely while nothing is enabled, so the rail looks exactly as
 * before until the user opts in under Settings > Agents.
 */

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IExternalAgentsService, type IExternalAgentsState } from '../common/externalAgentsService.js';
import { getExternalAgentSessionIcon } from '../../chat/browser/agentSessions/agentSessions.js';

const STYLES = `
.monaco-workbench .part.unifiedsidebar .external-agents-dock {
	flex: 0 0 auto;
	display: none;
	flex-direction: column;
	gap: 4px;
	margin: 2px 10px 6px;
	padding: 6px 8px 8px;
	border-radius: 12px;
	border: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
	background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock.is-visible {
	display: flex;
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock-head {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	letter-spacing: 0.02em;
	text-transform: uppercase;
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock-head .codicon {
	font-size: 12px;
	opacity: 0.8;
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock-title {
	flex: 1 1 auto;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock-settings {
	appearance: none;
	border: 0;
	background: transparent;
	color: inherit;
	cursor: pointer;
	padding: 2px;
	border-radius: 4px;
	line-height: 1;
	opacity: 0.7;
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock-settings:hover {
	opacity: 1;
	background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
}
.monaco-workbench .part.unifiedsidebar .external-agents-chips {
	display: flex;
	max-height: 180px;
	overflow-y: auto;
	flex-wrap: wrap;
	gap: 6px;
}
.monaco-workbench .part.unifiedsidebar .external-agents-chips[hidden] { display: none; }
.monaco-workbench .part.unifiedsidebar .external-agents-dock-toggle {
	display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;
	border: 0; padding: 3px 0; background: transparent; color: inherit;
	font: inherit; text-transform: inherit; cursor: pointer; border-radius: 6px;
}
.monaco-workbench .part.unifiedsidebar .external-agents-dock-toggle:focus:not(:focus-visible) { outline: none; }
.monaco-workbench .part.unifiedsidebar .external-agents-dock-toggle:focus-visible {
	outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip {
	appearance: none;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	max-width: 100%;
	height: 26px;
	padding: 0 8px 0 4px;
	border-radius: 999px;
	border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
	background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
	color: var(--vscode-foreground);
	font-size: 12px;
	cursor: pointer;
	text-align: left;
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip:hover {
	background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
	border-color: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip:focus-visible {
	outline: none;
	border-color: color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent);
	box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip.is-unavailable {
	opacity: 0.55;
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip-monogram {
	flex: 0 0 auto;
	width: 18px;
	height: 18px;
	border-radius: 999px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 10px;
	font-weight: 600;
	background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
	color: var(--vscode-foreground);
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip-label {
	flex: 1 1 auto;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.monaco-workbench .part.unifiedsidebar .external-agents-chip-dot {
	flex: 0 0 auto;
	width: 6px;
	height: 6px;
	border-radius: 999px;
	background: var(--vscode-notificationsWarningIcon-foreground, #cca700);
}
`;

let stylesInjected = false;
function injectStyles(): void {
	if (stylesInjected) { return; }
	stylesInjected = true;
	const el = document.createElement('style');
	el.textContent = STYLES;
	document.head.appendChild(el);
}

function monogram(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return '?';
	}
	if (words.length === 1) {
		return words[0].slice(0, 2).toUpperCase();
	}
	return (words[0][0] + words[1][0]).toUpperCase();
}

export class ExternalAgentsDock extends Disposable {
	readonly element: HTMLElement;
	private readonly _chips: HTMLElement;
	private readonly _chipListeners = this._register(new DisposableStore());
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(
		@IExternalAgentsService private readonly _externalAgents: IExternalAgentsService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		injectStyles();
		this.element = $('.external-agents-dock');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('externalAgents.dockAria', "External agents"));

		const head = append(this.element, $('.external-agents-dock-head'));
		const toggle = append(head, $('button.external-agents-dock-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		const headIcon = append(toggle, $('span'));
		headIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.plug));
		append(toggle, $('span.external-agents-dock-title')).textContent = localize('externalAgents.dockTitle', "Agents · ACP");
		const chevron = append(toggle, $('span'));
		const settings = append(head, $('button.external-agents-dock-settings')) as HTMLButtonElement;
		settings.type = 'button';
		settings.title = localize('externalAgents.manage', "Manage external agents");
		settings.setAttribute('aria-label', settings.title);
		const settingsIcon = append(settings, $('span'));
		settingsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));
		this._register(addDisposableListener(settings, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			void this._externalAgents.openSettings();
		}));

		this._chips = append(this.element, $('.external-agents-chips'));
		// V3Code: preserve the user's rail preference without disabling any agent.
		let collapsed = this._storageService.getBoolean('v3code.acpDock.collapsed', StorageScope.PROFILE, false);
		const updateCollapsed = () => {
			this._chips.hidden = collapsed;
			toggle.setAttribute('aria-expanded', String(!collapsed));
			chevron.className = ThemeIcon.asClassName(collapsed ? Codicon.chevronRight : Codicon.chevronDown);
			this._onDidChangeHeight.fire();
		};
		updateCollapsed();
		this._register(addDisposableListener(toggle, EventType.CLICK, () => {
			collapsed = !collapsed;
			this._storageService.store('v3code.acpDock.collapsed', collapsed, StorageScope.PROFILE, StorageTarget.USER);
			updateCollapsed();
		}));

		this._register(this._externalAgents.onDidChangeState(state => this._render(state)));
		this._render(this._externalAgents.state);
	}

	private _render(state: IExternalAgentsState): void {
		this._chipListeners.clear();
		clearNode(this._chips);

		const enabled = state.catalogue.agents.filter(a => state.catalogue.enabledIds.includes(a.id));
		for (const entry of enabled) {
			const hosted = state.hosted.get(entry.id);
			const chip = append(this._chips, $('button.external-agents-chip')) as HTMLButtonElement;
			chip.type = 'button';
			const unavailable = !state.hostEnabled || !hosted || hosted.description.startsWith('Command not found') || hosted.description.startsWith('No launch command');
			chip.classList.toggle('is-unavailable', unavailable);
			const mark = append(chip, $('span.external-agents-chip-monogram'));
			const icon = getExternalAgentSessionIcon(`acp-${entry.id}`);
			if (icon) {
				mark.classList.add(...ThemeIcon.asClassNameArray(icon));
			} else {
				mark.textContent = monogram(entry.name);
			}
			mark.setAttribute('aria-hidden', 'true');
			append(chip, $('span.external-agents-chip-label')).textContent = entry.name;
			if (unavailable) {
				append(chip, $('span.external-agents-chip-dot'));
			}
			const status = !state.hostEnabled
				? localize('externalAgents.chip.hostOff', "Local agent host is off")
				: hosted
					? hosted.description
					: localize('externalAgents.chip.pending', "Waiting for the agent host to register it");
			chip.title = `${entry.name} · ${status}`;
			chip.setAttribute('aria-label', localize('externalAgents.chip.aria', "Open a new chat with {0}", entry.name));
			this._chipListeners.add(addDisposableListener(chip, EventType.CLICK, e => {
				e.preventDefault();
				void this._externalAgents.openChat(entry.id, 'sidebar');
			}));
		}

		const visible = enabled.length > 0;
		this.element.classList.toggle('is-visible', visible);
		this._onDidChangeHeight.fire();
	}
}
