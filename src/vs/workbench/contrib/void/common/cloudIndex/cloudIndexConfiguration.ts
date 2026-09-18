/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize } from '../../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

export const CLOUD_INDEX_ENABLED_KEY = 'v3code.cloudIndex.enabled';
export const CLOUD_INDEX_ENDPOINT_KEY = 'v3code.cloudIndex.endpoint';
export const CLOUD_INDEX_TOKEN_KEY = 'v3code.cloudIndex.token';
export const CLOUD_INDEX_WORKSPACE_ID_KEY = 'v3code.cloudIndex.workspaceId';

export const CLOUD_INDEX_SETTING_IDS = [
	CLOUD_INDEX_ENABLED_KEY,
	CLOUD_INDEX_ENDPOINT_KEY,
	CLOUD_INDEX_TOKEN_KEY,
	CLOUD_INDEX_WORKSPACE_ID_KEY,
] as const;

export type CloudIndexSettings = {
	enabled: boolean;
	endpoint: string;
	token: string;
	workspaceId: string;
};

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'v3code.cloudIndex',
	order: 201,
	title: localize('v3code.cloudIndex.title', 'V3Code Cloud Index'),
	type: 'object',
	properties: {
		[CLOUD_INDEX_ENABLED_KEY]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('v3code.cloudIndex.enabled', 'Advanced: use a manually managed V3Index deployment instead of automatic paid-plan Cloud Index.'),
		},
		[CLOUD_INDEX_ENDPOINT_KEY]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('v3code.cloudIndex.endpoint', 'Advanced manual override: V3Index base URL. Paid plans receive the managed endpoint automatically.'),
		},
		[CLOUD_INDEX_TOKEN_KEY]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('v3code.cloudIndex.token', 'Advanced manual override: bearer write token. Managed paid-plan credentials are short-lived and never stored in settings.'),
		},
		[CLOUD_INDEX_WORKSPACE_ID_KEY]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.WINDOW,
			description: localize('v3code.cloudIndex.workspaceId', 'Advanced manual override: V3Index workspace id. Managed personal/team repository ids are provisioned automatically.'),
		},
	},
});

/**
 * Derive a safe fallback id for personal/device-local cloud indexes.
 *
 * A folder basename is not an identity: two clones named `app`, two worktrees,
 * or two unrelated repositories with the same folder name would all write to
 * the same Durable Object. The workbench workspace id covers the complete
 * workspace (including multi-root layouts), so suffixing it prevents those
 * silent corpus collisions without putting an absolute path on the wire.
 *
 * Cross-device/team indexes use an authenticated, server-provisioned id via
 * the setting above. A local workspace id is intentionally not presented as a
 * canonical repository identity.
 */
export function deriveCloudIndexWorkspaceIdForWorkspace(workspace: IWorkspace, configured: string): string {
	if (configured) {
		return configured;
	}
	const displayName = workspace.name || workspace.folders[0]?.name || 'workspace';
	const slug = displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
	const fingerprint = workspace.id.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'anonymous';
	return `${slug.slice(0, 47)}-${fingerprint}`.slice(0, 64);
}

export function deriveCloudIndexWorkspaceId(workspaceService: IWorkspaceContextService, configured: string): string {
	return deriveCloudIndexWorkspaceIdForWorkspace(workspaceService.getWorkspace(), configured);
}

export function readCloudIndexSettings(
	configurationService: IConfigurationService,
	workspaceService: IWorkspaceContextService,
): CloudIndexSettings {
	const folder = workspaceService.getWorkspace().folders[0];
	const resource = folder?.uri;
	const endpoint = (configurationService.getValue<string>(CLOUD_INDEX_ENDPOINT_KEY) ?? '').trim();
	const token = (configurationService.getValue<string>(CLOUD_INDEX_TOKEN_KEY) ?? '').trim();
	const workspaceId = (configurationService.getValue<string>(CLOUD_INDEX_WORKSPACE_ID_KEY, { resource }) ?? '').trim();
	const enabled = !!configurationService.getValue<boolean>(CLOUD_INDEX_ENABLED_KEY) && !!endpoint && !!token;
	return { enabled, endpoint, token, workspaceId };
}

export function cloudIndexConfigurationAffects(e: { affectsConfiguration(configuration: string, overrides?: unknown): boolean }): boolean {
	return CLOUD_INDEX_SETTING_IDS.some(id => e.affectsConfiguration(id));
}
