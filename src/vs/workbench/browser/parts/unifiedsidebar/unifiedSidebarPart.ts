/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/unifiedSidebarPart.css';
import { $, append } from '../../../../base/browser/dom.js';
import { LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Part } from '../../part.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IUnifiedSidebarService } from '../../../services/unifiedSidebar/browser/unifiedSidebarService.js';

const UNIFIED_SIDEBAR_FIXED_WIDTH = 210;

/**
 * Cursor-faithful dedicated Agents rail (`workbench.parts.unifiedsidebar`).
 * Content is mounted from contrib via {@link IUnifiedSidebarService}.
 */
export class UnifiedSidebarPart extends Part {

	static readonly fixedWidth = UNIFIED_SIDEBAR_FIXED_WIDTH;
	static readonly minimumWidth = UNIFIED_SIDEBAR_FIXED_WIDTH;

	readonly minimumWidth = UNIFIED_SIDEBAR_FIXED_WIDTH;
	readonly maximumWidth = UNIFIED_SIDEBAR_FIXED_WIDTH;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	readonly priority = LayoutPriority.Low;
	get snap(): boolean { return true; }

	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus = this._onDidFocus.event;

	private readonly contentDisposables = this._register(new DisposableStore());

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IUnifiedSidebarService private readonly unifiedSidebarService: IUnifiedSidebarService,
	) {
		super(Parts.UNIFIED_SIDEBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);
		this._register(this.onDidVisibilityChange(visible => this.unifiedSidebarService.setVisible(visible)));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		// Parts must assign `element` — the workbench grid appends this into SplitView.
		this.element = parent;

		const content = append(parent, $('.content'));
		const agents = append(content, $('.unified-agents-sidebar'));
		agents.setAttribute('role', 'complementary');
		agents.setAttribute('aria-label', localize('unifiedAgentsSidebar', "Unified agents sidebar"));

		// Cursor-faithful: the rail top is just a single collapse toggle icon.
		// Search / New Agent / Customize + the session list are rendered by the
		// contrib content controller into the content host below.
		const header = append(agents, $('.unified-agents-sidebar-header'));
		const actions = append(header, $('.unified-agents-sidebar-actions'));
		const actionBar = this.contentDisposables.add(new ActionBar(actions));
		actionBar.push(this.contentDisposables.add(new Action(
			'unifiedSidebar.toggle',
			localize('toggleAgentsSideBar', "Toggle Agents Side Bar"),
			ThemeIcon.asClassName(Codicon.layoutSidebarLeft),
			true,
			() => this.commandService.executeCommand('workbench.action.toggleUnifiedSidebar'),
		)), { icon: true, label: false });

		const listHost = append(agents, $('.unified-agents-sidebar-content'));
		this.unifiedSidebarService.setContentHost(listHost);
		this.unifiedSidebarService.setVisible(this.layoutService.isVisible(Parts.UNIFIED_SIDEBAR_PART));
		this._register({ dispose: () => this.unifiedSidebarService.setContentHost(undefined) });
		return content;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		// Subtract the slim collapse-toggle row; the contrib controller
		// subtracts its own Search / New Agent / Customize header height.
		const contentHeight = Math.max(0, height - 36);
		this.unifiedSidebarService.layout(contentHeight, width);
	}

	focus(): void {
		this.unifiedSidebarService.focus();
		this._onDidFocus.fire();
	}

	toJSON(): object {
		return { type: Parts.UNIFIED_SIDEBAR_PART };
	}
}
