/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import type { Turn } from '../../common/state/sessionState.js';

/**
 * Per-session transcript persisted by the external-agent provider. Agents
 * speaking the Agent Client Protocol own their own history; the host keeps
 * this mirror so sessions list and reopen after a restart even when the
 * agent cannot replay them.
 */
export interface IAcpSessionRecord {
	readonly version: 1;
	readonly sessionId: string;
	/** The agent's own session id, used with `session/load` when supported. */
	acpSessionId?: string;
	readonly cwd: string;
	readonly createdAt: number;
	modifiedAt: number;
	title?: string;
	modelId?: string;
	project?: { readonly uri: string; readonly displayName: string };
	turns: Turn[];
}

const RECORD_VERSION = 1;

export class AcpTranscriptStore {

	constructor(
		private readonly _root: URI,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) { }

	private _fileFor(sessionId: string): URI {
		return joinPath(this._root, `${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-')}.json`);
	}

	async read(sessionId: string): Promise<IAcpSessionRecord | undefined> {
		try {
			const content = await this._fileService.readFile(this._fileFor(sessionId));
			return this._parse(content.value.toString());
		} catch (err) {
			if (err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			this._logService.warn(`[ACP] failed to read transcript ${sessionId}`, err);
			return undefined;
		}
	}

	async write(record: IAcpSessionRecord): Promise<void> {
		record.modifiedAt = Date.now();
		await this._fileService.writeFile(this._fileFor(record.sessionId), VSBuffer.fromString(JSON.stringify(record)));
	}

	async delete(sessionId: string): Promise<void> {
		try {
			await this._fileService.del(this._fileFor(sessionId));
		} catch (err) {
			if (!(err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this._logService.warn(`[ACP] failed to delete transcript ${sessionId}`, err);
			}
		}
	}

	async list(): Promise<IAcpSessionRecord[]> {
		let children;
		try {
			children = (await this._fileService.resolve(this._root)).children ?? [];
		} catch (err) {
			if (err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return [];
			}
			this._logService.warn('[ACP] failed to list transcripts', err);
			return [];
		}
		const records: IAcpSessionRecord[] = [];
		for (const child of children) {
			if (child.isDirectory || !child.name.endsWith('.json')) {
				continue;
			}
			try {
				const record = this._parse((await this._fileService.readFile(child.resource)).value.toString());
				if (record) {
					records.push(record);
				}
			} catch (err) {
				this._logService.warn(`[ACP] skipping unreadable transcript ${child.name}`, err);
			}
		}
		return records;
	}

	create(sessionId: string, cwd: string, project: IAcpSessionRecord['project'], modelId: string | undefined): IAcpSessionRecord {
		const now = Date.now();
		return { version: RECORD_VERSION, sessionId, cwd, createdAt: now, modifiedAt: now, project, modelId, turns: [] };
	}

	private _parse(text: string): IAcpSessionRecord | undefined {
		const json = JSON.parse(text) as Partial<IAcpSessionRecord>;
		if (json.version !== RECORD_VERSION || typeof json.sessionId !== 'string' || typeof json.cwd !== 'string') {
			return undefined;
		}
		return {
			version: RECORD_VERSION,
			sessionId: json.sessionId,
			acpSessionId: typeof json.acpSessionId === 'string' ? json.acpSessionId : undefined,
			cwd: json.cwd,
			createdAt: typeof json.createdAt === 'number' ? json.createdAt : Date.now(),
			modifiedAt: typeof json.modifiedAt === 'number' ? json.modifiedAt : Date.now(),
			title: typeof json.title === 'string' ? json.title : undefined,
			modelId: typeof json.modelId === 'string' ? json.modelId : undefined,
			project: json.project && typeof json.project.uri === 'string' && typeof json.project.displayName === 'string' ? json.project : undefined,
			turns: Array.isArray(json.turns) ? json.turns : [],
		};
	}
}
