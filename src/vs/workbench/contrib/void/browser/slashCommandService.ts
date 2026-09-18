/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { URI } from '../../../../base/common/uri.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlashCommand {
	id: string;
	name: string;
	description: string;
	icon?: string;
}

export interface SlashCommandContext {
	activeFileUri?: URI;
	selectedText?: string;
	diagnostics?: string[];
}

export interface SlashCommandResult {
	modifiedMessage: string;
	systemPromptAddition?: string;
	mode?: 'agent' | 'ask' | 'plan';
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ISlashCommandService {
	readonly _serviceBrand: undefined;
	getCommands(): SlashCommand[];
	executeCommand(commandId: string, context: SlashCommandContext): SlashCommandResult;
	matchPrefix(input: string): SlashCommand[];
}

export const ISlashCommandService = createDecorator<ISlashCommandService>('slashCommandService');

// ---------------------------------------------------------------------------
// Built-in command handler type
// ---------------------------------------------------------------------------

type CommandHandler = (context: SlashCommandContext) => SlashCommandResult;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SlashCommandService extends Disposable implements ISlashCommandService {
	declare readonly _serviceBrand: undefined;

	private readonly _commands: Map<string, SlashCommand> = new Map();
	private readonly _handlers: Map<string, CommandHandler> = new Map();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		super();
		this._registerBuiltinCommands();
		this.logService.debug('[SlashCommandService] Initialized with built-in commands');
	}

	// -- public API ----------------------------------------------------------

	getCommands(): SlashCommand[] {
		return Array.from(this._commands.values());
	}

	executeCommand(commandId: string, context: SlashCommandContext): SlashCommandResult {
		const handler = this._handlers.get(commandId);
		if (!handler) {
			this.logService.warn(`[SlashCommandService] Unknown command: ${commandId}`);
			return { modifiedMessage: '' };
		}

		const enrichedContext = this._enrichContext(context);
		return handler(enrichedContext);
	}

	matchPrefix(input: string): SlashCommand[] {
		const trimmed = input.trim().toLowerCase();
		if (!trimmed.startsWith('/')) {
			return [];
		}
		const prefix = trimmed.slice(1);
		if (prefix.length === 0) {
			return this.getCommands();
		}
		return this.getCommands().filter(cmd => cmd.name.startsWith(prefix));
	}

	// -- internals -----------------------------------------------------------

	private _enrichContext(context: SlashCommandContext): SlashCommandContext {
		if (context.activeFileUri && (!context.diagnostics || context.diagnostics.length === 0)) {
			const markers = this.markerService.read({ resource: context.activeFileUri });
			const diagnosticStrings = markers
				.filter(m => m.severity === MarkerSeverity.Error || m.severity === MarkerSeverity.Warning)
				.map(m => `[${m.severity === MarkerSeverity.Error ? 'Error' : 'Warning'}] Line ${m.startLineNumber}: ${m.message}`);

			if (diagnosticStrings.length > 0) {
				return { ...context, diagnostics: diagnosticStrings };
			}
		}
		return context;
	}

	private _registerCommand(id: string, name: string, description: string, icon: string | undefined, handler: CommandHandler): void {
		this._commands.set(id, { id, name, description, icon });
		this._handlers.set(id, handler);
	}

	private _registerBuiltinCommands(): void {
		this._registerCommand('fix', 'fix', 'Fix errors in the current file', 'wrench', (ctx) => {
			const diagBlock = ctx.diagnostics?.length
				? `Current diagnostics:\n${ctx.diagnostics.join('\n')}\n\n`
				: '';
			return {
				modifiedMessage: `${diagBlock}Fix all errors and warnings in the current file.`,
				systemPromptAddition: 'Focus exclusively on resolving the reported diagnostics. Apply minimal, targeted changes.',
				mode: 'agent',
			};
		});

		this._registerCommand('explain', 'explain', 'Explain the selected code', 'book', (ctx) => {
			const selection = ctx.selectedText ? `\n\n\`\`\`\n${ctx.selectedText}\n\`\`\`` : '';
			return {
				modifiedMessage: `Explain this:${selection}`,
				systemPromptAddition: 'Provide a clear, concise explanation. Use bullet points for multi-step logic.',
				mode: 'ask',
			};
		});

		this._registerCommand('test', 'test', 'Generate tests for this file', 'beaker', (ctx) => {
			const filePath = ctx.activeFileUri?.fsPath ?? 'the current file';
			return {
				modifiedMessage: `Generate comprehensive unit tests for ${filePath}.`,
				systemPromptAddition: 'Write idiomatic tests using the project\'s existing test framework. Cover edge cases and error paths.',
				mode: 'agent',
			};
		});

		this._registerCommand('commit', 'commit', 'Stage all changes and commit', 'git-commit', (ctx) => {
			return {
				modifiedMessage: 'Stage all current changes and create a well-formatted git commit with a descriptive message.',
				systemPromptAddition: 'Use conventional commit format. Summarise the "why" over the "what". Do not push unless asked.',
				mode: 'agent',
			};
		});

		this._registerCommand('refactor', 'refactor', 'Refactor the selected code', 'tools', (ctx) => {
			const selection = ctx.selectedText ? `\n\n\`\`\`\n${ctx.selectedText}\n\`\`\`` : '';
			return {
				modifiedMessage: `Refactor the following code for clarity and maintainability:${selection}`,
				systemPromptAddition: 'Preserve existing behaviour. Improve naming, reduce duplication, and simplify control flow.',
				mode: 'agent',
			};
		});

		this._registerCommand('doc', 'doc', 'Add documentation', 'note', (ctx) => {
			const selection = ctx.selectedText ? `\n\n\`\`\`\n${ctx.selectedText}\n\`\`\`` : '';
			return {
				modifiedMessage: `Add thorough documentation to the following code:${selection}`,
				systemPromptAddition: 'Write JSDoc/TSDoc comments. Document parameters, return values, thrown errors, and non-obvious behaviour.',
				mode: 'agent',
			};
		});

		this._registerCommand('plan', 'plan', 'Switch to planning mode for architecture and design', 'tasklist', (ctx) => {
			const selection = ctx.selectedText ? `\n\nContext:\n\`\`\`\n${ctx.selectedText}\n\`\`\`` : '';
			return {
				modifiedMessage: `Create a detailed implementation plan:${selection}\n\n${ctx.activeFileUri ? `Active file: ${ctx.activeFileUri.fsPath}` : ''}`.trim(),
				systemPromptAddition: 'Produce a structured plan with steps, dependencies, risks, and verification criteria. Do not edit files.',
				mode: 'plan',
			};
		});
	}
}

registerSingleton(ISlashCommandService, SlashCommandService, InstantiationType.Delayed);
