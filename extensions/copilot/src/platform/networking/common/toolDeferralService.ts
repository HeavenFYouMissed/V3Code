/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createServiceIdentifier } from '../../../util/common/services';

export const IToolDeferralService = createServiceIdentifier<IToolDeferralService>('IToolDeferralService');

export interface IToolDeferralService {
	readonly _serviceBrand: undefined;

	/**
	 * Check whether a tool (by its API-facing name) should be non-deferred.
	 * Returns true if the tool should always be immediately available when
	 * tool search is enabled.
	 */
	isNonDeferredTool(name: string): boolean;
}
