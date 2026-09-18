/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { generateUuid } from '../../../util/vs/base/common/uuid';

export function createCorrelationId(engine: string, flags: Partial<{ isFromCursorJump: boolean }> | undefined): string {
	return JSON.stringify({ id: generateUuid(), engine, ...flags });
}
