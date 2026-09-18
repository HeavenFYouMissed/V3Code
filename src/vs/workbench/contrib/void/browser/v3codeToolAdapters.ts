/*--------------------------------------------------------------------------------------

 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.

 *  Licensed under the Apache License, Version 2.0.

 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */



/**

 * V3CodeToolAdapters — wraps V3Code builtin + MCP tools as native IToolImpl adapters.

 */



import { CancellationToken } from '../../../../base/common/cancellation.js';

import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';

import { Codicon } from '../../../../base/common/codicons.js';

import { URI } from '../../../../base/common/uri.js';
import { resolveV3BuiltinModeName } from '../common/v3DebugMode.js';

import { generateUuid } from '../../../../base/common/uuid.js';

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

import { isWindows } from '../../../../base/common/platform.js';

import type { IChatTerminalToolInvocationData } from '../../chat/common/chatService/chatService.js';

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

import {

	ILanguageModelToolsService,

	IToolData,

	IToolImpl,

	IToolInvocation,

	IToolResult,

	ToolDataSource,

	ToolProgress,

	CountTokensCallback,

	IPreparedToolInvocation,

	IToolInvocationPreparationContext,

	ToolSet,

	IToolResultInputOutputDetails,

} from '../../chat/common/tools/languageModelToolsService.js';

import { SLIM_DIFF_LANGUAGE_ID, withSlimDiffResources } from '../../chat/common/chatSlimDiffPayload.js';

import { builtinTools, inputSchemaOfTool, InternalToolInfo } from '../common/prompt/prompts.js';

import { IToolsService, type ToolCallContext } from './toolsService.js';

import { IVoidSettingsService } from '../common/voidSettingsService.js';

import { ConfirmationOptionKind } from '../../../../platform/agentHost/common/state/protocol/state.js';

import { approvalTypeOfBuiltinToolName, BuiltinToolName } from '../common/toolsServiceTypes.js';

import { MarkdownString } from '../../../../base/common/htmlContent.js';


import { IMCPService } from '../common/mcpService.js';

import { IChatService } from '../../chat/common/chatService/chatService.js';

import { ChatModel } from '../../chat/common/model/chatModel.js';

import { ChatExternalEditKind } from '../../chat/common/chatService/chatService.js';

import { mcpNativeToolId, V3CODE_TOOL_ID_PREFIX } from './v3codeToolIds.js';
import { getV3CodeToolIcon, getV3CodeToolPresenter } from './v3codeToolPresenters.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService, ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';
import { ITextModel } from '../../../../editor/common/model.js';

const EDIT_TOOLS = new Set<BuiltinToolName>(['edit_file', 'rewrite_file', 'append_file', 'create_file_or_folder']);

// Negative IDs keep V3Code operations separate from extension progress handles.
let nextV3ReviewOperationId = -1;

const TERMINAL_CHAT_TOOLS = new Set<BuiltinToolName>(['run_command', 'run_persistent_command']);

const V3CODE_EDIT_SNAPSHOT_SCHEME = 'v3code-edit-snapshot';

function terminalToolSpecificDataFromParams(parameters: unknown): IChatTerminalToolInvocationData {
	const params = (parameters && typeof parameters === 'object') ? parameters as Record<string, unknown> : {};
	const command = typeof params.command === 'string' ? params.command : '';
	const cwdStr = typeof params.cwd === 'string' ? params.cwd : undefined;
	return {
		kind: 'terminal',
		terminalToolSessionId: generateUuid(),
		terminalCommandId: `tool-${generateUuid()}`,
		commandLine: {
			original: command,
			forDisplay: command,
		},
		cwd: cwdStr ? URI.file(cwdStr) : undefined,
		language: isWindows ? 'pwsh' : 'sh',
	};
}



// Command bridge: lets the extension host (where the Claude Agent SDK + its in-process MCP
// servers run) invoke a native V3Code tool by name. The tool logic stays in this renderer
// process; the extension only forwards (name, params) and gets back the formatted result.
// Prefixed with '_' so it stays out of the command palette but is still callable via executeCommand.
export const V3CODE_INVOKE_NATIVE_TOOL_COMMAND_ID = '_v3code.contextBridge.invokeNativeTool';
export const V3CODE_LIST_NATIVE_TOOL_CONTRACTS_COMMAND_ID = '_v3code.contextBridge.listNativeToolContracts';



