/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Recent-edits journal (Tab-Tab autocomplete packet section 1) — the keystone.
 *
 * A rolling, in-memory ring buffer of the user's recent edits, fed by editor content
 * changes. Both the Next-Edit-Prediction context builder and the structural detector read
 * from it, and the agent gets a `recent_edits` tool so it stops re-editing code it just
 * fixed. Edits are COALESCED into bursts (not per-keystroke) so the journal stays a
 * meaningful "what you just did" signal, and persisted (debounced) to the workspace's
 * already-gitignored `.context-bridge/edit-journal.json` so it survives a reload.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { EditEntry, EditEntrySource } from '../common/recentEditsTypes.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { workspaceIndexPath } from '../common/semanticIndex/workspaceIndexPath.js';

export type { EditEntry, EditEntrySource };

export interface IRecentEditsService {
	readonly _serviceBrand: undefined;
	/** Most-recent edits first, up to `n` (default all, max ring size). */
	getRecentEdits(n?: number): EditEntry[];
	getRecentEditsForFile(uri: string, n?: number): EditEntry[];
	getEditsSince(ts: number): EditEntry[];
	/**
	 * Prefer Tab/NES accepts for Turbo Draft. Falls back to mixed recent edits
	 * when fewer than `minAccepts` tagged accepts exist.
	 */
	getRecentAcceptedEdits(n?: number, minAccepts?: number): EditEntry[];
	/**
	 * Turbo Draft's edit trail: recent Tab/NES accepts merged with the developer's own
	 * recent edits in `fileUri` — including DELETIONS, which the accepts-only view drops
	 * the moment five accepts exist. Oldest -> newest, de-duplicated by entry id.
	 */
	getTurboEditContext(fileUri: string, opts?: { accepts?: number; recent?: number }): EditEntry[];
	/** Tag the next content-change burst as a Tab/NES accept (short window). */
	markNextEditAccepted(source: 'tab' | 'nes'): void;
	readonly onDidRecordEdit: Event<EditEntry>;
}

export const IRecentEditsService = createDecorator<IRecentEditsService>('recentEditsService');

const RING_SIZE = 50;
const TEXT_CAP = 200;
const COALESCE_MS = 1_500;   // edits to the same line within this window merge into one entry
const SAVE_DEBOUNCE_MS = 2_000;
/**
 * How long an edit counts as "recent". Turbo Draft tells the model never to restore code the
 * developer just deleted, which is only true for a while — the journal survives restarts, so
 * without a cutoff a deletion from days ago keeps vetoing that code forever, including when
 * the developer now wants it back. One working day.
 */
const EDIT_TTL_MS = 8 * 60 * 60 * 1_000;
const EDIT_JOURNAL_REL = ['.context-bridge', 'edit-journal.json'] as const;

function cap(s: string): string { return s.length <= TEXT_CAP ? s : s.slice(0, TEXT_CAP); }

function editSummary(relativePath: string, startLine: number, endLine: number, oldText: string, newText: string): string {
	const firstChanged = (newText.split('\n')[0] || oldText.split('\n')[0] || '').trim().slice(0, 80);
	return `${relativePath}:${startLine}${endLine !== startLine ? `-${endLine}` : ''} — ${firstChanged}`;
}

