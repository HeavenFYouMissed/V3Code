/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3 is the product's chat-first surface. The preference is profile-scoped so
 * opening a different project does not unexpectedly drop the user back into IDE
 * mode. The workspace-scoped key is retained only for one-time migration from
 * builds that stored the pill independently in every folder.
 */
export const V3_AGENT_MODE_PREFERENCE_KEY = 'v3code.agentMode.preferred';
export const V3_AGENT_MODE_LEGACY_WORKSPACE_KEY = 'v3code.agentMode.active';

export function initialV3AgentModePreference(
	profilePreference: boolean | undefined,
	legacyWorkspacePreference: boolean | undefined,
): boolean {
	return profilePreference ?? legacyWorkspacePreference ?? true;
}
