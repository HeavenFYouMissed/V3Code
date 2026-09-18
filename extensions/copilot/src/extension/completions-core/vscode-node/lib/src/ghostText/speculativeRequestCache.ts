/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { createServiceIdentifier } from '../../../../../../util/common/services';
import { LRUCacheMap } from '../helpers/cache';

type RequestFunction = () => Promise<unknown>;

export const ICompletionsSpeculativeRequestCache = createServiceIdentifier<ICompletionsSpeculativeRequestCache>('ICompletionsSpeculativeRequestCache');
export interface ICompletionsSpeculativeRequestCache {
	readonly _serviceBrand: undefined;

	set(completionId: string, requestFunction: RequestFunction): void;
	request(completionId: string): Promise<void>;
}

export class SpeculativeRequestCache implements ICompletionsSpeculativeRequestCache {
	readonly _serviceBrand: undefined;

	private cache = new LRUCacheMap<string, RequestFunction>(100);

	set(completionId: string, requestFunction: RequestFunction): void {
		this.cache.set(completionId, requestFunction);
	}

	async request(completionId: string): Promise<void> {
		const fn = this.cache.get(completionId);
		if (fn === undefined) { return; }
		this.cache.delete(completionId);
		await fn();
	}
}