class V3CodeToolAdaptersContribution extends Disposable implements IWorkbenchContribution {



	static readonly ID = 'workbench.contrib.v3codeToolAdapters';



	private readonly _mcpToolRegistrations = new Set<IDisposable>();

	private readonly _browserToolSet: ToolSet;

	private readonly _snapshotModelDisposables = new Map<string, IDisposable>();

	private readonly _snapshotContentCache = new Map<string, { content: string; languageId: string }>();

	constructor(

		@ILanguageModelToolsService private readonly nativeToolsService: ILanguageModelToolsService,

		@IToolsService private readonly v3ToolsService: IToolsService,

		@IMCPService private readonly mcpService: IMCPService,

		@IChatService private readonly chatService: IChatService,

		@IEditCodeService private readonly editCodeService: IEditCodeService,

		@IVoidModelService private readonly voidModelService: IVoidModelService,

		@IModelService private readonly modelService: IModelService,

		@ILanguageService private readonly languageService: ILanguageService,

		@ITextModelService private readonly textModelService: ITextModelService,

		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,

	) {

		super();

		// Diff snapshot models live under the v3code-edit-snapshot scheme and are created directly in
		// the IModelService by _createSnapshotModel. But createModelReference (used by the diff card AND
		// by editCodeService's onModelAdded -> voidModelService.initializeModel listener) resolves ONLY
		// through registered content providers — it ignores in-memory models — so without this provider
		// it threw "Unable to resolve resource v3code-edit-snapshot:..." on every edit, spamming the
		// console and stalling the turn briefly. The provider just hands back the model we already
		// created, which makes both the initialize listener and the expandable diff hunk card work.
		const snapshotProvider: ITextModelContentProvider = {
			provideTextContent: async (resource: URI): Promise<ITextModel | null> => {
				const existing = this.modelService.getModel(resource);
				if (existing) {
					return existing;
				}
				const uriKey = resource.toString();
				const cached = this._snapshotContentCache.get(uriKey);
				if (!cached) {
					return null;
				}
				const model = this.modelService.createModel(
					cached.content,
					this.languageService.createById(cached.languageId),
					resource,
					false,
				);
				this._snapshotModelDisposables.set(uriKey, { dispose: () => model.dispose() });
				// LRU touch on cache hit.
				this._snapshotContentCache.delete(uriKey);
				this._snapshotContentCache.set(uriKey, cached);
				return model;
			},
		};
		this._register(this.textModelService.registerTextModelContentProvider(V3CODE_EDIT_SNAPSHOT_SCHEME, snapshotProvider));

		this._browserToolSet = this._register(this.nativeToolsService.createToolSet(
			ToolDataSource.Internal,
			'v3code_browser',
			'browser',
			{
				icon: Codicon.globe,
				description: 'Open and preview pages in the integrated browser',
			},
		));

		this._registerAllBuiltinTools();

		this._register(this.mcpService.onDidChangeState(() => this._refreshMcpTools()));

		this._refreshMcpTools();

		this._register(CommandsRegistry.registerCommand(V3CODE_INVOKE_NATIVE_TOOL_COMMAND_ID, (_accessor, args: { name: string; params?: Record<string, unknown> }) => {

			return this._invokeNativeToolByName(args?.name, args?.params ?? {});

		}));

		this._register(CommandsRegistry.registerCommand(V3CODE_LIST_NATIVE_TOOL_CONTRACTS_COMMAND_ID, (_accessor, args?: { names?: readonly string[] }) => {
			const names = Array.isArray(args?.names) ? args.names : [];
			return names.flatMap(name => {
				const tool = (builtinTools as Record<string, InternalToolInfo>)[name];
				return tool ? [{ name: tool.name, description: tool.description, inputSchema: inputSchemaOfTool(tool) }] : [];
			});
		}));

	}



