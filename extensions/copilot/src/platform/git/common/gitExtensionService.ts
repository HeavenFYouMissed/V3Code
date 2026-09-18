/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { API } from '../vscode/git';

export const IGitExtensionService = createServiceIdentifier<IGitExtensionService>('IGitExtensionService');

export interface IGitExtensionService {

	readonly _serviceBrand: undefined;

	onDidChange: vscode.Event<{ enabled: boolean }>;

	readonly extensionAvailable: boolean;

	getExtensionApi(): API | undefined;
}
