/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Next-Edit Prediction (NES) — the "tab to fix this" engine (autocomplete packet sec.3). SPECULATIVE:
 * after the user's edit SETTLES (debounced), it asks the model — using the recent-edits journal as
 * the time dimension — for the most likely NEXT edit, and caches it. An InlineCompletionsProvider
 * then serves that cached edit INSTANTLY as a range-replacement (so it can rewrite/delete, not just
 * insert), with a heuristic suppression gate (nextEditPrompt.ts) so it never proposes a no-op,
 * a revert of the user's own edit, or a hallucinated rewrite. Coexists with the FIM autocomplete
 * (returns nothing unless it has a fresh, relevant prediction).
 *
 * Context is REAL structure, not embedding guesses (packet sec.3/sec.7): the semantic index
 * (ISemanticIndexService.retrieve) + the LSP bridge (get_symbol_context), gathered additively under
 * a hard 150ms cap — if the index/LSP are cold, the prediction fires without them.
 *
 * Model: the dedicated 'NextEdit' role (Instinct via Ollama recommended — its native prompt format
 * is used when the model advertises supportsNextEdit); falls back to the Autocomplete model.
 * Tiering into ONE coordinated provider (packet sec.5) is a later refinement.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range, IRange } from '../../../../editor/common/core/range.js';
import { InlineCompletion } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { FeatureName, ModelSelection } from '../common/voidSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { ISemanticIndexService, Hit } from '../common/semanticIndex/semanticIndexTypes.js';
import { IContextBridgeService } from '../common/contextBridge/contextBridgeService.js';
import { ILspBridgeAdapter } from './contextBridge/lspBridgeAdapter.js';
import { runGetSymbolContext } from './contextBridge/contextBridgeTools.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { IRecentEditsService } from './recentEditsService.js';
import { autorun } from '../../../../base/common/observable.js';
import { INLINE_SUGGESTION_ALLOWED_SCHEMES } from '../common/autocomplete/autocompletePostprocessing.js';
import { workspaceIndexPath } from '../common/semanticIndex/workspaceIndexPath.js';
import {
	buildNextEditPrompt, buildNextEditPromptInstinct, parseNextEdit, nextEditSuppressionReason,
	NextEditContextSnippet, NextEditInput, NES_CURSOR_MARKER, INSTINCT_SYSTEM_PROMPT,
} from '../common/nextEditPrompt.js';

const SETTLE_MS = 1200;    // only predict after a real pause (FIM also preempts NES in the engine)
const REGION_RADIUS = 4;   // editable region = cursor line +/- this
const CONTEXT_LINES = 6;   // before/after context lines around the region
const MAX_EDIT_HISTORY = 6;

// context gathering (packet sec.3: additive + bounded — NEVER block a prediction on context)
const CONTEXT_TIMEOUT_MS = 150;   // hard cap; cold index / slow LSP => predict without context
const RETRIEVE_TOP_K = 5;
const PER_SNIPPET_CHARS = 600;    // per-snippet budget
const TOTAL_CONTEXT_CHARS = 2400; // whole related-context budget (small model stays fast)

export type NextEditPhase = 'off' | 'idle' | 'predicting' | 'ready';

export interface INextEditPending {
	readonly uri: string;
	readonly range: IRange;
	readonly updatedText: string;
	/** First non-empty line of the predicted edit, for the V Go panel. */
	readonly preview: string;
}

export interface INextEditService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<void>;
	/** off | idle | predicting | ready — for the V Go discoverability panel. */
	getPhase(): NextEditPhase;
	getPending(): INextEditPending | null;
	/** Focus the editor on the pending prediction range (no-op if none). */
	revealPending(): void;
}

export const INextEditService = createDecorator<INextEditService>('nextEditService');

interface PendingNES { uri: string; range: IRange; updatedText: string; }

class NextEditService extends Disposable implements INextEditService {
	declare readonly _serviceBrand: undefined;

	private _pending: PendingNES | null = null;
	private _phase: NextEditPhase = 'idle';
	private _requestId: string | null = null;
	/** bumped on every recorded edit — kills in-flight context gathers for superseded predictions */
	private _predictGen = 0;
	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _scheduler = this._register(new RunOnceScheduler(() => this._predictNext(), SETTLE_MS));

