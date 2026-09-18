/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { timeout } from '../../../../base/common/async.js';
import { CharCode } from '../../../../base/common/charCode.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { getParseErrorMessage } from '../../../../base/common/jsonErrorMessages.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { CatalogInput } from './mcpCatalog.js';
import { MCPServerOfName, MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, MCPToolCallParams, RawMCPToolCall, MCPServerEventResponse } from './mcpServiceTypes.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { InternalToolInfo } from './prompt/prompts.js';
import { toolInputSchemaFromUnknown } from './prompt/toolContract.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { MCPUserStateOfName } from './voidSettingsTypes.js';


type MCPServiceState = {
	mcpServerOfName: MCPServerOfName,
	error: string | undefined, // global parsing error
}

export interface IMCPService {
	readonly _serviceBrand: undefined;
	revealMCPConfigFile(): Promise<void>;
	toggleServerIsOn(serverName: string, isOn: boolean): Promise<void>;

	readonly state: MCPServiceState; // NOT persisted
	onDidChangeState: Event<void>;

	getMCPTools(): InternalToolInfo[] | undefined;
	callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }>;
	stringifyResult(result: RawMCPToolCall): string;

	/**
	 * Install a server. Bare `${VAR}` placeholders in the entry are rewritten into secure
	 * input prompts before anything is persisted; `requiredInputs` (catalog/gallery
	 * metadata) refines which values are secret and which are required.
	 */
	installMcpServer(serverName: string, entry: MCPConfigFileEntryJSON, requiredInputs?: readonly CatalogInput[]): Promise<void>;
	getMcpConfigServerNames(): Promise<string[]>;
	/**
	 * The exact installed server name a catalog id owns (via the install-identity map),
	 * or undefined when this catalog entry was never installed through the catalog.
	 * Display surfaces must prefer this over loose id/name matching — a suffixed
	 * install ("slack-2") otherwise shows one server's status while buttons act on another.
	 */
	installedServerNameFor(catalogId: string): string | undefined;

	/** Remove the installed server. Operates on the exact installed identity. */
	uninstallMcpServer(serverName: string): Promise<void>;
	/** Stop then start the server so a cancelled or failed browser sign-in can retry. */
	reauthenticateServer(serverName: string): Promise<void>;
	/** A genuinely fresh sign-in: wipes sessions and client registration, then starts over. */
	resetServerAuth(serverName: string): Promise<void>;
}

export const IMCPService = createDecorator<IMCPService>('mcpConfigService');



const MCP_CONFIG_FILE_NAME = 'mcp.json';
const MCP_CONFIG_SAMPLE = { mcpServers: {} }
const MCP_CONFIG_SAMPLE_STRING = JSON.stringify(MCP_CONFIG_SAMPLE, null, 2);

// The file watcher can fire while an editor or another process is halfway through saving, so a first
// syntax error is more often a torn write than something the user needs to fix.
const MCP_CONFIG_REPARSE_DELAY_MS = 150;


// export interface MCPCallToolOfToolName {
// 	[toolName: string]: (params: any) => Promise<{
// 		result: any | Promise<any>,
// 		interruptTool?: () => void
// 	}>;
// }


/**
 * Legacy MCP host: speaks the protocol itself over `void-channel-mcp` with no authentication
 * of any kind, so every OAuth-guarded remote server 401s and local servers spawn with the
 * GUI's bare PATH. Deliberately NOT registered — `MCPUpstreamFacade` (browser) is the live
 * `IMCPService`; this class stays only until its config-migration behaviour has a home.
 */
export class MCPService extends Disposable implements IMCPService {
	_serviceBrand: undefined;


	private readonly channel: IChannel // MCPChannel

	// list of MCP servers pulled from mcpChannel
	state: MCPServiceState = {
		mcpServerOfName: {},
		error: undefined,
	}

	// Emitters for server events
	private readonly _onDidChangeState = new Emitter<void>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	// private readonly _onLoadingServersChange = new Emitter<MCPServerEventLoadingParam>();
	// public readonly onLoadingServersChange = this._onLoadingServersChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IProductService private readonly productService: IProductService,
		@IEditorService private readonly editorService: IEditorService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-mcp')