	// Invoke a native V3Code tool by name with raw params, returning the same formatted text
	// the in-editor agent would get. Mirrors _invokeBuiltinTool's validate -> callTool ->
	// stringOfResult path, minus the chat-thread context (none exists for an external caller).
	// Used by the V3CODE_INVOKE_NATIVE_TOOL_COMMAND_ID bridge for the Claude SDK session.
	private async _invokeNativeToolByName(name: string, rawParams: Record<string, unknown>): Promise<string> {

		if (name === 'ask_user') {
			throw new Error('ask_user requires an in-chat button click and cannot be invoked from an external bridge.');
		}

		const callFn = (this.v3ToolsService.callTool as Record<string, ((p: unknown, c?: ToolCallContext) => Promise<{ result: unknown }>) | undefined>)[name];

		if (!callFn) {

			throw new Error(`Unknown V3Code tool: ${name}`);

		}

		const validate = (this.v3ToolsService.validateParams as Record<string, ((p: unknown) => unknown) | undefined>)[name];

		const params = validate ? validate(rawParams) : rawParams;

		const { result } = await callFn(params, undefined);

		const awaited = await result;

		const toStr = (this.v3ToolsService.stringOfResult as Record<string, ((p: unknown, r: unknown) => string) | undefined>)[name];

		return toStr ? toStr(params, awaited) : JSON.stringify(awaited);

	}



	private _toolContext(invocation: IToolInvocation): ToolCallContext | undefined {

		const session = invocation.context?.sessionResource?.toString();

		if (!session) {

			return undefined;

		}

		return { threadId: session, toolId: invocation.callId };

	}



	private _writeSnapshotContentCache(uriKey: string, content: string, languageId: string): void {
		if (this._snapshotContentCache.has(uriKey)) {
			this._snapshotContentCache.delete(uriKey);
		}
		this._snapshotContentCache.set(uriKey, { content, languageId });
		const MAX_SNAPSHOT_CONTENT_CACHE = 200;
		while (this._snapshotContentCache.size > MAX_SNAPSHOT_CONTENT_CACHE) {
			const oldestKey = this._snapshotContentCache.keys().next().value;
			if (oldestKey === undefined) { break; }
			this._snapshotContentCache.delete(oldestKey);
		}
	}

	private _createSnapshotModel(callId: string, kind: 'before' | 'after', fileUri: URI, content: string): URI {
		const snapshotUri = URI.from({
			scheme: V3CODE_EDIT_SNAPSHOT_SCHEME,
			path: `/${kind}/${callId}${fileUri.path}`,
		});
		const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(fileUri) ?? 'plaintext';
		const uriKey = snapshotUri.toString();
		this._writeSnapshotContentCache(uriKey, content, languageId);
		const existing = this.modelService.getModel(snapshotUri);
		if (existing) {
			existing.setValue(content);
		} else {
			const model = this.modelService.createModel(content, this.languageService.createById(languageId), snapshotUri, false);
			this._snapshotModelDisposables.set(uriKey, { dispose: () => model.dispose() });
			// Bound the number of retained snapshot models. Each edit created two and they were
			// never released until the whole service disposed — unbounded growth over a long
			// session. Evict the oldest (Map preserves insertion order). Content stays in
			// _snapshotContentCache so provideTextContent can recreate after resolver disposal.
			const MAX_SNAPSHOT_MODELS = 400;
			while (this._snapshotModelDisposables.size > MAX_SNAPSHOT_MODELS) {
				const oldestKey = this._snapshotModelDisposables.keys().next().value;
				if (oldestKey === undefined) { break; }
				this._snapshotModelDisposables.get(oldestKey)?.dispose();
				this._snapshotModelDisposables.delete(oldestKey);
			}
		}
		return snapshotUri;
	}

	private _captureFileContent(uri: URI): string {
		try {
			return this.editCodeService.getVoidFileSnapshot(uri).entireFileCode;
		} catch {
			return '';
		}
	}

	private _emitExternalEdit(
		invocation: IToolInvocation,
		uri: URI,
		added = 0,
		removed = 0,
		beforeContentUri?: URI,
		afterContentUri?: URI,
		editKind: ChatExternalEditKind = 'edit',
	): void {

		if (!invocation.context?.sessionResource) {

			return;

		}

		const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;

		if (!model) {

			return;

		}

		const request = model.getRequests().at(-1);

		if (!request) {

			return;

		}

		model.acceptResponseProgress(request, {

			kind: 'externalEdit',

			uri,

			editKind,

			diff: { added, removed },

			beforeContentUri,

			afterContentUri,

			undoStopId: invocation.callId,

		});

	}



	// ask_user is user-toggleable (enableAskUserTool): its registration is dynamic so a
	// disabled tool is not advertised to the model at all — an advertised-but-erroring
	// tool would just make models stumble.
	private readonly _askUserRegistration = this._register(new MutableDisposable<DisposableStore>());

