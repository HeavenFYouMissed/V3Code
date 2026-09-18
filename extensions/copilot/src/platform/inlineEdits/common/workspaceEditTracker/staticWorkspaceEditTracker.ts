/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { DocumentId } from '../dataTypes/documentId';
import { HistoryContext, IHistoryContextProvider } from './historyContextProvider';

export class StaticWorkspaceTracker implements IHistoryContextProvider {
	constructor(
		private readonly edits: HistoryContext,
	) {
	}

	getHistoryContext(_docId: DocumentId): HistoryContext | undefined {
		return this.edits;
	}
}
