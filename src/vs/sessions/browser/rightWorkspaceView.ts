/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { append, $, size, addDisposableListener } from '../../base/browser/dom.js';
import { ISerializableView, IViewSize } from '../../base/browser/ui/grid/grid.js';
import { LayoutPriority } from '../../base/browser/ui/splitview/splitview.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { Part } from '../../workbench/browser/part.js';
import { Parts } from '../../workbench/services/layout/browser/layoutService.js';

/** Permanent glass stage chrome height (mode rail). */
export const WORKPLACE_STAGE_CHROME_HEIGHT = 40;

/** Outer margin around the iPhone-shaped device (chunky glass breathe). */
export const WORKPLACE_DEVICE_PAD = 14;
/** Metal/glass bezel thickness around the screen. */
export const WORKPLACE_DEVICE_BEZEL = 10;
/** Bottom home-indicator reserve inside the screen. */
export const WORKPLACE_DEVICE_HOME = 14;

export type WorkplaceStageMode = 'browser' | 'code' | 'terminal' | 'files' | 'changes';

/**
 * One glass Workplace Stage for the Agents window.
 *
 * Exactly one surface fills the stage at a time (Browser/Code editor,
 * Terminal, Files, or Changes). No peer AUX/PANEL split-view wrappers
 * fighting the rail — modes own the whole right panel.
 *
 * Visually the leaf is an iPhone-class device: padded bezel + Dynamic Island
 * + home indicator; chrome + surfaces live inside the screen.
 */
export class RightWorkspaceView extends Disposable implements ISerializableView {

	static readonly TYPE = 'workbench.parts.sessionsRightWorkspace';

	readonly element = document.createElement('section');
	readonly priority = LayoutPriority.High;

