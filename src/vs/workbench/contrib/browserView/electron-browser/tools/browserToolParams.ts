/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Read a tool param accepting both camelCase (void agent) and snake_case (direct LM host). */
export function pickBrowserParam<T>(params: Record<string, unknown>, ...keys: string[]): T | undefined {
	for (const key of keys) {
		const v = params[key];
		if (v !== undefined && v !== '') {
			return v as T;
		}
	}
	return undefined;
}

export function browserPageId(params: Record<string, unknown>): string | undefined {
	return pickBrowserParam<string>(params, 'pageId', 'page_id');
}
