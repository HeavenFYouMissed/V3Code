/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { MessageAttachmentKind } from '../../common/state/sessionState.js';
import type { CompletionsParams, CompletionsResult } from '../../common/state/protocol/commands.js';

/** Only advertised commands, at the start of a message; never infer terminal commands. */
export function completeAcpCommands(commands: readonly AvailableCommand[], params: CompletionsParams): CompletionsResult {
	const prefix = params.text.slice(0, params.offset);
	if (!/^\/[\w.-]*$/.test(prefix)) {
		return { items: [] };
	}
	const seen = new Set<string>();
	return {
		items: commands.filter(command => {
			if (!/^[\w.-]+$/.test(command.name) || seen.has(command.name) || !command.name.toLowerCase().startsWith(prefix.slice(1).toLowerCase())) { return false; }
			seen.add(command.name);
			return true;
		}).map(command => ({
			insertText: `/${command.name} `,
			rangeStart: 0,
			rangeEnd: params.offset,
			attachment: {
				type: MessageAttachmentKind.Simple,
				label: `/${command.name}`,
				_meta: { command: command.name, description: `${command.description}${command.input?.hint ? ` (${command.input.hint})` : ''}`, acpCommand: true },
			},
		}))
	};
}
