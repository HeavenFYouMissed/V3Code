/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { CancellationToken, TextDocumentContentProvider, Uri } from 'vscode';

export class CopilotIgnoreInfoFileContentProvider implements TextDocumentContentProvider {
	constructor(private readonly contentProvider: () => Promise<string>) { }

	async provideTextDocumentContent(uri: Uri, token: CancellationToken) {
		return this.contentProvider();
	}

}