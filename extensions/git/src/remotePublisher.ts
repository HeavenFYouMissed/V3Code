/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable, Event } from 'vscode';
import type { RemoteSourcePublisher } from './api/git';

export interface IRemoteSourcePublisherRegistry {
	readonly onDidAddRemoteSourcePublisher: Event<RemoteSourcePublisher>;
	readonly onDidRemoveRemoteSourcePublisher: Event<RemoteSourcePublisher>;

	getRemoteSourcePublishers(): RemoteSourcePublisher[];
	registerRemoteSourcePublisher(publisher: RemoteSourcePublisher): Disposable;
}
