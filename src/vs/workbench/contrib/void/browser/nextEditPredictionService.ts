/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';

import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { InlineCompletion } from '../../../../editor/common/languages.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { INLINE_SUGGESTION_ALLOWED_SCHEMES } from '../common/autocomplete/autocompletePostprocessing.js';

interface RenamePattern {
	oldText: string;
	newText: string;
	uri: string;
	timestamp: number;
	line: number;
}

const PATTERN_TTL_MS = 30_000;
const MAX_PATTERNS = 10;
const MIN_IDENT_LEN = 2;
const IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Extracts word tokens from a line of code. Returns a Set of unique identifiers.
 */
function extractWords(line: string): string[] {
	const matches = line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
	return matches ?? [];
}

/**
 * Given old and new versions of a line, tries to find a single-identifier rename.
 * Returns { oldText, newText } or null.
 */
function detectRenameInLine(oldLine: string, newLine: string): { oldText: string; newText: string } | null {
	const oldWords = extractWords(oldLine);
	const newWords = extractWords(newLine);

	if (oldWords.length !== newWords.length) return null;
	if (oldWords.length === 0) return null;

	let diffCount = 0;
	let oldText = '';
	let newText = '';

	for (let i = 0; i < oldWords.length; i++) {
		if (oldWords[i] !== newWords[i]) {
			diffCount++;
			oldText = oldWords[i];
			newText = newWords[i];
		}
	}

	if (diffCount !== 1) return null;
	if (oldText.length < MIN_IDENT_LEN || newText.length < MIN_IDENT_LEN) return null;
	if (!IDENT_RE.test(oldText) || !IDENT_RE.test(newText)) return null;

	return { oldText, newText };
}

class NextEditPredictionService extends Disposable {
	static readonly ID = 'void.nextEditPredictionService';
	_serviceBrand: undefined;

	private readonly _patterns: RenamePattern[] = [];
	private readonly _lineCache = new Map<string, Map<number, string>>();
	private readonly _trackedEditors = new Set<string>();

	constructor(
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@ILanguageFeaturesService private readonly _langFeatureService: ILanguageFeaturesService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
	) {
		super();

		this._register(this._codeEditorService.onCodeEditorAdd(editor => this._attachEditor(editor)));
		for (const editor of this._codeEditorService.listCodeEditors()) {
			this._attachEditor(editor);
		}

		this._register(this._langFeatureService.inlineCompletionsProvider.register('*', {
			groupId: 'v3code-fim', // same primary group as FIM; NES yields to this
			provideInlineCompletions: async (model, position) => {
				return { items: this._predict(model, position) };
			},
			disposeInlineCompletions: () => { },
		}));
	}

	private _attachEditor(editor: ICodeEditor): void {
		const editorId = editor.getId();
		if (this._trackedEditors.has(editorId)) return;
		this._trackedEditors.add(editorId);

		const snapshotLines = (model: ITextModel) => {
			const uri = model.uri.fsPath;
			const cache = new Map<number, string>();
			const lineCount = model.getLineCount();
			for (let i = 1; i <= lineCount; i++) {
				cache.set(i, model.getLineContent(i));
			}
			this._lineCache.set(uri, cache);
		};

		const initModel = editor.getModel();
		if (initModel) snapshotLines(initModel);

		const modelDisposable = editor.onDidChangeModel((e) => {
			if (e.newModelUrl) {
				const model = editor.getModel();
				if (model) snapshotLines(model);
			}
		});

		const contentDisposable = editor.onDidChangeModelContent((e) => {
			if (!this._settingsService.state.globalSettings.enableAutocomplete) return;
			const model = editor.getModel();
			if (!model) return;

			const uri = model.uri.fsPath;
			const oldCache = this._lineCache.get(uri);
			const now = Date.now();

			if (oldCache) {
				for (const change of e.changes) {
					if (change.range.startLineNumber !== change.range.endLineNumber) continue;
					if (change.text.includes('\n') || change.text.includes('\r')) continue;

					const lineNum = change.range.startLineNumber;
					const oldLine = oldCache.get(lineNum);
					if (!oldLine) continue;

					const newLine = model.getLineContent(lineNum);
					const rename = detectRenameInLine(oldLine, newLine);
					if (!rename) continue;

					const existing = this._patterns.find(
						p => p.uri === uri && p.oldText === rename.oldText && p.newText === rename.newText
					);
					if (!existing) {
						this._patterns.push({
							...rename,
							uri,
							timestamp: now,
							line: lineNum,
						});
						while (this._patterns.length > MAX_PATTERNS) this._patterns.shift();
					} else {
						existing.timestamp = now;
						existing.line = lineNum;
					}
				}
			}

			snapshotLines(model);
			this._pruneStale();
		});

		this._register(modelDisposable);
		this._register(contentDisposable);
		this._register(editor.onDidDispose(() => {
			this._trackedEditors.delete(editorId);
			modelDisposable.dispose();
			contentDisposable.dispose();
		}));
	}

	private _pruneStale(): void {
		const cutoff = Date.now() - PATTERN_TTL_MS;
		while (this._patterns.length > 0 && this._patterns[0].timestamp < cutoff) {
			this._patterns.shift();
		}
	}

	private _predict(model: ITextModel, position: Position): InlineCompletion[] {
		if (!this._settingsService.state.globalSettings.enableAutocomplete) return [];
		// Real files only — see INLINE_SUGGESTION_ALLOWED_SCHEMES. The old single-scheme check let
		// every other non-file Monaco model through.
		if (!INLINE_SUGGESTION_ALLOWED_SCHEMES.has(model.uri.scheme)) return [];

		this._pruneStale();
		const uri = model.uri.fsPath;
		const relevant = this._patterns.filter(p => p.uri === uri);
		if (relevant.length === 0) return [];

		const wordInfo = model.getWordAtPosition(position);
		if (!wordInfo) return [];

		const wordUnderCursor = wordInfo.word;

		for (let i = relevant.length - 1; i >= 0; i--) {
			const pattern = relevant[i];
			if (wordUnderCursor !== pattern.oldText) continue;
			if (position.lineNumber === pattern.line) continue;

			return [{
				insertText: pattern.newText,
				range: new Range(
					position.lineNumber, wordInfo.startColumn,
					position.lineNumber, wordInfo.endColumn,
				),
			}];
		}

		return [];
	}
}

registerWorkbenchContribution2(NextEditPredictionService.ID, NextEditPredictionService, WorkbenchPhase.BlockRestore);
