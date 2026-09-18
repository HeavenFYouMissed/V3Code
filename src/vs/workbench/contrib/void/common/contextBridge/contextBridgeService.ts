/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { SymbolNote } from './contextBridgeTypes.js';
import { IContextBridgeScopeService } from './contextBridgeScopeService.js';

interface NotesFile {
	version: 1;
	notes: SymbolNote[];
	/** Legacy marker retained for backward-compatible reads. Parent-folder notes are no
	 *  longer auto-merged because a parent may contain unrelated sibling projects. */
	heritageMerged?: boolean;
}

/** Notes are keyed by {filePath, symbolName}. File paths arrive from multiple
 *  sources with inconsistent separators AND inconsistent roots (absolute,
 *  workspace-relative, or nested-root-relative). Normalize to POSIX and
 *  lowercase any Windows drive letter so comparison works regardless of origin. */
function normalizePath(p: string): string {
	return p.split('\\').join('/').replace(/\/{2,}/g, '/');
}

/** Lowercase a leading Windows drive letter so 'C:/x' and 'c:/x' compare equal. */
function normalizeDrive(p: string): string {
	return /^[a-zA-Z]:\//.test(p) ? p.charAt(0).toLowerCase() + p.slice(1) : p;
}

/** Segment-aligned suffix match: returns true when the shorter path's segments
 *  are a trailing subsequence of the longer path's segments. This reconciles
 *  the same symbol stored under different roots — e.g. 'src/vs/a.ts',
 *  'vselite/src/vs/a.ts', and 'c:/u/mcp/vselite/src/vs/a.ts' all match.
 *  Always paired with symbolName equality by callers, so the basename-only
 *  edge (single overlapping segment) stays safe in practice. */
function pathsMatch(a: string, b: string): boolean {
	const al = normalizeDrive(a).toLowerCase();
	const bl = normalizeDrive(b).toLowerCase();
	if (al === bl) return true;
	const as = al.split('/').filter(Boolean);
	const bs = bl.split('/').filter(Boolean);
	const min = Math.min(as.length, bs.length);
	if (min === 0) return false;
	for (let i = 1; i <= min; i++) {
		if (as[as.length - i] !== bs[bs.length - i]) return false;
	}
	return true;
}

export interface IContextBridgeService {
	readonly _serviceBrand: undefined;
	listNotes(filterFilePath?: string): Promise<SymbolNote[]>;
	getNotesForSymbol(filePath: string, symbolName: string): Promise<SymbolNote[]>;
	addNote(filePath: string, symbolName: string, note: string, threadId?: string): Promise<SymbolNote>;
	deleteNote(id: string): Promise<boolean>;
	/** Seed a minimal AGENTS.md persistence anchor at the workspace root if none exists.
	 *  Best-effort, idempotent, never throws — call on the first memory write of a session. */
	ensureWorkspaceAnchor(): Promise<void>;
}

export const IContextBridgeService = createDecorator<IContextBridgeService>('contextBridgeService');

export class ContextBridgeService extends Disposable implements IContextBridgeService {
	declare readonly _serviceBrand: undefined;

