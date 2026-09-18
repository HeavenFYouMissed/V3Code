/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IHostService } from '../../../services/host/browser/host.js';

/** How many recents to show before it stops being a shortlist and starts being a list. */
const MAX_RECENTS = 5;

/** V3Code's own settings pane (`VOID_OPEN_SETTINGS_ACTION_ID`), not the editor's. */
const V3CODE_SETTINGS_COMMAND_ID = 'workbench.action.openVoidSettings';

interface StartTile {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly commandId: string;
	/** Show even when the command is not registered yet, because running it activates its extension. */
	readonly alwaysShow?: boolean;
	/** Drawn as the filled/primary tile. */
	readonly primary?: boolean;
}

/**
 * What an empty V3Code window shows instead of a list of keyboard shortcuts.
 *
 * The shortcut list assumes you already know what an editor is and that you need a
 * folder open before anything works. Someone opening this for the first time sees a
 * logo and three key combinations, and has no idea the product is waiting on them to
 * pick a project. These are the four things you can actually do from nothing, plus
 * the projects you had open last.
 */
export class V3CodeStartScreen extends Disposable {

	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
	}

	private tiles(): StartTile[] {
		const tiles: StartTile[] = [
			{
				id: 'openProject',
				label: localize('v3start.openProject', "Open project"),
				icon: Codicon.folderOpened,
				// macOS has one picker for both; everywhere else they are separate commands.
				commandId: isMacintosh ? 'workbench.action.files.openFileFolder' : 'workbench.action.files.openFolder',
			},
			{
				id: 'cloneRepo',
				// `git.clone` is the GitHub path: the GitHub extension hooks its picker and
				// offers "Clone from GitHub" alongside a URL, so this covers both.
				label: localize('v3start.cloneRepo', "Clone repo"),
				icon: Codicon.repoClone,
				commandId: 'git.clone',
				// The git extension activates lazily, so this command is usually absent from
				// the registry at startup. Executing it activates the extension; filtering on
				// the registry instead made the most important action silently disappear.
				alwaysShow: true,
			},
			{
				id: 'newAgent',
				// The "I have no project, just build something" path. For an empty window
				// this is the most useful thing on screen and the least discoverable, which
				// is exactly why it belongs here rather than an SSH tile almost nobody uses.
				label: localize('v3start.newAgent', "Start an Agent"),
				icon: Codicon.commentDiscussion,
				commandId: 'workbench.action.openAgentsWindow',
				alwaysShow: true,
			},
			{
				id: 'steerFromMobile',
				label: localize('v3start.steerFromMobile', "Steer from Mobile"),
				icon: Codicon.deviceMobile,
				commandId: 'v3code.remote.showQr',
				alwaysShow: true,
				primary: true,
			},
			{
				id: 'newFile',
				label: localize('v3start.newFile', "New file"),
				icon: Codicon.newFile,
				commandId: 'workbench.action.files.newUntitledFile',
				alwaysShow: true,
			},
			{
				id: 'connectSsh',
				label: localize('v3start.connectSsh', "Connect via SSH"),
				icon: Codicon.remote,
				commandId: 'workbench.action.remote.showMenu',
			},
		];

		// Only drop a tile whose command genuinely will not exist. Anything contributed by
		// a lazily activated extension is marked alwaysShow, because executing the command
		// is what activates it - filtering on the registry hid working features.
		return tiles.filter(tile => tile.alwaysShow || !!CommandsRegistry.getCommand(tile.commandId));
	}

	/** Whether this build contributes any of the actions the screen is made of. */
	hasContent(): boolean {
		return this.tiles().length > 0;
	}

	async render(): Promise<void> {
		this.renderDisposables.clear();
		clearNode(this.container);

		const root = append(this.container, $('.v3-start'));

		// Brand. The logo itself is the existing letterpress mark, drawn by CSS so it
		// picks up the same asset the rest of the product uses.
		const brand = append(root, $('.v3-start-brand'));
		append(brand, $('.v3-start-logo'));
		const wordmarkBlock = append(brand, $('.v3-start-wordmark-block'));
		append(wordmarkBlock, $('.v3-start-wordmark')).textContent = this.productService.nameShort ?? 'V3Code';
		const settings = append(wordmarkBlock, $('a.v3-start-settings'));
		settings.textContent = localize('v3start.settings', "Settings");
		settings.tabIndex = 0;
		// The product's own settings, not the stock editor ones. Referenced by id rather
		// than imported, because this lives in the editor part and the settings pane is a
		// contribution; if a build omits it we fall back to the editor settings.
		this.renderDisposables.add(addDisposableListener(settings, EventType.CLICK, () => this.run(
			CommandsRegistry.getCommand(V3CODE_SETTINGS_COMMAND_ID) ? V3CODE_SETTINGS_COMMAND_ID : 'workbench.action.openSettings'
		)));

		// Actions.
		const tiles = append(root, $('.v3-start-tiles'));
		for (const tile of this.tiles()) {
			const el = append(tiles, $(`button.v3-start-tile${tile.primary ? '.is-primary' : ''}`)) as HTMLButtonElement;
			el.type = 'button';
			const icon = append(el, $('span.v3-start-tile-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(tile.icon));
			append(el, $('span.v3-start-tile-label')).textContent = tile.label;
			this.renderDisposables.add(addDisposableListener(el, EventType.CLICK, () => this.run(tile.commandId)));
		}

		await this.renderRecents(root);
	}

	private async renderRecents(root: HTMLElement): Promise<void> {
		let recent;
		try {
			recent = await this.workspacesService.getRecentlyOpened();
		} catch {
			return; // no recents is a fine state, not an error worth showing
		}

		const folders = recent.workspaces.slice(0, MAX_RECENTS);
		if (!folders.length) {
			return;
		}

		const section = append(root, $('.v3-start-recents'));
		append(section, $('.v3-start-recents-title')).textContent = localize('v3start.recents', "Recent projects");

		for (const entry of folders) {
			const uri: URI = isRecentFolder(entry) ? entry.folderUri : entry.workspace.configPath;
			const row = append(section, $('button.v3-start-recent')) as HTMLButtonElement;
			row.type = 'button';

			const name = isRecentFolder(entry)
				? entry.label ?? this.labelService.getWorkspaceLabel(uri, { verbose: 0 })
				: entry.label ?? this.labelService.getWorkspaceLabel(entry.workspace, { verbose: 0 });
			append(row, $('span.v3-start-recent-name')).textContent = name;

			// The parent directory, so two projects with the same name stay distinguishable.
			// `dirname` rather than a hand-rolled path chop, and no `noPrefix` - that flag
			// strips the tilde and turns "~/dev" into "Users/daniel/dev".
			append(row, $('span.v3-start-recent-path')).textContent = this.labelService.getUriLabel(dirname(uri));
			row.title = this.labelService.getUriLabel(uri);

			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
				void this.hostService.openWindow([isRecentFolder(entry) ? { folderUri: uri } : { workspaceUri: uri }], { forceNewWindow: false });
			}));
		}
	}

	private run(commandId: string): void {
		void this.commandService.executeCommand(commandId);
	}
}