	private _syncAskUserRegistration(): void {
		const enabled = this.voidSettingsService.state.globalSettings.enableAskUserTool !== false;
		if (enabled && !this._askUserRegistration.value) {
			const store = new DisposableStore();
			this._registerBuiltinTool('ask_user', builtinTools['ask_user'], false, store);
			this._askUserRegistration.value = store;
		} else if (!enabled && this._askUserRegistration.value) {
			this._askUserRegistration.value = undefined;
		}
	}

	private _registerBuiltinTool(toolName: BuiltinToolName, toolDef: typeof builtinTools[BuiltinToolName], needsApproval: boolean, store?: DisposableStore): void {

		const nativeId = V3CODE_TOOL_ID_PREFIX + toolName;



		const toolData: IToolData = {

			id: nativeId,

			source: ToolDataSource.Internal,

			toolReferenceName: toolName,

			displayName: toolDef.name,

			modelDescription: toolDef.description,

			userDescription: toolDef.description,

			inputSchema: inputSchemaOfTool(toolDef as InternalToolInfo),

			icon: getV3CodeToolIcon(toolName),

			canBeReferencedInPrompt: true,

			canRequestPreApproval: needsApproval,

			tags: needsApproval ? ['v3code', 'execute'] : ['v3code', 'read'],

		};



		const toolImpl: IToolImpl = {

			invoke: (invocation, countTokens, progress, token) =>

				this._invokeBuiltinTool(toolName, invocation, countTokens, progress, token),

			prepareToolInvocation: (context, token) => this._prepareBuiltinToolInvocation(toolName, needsApproval ? 'write' : 'read', context, token),

		};



		const reg = (d: IDisposable) => store ? store.add(d) : this._register(d);

		reg(this.nativeToolsService.registerTool(toolData, toolImpl));

		const toolSet = needsApproval ? this.nativeToolsService.executeToolSet : this.nativeToolsService.readToolSet;

		reg(toolSet.addTool(toolData));

		if (toolName === 'open_browser') {
			reg(this._browserToolSet.addTool(toolData));
		}

	}



	private async _prepareBuiltinToolInvocation(

		toolName: BuiltinToolName,

		approvalType: string,

		context: IToolInvocationPreparationContext,

		_token: CancellationToken,

	): Promise<IPreparedToolInvocation | undefined> {

		const validate = (this.v3ToolsService.validateParams as Record<string, (p: unknown) => unknown>)[toolName];
		const params = validate ? validate(context.parameters) : context.parameters;
		const presenter = getV3CodeToolPresenter(toolName);
		const prepared = presenter.prepare(params);

		// ask_user: the confirmation UI IS the tool — the question renders with one native
		// button per option (upstream ChatConfirmationWidget, same machinery as
		// vscode_get_confirmation_with_options), the chat pauses until the user clicks, and
		// the clicked label arrives in _invokeBuiltinTool as invocation.selectedCustomButton.
		if (toolName === 'ask_user') {
			const askParams = params as { question: string; options: string[] };
			return {
				invocationMessage: prepared.invocationMessage,
				pastTenseMessage: prepared.pastTenseMessage,
				icon: presenter.icon,
				confirmationMessages: {
					title: 'The agent has a question',
					message: new MarkdownString(askParams.question),
					// Custom buttons: never auto-confirm (there is no default choice), and
					// mirror upstream's kind convention (first Approve, rest Deny — styling only;
					// every custom button resolves the invocation with its label).
					allowAutoConfirm: false,
					customOptions: askParams.options.map((label, index) => ({
						id: label,
						label,
						kind: index === 0 ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny,
					})),
				},
			};
		}

		if (toolName === 'reload_window') {
			return {
				invocationMessage: prepared.invocationMessage,
				pastTenseMessage: prepared.pastTenseMessage,
				icon: presenter.icon,
				confirmationMessages: {
					title: 'Reload V3Code window?',
					message: new MarkdownString('This interrupts the current agent turn. Saved files and the chat are preserved, and the window will return with newly enabled editor features loaded.'),
				},
			};
		}

		const base: IPreparedToolInvocation = {

			invocationMessage: prepared.invocationMessage ?? new MarkdownString(`Running \`${toolName}\``),

			pastTenseMessage: prepared.pastTenseMessage,

			toolSpecificData: prepared.toolSpecificData,

			icon: presenter.icon,

			confirmationMessages: approvalType === 'read' ? undefined : {

				title: new MarkdownString(`Allow V3Code to run \`${toolName}\`?`),

				message: new MarkdownString(`This tool requires **${approvalType}** permission.`),

			},

		};

		if (TERMINAL_CHAT_TOOLS.has(toolName)) {

			base.toolSpecificData = terminalToolSpecificDataFromParams(context.parameters);

		}

		return base;

	}



