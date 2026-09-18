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
import { URI } from '../../../../base/common/uri.js';
import { ISemanticIndexService, Hit } from '../common/semanticIndex/semanticIndexTypes.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { workspaceIndexUri } from '../common/semanticIndex/workspaceIndexPath.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoContextFile {
	path: string;
	content: string;
	relevance: number;
}

export interface AutoContextResult {
	files: AutoContextFile[];
	tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface IAutoContextService {
	readonly _serviceBrand: undefined;
	gatherContext(userMessage: string, openFiles: URI[]): Promise<AutoContextResult>;
}

export const IAutoContextService = createDecorator<IAutoContextService>('autoContextService');

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
	'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
	'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
	'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
	'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
	'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
	'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
	'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
	'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
	'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
	'because', 'but', 'and', 'or', 'if', 'while', 'this', 'that', 'these',
	'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
	'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what',
	'which', 'who', 'whom', 'please', 'help', 'want', 'like', 'make',
]);

const MAX_FILE_LINES = 500;
const TOP_K_RETRIEVE = 15;
const MAX_UNIQUE_FILES = 5;
const APPROX_CHARS_PER_TOKEN = 4;

class AutoContextService extends Disposable implements IAutoContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISemanticIndexService private readonly semanticIndexService: ISemanticIndexService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async gatherContext(userMessage: string, openFiles: URI[]): Promise<AutoContextResult> {
		this.logService.debug('[AutoContext] gatherContext called', userMessage.slice(0, 80));

		const keywords = this._extractKeywords(userMessage);
		if (keywords.length === 0 && openFiles.length === 0) {
			return { files: [], tokenEstimate: 0 };
		}

		let hits: Hit[];
		try {
			// rerank budget is tight here — this runs during chat message prep
			hits = await this.semanticIndexService.retrieve(userMessage, { topK: TOP_K_RETRIEVE, rerank: { budgetMs: 400 } });
		} catch (err) {
			this.logService.warn('[AutoContext] semantic retrieval failed, falling back to empty', err);
			hits = [];
		}

		const uniqueFiles = this._deduplicateByFile(hits);
		const topFiles = uniqueFiles.slice(0, MAX_UNIQUE_FILES);

		const results: AutoContextFile[] = [];
		let totalChars = 0;

		for (const entry of topFiles) {
			try {
				const content = await this._readFileContent(entry.uri, MAX_FILE_LINES);
				if (content) {
					results.push({
						path: entry.path,
						content,
						relevance: entry.score,
					});
					totalChars += content.length;
				}
			} catch (err) {
				this.logService.warn('[AutoContext] failed to read file', entry.path, err);
			}
		}

		const tokenEstimate = Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN);

		this.logService.debug('[AutoContext] gathered', results.length, 'files, ~', tokenEstimate, 'tokens');
		return { files: results, tokenEstimate };
	}

	private _extractKeywords(message: string): string[] {
		const words = message.split(/[\s,;:.!?()[\]{}"'`]+/);
		const keywords: string[] = [];

		for (const word of words) {
			if (!word || word.length < 2) {
				continue;
			}

			const lower = word.toLowerCase();
			if (STOPWORDS.has(lower)) {
				continue;
			}

			// CamelCase splitting: "getUserName" -> ["get", "User", "Name"]
			const camelParts = word.split(/(?=[A-Z])/);
			if (camelParts.length > 1) {
				keywords.push(word);
				for (const part of camelParts) {
					if (part.length >= 2 && !STOPWORDS.has(part.toLowerCase())) {
						keywords.push(part.toLowerCase());
					}
				}
				continue;
			}

			// snake_case splitting: "get_user_name" -> ["get", "user", "name"]
			const snakeParts = word.split('_');
			if (snakeParts.length > 1) {
				keywords.push(word);
				for (const part of snakeParts) {
					if (part.length >= 2 && !STOPWORDS.has(part.toLowerCase())) {
						keywords.push(part.toLowerCase());
					}
				}
				continue;
			}

			keywords.push(lower);
		}

		return [...new Set(keywords)];
	}

	private _deduplicateByFile(hits: Hit[]): Array<{ path: string; uri: URI; score: number }> {
		const seen = new Map<string, { path: string; uri: URI; score: number }>();

		for (const hit of hits) {
			const filePath = hit.chunk.file;
			if (!seen.has(filePath)) {
				const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
				const fileUri = workspaceIndexUri(workspaceFolders, filePath);
				if (!fileUri) { continue; }

				seen.set(filePath, {
					path: filePath,
					uri: fileUri,
					score: hit.score,
				});
			}
		}

		return [...seen.values()].sort((a, b) => b.score - a.score);
	}

	private async _readFileContent(uri: URI, maxLines: number): Promise<string | null> {
		try {
			const stat = await this.fileService.stat(uri);
			if (!stat || stat.isDirectory) {
				return null;
			}

			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();
			const lines = text.split('\n');

			if (lines.length > maxLines) {
				return lines.slice(0, maxLines).join('\n');
			}
			return text;
		} catch {
			return null;
		}
	}
}

registerSingleton(IAutoContextService, AutoContextService, InstantiationType.Delayed);