		const onEvent = (e: MCPServerEventResponse) => {
			// console.log('GOT EVENT', e)
			this._setMCPServerState(e.response.name, e.response.newServer)
		}
		this._register((this.channel.listen('onAdd_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onUpdate_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onDelete_server') satisfies Event<MCPServerEventResponse>)(onEvent));

		this._initialize();
	}


	private async _initialize() {
		try {
			await this.voidSettingsService.waitForInitState;

			// Create .mcpConfig if it doesn't exist
			const mcpConfigUri = await this._getMCPConfigFilePath();
			const fileExists = await this._configFileExists(mcpConfigUri);
			if (!fileExists) {
				await this._createMCPConfigFile(mcpConfigUri);
				console.log('MCP Config file created:', mcpConfigUri.toString());
			}
			await this._addMCPConfigFileWatcher();
			await this._refreshMCPServers();
		} catch (error) {
			console.error('Error initializing MCPService:', error);
		}
	}

	private readonly _setMCPServerState = async (serverName: string, newServer: MCPServer | undefined) => {
		if (newServer === undefined) {
			// Remove the server from the state
			const { [serverName]: removed, ...remainingServers } = this.state.mcpServerOfName;
			this.state = {
				...this.state,
				mcpServerOfName: remainingServers
			}
		} else {
			// Add or update the server
			this.state = {
				...this.state,
				mcpServerOfName: {
					...this.state.mcpServerOfName,
					[serverName]: newServer
				}
			}
		}
		this._onDidChangeState.fire();
	}

	private readonly _setHasError = async (errMsg: string | undefined) => {
		this.state = {
			...this.state,
			error: errMsg,
		}
		this._onDidChangeState.fire();
	}

	// Create the file/directory if it doesn't exist
	private async _createMCPConfigFile(mcpConfigUri: URI): Promise<void> {
		// One write, not createFile()+writeFile(): the pair leaves a 0-byte file that the watcher happily reads.
		await this._writeMCPConfigFile(mcpConfigUri, VSBuffer.fromString(MCP_CONFIG_SAMPLE_STRING));
	}

	private async _writeMCPConfigFile(mcpConfigUri: URI, buffer: VSBuffer): Promise<void> {
		try {
			await this.fileService.writeFile(mcpConfigUri, buffer, { atomic: { postfix: '.tmp' } });
		} catch (error) {
			// Providers without atomic-write capability reject the option outright; a plain write still beats no config.
			await this.fileService.writeFile(mcpConfigUri, buffer);
		}
	}


	private async _addMCPConfigFileWatcher(): Promise<void> {
		const mcpConfigUri = await this._getMCPConfigFilePath();
		this._register(
			this.fileService.watch(mcpConfigUri)
		)

		this._register(this.fileService.onDidFilesChange(async e => {
			if (!e.contains(mcpConfigUri)) return
			await this._refreshMCPServers();
		}));
	}

	// Client-side functions

	public async revealMCPConfigFile(): Promise<void> {
		try {
			const mcpConfigUri = await this._getMCPConfigFilePath();
			await this.editorService.openEditor({
				resource: mcpConfigUri,
				options: {
					pinned: true,
					revealIfOpened: true,
				}
			});
		} catch (error) {
			console.error('Error opening MCP config file:', error);
		}
	}

	public getMCPTools(): InternalToolInfo[] | undefined {
		const allTools: InternalToolInfo[] = []
		for (const serverName in this.state.mcpServerOfName) {
			const server = this.state.mcpServerOfName[serverName];
			server.tools?.forEach(tool => {
				allTools.push({
					description: tool.description || '',
					params: this._transformInputSchemaToParams(tool.inputSchema),
					inputSchema: toolInputSchemaFromUnknown(tool.inputSchema),
					name: tool.name,
					mcpServerName: serverName,
				})
			})
		}
		if (allTools.length === 0) return undefined
		return allTools
	}

	private _transformInputSchemaToParams(inputSchema?: Record<string, any>): { [paramName: string]: { description: string } } {

		// Check if inputSchema is valid
		if (!inputSchema || !inputSchema.properties) return {};

		const params: { [paramName: string]: { description: string } } = {};
		Object.keys(inputSchema.properties).forEach(paramName => {
			const propertyValues = inputSchema.properties[paramName];

			// Check if propertyValues is not an object
			if (typeof propertyValues !== 'object') {
				console.warn(`Invalid property value for ${paramName}: expected object, got ${typeof propertyValues}`);
				return; // in forEach the return is equivalent to continue
			}

			// Add the parameter to the params object
			params[paramName] = {
				description: typeof propertyValues.description === 'string' ? propertyValues.description : '',
			}
		});
		return params;
	}

	private async _getMCPConfigFilePath(): Promise<URI> {
		const appName = this.productService.dataFolderName
		const userHome = await this.pathService.userHome();
		const uri = URI.joinPath(userHome, appName, MCP_CONFIG_FILE_NAME)
		return uri
	}

	private async _configFileExists(mcpConfigUri: URI): Promise<boolean> {
		try {
			await this.fileService.stat(mcpConfigUri);
			return true;
		} catch (error) {
			return false;
		}
	}


	private async _readMCPConfigFileContents(mcpConfigUri: URI): Promise<string | undefined> {
		try {
			const fileContent = await this.fileService.readFile(mcpConfigUri);
			return fileContent.value.toString();
		} catch (error) {
			return undefined;
		}
	}

	private _lineNumberOfOffset(contentString: string, offset: number): number {
		let line = 1;
		for (let i = 0; i < offset && i < contentString.length; i++) {
			if (contentString.charCodeAt(i) === CharCode.LineFeed) line++;
		}
		return line;
	}

	private async _parseMCPConfigFile(): Promise<MCPConfigFileJSON | null> {
		const mcpConfigUri = await this._getMCPConfigFilePath();

		for (let attempt = 0; ; attempt++) {
			const contentString = await this._readMCPConfigFileContents(mcpConfigUri);

			// A missing or still-empty file is first-run, not a failure the user should be told about.
			if (contentString === undefined || contentString.trim() === '') return { mcpServers: {} };

			// jsonc, so comments and trailing commas behave the way they do in every other config file here.
			const errors: ParseError[] = [];
			const configFileJson = parse(contentString, errors, { allowTrailingComma: true });

			if (errors.length === 0) {
				if (!configFileJson || typeof configFileJson !== 'object' || Array.isArray(configFileJson)) {
					this._setHasError(localize('v3code.mcpConfigNotAnObject', "{0} should contain a JSON object with an \"mcpServers\" property.", mcpConfigUri.fsPath))
					return null;
				}
				if (!configFileJson.mcpServers) return { mcpServers: {} };
				return configFileJson as MCPConfigFileJSON;
			}

			if (attempt === 0) {
				await timeout(MCP_CONFIG_REPARSE_DELAY_MS);
				continue;
			}

			const { error, offset } = errors[0];
			this._setHasError(localize(
				'v3code.mcpConfigParseError',
				"Couldn't read {0}: {1} on line {2}. Fix the file and your MCP servers will reload.",
				mcpConfigUri.fsPath,
				getParseErrorMessage(error),
				this._lineNumberOfOffset(contentString, offset),
			))
			// Returning null leaves the servers parsed from the last good version of the file in place.
			return null;
		}
	}


	// Handle server state changes
	private async _refreshMCPServers(): Promise<void> {

		this._setHasError(undefined)

		const newConfigFileJSON = await this._parseMCPConfigFile();
		if (!newConfigFileJSON) { console.log(`Not setting state: MCP config file not found`); return }
		if (!newConfigFileJSON?.mcpServers) { console.log(`Not setting state: MCP config file did not have an 'mcpServers' field`); return }


		const oldConfigFileNames = Object.keys(this.state.mcpServerOfName)
		const newConfigFileNames = Object.keys(newConfigFileJSON.mcpServers)

		const addedServerNames = newConfigFileNames.filter(serverName => !oldConfigFileNames.includes(serverName)); // in new and not in old
		const removedServerNames = oldConfigFileNames.filter(serverName => !newConfigFileNames.includes(serverName)); // in old and not in new

		// set isOn to any new servers in the config
		const addedUserStateOfName: MCPUserStateOfName = {}
		for (const name of addedServerNames) { addedUserStateOfName[name] = { isOn: true } }
		await this.voidSettingsService.addMCPUserStateOfNames(addedUserStateOfName);

		// delete isOn for any servers that no longer show up in the config
		await this.voidSettingsService.removeMCPUserStateOfNames(removedServerNames);

		// set all servers to loading
		for (const serverName in newConfigFileJSON.mcpServers) {
			this._setMCPServerState(serverName, { status: 'loading', tools: [] })
		}
		const updatedServerNames = Object.keys(newConfigFileJSON.mcpServers).filter(serverName => !addedServerNames.includes(serverName) && !removedServerNames.includes(serverName))

		this.channel.call('refreshMCPServers', {
			mcpConfigFileJSON: newConfigFileJSON,
			addedServerNames,
			removedServerNames,
			updatedServerNames,
			userStateOfName: this.voidSettingsService.state.mcpUserStateOfName,
		})
	}

	stringifyResult(result: RawMCPToolCall): string {
		let toolResultStr: string
		if (result.event === 'text') {
			toolResultStr = result.text
		} else if (result.event === 'image') {
			toolResultStr = `[Image: ${result.image.mimeType}]`
		} else if (result.event === 'audio') {
			toolResultStr = `[Audio content]`
		} else if (result.event === 'resource') {
			toolResultStr = `[Resource content]`
		} else {
			toolResultStr = JSON.stringify(result)
		}
		return toolResultStr
	}

	// toggle MCP server and update isOn in void settings
	public async toggleServerIsOn(serverName: string, isOn: boolean): Promise<void> {
		this._setMCPServerState(serverName, { status: 'loading', tools: [] })

		await this.voidSettingsService.setMCPServerState(serverName, { isOn });
		this.channel.call('toggleMCPServer', { serverName, isOn })
	}


	public async callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }> {
		const result = await this.channel.call<RawMCPToolCall>('callTool', toolData);
		if (result.event === 'error') {
			throw new Error(`Error: ${result.text}`)
		}
		return { result };
	}

	public async getMcpConfigServerNames(): Promise<string[]> {
		const mcpConfigUri = await this._getMCPConfigFilePath();
		if (!(await this._configFileExists(mcpConfigUri))) {
			return [];
		}
		const config = await this._parseMCPConfigFile();
		if (!config?.mcpServers) {
			return [];
		}
		return Object.keys(config.mcpServers);
	}

	public async installMcpServer(serverName: string, entry: MCPConfigFileEntryJSON): Promise<void> {
		const mcpConfigUri = await this._getMCPConfigFilePath();
		if (!(await this._configFileExists(mcpConfigUri))) {
			await this._createMCPConfigFile(mcpConfigUri);
		}

		const parsed = await this._parseMCPConfigFile();
		const config: MCPConfigFileJSON = parsed ?? { mcpServers: {} };
		config.mcpServers[serverName] = entry;

		const buffer = VSBuffer.fromString(JSON.stringify(config, null, 2));
		await this._writeMCPConfigFile(mcpConfigUri, buffer);
		await this._refreshMCPServers();
	}

	public async uninstallMcpServer(_serverName: string): Promise<void> {
		throw new Error('The legacy MCP host cannot uninstall servers; MCPUpstreamFacade is the live IMCPService.');
	}

	public installedServerNameFor(_catalogId: string): string | undefined {
		return undefined; // the legacy host has no catalog install-identity map
	}

	public async reauthenticateServer(_serverName: string): Promise<void> {
		throw new Error('The legacy MCP host cannot authenticate servers; MCPUpstreamFacade is the live IMCPService.');
	}

	public async resetServerAuth(_serverName: string): Promise<void> {
		throw new Error('The legacy MCP host cannot authenticate servers; MCPUpstreamFacade is the live IMCPService.');
	}

	// public getMCPToolFns(): MCPToolResultType {
	// 	const tools = this.getMCPTools();
	// 	const toolFns: MCPToolResultType = {};

	// 	tools.forEach((tool) => {
	// 		const name = tool.name;
	// 		// Define the tool call function
	// 		const toolFn = async (params: {
	// 			serverName: string,
	// 			toolName: string,
	// 			args: any
	// 		}) => {
	// 			const { serverName, toolName, args } = params;
	// 			const response = await this.callMCPTool({
	// 				serverName,
	// 				toolName,
	// 				params: args,
	// 			});
	// 			return { result: response }
	// 		};
	// 		toolFns[name] = toolFn;
	// 	});

	// 	return toolFns
	// }
}
