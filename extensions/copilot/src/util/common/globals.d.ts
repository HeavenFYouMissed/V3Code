/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export { };

declare global {

	type TextDecoder = { decode: (input: Uint8Array, opts?: { stream?: boolean }) => string };
	type TextEncoder = { encode: (input: string) => Uint8Array };
}
