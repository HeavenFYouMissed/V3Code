/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export type LanguageId = string & { _brand: 'languageId' };

export namespace LanguageId {
	export const PlainText = create('plaintext');

	export function create(value: string): LanguageId {
		return value as LanguageId;
	}
}
