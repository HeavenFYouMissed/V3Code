/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';

/** Environment override pointing at a locally installed SDK package directory. */
export const AgentHostAcpSdkPathEnvVar = 'VSCODE_AGENT_HOST_ACP_SDK_PATH';

const SDK_PACKAGE_DIR = ['node_modules', '@agentclientprotocol', 'sdk'] as const;
const SDK_ENTRY = ['dist', 'acp.js'] as const;

function isSdkDirectory(candidate: string): boolean {
	try {
		return fs.statSync(join(candidate, ...SDK_ENTRY)).isFile();
	} catch {
		return false;
	}
}

/**
 * Returns the directory of the bundled Agent Client Protocol SDK package
 * under `appRoot`, or `undefined` when it is not on disk. Mirrors the
 * "no SDK on disk → no provider" rule used for the other bundled SDK.
 */
export function getBundledAcpSdkPath(appRoot: string): string | undefined {
	const candidate = join(appRoot, ...SDK_PACKAGE_DIR);
	return isSdkDirectory(candidate) ? candidate : undefined;
}

/**
 * Resolves the SDK package directory the host should load: an explicit
 * environment override first, then the bundled copy.
 */
export function resolveAcpSdkPath(appRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env[AgentHostAcpSdkPathEnvVar];
	if (override && isSdkDirectory(override)) {
		return override;
	}
	return getBundledAcpSdkPath(appRoot);
}
