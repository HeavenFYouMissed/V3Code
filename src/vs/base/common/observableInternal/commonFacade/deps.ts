/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export { assertFn } from '../../assert.js';
export { type EqualityComparer, strictEquals } from '../../equals.js';
export { BugIndicatingError, onBugIndicatingError, onUnexpectedError } from '../../errors.js';
export { Event, type IValueWithChangeEvent } from '../../event.js';
export { DisposableStore, type IDisposable, markAsDisposed, toDisposable, trackDisposable } from '../../lifecycle.js';
