/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IMCPService } from '../common/mcpService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

const CONTEXT_BRIDGE_SERVER_NAME = 'context-bridge';

/**
 * SUPERSEDED — now a cleanup pass.
 *
 * This used to auto-register a standalone `context-bridge` *stdio* MCP server into
 * the user's mcp.json on every launch, and force-enable it (isOn=true) each time —
 * so the user could never turn it off. That external server hung the chat agent's
 * "Activating MCP extensions…" step (it never completed its MCP handshake), and
 * re-injected itself on every restart.
 *
 * It is now obsolete: the in-editor V3Code MCP server
 * (electron-main/v3codeMcpServerChannel.ts + browser/mcpExposeContribution.ts)
 * exposes the same context-bridge / memory / semantic tools natively, with no
 * external process to spawn — and the V3Code agent already has every one of those
 * tools built in. So instead of adding the server, this contribution now REMOVES
 * the auto-registered entry (once) so the hang goes away for good. Nothing is lost.
 */
class ContextBridgeStartup extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3code.contextBridgeStartup';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IProductService private readonly productService: IProductService,
		@IMCPService private readonly mcpService: IMCPService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
		this.removeAutoRegistered();
	}

	/** Remove the legacy auto-registered context-bridge stdio server from mcp.json. */
	private async removeAutoRegistered(): Promise<void> {
		try {
			await this.voidSettingsService.waitForInitState;

			const configUri = await this.getConfigUri();
			let config: { mcpServers?: Record<string, unknown> };
			try {
				const content = await this.fileService.readFile(configUri);
				config = JSON.parse(content.value.toString());
			} catch {
				return; // no config file yet — nothing to clean up
			}

			if (config.mcpServers && CONTEXT_BRIDGE_SERVER_NAME in config.mcpServers) {
				delete config.mcpServers[CONTEXT_BRIDGE_SERVER_NAME];
				const buffer = VSBuffer.fromString(JSON.stringify(config, null, 2));
				await this.fileService.writeFile(configUri, buffer);
				// Also clear it from Void's own MCP on/off state (best-effort).
				try { await this.mcpService.toggleServerIsOn(CONTEXT_BRIDGE_SERVER_NAME, false); } catch { /* ignore */ }
			}
		} catch (err) {
			console.error('[V3Code] Context Bridge cleanup failed:', err);
		}
	}

	private async getConfigUri(): Promise<URI> {
		const appName = this.productService.dataFolderName;
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, appName, 'mcp.json');
	}
}

registerWorkbenchContribution2(
	ContextBridgeStartup.ID,
	ContextBridgeStartup,
	WorkbenchPhase.BlockRestore,
);
