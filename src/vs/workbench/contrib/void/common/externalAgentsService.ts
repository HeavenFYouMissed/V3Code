/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IExternalAgentCatalogue, IExternalAgentEntry } from '../../../../platform/agentHost/common/externalAgentCatalogue.js';

/**
 * Published index of agents that speak the Agent Client Protocol (ACP).
 * Fetched only when the user asks for a refresh; never on startup.
 */
export const OFFICIAL_ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export const EXTERNAL_AGENTS_SETTINGS_TAB = 'agents';

export const IExternalAgentsService = createDecorator<IExternalAgentsService>('externalAgentsService');

/** What the agent host currently reports for one catalogue entry. */
export interface IExternalAgentHostStatus {
	readonly provider: string;
	readonly displayName: string;
	/** Probe status from the host (ready, command not found, no launch form). */
	readonly description: string;
	readonly modelCount: number;
}

export interface IExternalAgentsState {
	readonly catalogue: IExternalAgentCatalogue;
	/** Registered providers keyed by catalogue id. Empty when the host is off or the SDK is missing. */
	readonly hosted: ReadonlyMap<string, IExternalAgentHostStatus>;
	/** `chat.agentHost.enabled` is on, so enabled agents can register. */
	readonly hostEnabled: boolean;
	readonly refreshing: boolean;
	readonly lastRefreshAt: number | undefined;
	readonly lastError: string | undefined;
}

export interface IExternalAgentCustomInput {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly description?: string;
}

export interface IExternalAgentsService {
	readonly _serviceBrand: undefined;

	readonly state: IExternalAgentsState;
	readonly onDidChangeState: Event<IExternalAgentsState>;

	/** Enables or disables an entry. Enabling asks for workspace trust first. */
	setEnabled(id: string, enabled: boolean): Promise<boolean>;
	setEditorAccess(id: string, capability: 'memoryIndex' | 'browserAccess', enabled: boolean): Promise<void>;
	addCustom(input: IExternalAgentCustomInput): Promise<IExternalAgentEntry>;
	remove(id: string): Promise<void>;
	setRegistryUrl(url: string): Promise<void>;
	/** Fetches the registry and merges it; never enables or launches anything. */
	refreshFromRegistry(): Promise<void>;
	/** Opens a new native chat for an enabled agent. Asks for workspace trust first. */
	openChat(id: string, position?: 'sidebar' | 'editor', preserveEditor?: boolean): Promise<boolean>;
	/** Opens a user-controlled shell; any reviewed command is staged, never executed. */
	openSetupTerminal(id: string): Promise<void>;
	openSetupDocs(id: string): Promise<void>;
	openSettings(): Promise<void>;
}
