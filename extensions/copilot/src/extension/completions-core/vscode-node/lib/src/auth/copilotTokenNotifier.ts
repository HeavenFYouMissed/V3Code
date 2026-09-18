/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IAuthenticationService } from '../../../../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../../../../platform/authentication/common/copilotToken';

export function onCopilotToken(authService: IAuthenticationService, listener: (token: Omit<CopilotToken, 'token'>) => unknown) {
	return authService.onDidAuthenticationChange(() => {
		const copilotToken = authService.copilotToken;
		if (copilotToken) {
			listener(copilotToken);
		}
	});
}
