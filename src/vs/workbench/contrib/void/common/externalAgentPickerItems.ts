/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize } from '../../../../nls.js';
import type { IExternalAgentsState } from './externalAgentsService.js';

export function getExternalAgentPickerItems(state: IExternalAgentsState, currentType: string) {
	return state.catalogue.agents.filter(entry => state.catalogue.enabledIds.includes(entry.id)).map(entry => {
		const type = `agent-host-acp-${entry.id}`;
		const host = state.hosted.get(entry.id);
		const reason = !state.hostEnabled ? localize('agentPicker.hostOff', "Agent host is off")
			: !host ? localize('agentPicker.pending', "Waiting for agent host")
				: /^(Command not found|No launch command)/.test(host.description) ? host.description : undefined;
		return { id: entry.id, type, name: entry.name, reason, checked: currentType === type, enabled: !reason };
	});
}