	private _registerAllBuiltinTools(): void {

		for (const [toolName, toolDef] of Object.entries(builtinTools)) {

			// Skip tools routed directly to native IToolImpl via resolveNativeToolId
			if (toolName === 'run_subagent' || toolName === 'rename_symbol' || toolName === 'list_code_usages' || toolName === 'run_tests'
				|| toolName === 'open_browser_page' || toolName === 'read_page' || toolName === 'click_element'
				|| toolName === 'type_in_page' || toolName === 'screenshot_page' || toolName === 'navigate_page'
				|| toolName === 'hover_element' || toolName === 'drag_element'
				|| toolName === 'handle_dialog' || toolName === 'run_playwright_code'
				|| toolName === 'extract_page_data' || toolName === 'get_browser_console_logs'
				|| toolName === 'reconstruct_page_sources'
				|| toolName === 'get_computed_styles' || toolName === 'watch_page'
				|| toolName === 'save_browser_session' || toolName === 'restore_browser_session'
				|| toolName === 'fill_form' || toolName === 'intercept_network' || toolName === 'get_browser_network_log') {
				continue;
			}

			// Computer use is registered natively by computerUseTools.contribution.ts, and only while the
			// feature is on and the helper is healthy. Registering a flattened duplicate here would
			// advertise it unconditionally and lose the typed number/array params.
			if (toolName.startsWith('computer_')) {
				continue;
			}

			// ask_user registers dynamically (user-toggleable) — see _syncAskUserRegistration.
			if (toolName === 'ask_user') {
				continue;
			}

			const approvalType = (approvalTypeOfBuiltinToolName as Record<string, string | undefined>)[toolName];

			this._registerBuiltinTool(toolName as BuiltinToolName, toolDef as typeof builtinTools[BuiltinToolName], !!approvalType);

		}

		this._syncAskUserRegistration();
		this._register(this.voidSettingsService.onDidChangeState(() => this._syncAskUserRegistration()));

	}



	private _refreshMcpTools(): void {

		for (const registration of this._mcpToolRegistrations) {

			registration.dispose();

		}

		this._mcpToolRegistrations.clear();



		const mcpTools = this.mcpService.getMCPTools() ?? [];

		for (const mcpTool of mcpTools) {

			this._registerMcpTool(mcpTool);

		}

	}



	private _registerMcpTool(mcpTool: InternalToolInfo): void {

		if (!mcpTool.mcpServerName) {

			return;

		}



		const nativeId = mcpNativeToolId(mcpTool.mcpServerName, mcpTool.name);



		const toolData: IToolData = {

			id: nativeId,

			source: ToolDataSource.Internal,

			toolReferenceName: mcpTool.name,

			displayName: mcpTool.name,

			modelDescription: mcpTool.description,

			userDescription: mcpTool.description,

			inputSchema: inputSchemaOfTool(mcpTool),

			icon: Codicon.server,

			canBeReferencedInPrompt: true,

			canRequestPreApproval: true,

			tags: ['v3code', 'mcp', 'execute'],

		};



		const serverName = mcpTool.mcpServerName;

		const toolName = mcpTool.name;



		const toolImpl: IToolImpl = {

			invoke: async (invocation, _countTokens, _progress, _token) => {

				try {

					const result = await this.mcpService.callMCPTool({

						serverName,

						toolName,

						params: invocation.parameters,

					});

					return {

						content: [{ kind: 'text', value: this.mcpService.stringifyResult(result.result) }],

					};

				} catch (e: unknown) {

					const message = e instanceof Error ? e.message : String(e);

					return {

						content: [{ kind: 'text', value: `MCP tool error: ${message}` }],

						toolResultError: message,

					};

				}

			},

			prepareToolInvocation: (context, token) => this._prepareToolInvocation(toolName, 'MCP tools', context, token),

		};



		const registration = this.nativeToolsService.registerTool(toolData, toolImpl);

		this._mcpToolRegistrations.add(registration);

		this._mcpToolRegistrations.add(this.nativeToolsService.executeToolSet.addTool(toolData));

	}