	constructor(
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@ILanguageFeaturesService private readonly _langFeatureService: ILanguageFeaturesService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IRecentEditsService private readonly _recentEditsService: IRecentEditsService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessageService: IConvertToLLMMessageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@ISemanticIndexService private readonly _semanticIndexService: ISemanticIndexService,
		@IContextBridgeService private readonly _contextBridgeService: IContextBridgeService,
		@ILspBridgeAdapter private readonly _lspBridgeAdapter: ILspBridgeAdapter,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IChatService private readonly _chatService: IChatService,
	) {
		super();

		this._syncPhaseFromSettings();
		this._register(this._settingsService.onDidChangeState(() => this._syncPhaseFromSettings()));

		// Agent chat edits files too — don't expand V Go / NES while a chat turn is live.
		this._register(autorun(reader => {
			if (this._chatService.requestInProgressObs.read(reader)) {
				this._scheduler.cancel();
				this._pending = null;
				this._predictGen++;
				if (this._phase === 'predicting' || this._phase === 'ready') {
					this._setPhase(this._settingsService.state.globalSettings.enableAutocomplete ? 'idle' : 'off');
				}
			}
		}));

		// re-predict after each settled edit burst
		this._register(this._recentEditsService.onDidRecordEdit(() => {
			this._pending = null; // any prior prediction is stale now
			this._predictGen++;   // and so is any in-flight context gather
			this._setPhase(this._settingsService.state.globalSettings.enableAutocomplete ? 'idle' : 'off');
			if (this._chatService.requestInProgressObs.get()) {
				return;
			}
			if (this._settingsService.state.globalSettings.enableAutocomplete) { this._scheduler.schedule(); }
		}));

		// serve the cached prediction as an inline edit (range replacement). YIELDS to the FIM
		// group: VS Code only queries this provider when FIM/heuristic returned nothing, so NES
		// can NEVER preempt or suppress the normal autocomplete. (This is the fix for the
		// regression where adding NES as a 3rd provider killed FIM ghost text.)
		this._register(this._langFeatureService.inlineCompletionsProvider.register('*', {
			groupId: 'v3code-nes',
			yieldsToGroupIds: ['v3code-fim'],
			provideInlineCompletions: (model, position) => ({ items: this._serve(model, position) }),
			disposeInlineCompletions: () => { },
		}));
	}

	getPhase(): NextEditPhase {
		return this._phase;
	}

	getPending(): INextEditPending | null {
		if (!this._pending) { return null; }
		const preview = this._pending.updatedText.split('\n').find(l => l.trim().length > 0)?.trim() ?? this._pending.updatedText.trim();
		return {
			uri: this._pending.uri,
			range: this._pending.range,
			updatedText: this._pending.updatedText,
			preview: preview.length > 72 ? `${preview.slice(0, 71)}…` : preview,
		};
	}

	revealPending(): void {
		const p = this._pending;
		if (!p) { return; }
		void this._editorService.openEditor({
			resource: URI.file(p.uri),
			options: {
				selection: new Range(p.range.startLineNumber, p.range.startColumn, p.range.endLineNumber, p.range.endColumn),
				preserveFocus: false,
				revealIfVisible: true,
			},
		}).then(() => {
			void this._commandService.executeCommand('editor.action.inlineSuggest.trigger');
		});
	}

	private _syncPhaseFromSettings(): void {
		if (!this._settingsService.state.globalSettings.enableAutocomplete) {
			this._setPhase('off');
			return;
		}
		if (this._pending) {
			this._setPhase('ready');
			return;
		}
		if (this._requestId || this._scheduler.isScheduled()) {
			this._setPhase('predicting');
			return;
		}
		this._setPhase('idle');
	}

	private _setPhase(phase: NextEditPhase): void {
		if (this._phase === phase) { return; }
		this._phase = phase;
		this._onDidChangeState.fire();
	}

	// ---- serve (instant, from cache) ----
	private _serve(model: ITextModel, position: Position): InlineCompletion[] {
		if (!this._settingsService.state.globalSettings.enableAutocomplete) { return []; }
		// Real files only — see INLINE_SUGGESTION_ALLOWED_SCHEMES.
		if (!INLINE_SUGGESTION_ALLOWED_SCHEMES.has(model.uri.scheme)) { return []; }
		const p = this._pending;
		if (!p || p.uri !== model.uri.fsPath) { return []; }
		// only when the cursor is inside the predicted region
		if (position.lineNumber < p.range.startLineNumber || position.lineNumber > p.range.endLineNumber) { return []; }
		const range = new Range(p.range.startLineNumber, p.range.startColumn, p.range.endLineNumber, p.range.endColumn);
		const current = model.getValueInRange(range);
		if (current.trim() === p.updatedText.trim()) { return []; } // suppression: never propose a no-op
		return [{ insertText: p.updatedText, range }];
	}

