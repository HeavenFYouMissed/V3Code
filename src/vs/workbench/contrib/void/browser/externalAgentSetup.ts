/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Stage only reviewed, single-line text. Never execute setup or copy catalogue environment. */
export async function stageExternalAgentSetup(
	command: string,
	createTerminal: () => Promise<{ sendText(text: string, addNewLine: boolean): Promise<void> }>,
): Promise<void> {
	if (/[\x00-\x1f\x7f]/.test(command)) {
		throw new Error('Setup commands must be a single line without control characters.');
	}
	const terminal = await createTerminal();
	if (command.trim()) {
		await terminal.sendText(command.trim(), false);
	}
}
