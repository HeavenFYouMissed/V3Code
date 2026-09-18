/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IContextKeyService, RawContextKey, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { mainWindow } from '../../../../base/browser/window.js';

/**
 * VIBE = Agent-forward layout. File explorer hidden, aux bar (chat) expanded.
 *        Editor stays visible, files toggleable from activity bar. NO zen mode.
 * DEV  = Standard layout. All restored to pre-VIBE state.
 */
export type VibeMode = 'vibe' | 'dev';

export interface IVibeModeService {
	readonly _serviceBrand: undefined;
	readonly mode: VibeMode;
	readonly onDidChangeMode: Event<VibeMode>;
	toggle(): void;
	enterVibe(): void;
	exitVibe(): void;
}

export const IVibeModeService = createDecorator<IVibeModeService>('vibeModeService');

export const V3CODE_VIBE_MODE_CONTEXT_KEY = new RawContextKey<boolean>('v3code.vibeMode', false);
export const V3CODE_VIBE_TOOLS_TAB_CONTEXT_KEY = new RawContextKey<string>('v3code.vibeToolsTab', 'browser');

const STORAGE_KEY = 'v3code.vibeMode';

interface PreVibeLayout {
	sidebarHidden: boolean;
	auxBarHidden: boolean;
	editorHidden: boolean;
	panelHidden: boolean;
}

export class VibeModeService extends Disposable implements IVibeModeService {
	declare readonly _serviceBrand: undefined;

	private _mode: VibeMode = 'dev';
	get mode(): VibeMode { return this._mode; }

	private readonly _onDidChangeMode = this._register(new Emitter<VibeMode>());
	readonly onDidChangeMode: Event<VibeMode> = this._onDidChangeMode.event;

	private readonly _vibeModeKey: IContextKey<boolean>;
	private _preVibeLayout: PreVibeLayout | null = null;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this._vibeModeKey = V3CODE_VIBE_MODE_CONTEXT_KEY.bindTo(contextKeyService);

		// Restore previous mode
		const stored = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (stored === 'vibe') {
			queueMicrotask(() => {
				if (this._mode === 'dev') {
					this.enterVibe();
				}
			});
		}
	}

	toggle(): void {
		if (this._mode === 'dev') {
			this.enterVibe();
		} else {
			this.exitVibe();
		}
	}

	enterVibe(): void {
		if (this._mode === 'vibe') { return; }
		this.logService.info('[v3code.vibe] Entering VIBE mode');

		try {
			// Snapshot current layout for later restore
			this._preVibeLayout = {
				sidebarHidden: !this.layoutService.isVisible(Parts.SIDEBAR_PART),
				auxBarHidden: !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART),
				editorHidden: !this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
				panelHidden: !this.layoutService.isVisible(Parts.PANEL_PART),
			};

			// Hide file explorer sidebar (still toggleable via activity bar)
			if (this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
				this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			}

			// Hide bottom panel (terminal/output) to maximize chat real-estate
			if (this.layoutService.isVisible(Parts.PANEL_PART)) {
				this.layoutService.setPartHidden(true, Parts.PANEL_PART);
			}

			// Hide editor so the auxiliary bar (chat) takes over the main canvas
			if (this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
				this.layoutService.setPartHidden(true, Parts.EDITOR_PART);
			}

			// Show auxiliary bar (where chat lives) — now full width
			if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			}

			this._mode = 'vibe';
			this._vibeModeKey.set(true);
			this.storageService.store(STORAGE_KEY, 'vibe', StorageScope.WORKSPACE, StorageTarget.USER);
			this._onDidChangeMode.fire('vibe');
		} catch (err) {
			this.logService.error('[v3code.vibe] enterVibe failed', err);
		}
	}

	exitVibe(): void {
		if (this._mode === 'dev') { return; }
		this.logService.info('[v3code.vibe] Exiting VIBE mode');

		try {
			if (this._preVibeLayout) {
				// Restore editor first so other parts size correctly around it
				this.layoutService.setPartHidden(this._preVibeLayout.editorHidden, Parts.EDITOR_PART);
				this.layoutService.setPartHidden(this._preVibeLayout.sidebarHidden, Parts.SIDEBAR_PART);
				this.layoutService.setPartHidden(this._preVibeLayout.auxBarHidden, Parts.AUXILIARYBAR_PART);
				this.layoutService.setPartHidden(this._preVibeLayout.panelHidden, Parts.PANEL_PART);
				this._preVibeLayout = null;
			}

			this._mode = 'dev';
			this._vibeModeKey.set(false);
			this.storageService.store(STORAGE_KEY, 'dev', StorageScope.WORKSPACE, StorageTarget.USER);
			this._onDidChangeMode.fire('dev');
		} catch (err) {
			this.logService.error('[v3code.vibe] exitVibe failed', err);
		}
	}
}

registerSingleton(IVibeModeService, VibeModeService, InstantiationType.Delayed);
