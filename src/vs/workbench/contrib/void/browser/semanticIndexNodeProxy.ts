/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Browser-side proxy that calls the SemanticIndexNodeChannel in the main
// process over IPC. Mirrors semanticEmbedProxy.ts. Consumed by
// semanticIndexBrowserImpl.ts behind the `v3code.semanticIndex.nodeBackend`
// feature flag (default off).

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	NodeIndexChunkInput, NodeIndexHit, NodeIndexOpenParams, NodeIndexOpenResult, NodeIndexStatusResult,
} from '../common/semanticIndex/semanticIndexNodeIpc.js';

export const ISemanticIndexNodeService = createDecorator<ISemanticIndexNodeService>('semanticIndexNodeService');

export interface ISemanticIndexNodeService {
	readonly _serviceBrand: undefined;
	/** Open (or re-key) the engine for a workspace db. Idempotent per identity. */
	open(opts: NodeIndexOpenParams): Promise<NodeIndexOpenResult>;
	/** Mirror pre-chunked units into the engine — embedding happens main-side. */
	upsertChunks(dbPath: string, chunks: NodeIndexChunkInput[]): Promise<{ upserted: number; skipped: number }>;
	/** Drop every chunk indexed under a workspace-relative POSIX path. */
	removeFile(dbPath: string, file: string): Promise<number>;
	/** Query expansion + 4-channel RRF (FTS5-only when vectors unavailable). */
	retrieve(dbPath: string, prompt: string, topK?: number, expanderMode?: 'heuristic' | 'local-llama' | 'chat-model'): Promise<NodeIndexHit[]>;
	status(dbPath: string): Promise<NodeIndexStatusResult>;
	/** Close one engine (or all when dbPath is omitted). */
	disposeBackend(dbPath?: string): Promise<void>;
}

export class SemanticIndexNodeService extends Disposable implements ISemanticIndexNodeService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-semanticIndexNode');
	}

	open(opts: NodeIndexOpenParams): Promise<NodeIndexOpenResult> {
		return this.channel.call('open', opts);
	}

	upsertChunks(dbPath: string, chunks: NodeIndexChunkInput[]): Promise<{ upserted: number; skipped: number }> {
		return this.channel.call('upsertChunks', { dbPath, chunks });
	}

	removeFile(dbPath: string, file: string): Promise<number> {
		return this.channel.call('removeFile', { dbPath, file });
	}

	retrieve(dbPath: string, prompt: string, topK?: number, expanderMode?: 'heuristic' | 'local-llama' | 'chat-model'): Promise<NodeIndexHit[]> {
		return this.channel.call('retrieve', { dbPath, prompt, topK, expanderMode });
	}

	status(dbPath: string): Promise<NodeIndexStatusResult> {
		return this.channel.call('status', { dbPath });
	}

	disposeBackend(dbPath?: string): Promise<void> {
		return this.channel.call('dispose', dbPath ? { dbPath } : undefined);
	}
}

registerSingleton(ISemanticIndexNodeService, SemanticIndexNodeService, InstantiationType.Delayed);
