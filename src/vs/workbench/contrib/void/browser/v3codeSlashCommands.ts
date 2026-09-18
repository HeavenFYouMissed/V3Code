/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Bridges V3Code SlashCommandService commands into native IChatSlashCommandService.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatSlashCommandService } from '../../chat/common/participants/chatSlashCommands.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { ISlashCommandService } from './slashCommandService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { V3CodeOpenMarketplaceActionId } from './v3codeMarketplacePane.js';

class V3CodeSlashCommandsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.v3codeSlashCommands';

	constructor(
		@IChatSlashCommandService private readonly chatSlashCommandService: IChatSlashCommandService,
		@ISlashCommandService private readonly slashCommandService: ISlashCommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IChatService private readonly chatService: IChatService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._registerV3Commands();
	}

	private _registerV3Commands(): void {
		for (const cmd of this.slashCommandService.getCommands()) {
			this._register(this.chatSlashCommandService.registerSlashCommand({
				command: cmd.name,
				detail: cmd.description,
				sortText: `v3_${cmd.name}`,
				locations: [ChatAgentLocation.Chat, ChatAgentLocation.Terminal, ChatAgentLocation.EditorInline],
				modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Plan],
			}, async (_prompt, _progress, _history, _location, sessionResource) => {
				const activeEditor = this.editorService.activeTextEditorControl;
				let selectedText: string | undefined;
				if (activeEditor && 'getSelection' in activeEditor && 'getModel' in activeEditor) {
					const selection = (activeEditor as { getSelection: () => { isEmpty: () => boolean } | null }).getSelection?.();
					const model = (activeEditor as { getModel: () => { getValueInRange: (r: unknown) => string } | null }).getModel?.();
					if (selection && model && !selection.isEmpty()) {
						selectedText = model.getValueInRange(selection);
					}
				}

				const result = this.slashCommandService.executeCommand(cmd.id, {
					activeFileUri: this.editorService.activeEditor?.resource,
					selectedText,
				});

				if (!result.modifiedMessage) {
					return;
				}

				const modeKind = result.mode === 'agent'
					? ChatModeKind.Agent
					: result.mode === 'plan'
						? ChatModeKind.Plan
						: ChatModeKind.Ask;

				await this.chatService.sendRequest(sessionResource, result.modifiedMessage, {
					modeInfo: {
						kind: modeKind,
						isBuiltin: true,
						modeInstructions: result.systemPromptAddition
							? {
								name: cmd.name,
								content: result.systemPromptAddition,
								toolReferences: [],
							}
							: undefined,
						modeId: modeKind === ChatModeKind.Agent ? 'agent' : modeKind === ChatModeKind.Ask ? 'ask' : undefined,
						applyCodeBlockSuggestionId: undefined,
					},
				});
			}));
		}

		this._register(this.chatSlashCommandService.registerSlashCommand({
			command: 'marketplace',
			detail: localize('v3code.marketplace.slash', 'Open MCP Servers'),
			sortText: 'v3_marketplace',
			executeImmediately: true,
			silent: true,
			locations: [ChatAgentLocation.Chat],
		}, async () => {
			await this.commandService.executeCommand(V3CodeOpenMarketplaceActionId);
		}));
	}
}

registerWorkbenchContribution2(V3CodeSlashCommandsContribution.ID, V3CodeSlashCommandsContribution, WorkbenchPhase.AfterRestored);