	// ---- predict (background, after settle) ----
	private _predictNext(): void {
		if (this._chatService.requestInProgressObs.get()) { return; }
		const editor = this._codeEditorService.getFocusedCodeEditor() ?? this._codeEditorService.listCodeEditors().find(e => e.hasTextFocus());
		const model = editor?.getModel();
		const position = editor?.getPosition();
		if (!editor || !model || !position) { return; }
		if (!INLINE_SUGGESTION_ALLOWED_SCHEMES.has(model.uri.scheme)) { return; }

		// dedicated NES role; fall back to the Autocomplete model (pre-role behavior)
		const nextEditSelection = this._settingsService.state.modelSelectionOfFeature['NextEdit'];
		const modelSelection = nextEditSelection ?? this._settingsService.state.modelSelectionOfFeature['Autocomplete'];
		const featureName: FeatureName = nextEditSelection ? 'NextEdit' : 'Autocomplete';
		if (!modelSelection) { return; }
		this._setPhase('predicting');

		const lineCount = model.getLineCount();
		const startLine = Math.max(1, position.lineNumber - REGION_RADIUS);
		const endLine = Math.min(lineCount, position.lineNumber + REGION_RADIUS);
		const range: IRange = { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: model.getLineMaxColumn(endLine) };

		// editable region, with the cursor marker inserted at the caret
		const regionLines: string[] = [];
		for (let ln = startLine; ln <= endLine; ln++) {
			let text = model.getLineContent(ln);
			if (ln === position.lineNumber) {
				const col = Math.min(position.column, text.length + 1) - 1;
				text = text.slice(0, col) + NES_CURSOR_MARKER + text.slice(col);
			}
			regionLines.push(text);
		}
		const before = this._lines(model, startLine - CONTEXT_LINES, startLine - 1);
		const after = this._lines(model, endLine + 1, endLine + CONTEXT_LINES);
		const currentRegion = model.getValueInRange(new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn));
		const uri = model.uri.fsPath;

		const promptInput: NextEditInput = {
			editHistory: this._recentEditsService.getRecentEdits(MAX_EDIT_HISTORY).slice().reverse(), // oldest -> newest
			contextSnippets: [], // filled in after the bounded gather below
			filePath: model.uri.fsPath,
			beforeRegion: before,
			editableRegion: regionLines.join('\n'),
			afterRegion: after,
		};

