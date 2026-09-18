/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Registration of the computer-use tools with the chat agent.
 *
 * The tool surface is not static: it tracks what the computer-use service reports. When the feature
 * is off, the helper is missing, or machine-wide consent has not been given, nothing is registered at
 * all — an agent that cannot see a tool cannot waste a turn discovering it does not work.
 *
 * When the feature is on but the OS has not granted the permission needed to synthesize input, the
 * surface degrades rather than disappearing — the observation tools stay, the input tools go —
 * mirroring how the integrated browser tools fall back to a reduced set when page sharing is
 * unavailable.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';
import { ILanguageModelToolsService, ToolDataSource, type IToolData, type IToolImpl, type ToolSet } from '../../chat/common/tools/languageModelToolsService.js';
import { IComputerUseService } from '../browser/computerUseService.js';
import {
	ComputerUseClickTool,
	ComputerUseClickToolData,
	ComputerUseClipboardReadTool,
	ComputerUseClipboardReadToolData,
	ComputerUseClipboardWriteTool,
	ComputerUseClipboardWriteToolData,
	ComputerUseCursorTool,
	ComputerUseCursorToolData,
	ComputerUseDragTool,
	ComputerUseDragToolData,
	ComputerUseHoverTool,
	ComputerUseHoverToolData,
	ComputerUseKeyTool,
	ComputerUseKeyToolData,
	ComputerUseOpenAppTool,
	ComputerUseOpenAppToolData,
	computerUseToolDataList,
	ComputerUseListAppsTool,
	ComputerUseListAppsToolData,
	ComputerUseReadScreenChangesTool,
	ComputerUseReadScreenChangesToolData,
	ComputerUseReadScreenTool,
	ComputerUseReadScreenToolData,
	ComputerUseScreenshotTool,
	ComputerUseScreenshotToolData,
	ComputerUseScrollTool,
	ComputerUseScrollToolData,
	ComputerUseTypeTool,
	ComputerUseTypeToolData,
	ComputerUseWaitForStableTool,
	ComputerUseWaitForStableToolData,
} from './tools/computerUseTools.js';

class ComputerUseToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'computerUse.chatAgentTools';

	/**
	 * Holds the current registrations.
	 *
	 * A {@link MutableDisposable} rather than a plain store because availability changes revoke the
	 * whole surface: disabling the feature mid-session must actually take the tools away, not just
	 * stop refreshing them.
	 */
	private readonly _toolsStore = this._register(new MutableDisposable<DisposableStore>());

	private readonly _toolSet: ToolSet;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@IComputerUseService private readonly computerUseService: IComputerUseService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._toolSet = this._register(this.toolsService.createToolSet(
			ToolDataSource.Internal,
			'computerUse',
			'computer',
			{
				icon: Codicon.deviceDesktop,
				description: localize('computerUseToolSet.description', "Observe and control desktop applications on this machine"),
			},
		));

		// `isAvailable` starts out false and flips once the first helper probe resolves, so the initial
		// pass usually registers nothing and the event does the real work.
		this._updateToolRegistrations();
		this._register(this.computerUseService.onDidChangeAvailability(() => this._updateToolRegistrations()));
	}

	/**
	 * Rebuilds the registered tool surface from the service's current state.
	 *
	 * Everything is torn down and re-registered rather than diffed: the surface is ten tools, and a
	 * diff would be more code than it saves while being able to leave a revoked tool behind.
	 */
	private _updateToolRegistrations(): void {
		this._toolsStore.clear();
		this._registeredIds = [];

		if (!this.computerUseService.isAvailable) {
			// Unregistered tools surface to the model as "was not contributed", which reads as
			// "this feature does not exist" — so the one place that knows the real reason has to
			// say it. A build packaged without the helper is otherwise indistinguishable from a
			// setting the user turned off, and that ambiguity was diagnosed wrongly twice.
			this.logService.info(`[computerUse] tools not registered — ${{
				// The build gate verifies the helper is packaged, so a failed probe means the
				// RUNTIME install into ~/.v3code/bin (or spawn/ping) failed — not the package.
				'helper-missing': 'helper probe failed — not installed in ~/.v3code/bin, or install/spawn failed; see [v3code-computer-use] log lines. The package itself is gate-verified.',
				'setting-disabled': 'the "Computer use (beta)" setting is off',
				'tripped': 'the feature tripped earlier this session',
			}[this.computerUseService.unavailableReason ?? 'helper-missing']}`);
			return;
		}

		const store = new DisposableStore();
		this._toolsStore.value = store;

		// Observation tools. Safe as soon as computer use is available: they change nothing, and
		// withholding them would leave the model unable to answer questions about what the user is
		// looking at.
		this._add(store, ComputerUseReadScreenToolData, this.instantiationService.createInstance(ComputerUseReadScreenTool));
		// Both protocol-2 read tools belong here rather than below the input gate: one reads the same
		// accessibility tree incrementally and the other only waits for that tree to stop moving, so
		// neither changes anything. Withholding the change reader would also be actively harmful — every
		// action result now tells the model to call it, and a tool named in a result but absent from the
		// surface costs a wasted turn.
		this._add(store, ComputerUseReadScreenChangesToolData, this.instantiationService.createInstance(ComputerUseReadScreenChangesTool));
		this._add(store, ComputerUseWaitForStableToolData, this.instantiationService.createInstance(ComputerUseWaitForStableTool));
		this._add(store, ComputerUseScreenshotToolData, this.instantiationService.createInstance(ComputerUseScreenshotTool));
		this._add(store, ComputerUseCursorToolData, this.instantiationService.createInstance(ComputerUseCursorTool));
		this._add(store, ComputerUseListAppsToolData, this.instantiationService.createInstance(ComputerUseListAppsTool));

		// Clipboard and application launching sit above the input gate deliberately. Neither synthesizes
		// an input event, so neither needs the Accessibility permission that `isInputEnabled` reports —
		// putting them below would hide them on a machine where Accessibility is simply not granted yet,
		// even though they would work perfectly.
		this._add(store, ComputerUseClipboardReadToolData, this.instantiationService.createInstance(ComputerUseClipboardReadTool));
		this._add(store, ComputerUseClipboardWriteToolData, this.instantiationService.createInstance(ComputerUseClipboardWriteTool));
		this._add(store, ComputerUseOpenAppToolData, this.instantiationService.createInstance(ComputerUseOpenAppTool));

		if (!this.computerUseService.isInputEnabled) {
			// Reduced surface: the OS has not granted the permission the helper needs to synthesize
			// events, so the model can look but the input tools are simply not there to be called. A tool
			// that fails on every invocation is worse than a tool that is absent.
			return;
		}

		this._add(store, ComputerUseClickToolData, this.instantiationService.createInstance(ComputerUseClickTool));
		this._add(store, ComputerUseTypeToolData, this.instantiationService.createInstance(ComputerUseTypeTool));
		this._add(store, ComputerUseKeyToolData, this.instantiationService.createInstance(ComputerUseKeyTool));
		this._add(store, ComputerUseScrollToolData, this.instantiationService.createInstance(ComputerUseScrollTool));
		this._add(store, ComputerUseDragToolData, this.instantiationService.createInstance(ComputerUseDragTool));
		this._add(store, ComputerUseHoverToolData, this.instantiationService.createInstance(ComputerUseHoverTool));

		// Guard against the drift that put this comment here: `computerUseToolDataList` is the declared
		// surface, and every entry must be registered by one of the `_add` calls above. Adding a tool to
		// that list and forgetting this method is silent — the tool exists, type-checks, and is simply
		// never offered to the model, which is exactly how the first five additions shipped broken.
		const registered = new Set(this._registeredIds);
		const missing = computerUseToolDataList.filter(data => !registered.has(data.id)).map(data => data.id);
		if (missing.length > 0) {
			this.logService.warn(`[v3code-computer-use] declared but not registered: ${missing.join(', ')}`);
		}
	}

	/** Ids registered during the current pass, for the drift check at the end of it. */
	private _registeredIds: string[] = [];

	/** Registers one tool and adds it to the tool set, tracking both in the given store. */
	private _add(store: DisposableStore, data: IToolData, impl: IToolImpl): void {
		store.add(this.toolsService.registerTool(data, impl));
		store.add(this._toolSet.addTool(data));
		this._registeredIds.push(data.id);
	}
}

registerWorkbenchContribution2(ComputerUseToolsContribution.ID, ComputerUseToolsContribution, WorkbenchPhase.AfterRestored);