	private async _invokeBuiltinTool(

		toolName: BuiltinToolName,

		invocation: IToolInvocation,

		_countTokens: CountTokensCallback,

		_progress: ToolProgress,

		_token: CancellationToken,

	): Promise<IToolResult> {

		// ask_user resolves from the confirmation click, never from tool execution —
		// toolsService.callTool['ask_user'] intentionally throws and must not be reached.
		if (toolName === 'ask_user') {
			if (this.voidSettingsService.state.globalSettings.enableAskUserTool === false) {
				return { content: [{ kind: 'text', value: 'The ask_user tool is disabled in this editor\'s settings. Decide yourself, or ask the user in plain text at the end of your reply.' }] };
			}
			const choice = invocation.selectedCustomButton;
			const value = choice
				? `The user chose: ${choice}`
				: 'The user dismissed the question without picking an option. Continue with your best judgment, or ask in plain text.';
			return { content: [{ kind: 'text', value }] };
		}

		try {

			const validate = (this.v3ToolsService.validateParams as Record<string, (p: unknown) => unknown>)[toolName];

			const params = validate ? validate(invocation.parameters) : invocation.parameters;

			const terminalData = invocation.toolSpecificData?.kind === 'terminal'
				? invocation.toolSpecificData as IChatTerminalToolInvocationData
				: undefined;

			const ctx: ToolCallContext | undefined = terminalData?.terminalToolSessionId
				? { ...this._toolContext(invocation), terminalToolSessionId: terminalData.terminalToolSessionId }
				: this._toolContext(invocation);

			let beforeContent: string | undefined;
			const editUri = EDIT_TOOLS.has(toolName) ? (params as { uri?: URI }).uri : undefined;
			if (editUri instanceof URI && toolName !== 'create_file_or_folder') {
				// Ensure the text model is LOADED before snapshotting the "before" content. The
				// snapshot lookup is synchronous and returns '' for an unloaded model — and the edit
				// tools only load the model INSIDE callTool (which runs below), so without this the
				// before side was empty and the click-to-open diff showed no real before-vs-after.
				try { await this.voidModelService.initializeModel(editUri); } catch { /* fall back to '' */ }
				beforeContent = this._captureFileContent(editUri);
			}

			const chatModel = invocation.context?.sessionResource
				? this.chatService.getSession(invocation.context.sessionResource)
				: undefined;
			const response = chatModel?.getRequests().find(request => request.id === invocation.chatRequestId)?.response;
			const reviewSession = editUri instanceof URI && toolName !== 'create_file_or_folder' && response
				? chatModel?.editingSession : undefined;
			const reviewOperationId = nextV3ReviewOperationId--;
			if (reviewSession && response && editUri instanceof URI) {
				await reviewSession.startExternalEdits(response, reviewOperationId, [editUri], invocation.callId);
			}
			let awaited: unknown;
			try {
				const { result } = await (this.v3ToolsService.callTool as Record<string, (p: unknown, c?: ToolCallContext) => Promise<{ result: unknown }>>)[toolName](params, ctx);
				awaited = await result;
			} finally {
				if (reviewSession && response) {
					// Finalize even on failure: a tool can write partially before throwing.
					// Transcript cards below remain separate; this owns Keep/Undo and Explain.
					await reviewSession.stopExternalEdits(response, reviewOperationId);
				}
			}

			const toStr = (this.v3ToolsService.stringOfResult as Record<string, (p: unknown, r: unknown) => string>)[toolName];

			const text: string = toStr ? toStr(params, awaited) : JSON.stringify(awaited);

			const presentation = getV3CodeToolPresenter(toolName).present(params, awaited);

			let resultDetails = presentation.toolResultDetails;

			if (terminalData && TERMINAL_CHAT_TOOLS.has(toolName)) {
				const termResult = awaited as { result?: string; resolveReason?: { type: string; exitCode?: number } };
				terminalData.terminalCommandOutput = { text: termResult?.result ?? text };
				if (termResult?.resolveReason?.type === 'done') {
					// Shell integration or an early terminal exit may not provide an exit code.
					// Preserve "unknown" instead of painting an interrupted command green.
					terminalData.terminalCommandState = { exitCode: termResult.resolveReason.exitCode };
				}
				invocation.toolSpecificData = terminalData;
			} else if (presentation.toolSpecificData) {
				invocation.toolSpecificData = presentation.toolSpecificData as IToolInvocation['toolSpecificData'];
			}

			if (editUri instanceof URI && EDIT_TOOLS.has(toolName)) {

				const editResult = awaited as { added?: number; removed?: number; alreadyExists?: boolean };

				const added = editResult.added ?? 0;

				const removed = editResult.removed ?? 0;

				if (toolName === 'create_file_or_folder') {
					// No snapshot URIs for create: the new file has no text model yet, so both
					// snapshots captured '' and the pill opened a blank empty↔empty diff — clicking
					// "Created foo.ts" looked like the file didn't exist. Without snapshot URIs the
					// pill's click handler falls through to opening the REAL file.
					const editKind: ChatExternalEditKind = editResult.alreadyExists ? 'edit' : 'create';
					this._emitExternalEdit(invocation, editUri, added, removed, undefined, undefined, editKind);
				} else {
					const afterContent = this._captureFileContent(editUri);
					const beforeUri = this._createSnapshotModel(invocation.callId, 'before', editUri, beforeContent ?? '');
					const afterUri = this._createSnapshotModel(invocation.callId, 'after', editUri, afterContent);
					this._emitExternalEdit(invocation, editUri, added, removed, beforeUri, afterUri, 'edit');
					// Hand the same snapshots to the card, so its "open changes" button opens the
					// identical diff the pill used to. These resources resolve through the provider
					// registered above; the card must not mint its own.
					const details = resultDetails as IToolResultInputOutputDetails | undefined;
					if (details?.inputLanguage === SLIM_DIFF_LANGUAGE_ID && typeof details.input === 'string') {
						resultDetails = { ...details, input: withSlimDiffResources(details.input, beforeUri.toString(), afterUri.toString()) };
					}
				}

			}

			return {

				content: [{ kind: 'text', value: text }],

				toolResultMessage: presentation.pastTenseMessage,

				toolResultDetails: resultDetails,

			};

		} catch (e: unknown) {

			const message = e instanceof Error ? e.message : String(e);

			return {

				content: [{ kind: 'text', value: `Tool error: ${message}` }],

				toolResultError: message,

				// Debug mode only: the completed card must not read as a success receipt. The
				// input/output details carry `isError`, which is what the model persists — so a
				// reopened Debug chat still shows the failure. Other modes keep their card as is.
				toolResultDetails: this._isDebugModeRequest(invocation) ? {
					input: this._formatFailedToolInput(invocation.parameters),
					output: [{ type: 'embed', isText: true, value: `Tool error: ${message}` }],
					isError: true,
				} : undefined,

			};

		}

	}

