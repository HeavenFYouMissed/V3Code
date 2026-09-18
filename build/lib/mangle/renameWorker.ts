/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import ts from 'typescript';
import workerpool from 'workerpool';
import { StaticLanguageServiceHost } from './staticLanguageServiceHost.ts';

let service: ts.LanguageService | undefined;

function findRenameLocations(
	projectPath: string,
	fileName: string,
	position: number,
): readonly ts.RenameLocation[] {
	if (!service) {
		service = ts.createLanguageService(new StaticLanguageServiceHost(projectPath));
	}

	return service.findRenameLocations(fileName, position, false, false, {
		providePrefixAndSuffixTextForRename: true,
	}) ?? [];
}

workerpool.worker({
	findRenameLocations
});
