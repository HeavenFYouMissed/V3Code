/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

type ShortCircuitableFunction<A extends unknown[], R, T> = (this: T, ...args: A) => Promise<R>;

// TODO: need to log whenever we hit this short circuit
export function shortCircuit<A extends unknown[], R, T>(
	fn: ShortCircuitableFunction<A, R, T>,
	shortCircuitMs: number,
	shortCircuitReturn: R
): ShortCircuitableFunction<A, R, T> {
	return async function (this: T, ...args: A) {
		return await Promise.race([
			fn.apply(this, args),
			new Promise<R>(resolve => {
				setTimeout(resolve, shortCircuitMs, shortCircuitReturn);
			}),
		]);
	};
}
