/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IChatSessionService } from '../common/chatSessionService';
import { Event } from '../../../util/vs/base/common/event';
import * as vscode from 'vscode';

export class ChatSessionService implements IChatSessionService {
	declare _serviceBrand: undefined;

	get onDidDisposeChatSession(): Event<string> {
		return vscode.chat.onDidDisposeChatSession as Event<string>;
	}
}