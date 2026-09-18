/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { LegacyLinesDiffComputer } from './legacyLinesDiffComputer.js';
import { DefaultLinesDiffComputer } from './defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { getExternalLinesDiffComputer } from './externalLinesDiffComputer.js';
import { ILinesDiffComputer } from './linesDiffComputer.js';

export const linesDiffComputers = {
	getLegacy: () => new LegacyLinesDiffComputer(),
	getDefault: () => new DefaultLinesDiffComputer(),
	getAdvancedExternal: () => getExternalLinesDiffComputer(false),
	getAdvancedWasm: () => getExternalLinesDiffComputer(true),
} satisfies Record<string, () => ILinesDiffComputer | Promise<ILinesDiffComputer>>;
