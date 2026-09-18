/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Write-path hooks for Packet 1e: record diff/decision chat events and debounced
 * rollup (chat_events → ws_facts). Called from mutating builtin tools and plan updates.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IMemoryService } from './memoryService.js';

const ROLLUP_DEBOUNCE_MS = 3000;

export interface IMemoryCaptureService {
	readonly _serviceBrand: undefined;
	recordFileEdit(sessionId: string | undefined, uri: URI, toolName: string, verifyPassed?: boolean): void;
	recordPlanUpdate(sessionId: string | undefined, todos: Array<{ id: string; content: string; status: string }>, merge: boolean): void;
	scheduleRollup(): void;
}

export const IMemoryCaptureService = createDecorator<IMemoryCaptureService>('memoryCaptureService');

export class MemoryCaptureService extends Disposable implements IMemoryCaptureService {
	readonly _serviceBrand: undefined;
	private readonly lastPlanPayloadBySession = new Map<string, string>();

	private readonly rollupScheduler = this._register(new RunOnceScheduler(() => {
		if (!this.memoryService.isAvailable) return;
		void this.memoryService.rollup().catch(() => { /* best-effort */ });
	}, ROLLUP_DEBOUNCE_MS));

	constructor(
		@IMemoryService private readonly memoryService: IMemoryService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
	}

	private relPath(uri: URI): string {
		const folder = this.workspaceService.getWorkspaceFolder(uri);
		if (!folder) return uri.fsPath.replace(/\\/g, '/');
		const root = folder.uri.path.endsWith('/') ? folder.uri.path : folder.uri.path + '/';
		return uri.path.startsWith(root) ? uri.path.slice(root.length) : uri.fsPath.replace(/\\/g, '/');
	}

	private title(text: string): string {
		const t = text.trim().replace(/\s+/g, ' ');
		return t.length <= 80 ? t : t.slice(0, 77) + '...';
	}

	recordFileEdit(sessionId: string | undefined, uri: URI, toolName: string, verifyPassed?: boolean): void {
		if (!sessionId || !this.memoryService.isAvailable) return;
		const path = this.relPath(uri);
		void this.memoryService.record({
			sessionId,
			kind: 'diff',
			role: 'lead',
			title: this.title(`${toolName}: ${path}`),
			body: `File changed via ${toolName}`,
			files: [path],
			meta: { tool: toolName, verifyPassed: verifyPassed ?? false },
		}).then(() => this.scheduleRollup()).catch(() => { /* best-effort */ });
	}

	recordPlanUpdate(sessionId: string | undefined, todos: Array<{ id: string; content: string; status: string }>, merge: boolean): void {
		if (!sessionId || !this.memoryService.isAvailable || !todos.length) return;
		const body = todos.map(t => `- [${t.status}] ${t.content}`).join('\n');
		const planKey = todos.map(t => t.id || t.content).join('|').slice(0, 160);
		const payloadKey = `${planKey}\n${body}`;
		if (this.lastPlanPayloadBySession.get(sessionId) === payloadKey) { return; }
		this.lastPlanPayloadBySession.set(sessionId, payloadKey);
		void this.memoryService.record({
			sessionId,
			kind: 'decision',
			role: 'lead',
			title: this.title(`Plan: ${planKey || `${todos.length} items`}`),
			body,
			meta: { merge, todoCount: todos.length, plan: true, planKey },
		}).then(() => this.scheduleRollup()).catch(() => { /* best-effort */ });
	}

	scheduleRollup(): void {
		if (!this.memoryService.isAvailable) return;
		this.rollupScheduler.schedule();
	}
}

registerSingleton(IMemoryCaptureService, MemoryCaptureService, InstantiationType.Delayed);
