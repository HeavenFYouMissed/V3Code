/*--------------------------------------------------------------------------------------
 *  Copyright (c) 2025-2026 KandD Labs. Proprietary. See LICENSE-V3CODE.txt
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Resumable local memory indexing during genuine workbench idle slices.
 * Each slice builds at most one bounded archive page and embeds one small document batch.
 */

import { disposableTimeout, runWhenGlobalIdle } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IMemoryService } from './memoryService.js';

export class MemoryIndexScheduler extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.memoryIndexScheduler';
	private readonly idleHandle = this._register(new MutableDisposable());
	private readonly delayHandle = this._register(new MutableDisposable());
	private sessionCursor = 0;
	private running = false;
	private failures = 0;
	private stopped = false;

	constructor(@IMemoryService private readonly memoryService: IMemoryService) {
		super();
		this.schedule(5_000);
	}

	/** Schedule one cancellable idle slice; failures back off without blocking startup or chat. */
	private schedule(delay: number): void {
		if (this.stopped) return;
		this.idleHandle.clear();
		// V3Code: an idle timeout is a deadline, not a delay. Enforce the gap first
		// so an idle editor cannot continuously repeat memory reads and writes.
		this.delayHandle.value = disposableTimeout(() => {
			if (this.stopped) return;
			this.idleHandle.value = runWhenGlobalIdle(() => void this.runSlice(), 5_000);
		}, delay);
	}

	private async runSlice(): Promise<void> {
		if (this.stopped) return;
		if (this.running || !this.memoryService.hasWorkspace) {
			this.schedule(30_000);
			return;
		}
		this.running = true;
		try {
			await this.memoryService.backfillMemoryFacts(50);
			const sessions = await this.memoryService.listMemorySessionIds(100);
			if (sessions.length) {
				const sessionId = sessions[this.sessionCursor % sessions.length];
				this.sessionCursor = (this.sessionCursor + 1) % sessions.length;
				await this.memoryService.rebuildArchivePages(sessionId, 80);
			}
			await this.memoryService.drainMemoryIndex(12);
			this.failures = 0;
		} catch {
			this.failures = Math.min(6, this.failures + 1);
		} finally {
			this.running = false;
			this.schedule(this.failures ? Math.min(300_000, 5_000 * 2 ** this.failures) : 30_000);
		}
	}

	override dispose(): void {
		this.stopped = true;
		super.dispose();
	}
}

registerWorkbenchContribution2(MemoryIndexScheduler.ID, MemoryIndexScheduler, WorkbenchPhase.Eventually);
