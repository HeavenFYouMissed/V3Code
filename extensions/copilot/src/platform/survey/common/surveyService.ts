/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createServiceIdentifier } from '../../../util/common/services';

export const ISurveyService = createServiceIdentifier<ISurveyService>('ISurveyService');

export interface ISurveyService {
	readonly _serviceBrand: undefined;
	signalUsage(source: string, languageId?: string): Promise<void>;
}

export class NullSurveyService implements ISurveyService {

	_serviceBrand: undefined;

	async signalUsage(source: string, languageId?: string): Promise<void> {
		// no-op
	}
}