/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { languages, workspace } from 'vscode';
import { DocumentSelector } from 'vscode-languageserver-protocol';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { isDocumentValid } from '../../lib/src/util/documentEvaluation';
import { DocumentContext } from '../../types/src';

export async function contextProviderMatch(
	instantiationService: IInstantiationService,
	documentSelector: DocumentSelector,
	documentContext: DocumentContext
): Promise<number> {
	const vscDoc = workspace.textDocuments.find(td => td.uri.toString() === documentContext.uri);
	if (!vscDoc) {
		return 0;
	}

	const result = await instantiationService.invokeFunction(isDocumentValid, documentContext);
	if (result.status !== 'valid') {
		return 0;
	}

	return languages.match(documentSelector, vscDoc);
}