		// everything above is captured synchronously; the gather only ever ADDS context. If a new
		// edit lands while gathering (gen moves on), this prediction is stale — drop it silently.
		const gen = this._predictGen;
		void this._gatherContextSnippets(model, position).then(contextSnippets => {
			if (gen !== this._predictGen) { return; }
			promptInput.contextSnippets = contextSnippets;
			this._sendPrediction({ promptInput, modelSelection, featureName, uri, range, currentRegion });
		});
	}

	/**
	 * Related context under a hard 150ms cap (packet sec.3/sec.7): semantic-index retrieval for the
	 * current line + LSP symbol context (get_symbol_context — the same tool agents use) for the
	 * symbol at the cursor, both in parallel. Any failure or timeout degrades to fewer/no snippets;
	 * this can never block or fail the prediction.
	 */
	private async _gatherContextSnippets(model: ITextModel, position: Position): Promise<NextEditContextSnippet[]> {
		try {
			const deadline = <T,>(p: Promise<T>, fallback: T) => Promise.race([
				p.catch(() => fallback),
				new Promise<T>(resolve => setTimeout(() => resolve(fallback), CONTEXT_TIMEOUT_MS)),
			]);

			const lineText = model.getLineContent(position.lineNumber).trim();
			const word = model.getWordAtPosition(position)?.word ?? model.getWordUntilPosition(position).word;
			const relPath = this._relativePath(model.uri);

			const [hits, symbolCtx] = await Promise.all([
				lineText ? deadline(this._semanticIndexService.retrieve(lineText, { topK: RETRIEVE_TOP_K }), [] as Hit[]) : Promise.resolve([] as Hit[]),
				(word && relPath) ? deadline(runGetSymbolContext(this._lspBridgeAdapter, this._contextBridgeService, { filePath: relPath, symbolName: word }), null) : Promise.resolve(null),
			]);

			const snippets: NextEditContextSnippet[] = [];

			// LSP symbol context first — real structure beats embedding guesses (the packet's edge)
			if (symbolCtx?.symbol) {
				const parts: string[] = [];
				if (symbolCtx.definition) { parts.push(symbolCtx.definition); }
				if (symbolCtx.callers.length) { parts.push(`called by: ${symbolCtx.callers.slice(0, 6).map(c => c.name).join(', ')}`); }
				if (symbolCtx.callees.length) { parts.push(`calls: ${symbolCtx.callees.slice(0, 6).map(c => c.name).join(', ')}`); }
				if (parts.length) { snippets.push({ path: symbolCtx.symbol.filePath, content: parts.join('\n').slice(0, PER_SNIPPET_CHARS) }); }
			}

			// index snippets next, skipping the file being edited (the region/before/after cover it)
			let budget = TOTAL_CONTEXT_CHARS - snippets.reduce((n, s) => n + s.content.length, 0);
			for (const h of hits) {
				if (budget <= 0) { break; }
				const content = h.content?.trim();
				if (!content || !h.chunk?.file) { continue; }
				if (relPath && h.chunk.file === relPath) { continue; }
				const sliced = content.slice(0, Math.min(PER_SNIPPET_CHARS, budget));
				snippets.push({ path: h.chunk.file, content: sliced });
				budget -= sliced.length;
			}
			return snippets;
		} catch { return []; }
	}

	private _sendPrediction(args: {
		promptInput: NextEditInput;
		modelSelection: ModelSelection;
		featureName: FeatureName;
		uri: string;
		range: IRange;
		currentRegion: string;
	}): void {
		const { promptInput, modelSelection, featureName, uri, range, currentRegion } = args;

		// Instinct-family models get their native training format; everything else gets zeta
		const capabilities = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, this._settingsService.state.overridesOfModel);
		const useInstinct = !!capabilities.supportsNextEdit;
		const prompt = useInstinct ? buildNextEditPromptInstinct(promptInput) : buildNextEditPrompt(promptInput);
		const systemMessage = useInstinct
			? INSTINCT_SYSTEM_PROMPT
			: 'You are a precise code next-edit predictor. Output only the updated region or NO_EDITS.';

		const { messages, separateSystemMessage } = this._convertToLLMMessageService.prepareLLMSimpleMessages({
			simpleMessages: [{ role: 'user', content: prompt }],
			systemMessage,
			modelSelection,
			featureName,
		});

		const modelSelectionOptions = this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName];

		// abort any in-flight prediction
		if (this._requestId) { this._llmMessageService.abort(this._requestId); this._requestId = null; }

		this._requestId = this._llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			logging: { loggingName: 'NextEdit' },
			messages,
			modelSelection,
			modelSelectionOptions,
			overridesOfModel: this._settingsService.state.overridesOfModel,
			separateSystemMessage,
			chatMode: null,
			onText: () => { /* no streaming for NES; we use the final */ },
			onFinalMessage: ({ fullText }) => {
				this._requestId = null;
				const { updated } = parseNextEdit(fullText);
				if (updated === null) {
					this._setPhase(this._settingsService.state.globalSettings.enableAutocomplete ? 'idle' : 'off');
					return;
				}
				// suppression gate (packet sec.3) — a bad interruption costs more than a missed one
				const suppressReason = nextEditSuppressionReason({
					updated,
					currentRegion,
					beforeRegion: promptInput.beforeRegion,
					afterRegion: promptInput.afterRegion,
					recentEdits: this._recentEditsService.getRecentEdits(MAX_EDIT_HISTORY), // newest first
				});
				if (suppressReason) {
					this._setPhase(this._settingsService.state.globalSettings.enableAutocomplete ? 'idle' : 'off');
					return;
				}
				this._pending = { uri, range, updatedText: updated };
				this._setPhase('ready');
				this._refreshInlineSuggestion();
			},
			onError: () => {
				this._requestId = null;
				this._setPhase(this._settingsService.state.globalSettings.enableAutocomplete ? 'idle' : 'off');
			},
			onAbort: () => {
				this._requestId = null;
				this._setPhase(this._settingsService.state.globalSettings.enableAutocomplete ? 'idle' : 'off');
			},
		});
	}

	private _lines(model: ITextModel, from: number, to: number): string {
		const a = Math.max(1, from);
		const b = Math.min(model.getLineCount(), to);
		if (b < a) { return ''; }
		const out: string[] = [];
		for (let ln = a; ln <= b; ln++) { out.push(model.getLineContent(ln)); }
		return out.join('\n');
	}

	/** Workspace-relative path for a file uri, or undefined if it's outside the workspace. */
	private _relativePath(uri: URI): string | undefined {
		return workspaceIndexPath(this._workspaceContextService.getWorkspace().folders, uri);
	}

	/** NES predicts in the background; without this the editor never re-queries providers. */
	private _refreshInlineSuggestion(): void {
		const editor = this._codeEditorService.getFocusedCodeEditor();
		if (!editor?.hasTextFocus()) { return; }
		void this._commandService.executeCommand('editor.action.inlineSuggest.trigger');
	}
}

registerSingleton(INextEditService, NextEditService, InstantiationType.Eager);
