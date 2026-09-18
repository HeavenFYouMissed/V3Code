/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Shared brand mark URIs — chrome V for guest/account fallbacks, grey devil for agent "V".
 */

import { FileAccess, type AppResourcePath } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

export const V3_CHROME_AVATAR_PATH = 'vs/workbench/browser/parts/editor/media/v3code_logo_chrome.png' as AppResourcePath;
export const V3_AGENT_DEVIL_PATH = 'vs/workbench/contrib/void/browser/media/v3-agent-devil.png' as AppResourcePath;

export function v3ChromeAvatarUri(): URI {
	return FileAccess.asBrowserUri(V3_CHROME_AVATAR_PATH);
}

export function v3ChromeAvatarUrl(): string {
	return v3ChromeAvatarUri().toString(true);
}

/** Registry marks are bundled locally: opening settings never contacts an icon server. */
export function externalAgentMarkUrls(): string[] {
	return [1, 2, 3].map(index => FileAccess.asBrowserUri(`vs/workbench/contrib/void/browser/media/external-agent-${index}.svg` as AppResourcePath).toString(true));
}

export function v3AgentDevilUri(): URI {
	return FileAccess.asBrowserUri(V3_AGENT_DEVIL_PATH);
}
