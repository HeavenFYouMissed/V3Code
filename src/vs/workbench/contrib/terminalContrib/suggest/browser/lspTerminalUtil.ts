/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export const VSCODE_LSP_TERMINAL_PROMPT_TRACKER = 'vscode_lsp_terminal_prompt_tracker= {}\n';

export const terminalLspSupportedLanguages = new Set<{ shellType: string; languageId: string; extension: string }>([
	{
		shellType: 'python',
		languageId: 'python',
		extension: 'py'
	}
]);

export function getTerminalLspSupportedLanguageObj(shellType: string): { shellType: string; languageId: string; extension: string } | undefined {
	for (const supportedLanguage of terminalLspSupportedLanguages) {
		if (supportedLanguage.shellType === shellType) {
			return supportedLanguage;
		}
	}
	return undefined;
}
