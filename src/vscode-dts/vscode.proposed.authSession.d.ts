/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

declare module 'vscode' {
	export namespace authentication {
		/**
		 * @deprecated Use {@link getSession()} {@link AuthenticationGetSessionOptions.silent} instead.
		 */
		export function hasSession(providerId: string, scopes: readonly string[]): Thenable<boolean>;
	}
}
