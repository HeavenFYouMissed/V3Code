/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IUnifiedSidebarContentController {
	mount(parent: HTMLElement): void;
	layout(height: number, width: number): void;
	focus(): void;
	setVisible(visible: boolean): void;
	dispose(): void;
}

export const IUnifiedSidebarService = createDecorator<IUnifiedSidebarService>('unifiedSidebarService');

/**
 * Bridge so `workbench/browser` Parts can host Agents UI implemented in `contrib`
 * without violating import layering.
 */
export interface IUnifiedSidebarService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeContentHost: Event<HTMLElement | undefined>;
	readonly onDidChangeVisibility: Event<boolean>;
	readonly onDidRequestFocus: Event<void>;
	readonly onDidLayout: Event<{ height: number; width: number }>;

	setContentHost(host: HTMLElement | undefined): void;
	getContentHost(): HTMLElement | undefined;
	setVisible(visible: boolean): void;
	isVisible(): boolean;
	layout(height: number, width: number): void;
	focus(): void;
	registerContentController(factory: () => IUnifiedSidebarContentController): IDisposable;
}

export class UnifiedSidebarService extends Disposable implements IUnifiedSidebarService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeContentHost = this._register(new Emitter<HTMLElement | undefined>());
	readonly onDidChangeContentHost = this._onDidChangeContentHost.event;

	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

	private readonly _onDidRequestFocus = this._register(new Emitter<void>());
	readonly onDidRequestFocus = this._onDidRequestFocus.event;

	private readonly _onDidLayout = this._register(new Emitter<{ height: number; width: number }>());
	readonly onDidLayout = this._onDidLayout.event;

	private contentHost: HTMLElement | undefined;
	private visible = false;
	private lastLayout: { height: number; width: number } | undefined;
	private controller: IUnifiedSidebarContentController | undefined;
	private controllerFactory: (() => IUnifiedSidebarContentController) | undefined;

	setContentHost(host: HTMLElement | undefined): void {
		this.contentHost = host;
		this._onDidChangeContentHost.fire(host);
		this.remount();
	}

	getContentHost(): HTMLElement | undefined {
		return this.contentHost;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.controller?.setVisible(visible);
		this._onDidChangeVisibility.fire(visible);
	}

	isVisible(): boolean {
		return this.visible;
	}

	layout(height: number, width: number): void {
		this.lastLayout = { height, width };
		this.controller?.layout(height, width);
		this._onDidLayout.fire({ height, width });
	}

	focus(): void {
		this.controller?.focus();
		this._onDidRequestFocus.fire();
	}

	registerContentController(factory: () => IUnifiedSidebarContentController): IDisposable {
		this.controllerFactory = factory;
		this.remount();
		return toDisposable(() => {
			if (this.controllerFactory === factory) {
				this.controllerFactory = undefined;
				this.controller?.dispose();
				this.controller = undefined;
			}
		});
	}

	private remount(): void {
		this.controller?.dispose();
		this.controller = undefined;
		if (!this.contentHost || !this.controllerFactory) {
			return;
		}
		this.controller = this.controllerFactory();
		this.controller.mount(this.contentHost);
		this.controller.setVisible(this.visible);
		if (this.lastLayout) {
			this.controller.layout(this.lastLayout.height, this.lastLayout.width);
		}
	}
}

registerSingleton(IUnifiedSidebarService, UnifiedSidebarService, InstantiationType.Delayed);
