/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { generateUuid } from '../../../../base/common/uuid.js';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTask {
	id: string;
	threadId: string;
	status: BackgroundTaskStatus;
	startedAt: number;
	completedAt?: number;
	summary?: string;
}

export interface IBackgroundAgentService {
	readonly _serviceBrand: undefined;
	forkToBackground(threadId: string): string;
	getRunningTasks(): BackgroundTask[];
	getCompletedTasks(): BackgroundTask[];
	cancelTask(taskId: string): void;
	readonly onDidTaskComplete: Event<BackgroundTask>;
	readonly onDidTasksChange: Event<void>;
}

export const IBackgroundAgentService = createDecorator<IBackgroundAgentService>('backgroundAgentService');

export class BackgroundAgentService extends Disposable implements IBackgroundAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _tasks = new Map<string, BackgroundTask>();

	private readonly _onDidTaskComplete = this._register(new Emitter<BackgroundTask>());
	readonly onDidTaskComplete: Event<BackgroundTask> = this._onDidTaskComplete.event;

	private readonly _onDidTasksChange = this._register(new Emitter<void>());
	readonly onDidTasksChange: Event<void> = this._onDidTasksChange.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	forkToBackground(threadId: string): string {
		const id = generateUuid();
		const task: BackgroundTask = {
			id,
			threadId,
			status: 'running',
			startedAt: Date.now(),
		};
		this._tasks.set(id, task);
		this.logService.info(`[v3code.bgAgent] Forked thread ${threadId} to background task ${id}`);
		this._onDidTasksChange.fire();
		return id;
	}

	getRunningTasks(): BackgroundTask[] {
		const result: BackgroundTask[] = [];
		for (const task of this._tasks.values()) {
			if (task.status === 'running') {
				result.push({ ...task });
			}
		}
		return result;
	}

	getCompletedTasks(): BackgroundTask[] {
		const result: BackgroundTask[] = [];
		for (const task of this._tasks.values()) {
			if (task.status !== 'running') {
				result.push({ ...task });
			}
		}
		return result;
	}

	cancelTask(taskId: string): void {
		const task = this._tasks.get(taskId);
		if (!task) {
			this.logService.warn(`[v3code.bgAgent] Cannot cancel unknown task ${taskId}`);
			return;
		}
		if (task.status !== 'running') {
			this.logService.warn(`[v3code.bgAgent] Task ${taskId} is already ${task.status}`);
			return;
		}
		task.status = 'cancelled';
		task.completedAt = Date.now();
		this.logService.info(`[v3code.bgAgent] Cancelled task ${taskId}`);
		this._onDidTaskComplete.fire({ ...task });
		this._onDidTasksChange.fire();
	}
}

registerSingleton(IBackgroundAgentService, BackgroundAgentService, InstantiationType.Delayed);