class RecentEditsService extends Disposable implements IRecentEditsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRecordEdit = this._register(new Emitter<EditEntry>());
	readonly onDidRecordEdit = this._onDidRecordEdit.event;

	private _ring: EditEntry[] = []; // newest LAST
	private readonly _lineCache = new Map<string, Map<number, string>>(); // uri -> (line -> old content)
	private readonly _trackedEditors = new Set<string>();
	private _pendingAcceptSource: EditEntrySource | null = null;
	private _pendingAcceptUntil = 0;
	private _workspaceIdentity = '';
	private _journalTarget: URI | null = null;

	private readonly _saveScheduler = this._register(new RunOnceScheduler(() => { void this._persist(); }, SAVE_DEBOUNCE_MS));

	constructor(
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._workspaceIdentity = this._currentWorkspaceIdentity();
		this._journalTarget = this._currentJournalUri();
		void this._hydrate();
		this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => this._onWorkspaceChanged()));
		this._register(this._codeEditorService.onCodeEditorAdd(editor => this._attachEditor(editor)));
		for (const editor of this._codeEditorService.listCodeEditors()) { this._attachEditor(editor); }
		// Tab / inline-suggest commit → next buffer change is a Tab/NES accept for Turbo context.
		this._register(this._commandService.onWillExecuteCommand(e => {
			if (e.commandId === 'editor.action.inlineSuggest.commit') {
				this.markNextEditAccepted('tab');
			}
		}));
	}

	// ---- public API ----
	getRecentEdits(n = RING_SIZE): EditEntry[] {
		// Single funnel for every reader, so the age cutoff only has to be applied here.
		const cutoff = Date.now() - EDIT_TTL_MS;
		const out = [...this._ring].reverse().filter(e => e.timestamp >= cutoff);
		return n >= out.length ? out : out.slice(0, Math.max(0, n));
	}
	getRecentEditsForFile(uri: string, n = RING_SIZE): EditEntry[] {
		return this.getRecentEdits(RING_SIZE).filter(e => e.fileUri === uri).slice(0, Math.max(0, n));
	}
	getEditsSince(ts: number): EditEntry[] {
		return this.getRecentEdits(RING_SIZE).filter(e => e.timestamp >= ts);
	}
	getRecentAcceptedEdits(n = 20, minAccepts = 5): EditEntry[] {
		const accepts = this.getRecentEdits(RING_SIZE).filter(e => e.source === 'tab' || e.source === 'nes');
		if (accepts.length >= minAccepts) {
			return accepts.slice(0, Math.max(0, n));
		}
		return this.getRecentEdits(n);
	}
	getTurboEditContext(fileUri: string, opts?: { accepts?: number; recent?: number }): EditEntry[] {
		const acceptsWanted = Math.max(0, opts?.accepts ?? 12);
		const recentWanted = Math.max(0, opts?.recent ?? 8);
		const all = this.getRecentEdits(RING_SIZE); // newest first
		const accepts = all.filter(e => e.source === 'tab' || e.source === 'nes').slice(0, acceptsWanted);
		// Everything the developer did by hand in THIS file — typing and, critically, deletions.
		const ownEdits = all.filter(e => e.fileUri === fileUri && e.source !== 'tab' && e.source !== 'nes').slice(0, recentWanted);
		const byId = new Map<string, EditEntry>();
		for (const e of [...accepts, ...ownEdits]) { byId.set(e.id, e); }
		return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp); // oldest -> newest
	}

	markNextEditAccepted(source: 'tab' | 'nes'): void {
		this._pendingAcceptSource = source;
		this._pendingAcceptUntil = Date.now() + 2_500;
	}

	// ---- editor wiring (mirrors nextEditPredictionService) ----
	private _attachEditor(editor: ICodeEditor): void {
		const id = editor.getId();
		if (this._trackedEditors.has(id)) { return; }
		this._trackedEditors.add(id);

		const init = editor.getModel();
		if (init) { this._snapshot(init); }

		const modelDisposable = editor.onDidChangeModel(() => {
			const model = editor.getModel();
			if (model) { this._snapshot(model); }
		});
		const contentDisposable = editor.onDidChangeModelContent(e => {
			const model = editor.getModel();
			if (!model) { return; }
			this._onContentChange(model, e.changes);
		});

		this._register(modelDisposable);
		this._register(contentDisposable);
		this._register(editor.onDidDispose(() => {
			this._trackedEditors.delete(id);
			modelDisposable.dispose();
			contentDisposable.dispose();
		}));
	}

	private _snapshot(model: ITextModel): void {
		const uri = model.uri.fsPath;
		const cache = new Map<number, string>();
		const n = model.getLineCount();
		for (let i = 1; i <= n; i++) { cache.set(i, model.getLineContent(i)); }
		this._lineCache.set(uri, cache);
	}

	private _onContentChange(model: ITextModel, changes: readonly { range: { startLineNumber: number; endLineNumber: number }; text: string }[]): void {
		// Open editors from the previous project can remain visible across an
		// in-place workspace swap. They must not enter the new project's journal.
		if (!this._workspaceService.getWorkspaceFolder(model.uri)) { return; }
		const uri = model.uri.fsPath;
		const oldCache = this._lineCache.get(uri);
		const relativePath = this._relativePath(model.uri);
		const now = Date.now();

		for (const change of changes) {
			const startLine = change.range.startLineNumber;
			const endLine = change.range.endLineNumber;
			// old text = the affected lines as they were before the change (whole-line approx)
			let oldText = '';
			if (oldCache) {
				const parts: string[] = [];
				for (let ln = startLine; ln <= endLine; ln++) { const l = oldCache.get(ln); if (l !== undefined) { parts.push(l); } }
				oldText = parts.join('\n');
			}
			const newText = change.text;
			if (oldText === newText) { continue; } // no-op
			this._record({ uri, relativePath, startLine, endLine, oldText, newText, now });
		}

		this._snapshot(model);
		this._saveScheduler.schedule();
	}

	private _record(p: { uri: string; relativePath: string; startLine: number; endLine: number; oldText: string; newText: string; now: number }): void {
		const summary = editSummary(p.relativePath, p.startLine, p.endLine, p.oldText, p.newText);
		const source: EditEntrySource = (this._pendingAcceptSource && p.now <= this._pendingAcceptUntil)
			? this._pendingAcceptSource
			: 'edit';
		if (source !== 'edit') {
			this._pendingAcceptSource = null;
			this._pendingAcceptUntil = 0;
		}

		// Coalesce: a fresh edit to the same file+startLine within COALESCE_MS extends the last
		// entry instead of spamming the ring with one entry per keystroke.
		const last = this._ring[this._ring.length - 1];
		if (last && last.fileUri === p.uri && last.range.startLine === p.startLine && (p.now - last.timestamp) < COALESCE_MS) {
			last.newText = cap(p.newText);
			last.range.endLine = Math.max(last.range.endLine, p.endLine);
			last.timestamp = p.now;
			last.summary = summary;
			if (source === 'tab' || source === 'nes') {
				last.source = source;
			}
			this._onDidRecordEdit.fire(last);
			return;
		}

		const entry: EditEntry = {
			id: generateUuid(),
			fileUri: p.uri,
			relativePath: p.relativePath,
			timestamp: p.now,
			range: { startLine: p.startLine, endLine: p.endLine },
			oldText: cap(p.oldText),
			newText: cap(p.newText),
			summary,
			source,
		};
		this._ring.push(entry);
		while (this._ring.length > RING_SIZE) { this._ring.shift(); }
		this._onDidRecordEdit.fire(entry);
	}

	private _relativePath(uri: URI): string {
		return workspaceIndexPath(this._workspaceService.getWorkspace().folders, uri) ?? uri.fsPath.replace(/\\/g, '/');
	}

	// ---- persistence (best-effort; .context-bridge/ is gitignored) ----
	private _currentJournalUri(): URI | null {
		const folder = this._workspaceService.getWorkspace().folders[0];
		return folder ? URI.joinPath(folder.uri, ...EDIT_JOURNAL_REL) : null;
	}
	private _currentWorkspaceIdentity(): string {
		return this._workspaceService.getWorkspace().folders.map(folder => folder.uri.toString()).sort().join('|');
	}
	private _onWorkspaceChanged(): void {
		const previousTarget = this._journalTarget;
		const previousRing = this._ring.slice();
		this._saveScheduler.cancel();
		if (previousTarget && previousRing.length > 0) {
			void this._persistSnapshot(previousTarget, previousRing);
		}
		this._workspaceIdentity = this._currentWorkspaceIdentity();
		this._journalTarget = this._currentJournalUri();
		this._ring = [];
		this._lineCache.clear();
		this._pendingAcceptSource = null;
		this._pendingAcceptUntil = 0;
		for (const editor of this._codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (model && this._workspaceService.getWorkspaceFolder(model.uri)) this._snapshot(model);
		}
		void this._hydrate();
	}
	private async _persistSnapshot(uri: URI, entries: readonly EditEntry[]): Promise<void> {
		try { await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(entries))); }
		catch { /* best-effort */ }
	}
	private async _persist(): Promise<void> {
		const uri = this._journalTarget;
		if (!uri) { return; }
		await this._persistSnapshot(uri, this._ring.slice());
	}
	private async _hydrate(): Promise<void> {
		const workspaceIdentity = this._workspaceIdentity;
		const uri = this._journalTarget;
		if (!uri) { return; }
		try {
			if (!(await this._fileService.exists(uri))) { return; }
			const buf = await this._fileService.readFile(uri);
			if (workspaceIdentity !== this._workspaceIdentity || uri.toString() !== this._journalTarget?.toString()) return;
			const data = JSON.parse(buf.value.toString()) as EditEntry[];
			if (Array.isArray(data)) {
				// Prune on load as well as on read, so the journal file does not carry dead
				// entries forward and a corrupt record without a timestamp cannot linger.
				// fileUri is absolute, so it is also an unambiguous migration source for
				// journals written before multi-root canonical paths existed.
				const cutoff = Date.now() - EDIT_TTL_MS;
				this._ring = data
					.filter(e => typeof e?.timestamp === 'number' && e.timestamp >= cutoff)
					.slice(-RING_SIZE)
					.map(e => {
						if (typeof e.fileUri !== 'string' || typeof e.range?.startLine !== 'number' || typeof e.range?.endLine !== 'number'
							|| typeof e.oldText !== 'string' || typeof e.newText !== 'string') { return e; }
						const relativePath = this._relativePath(URI.file(e.fileUri));
						return relativePath === e.relativePath ? e : {
							...e,
							relativePath,
							summary: editSummary(relativePath, e.range.startLine, e.range.endLine, e.oldText, e.newText),
						};
					});
			}
		} catch { /* corrupt/missing -> start fresh */ }
	}
}

registerSingleton(IRecentEditsService, RecentEditsService, InstantiationType.Eager);
