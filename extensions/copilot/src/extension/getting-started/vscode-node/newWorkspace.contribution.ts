/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { NewWorkspaceInitializer } from './newWorkspaceInitializer';

export function create(accessor: ServicesAccessor): IDisposable {
	const instantiationService = accessor.get(IInstantiationService);

	const disposableStore = new DisposableStore();
	disposableStore.add(instantiationService.createInstance(NewWorkspaceInitializer));

	return disposableStore;
}