	private readonly _onDidChange = this._register(new Emitter<IViewSize | undefined>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeMode = this._register(new Emitter<WorkplaceStageMode>());
	readonly onDidChangeMode = this._onDidChangeMode.event;

	private readonly _onDidRequestMode = this._register(new Emitter<WorkplaceStageMode>());
	readonly onDidRequestMode = this._onDidRequestMode.event;

	private readonly deviceEl: HTMLElement;
	private readonly screenEl: HTMLElement;
	private readonly chromeEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly modeButtons = new Map<WorkplaceStageMode, HTMLButtonElement>();

	private width = 0;
	private height = 0;
	private top = 0;
	private left = 0;
	private mode: WorkplaceStageMode = 'browser';

	constructor(
		private readonly editorPart: Part,
		private readonly panelPart: Part,
		private readonly auxiliaryBarPart: Part,
		_initialWidth: number,
		_initialAuxiliaryBarWidth: number,
		editorVisible: boolean,
		panelVisible: boolean,
		auxiliaryBarVisible: boolean,
	) {
		super();

		this.element.classList.add('sessions-right-workspace', 'sessions-workplace-stage');

		this.deviceEl = append(this.element, $('.sessions-workplace-device'));
		append(this.deviceEl, $('.sessions-workplace-device-island'));
		this.screenEl = append(this.deviceEl, $('.sessions-workplace-device-screen'));
		append(this.deviceEl, $('.sessions-workplace-device-home'));

		this.chromeEl = append(this.screenEl, $('.sessions-workplace-stage-chrome'));
		const rail = append(this.chromeEl, $('.sessions-workplace-stage-rail'));
		this.createModeButton(rail, 'browser', 'Browser');
		this.createModeButton(rail, 'terminal', 'Terminal');
		this.createModeButton(rail, 'changes', 'Changes');
		this.createModeButton(rail, 'files', 'Files');
		append(this.chromeEl, $('span.sessions-workplace-stage-hint')).textContent = 'Workplace';

		this.bodyEl = append(this.screenEl, $('.sessions-workplace-stage-body'));

		for (const part of [editorPart, panelPart, auxiliaryBarPart]) {
			part.element.style.position = 'absolute';
			part.element.style.inset = '0';
			this.bodyEl.appendChild(part.element);
		}

		if (panelVisible) {
			this.mode = 'terminal';
		} else if (auxiliaryBarVisible) {
			this.mode = 'files';
		} else if (editorVisible) {
			this.mode = 'browser';
		}

		this.applyMode(this.mode, true);
	}

	get minimumWidth(): number {
		return 280;
	}

	get maximumWidth(): number {
		return Number.POSITIVE_INFINITY;
	}

	get minimumHeight(): number {
		return 0;
	}

	get maximumHeight(): number {
		return Number.POSITIVE_INFINITY;
	}

	get preferredWidth(): number {
		return this.width || 720;
	}

	get size(): IViewSize {
		return { width: this.width, height: this.height };
	}

	get currentMode(): WorkplaceStageMode {
		return this.mode;
	}

	layout(width: number, height: number, top: number, left: number): void {
		this.width = width;
		this.height = height;
		this.top = top;
		this.left = left;

		size(this.element, width, height);

		const pad = WORKPLACE_DEVICE_PAD;
		const bezel = WORKPLACE_DEVICE_BEZEL;
		const home = WORKPLACE_DEVICE_HOME;
		const chrome = WORKPLACE_STAGE_CHROME_HEIGHT;

		const deviceW = Math.max(0, width - pad * 2);
		const deviceH = Math.max(0, height - pad * 2);
		size(this.deviceEl, deviceW, deviceH);
		this.deviceEl.style.left = `${pad}px`;
		this.deviceEl.style.top = `${pad}px`;

		const screenW = Math.max(0, deviceW - bezel * 2);
		const screenH = Math.max(0, deviceH - bezel * 2);
		size(this.screenEl, screenW, screenH);
		this.screenEl.style.left = `${bezel}px`;
		this.screenEl.style.top = `${bezel}px`;

		size(this.chromeEl, screenW, chrome);
		const bodyHeight = Math.max(0, screenH - chrome - home);
		size(this.bodyEl, screenW, bodyHeight);
		this.bodyEl.style.top = `${chrome}px`;

		const screenLeft = left + pad + bezel;
		const bodyTop = top + pad + bezel + chrome;
		this.layoutActivePart(screenW, bodyHeight, bodyTop, screenLeft);
	}

	setVisible(visible: boolean): void {
		this.element.classList.toggle('hidden', !visible);
	}

	isPartVisible(part: Parts): boolean {
		switch (part) {
			case Parts.EDITOR_PART:
				return this.mode === 'browser' || this.mode === 'code';
			case Parts.PANEL_PART:
				return this.mode === 'terminal';
			case Parts.AUXILIARYBAR_PART:
				return this.mode === 'files' || this.mode === 'changes';
			default:
				return false;
		}
	}

	setPartVisible(part: Parts, visible: boolean): void {
		if (!visible) {
			if (
				(part === Parts.EDITOR_PART && (this.mode === 'browser' || this.mode === 'code')) ||
				(part === Parts.PANEL_PART && this.mode === 'terminal') ||
				(part === Parts.AUXILIARYBAR_PART && (this.mode === 'files' || this.mode === 'changes'))
			) {
				this.setMode('browser');
			}
			return;
		}

		switch (part) {
			case Parts.EDITOR_PART:
				this.setMode(this.mode === 'code' ? 'code' : 'browser');
				break;
			case Parts.PANEL_PART:
				this.setMode('terminal');
				break;
			case Parts.AUXILIARYBAR_PART:
				this.setMode(this.mode === 'changes' ? 'changes' : 'files');
				break;
		}
	}

	getPartSize(part: Parts): IViewSize {
		if (!this.isPartVisible(part)) {
			return { width: 0, height: 0 };
		}
		const inset = (WORKPLACE_DEVICE_PAD + WORKPLACE_DEVICE_BEZEL) * 2;
		return {
			width: Math.max(0, this.width - inset),
			height: Math.max(0, this.height - inset - WORKPLACE_STAGE_CHROME_HEIGHT - WORKPLACE_DEVICE_HOME),
		};
	}

	getPartCachedVisibleWidth(_part: Parts): number | undefined {
		return this.width || undefined;
	}

	resizePart(_part: Parts, _width: number): void {
		// Stage modes always fill the leaf — width is owned by the outer sash.
	}

	setMode(mode: WorkplaceStageMode): void {
		if (this.mode === mode) {
			return;
		}
		this.mode = mode;
		this.applyMode(mode, false);
		this._onDidChangeMode.fire(mode);
	}

	toJSON(): object {
		return { type: RightWorkspaceView.TYPE };
	}

	private createModeButton(parent: HTMLElement, mode: WorkplaceStageMode, label: string): void {
		const button = append(parent, $('button.sessions-workplace-stage-mode')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.dataset.mode = mode;
		this.modeButtons.set(mode, button);
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this._onDidRequestMode.fire(mode);
		}));
	}

	private applyMode(mode: WorkplaceStageMode, initial: boolean): void {
		const showEditor = mode === 'browser' || mode === 'code';
		const showPanel = mode === 'terminal';
		const showAux = mode === 'files' || mode === 'changes';

		// DOM only — do NOT call Part.setVisible here. That always fires
		// onDidVisibilityChange (even when unchanged) and re-enters the
		// workbench hide/show setters → stack overflow.
		this.editorPart.element.classList.toggle('hidden', !showEditor);
		this.panelPart.element.classList.toggle('hidden', !showPanel);
		this.auxiliaryBarPart.element.classList.toggle('hidden', !showAux);

		this.element.classList.toggle('mode-browser', mode === 'browser');
		this.element.classList.toggle('mode-code', mode === 'code');
		this.element.classList.toggle('mode-terminal', mode === 'terminal');
		this.element.classList.toggle('mode-files', mode === 'files');
		this.element.classList.toggle('mode-changes', mode === 'changes');

		for (const [buttonMode, button] of this.modeButtons) {
			button.classList.toggle('active', buttonMode === mode || (mode === 'code' && buttonMode === 'browser'));
			button.setAttribute('aria-pressed', String(button.classList.contains('active')));
		}

		if (!initial && this.width > 0) {
			this.layout(this.width, this.height, this.top, this.left);
		}
	}

	private layoutActivePart(width: number, height: number, top: number, left: number): void {
		const part =
			this.mode === 'terminal' ? this.panelPart :
				(this.mode === 'files' || this.mode === 'changes') ? this.auxiliaryBarPart :
					this.editorPart;

		size(part.element, width, height);
		part.layout(width, height, top, left);
	}
}
