/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as vscode from 'vscode';
import { Command } from '../commandManager';

export class OpenFrontMatterSettingsCommand implements Command {
	public readonly id = '_markdown.openFrontMatterSettings';

	public async execute() {
		await vscode.commands.executeCommand('workbench.action.openSettings', '@id:markdown.preview.frontMatter');
	}
}