	private notes: SymbolNote[] = [];
	private loaded = false;
	private loadedNotesUri: string | null = null;
	private heritageMerged = false;
	private savePromise: Promise<void> = Promise.resolve();
	private _anchorEnsured = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IContextBridgeScopeService private readonly scopeService: IContextBridgeScopeService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this.loaded = false;
			this.loadedNotesUri = null;
			this.notes = [];
			this._anchorEnsured = false;
		}));
	}

	private getNotesUri(): URI {
		// Symbol notes are project knowledge. Keep them in the active workspace's
		// .context-bridge store; use the global file only in a true no-folder window.
		return (this.scopeService.getScope() ?? this.scopeService.getGlobalScope()).notesUri;
	}

	/** Canonicalize an incoming path to workspace-relative POSIX form when it
	 *  falls under a workspace folder; otherwise return the normalized absolute
	 *  path. New notes are stored in this form; legacy notes are matched against
	 *  it via {@link pathsMatch} and healed in place on the next addNote touch. */
	private toCanonicalPath(p: string): string {
		const norm = normalizeDrive(normalizePath(p).replace(/^\.\//, ''));
		for (const folder of this.workspaceService.getWorkspace().folders) {
			const root = normalizeDrive(normalizePath(folder.uri.fsPath));
			const rootSlash = root.endsWith('/') ? root : root + '/';
			if (norm.toLowerCase() === root.toLowerCase()) return '';
			if (norm.toLowerCase().startsWith(rootSlash.toLowerCase())) {
				return norm.slice(rootSlash.length);
			}
		}
		return norm;
	}

	private async ensureLoaded(): Promise<void> {
		await this.scopeService.resolve();
		const uri = this.getNotesUri();
		const uriKey = uri.toString();
		if (this.loaded && this.loadedNotesUri === uriKey) return;
		let notes: SymbolNote[] = [];
		let heritageMerged = false;
		try {
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString()) as NotesFile;
			notes = Array.isArray(data.notes) ? data.notes : [];
			heritageMerged = data.heritageMerged === true;
		} catch {
			// File doesn't exist yet or is unreadable — start with empty notes.
			notes = [];
			heritageMerged = false;
		}
		// The file read can finish after a project swap. Discard it instead of
		// installing old-project notes into the new workspace service state.
		await this.scopeService.resolve();
		if (this.getNotesUri().toString() !== uriKey) return this.ensureLoaded();
		this.notes = notes;
		this.heritageMerged = heritageMerged;
		this.loadedNotesUri = uriKey;
		this.loaded = true;
		// Never auto-import parent/global notes into an open project. Existing global
		// notes remain intact and are reachable only through explicit global memory.
	}

	private async save(): Promise<void> {
		const uri = this.getNotesUri();
		if (!uri) return;
		const notes = this.notes.map(note => ({ ...note }));
		const heritageMerged = this.heritageMerged;
		// Serialize writes — chain on the prior save to avoid interleaved writes.
		const prior = this.savePromise;
		this.savePromise = prior.then(async () => {
			try {
				// Capture both the target and payload before awaiting the prior write. A
				// later workspace change must not redirect or empty this pending save.
				const data: NotesFile = { version: 1, notes, heritageMerged };
				const buf = VSBuffer.fromString(JSON.stringify(data, null, 2));
				await this.fileService.writeFile(uri, buf);
			} catch (e) {
				this.logService.error('[ContextBridge] failed to persist notes', e);
				throw e;
			}
		});
		return this.savePromise;
	}

	async listNotes(filterFilePath?: string): Promise<SymbolNote[]> {
		await this.ensureLoaded();
		if (!filterFilePath) return [...this.notes];
		const target = this.toCanonicalPath(filterFilePath);
		return this.notes.filter(n => pathsMatch(this.toCanonicalPath(n.filePath), target));
	}

	async getNotesForSymbol(filePath: string, symbolName: string): Promise<SymbolNote[]> {
		await this.ensureLoaded();
		const target = this.toCanonicalPath(filePath);
		return this.notes.filter(n => n.symbolName === symbolName && pathsMatch(this.toCanonicalPath(n.filePath), target));
	}

	async ensureWorkspaceAnchor(): Promise<void> {
		if (this._anchorEnsured) return;
		this._anchorEnsured = true; // set first: a failed attempt should not retry every write
		try {
			const folder = this.workspaceService.getWorkspace().folders[0];
			if (!folder) return;
			// Anchor already exists in any recognized form → nothing to seed.
			const candidates = [
				URI.joinPath(folder.uri, 'AGENTS.md'),
				URI.joinPath(folder.uri, '.github', 'AGENTS.md'),
				URI.joinPath(folder.uri, '.github', 'copilot-instructions.md'),
			];
			for (const c of candidates) {
				if (await this.fileService.exists(c)) return;
			}
			const name = folder.name || 'Project';
			const scaffold = `# ${name} — Project Journal\n\n`
				+ `Persistence anchor for this workspace's agent memory. The agent maintains this file:\n`
				+ `append notable decisions, changes, and session notes so they survive across chats and\n`
				+ `sessions. Newest entries on top. \`get_project_briefing\` reads the sections below.\n\n`
				+ `## About\n\n_(Replace this with one or two sentences: what this workspace is and what it's for. This is the durable orientation shown to every session.)_\n\n`
				+ `## Recent Changes\n\n_(none yet)_\n\n`
				+ `## Session Memory\n\n_(none yet)_\n`;
			await this.fileService.writeFile(URI.joinPath(folder.uri, 'AGENTS.md'), VSBuffer.fromString(scaffold));
			this.logService.info('[ContextBridge] seeded AGENTS.md persistence anchor at workspace root');
		} catch (e) {
			this.logService.warn('[ContextBridge] failed to seed AGENTS.md anchor', e);
		}
	}

	async addNote(filePath: string, symbolName: string, note: string, threadId?: string): Promise<SymbolNote> {
		await this.ensureLoaded();
		if (!threadId) void this.ensureWorkspaceAnchor();
		const now = new Date().toISOString();
		const canonical = this.toCanonicalPath(filePath);
		const trimmed = note.trim();
		// Upsert: if an identical note (same symbol + same text + matching path)
		// already exists, refresh its timestamp and heal any legacy path instead
		// of creating a duplicate. Distinct insights on the same symbol are kept.
		const existing = this.notes.find(n =>
			n.symbolName === symbolName &&
			n.note.trim() === trimmed &&
			(n.threadId ?? null) === (threadId ?? null) &&
			pathsMatch(this.toCanonicalPath(n.filePath), canonical)
		);
		if (existing) {
			existing.updatedAt = now;
			existing.filePath = canonical;
			await this.save();
			return existing;
		}
		const entry: SymbolNote = {
			id: generateUuid(),
			filePath: canonical,
			symbolName,
			note,
			createdAt: now,
			updatedAt: now,
			threadId,
		};
		// Native-thread work notes live only in the per-user, per-profile canonical
		// anchor store. Returning the normalized record lets the caller persist it there
		// without copying private thread state into the repository's notes.json.
		if (threadId) return entry;
		this.notes.push(entry);
		await this.save();
		return entry;
	}

	async deleteNote(id: string): Promise<boolean> {
		await this.ensureLoaded();
		const before = this.notes.length;
		this.notes = this.notes.filter(n => n.id !== id);
		if (this.notes.length === before) return false;
		await this.save();
		return true;
	}
}

registerSingleton(IContextBridgeService, ContextBridgeService, InstantiationType.Delayed);