	private _isDebugModeRequest(invocation: IToolInvocation): boolean {
		const sessionResource = invocation.context?.sessionResource;
		if (!sessionResource || !invocation.chatRequestId) {
			return false;
		}
		const request = this.chatService.getSession(sessionResource)?.getRequests().find(r => r.id === invocation.chatRequestId);
		return resolveV3BuiltinModeName(request?.modeInfo?.modeName) === 'debug';
	}

	private _formatFailedToolInput(parameters: Record<string, unknown> | undefined): string {
		try {
			return JSON.stringify(parameters ?? {}, (_key, value) => value instanceof URI ? value.toString() : value, 2);
		} catch {
			return String(parameters);
		}
	}



	private async _prepareToolInvocation(

		toolName: string,

		approvalType: string,

		_context: IToolInvocationPreparationContext,

		_token: CancellationToken,

	): Promise<IPreparedToolInvocation | undefined> {

		return {

			invocationMessage: new MarkdownString(`Running \`${toolName}\``),

			confirmationMessages: {

				title: new MarkdownString(`Allow V3Code to run \`${toolName}\`?`),

				message: new MarkdownString(`This tool requires **${approvalType}** permission.`),

			},

		};

	}

}



registerWorkbenchContribution2(V3CodeToolAdaptersContribution.ID, V3CodeToolAdaptersContribution, WorkbenchPhase.AfterRestored);
