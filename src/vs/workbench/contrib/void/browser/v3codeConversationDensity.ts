/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Maps V3Code gear-settings (`v3code.agent.conversationDensity` /
 * `v3code.agent.editorConversationDensity`) to upstream chat tool-card grouping
 * (`CollapsedToolsDisplayMode`). Native chat implements grouping via pinning
 * shell/edit/terminal tools into thinking sections.
 */

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatAgentLocation, CollapsedToolsDisplayMode } from '../../chat/common/constants.js';
import type { IChatResponseViewModel } from '../../chat/common/model/chatViewModel.js';
import { isV3TranscriptResponse } from './v3TranscriptResponse.js';

export type V3ConversationDensity = 'compact-all-grouped' | 'detailed' | 'default';

const DENSITY_CONFIG_KEYS = {
	panel: 'v3code.agent.conversationDensity',
	editor: 'v3code.agent.editorConversationDensity',
} as const;

export function v3DensityToCollapsedToolsMode(density: V3ConversationDensity): CollapsedToolsDisplayMode {
	switch (density) {
		case 'compact-all-grouped':
			return CollapsedToolsDisplayMode.Always;
		case 'detailed':
			return CollapsedToolsDisplayMode.Off;
		default:
			return CollapsedToolsDisplayMode.WithThinking;
	}
}

export function getV3CollapsedToolsDisplayMode(
	configService: IConfigurationService,
	location?: ChatAgentLocation,
): CollapsedToolsDisplayMode {
	const isEditor = location === ChatAgentLocation.EditorInline;
	const configKey = isEditor ? DENSITY_CONFIG_KEYS.editor : DENSITY_CONFIG_KEYS.panel;
	const fallback: V3ConversationDensity = isEditor ? 'detailed' : 'compact-all-grouped';
	const density = configService.getValue<V3ConversationDensity>(configKey) ?? fallback;
	// Earlier V3Code builds wrote `default` explicitly into user profiles. Preserve the
	// setting value while restoring the panel's rolling Working group for those users.
	if (!isEditor && density === 'default') {
		return CollapsedToolsDisplayMode.Always;
	}
	return v3DensityToCollapsedToolsMode(density);
}

export function getV3CollapsedToolsDisplayModeForResponse(
	configService: IConfigurationService,
	element?: IChatResponseViewModel,
): CollapsedToolsDisplayMode {
	// Every V3Code response hands tool grouping to the shared transcript instead of the native
	// rolling thinking group. The transcript keeps each operation visible while it runs and
	// groups only completed successes, so grouping decisions read from observed card state
	// rather than from the native pinning heuristic.
	if (isV3TranscriptResponse(element)) {
		return CollapsedToolsDisplayMode.Off;
	}
	const location = element?.session?.model?.initialLocation;
	return getV3CollapsedToolsDisplayMode(configService, location);
}
