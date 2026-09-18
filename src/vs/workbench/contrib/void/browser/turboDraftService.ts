/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Turbo Draft — whole-file BYO-model ghost draft.
 * Shift+Tab → gather context → LLM SR blocks → owned DiffZone → Tab/Del cherry-pick.
 *
 * Run stages advance only on real checkpoints (no fake phase timers).
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IOutputChannelRegistry } from '../../../services/output/common/output.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { FeatureName, ModelSelection } from '../common/voidSettingsTypes.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { IRecentEditsService } from './recentEditsService.js';
import { ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { IChatThreadService } from './chatThreadService.js';
import {
	buildTurboDraftPrompt,
	buildTurboDraftRepairPrompt,
	classifyTurboDraftResponse,
	TurboDraftMode,
	TURBO_DRAFT_REPAIR_SYSTEM_PROMPT,
	turboDraftSystemPromptFor,
} from '../common/turboDraftPrompt.js';
import { scoreTurboDraftBlocks, serializeTurboDraftBlocks } from '../common/turboDraftHunkQuality.js';
import { ExtractedSearchReplaceBlock } from '../common/helpers/extractCodeFromResult.js';
import { FINAL, ORIGINAL } from '../common/prompt/prompts.js';
import { estimateTokens } from '../common/tokenBudget.js';
import { deriveTurboIntent, TurboDraftIntent, TurboIntentSource } from '../common/turboDraftIntent.js';
import { gatherTurboCompilerTruth, TurboCompilerTruth } from './turboDraftCompilerContext.js';
import { pickNearbySymbols } from '../common/turboDraftCompilerTruth.js';
import { buildTurboDraftFixPrompt, diffTurboProblems, TurboVerifyProblem } from '../common/turboDraftVerify.js';
import { IMarkerCheckService } from './_markerCheckService.js';
import { ILspBridgeAdapter } from './contextBridge/lspBridgeAdapter.js';
import {
	appendStageHistory,
	canTransitionTurboDraftPhase,
	isTurboDraftTerminalPhase,
	TurboDraftPhase,
	TurboDraftStageDetail,
	TurboDraftStageHistoryEntry,
} from '../common/turboDraftRunState.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DiffZone } from '../common/editCodeServiceTypes.js';
import { workspaceIndexPath } from '../common/semanticIndex/workspaceIndexPath.js';

export type { TurboDraftPhase } from '../common/turboDraftRunState.js';

export interface TurboDraftStartOptions {
	uri?: URI;
	mode?: TurboDraftMode;
	userIntent?: string;
	/**
	 * Deep multi-file (Shift+Q): after this file is reviewed, walk the call-graph blast
	 * radius and draft each affected file in turn, so a change becomes a feature instead
	 * of a file. Ignored in fast mode.
	 */
	multiFile?: boolean;
	/** Internal: continuing an existing multi-file run, do not recompute the queue. */
	_continueQueue?: boolean;
}

export interface TurboDraftSession {
	readonly id: string;
	readonly uri: URI;
	readonly mode: TurboDraftMode;
	phase: TurboDraftPhase;
	acceptedHunks: number;
	rejectedHunks: number;
	pendingHunks: number;
	hunkIdx: number;
	ownedDiffAreaId: number | null;
	sourceHash: string;
	modelLabel: string;
	/** Short human line for the dock, e.g. "From TODO on line 42". */
	intentLabel: string;
	intentSource: TurboIntentSource;
	/** 1-based position in a multi-file run; 1 of 1 for an ordinary single-file draft. */
	fileIndex: number;
	fileTotal: number;
	stageHistory: TurboDraftStageHistoryEntry[];
	detail: TurboDraftStageDetail;
	errorMessage?: string;
	failedPhase?: TurboDraftPhase;
}

export interface ITurboDraftService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSession: Event<TurboDraftSession | undefined>;
	getSession(): TurboDraftSession | undefined;
	startDraft(opts?: TurboDraftStartOptions): Promise<void>;
	/** Abort in-flight LLM only — never restores file contents. */
	cancelDraft(): void;
	/** Discard owned review (Esc). Preserves user edits when source drifted. */
	discardDraft(): void;
	acceptCurrentHunk(): void;
	rejectCurrentHunk(): void;
	openDetails(): void;
	openChangeModel(): void;
}

export const ITurboDraftService = createDecorator<ITurboDraftService>('turboDraftService');

/** True while DiffZones from Turbo Draft are waiting for Tab/Del on the active owned URI. */
export const TURBO_DRAFT_REVIEWING_CONTEXT_KEY = new RawContextKey<boolean>('turboDraft.reviewing', false);

const CONTEXT_TIMEOUT_FAST_MS = 150;
const CONTEXT_TIMEOUT_DEEP_MS = 450;
const RETRIEVE_TOP_K_FAST = 6;
const RETRIEVE_TOP_K_DEEP = 14;
const PER_SNIPPET_CHARS = 900;
const TOTAL_CONTEXT_CHARS_FAST = 2800;
const TOTAL_CONTEXT_CHARS_DEEP = 7200;
const MAX_EDIT_HISTORY = 20;
/** Hand-typed/deleted edits in the drafted file always ride along with the accepts. */
const OWN_EDIT_HISTORY = 8;
const MAX_PLAN_DOCS = 3;
/** Language servers are slow right after an edit; wait, but never hang the session. */
const VERIFY_WAIT_MS = 4_000;
/** Deep multi-file: at most this many extra files after the one you pressed the key in. */
const MAX_QUEUE_FILES = 3;
const BLAST_RADIUS_SYMBOLS = 4;
const BLAST_RADIUS_BUDGET_MS = 2_500;
const PLAN_DOC_CHARS = 8_000;
const CHAT_TURNS = 8;
const CHAT_TURN_CHARS = 400;
const OUTPUT_CHANNEL_ID = 'v3code.turboDraft';

function hashSource(s: string): string {
	const norm = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	let h = 2166136261;
	for (let i = 0; i < norm.length; i++) {
		h ^= norm.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `${norm.length}:${(h >>> 0).toString(16)}`;
}

class TurboDraftService extends Disposable implements ITurboDraftService {
	_serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<TurboDraftSession | undefined>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	private _session: TurboDraftSession | undefined;
	private _requestId: string | null = null;
	private _runGen = 0;
	private _attemptId = 0;
	private readonly _reviewingKey: IContextKey<boolean>;

	constructor(
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IEditorService private readonly _editorService: IEditorService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessageService: IConvertToLLMMessageService,
		@IRecentEditsService private readonly _recentEditsService: IRecentEditsService,
		@ISemanticIndexService private readonly _semanticIndexService: ISemanticIndexService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILspBridgeAdapter private readonly _lspBridgeAdapter: ILspBridgeAdapter,
		@IMarkerCheckService private readonly _markerCheckService: IMarkerCheckService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
		@IOutputService private readonly _outputService: IOutputService,
	) {
		super();
		this._reviewingKey = TURBO_DRAFT_REVIEWING_CONTEXT_KEY.bindTo(contextKeyService);
		this._ensureOutputChannel();

		this._register(this._editCodeService.onDidAddOrDeleteDiffZones(({ uri }) => {
			if (this._session && uri.toString() === this._session.uri.toString()) {
				this._syncOwnedReview();
			}
		}));
		this._register(this._editCodeService.onDidChangeDiffsInDiffZoneNotStreaming(({ uri }) => {
			if (this._session && uri.toString() === this._session.uri.toString()) {
				this._syncOwnedReview();
			}
		}));
		this._register(this._editorService.onDidActiveEditorChange(() => this._updateReviewingKey()));

		// Keyed on the editor so the listeners die with it. Registering them on this service's own
		// lifetime instead leaks two listeners per editor ever opened, none of which are released
		// when it closes — after a long session of opening files, every focus change fans out to a
		// crowd of listeners belonging to editors that no longer exist.
		const editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
		const watchEditor = (editor: ICodeEditor): void => {
			const store = new DisposableStore();
			store.add(editor.onDidFocusEditorText(() => this._updateReviewingKey()));
			store.add(editor.onDidChangeModel(() => this._updateReviewingKey()));
			editorListeners.set(editor, store);
		};
		for (const editor of this._codeEditorService.listCodeEditors()) {
			watchEditor(editor);
		}
		this._register(this._codeEditorService.onCodeEditorAdd(watchEditor));
		this._register(this._codeEditorService.onCodeEditorRemove(editor => {
			editorListeners.deleteAndDispose(editor);
			// The removed editor may have been the one under review, and no focus or model event
			// arrives for an editor that is going away.
			this._updateReviewingKey();
		}));
	}

	getSession(): TurboDraftSession | undefined {
		return this._session;
	}

	openDetails(): void {
		this._ensureOutputChannel();
		void this._outputService.showChannel(OUTPUT_CHANNEL_ID, true);
	}

	openChangeModel(): void {
		// Jump to Features tab where the Turbo Draft model picker lives.
		void this._commandService.executeCommand('void.settingsAction');
	}

	cancelDraft(): void {
		if (this._session?.phase === 'ready') {
			this.discardDraft();
			return;
		}
		this._abortInFlight('cancelled');
	}

	discardDraft(): void {
		const session = this._session;
		if (!session) {
			this._abortInFlight('cancelled');
			return;
		}
		if (session.phase === 'ready' && session.ownedDiffAreaId !== null) {
			// Reject remaining hunks only — never wholesale-revert the file (preserves accepts + user edits).
			for (const id of this._ownedSortedDiffIds()) {
				this._editCodeService.rejectDiff({ diffid: id });
			}
			this._finishTerminal(this._runGen, 'cancelled', localize('turboDraft.discarded', 'Turbo Draft discarded.'));
			return;
		}
		this._abortInFlight('cancelled');
	}

	acceptCurrentHunk(): void {
		if (!this._isActiveOwnedReview()) { return; }
		const diffs = this._ownedSortedDiffIds();
		if (diffs.length === 0 || !this._session) { return; }
		const idx = Math.min(Math.max(0, this._session.hunkIdx), diffs.length - 1);
		this._editCodeService.acceptDiff({ diffid: diffs[idx]! });
		if (this._session) {
			this._session = { ...this._session, acceptedHunks: this._session.acceptedHunks + 1 };
		}
		this._afterHunkOp(idx);
	}

	rejectCurrentHunk(): void {
		if (!this._isActiveOwnedReview()) { return; }
		const diffs = this._ownedSortedDiffIds();
		if (diffs.length === 0 || !this._session) { return; }
		const idx = Math.min(Math.max(0, this._session.hunkIdx), diffs.length - 1);
		this._editCodeService.rejectDiff({ diffid: diffs[idx]! });
		if (this._session) {
			this._session = { ...this._session, rejectedHunks: this._session.rejectedHunks + 1 };
		}
		this._afterHunkOp(idx);
	}

	async startDraft(opts?: TurboDraftStartOptions): Promise<void> {
		let editor = this._codeEditorService.getFocusedCodeEditor() ?? this._codeEditorService.getActiveCodeEditor();
		if (opts?.uri) {
			await this._editorService.openEditor({ resource: opts.uri, options: { preserveFocus: false } });
			editor = this._codeEditorService.getFocusedCodeEditor() ?? this._codeEditorService.getActiveCodeEditor() ?? editor;
		}
		const fileModel = editor?.getModel();
		const fileUri = fileModel?.uri;
		if (!fileUri || !fileModel || fileUri.scheme === Schemas.vscodeChatInput) {
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('turboDraft.noFile', "Open a text file, then press Shift+Tab for Turbo Draft."),
			});
			return;
		}

		// Never restore a prior snapshot on retry — that wiped intentional user edits.
		this._abortInFlight(undefined, { clearSession: true });

		// A fresh Shift+Tab/Shift+Q abandons any multi-file run still in flight.
		if (!opts?._continueQueue) {
			this._fileQueue = [];
			this._queueTotal = 0;
			this._queueIntent = undefined;
		}

		const runGen = ++this._runGen;
		const attemptId = ++this._attemptId;
		const mode: TurboDraftMode = opts?.mode ?? 'fast';
		const fileContents = fileModel.getValue();
		// Later files in a multi-file run inherit the original goal - re-deriving intent
		// from whatever TODO happens to sit in file 3 would scatter the feature.
		const intent = this._deriveIntent(editor, fileModel, fileContents, opts?.userIntent ?? this._queueIntent);
		const modelSel = this._resolveChatModelSelection();
		const modelLabel = modelSel
			? `${mode === 'deep' ? 'Deep' : 'Fast'} · ${modelSel.providerName}/${modelSel.modelName}`
			: `${mode === 'deep' ? 'Deep' : 'Fast'} · (no model)`;

		this._session = {
			id: `turbo-${Date.now()}-${runGen}`,
			uri: fileUri,
			mode,
			phase: 'reading',
			acceptedHunks: 0,
			rejectedHunks: 0,
			pendingHunks: 0,
			hunkIdx: 0,
			ownedDiffAreaId: null,
			sourceHash: hashSource(fileContents),
			modelLabel,
			intentLabel: intent.label,
			intentSource: intent.source,
			fileIndex: this._queueTotal > 0 ? this._queueTotal - this._fileQueue.length : 1,
			fileTotal: this._queueTotal > 0 ? this._queueTotal : 1,
			stageHistory: [{ phase: 'reading', at: Date.now() }],
			detail: {
				fileLines: fileContents.split('\n').length,
				modelLabel,
			},
		};
		this._updateReviewingKey();
		this._fire();
		this._log(`run ${this._session.id} start mode=${mode} model=${modelLabel} lines=${this._session.detail.fileLines} intent=${intent.source}`);

		if (!modelSel) {
			this._fail(runGen, localize('turboDraft.noModel', "Pick a Turbo Draft model in Settings → Features (cloud Chat model — not local FIM)."), 'reading');
			return;
		}

		this._checkpoint(runGen, 'recognizing');
		const cursorLine = editor?.getPosition()?.lineNumber ?? 1;
		// Accepts PLUS the developer's own recent edits in this file. The accepts-only view
		// silently dropped hand-typed edits and deletions once five accepts existed, so
		// "I just deleted this on purpose" never reached the model.
		const editHistory = this._recentEditsService.getTurboEditContext(fileUri.toString(), {
			accepts: MAX_EDIT_HISTORY,
			recent: OWN_EDIT_HISTORY,
		});
		const recentChatSummary = this._summarizeChat();
		const chatTurnCount = recentChatSummary ? recentChatSummary.split('\n').filter(Boolean).length : 0;
		this._patchDetail(runGen, {
			acceptedEditCount: editHistory.length,
			chatTurnCount,
		});
		this._log(`context edits=${editHistory.length} chatTurns=${chatTurnCount}`);

		this._checkpoint(runGen, 'findingRelated');
		const retrieveQuery = this._buildRetrieveQuery(fileUri, fileContents, cursorLine, editHistory.map(e => e.summary), recentChatSummary);
		const contextSnippets = await this._gatherContext(retrieveQuery, fileUri, mode);
		if (runGen !== this._runGen) { return; }
		const relatedFiles = new Set(contextSnippets.map(s => s.path)).size;
		this._patchDetail(runGen, {
			relatedSnippetCount: contextSnippets.length,
			relatedFileCount: relatedFiles,
		});
		this._log(`related snippets=${contextSnippets.length} files=${relatedFiles}`);

		// Deep multi-file: work out the blast radius once, at the head of the run.
		if (opts?.multiFile && mode === 'deep' && !opts?._continueQueue) {
			this._queueIntent = intent.text || undefined;
			const radius = await this._computeBlastRadius(fileUri, cursorLine);
			if (runGen !== this._runGen) { return; }
			this._fileQueue = radius;
			this._queueTotal = radius.length + 1;
			this._session = { ...this._session!, fileIndex: 1, fileTotal: this._queueTotal };
			this._fire();
			this._log(`multi-file queue=${radius.length + 1} files: ${radius.map(u => u.path.split('/').pop()).join(', ')}`);
		}

		// Compiler truth: real diagnostics/signatures/callers beat similar-looking snippets.
		// Strictly time-boxed - a slow language server degrades the prompt, never the draft.
		const compilerTruth = await this._gatherCompilerTruth(fileUri, cursorLine, mode);
		if (runGen !== this._runGen) { return; }
		if (compilerTruth) {
			this._patchDetail(runGen, {
				diagnosticCount: compilerTruth.diagnostics.length,
				signatureCount: compilerTruth.signatures.length,
			});
			this._log(`compiler truth diags=${compilerTruth.diagnostics.length} sigs=${compilerTruth.signatures.length} callers=${compilerTruth.callSites.length} partial=${compilerTruth.partial} in ${compilerTruth.elapsedMs}ms`);
		}

		this._checkpoint(runGen, 'organizing');
		const prompt = buildTurboDraftPrompt({
			filePath: fileUri.fsPath,
			fileContents,
			cursorLine,
			editHistory,
			contextSnippets,
			recentChatSummary,
			mode,
			userIntent: intent.text || undefined,
			compilerTruth: compilerTruth ?? undefined,
		});

		// Snapshot the problem set BEFORE we touch the file; post-review verification only
		// reports what the draft itself broke, not what was already wrong.
		this._baselineProblems = this._markerCheckService.collectDiagnostics(fileUri) ?? [];
		this._runModelSelection = modelSel;
		this._verifiedRunGen = -1;

		this._checkpoint(runGen, 'restructuring');
		await this._callModel({
			runGen,
			attemptId,
			uri: fileUri,
			fileContents,
			modelSelection: modelSel,
			// Prose files get editorial rules; code rules made Markdown passes timid and useless.
			systemMessage: turboDraftSystemPromptFor(this._lspBridgeAdapter.relativize(fileUri)),
			userPrompt: prompt,
			isRepair: false,
		});
	}

	private async _callModel(opts: {
		runGen: number;
		attemptId: number;
		uri: URI;
		fileContents: string;
		modelSelection: ModelSelection;
		systemMessage: string;
		userPrompt: string;
		isRepair: boolean;
		/** Valid blocks from the attempt being repaired, applied if this attempt also fails. */
		salvage?: ExtractedSearchReplaceBlock[];
	}): Promise<void> {
		const featureName: FeatureName = 'TurboDraft';
		const { messages, separateSystemMessage } = this._convertToLLMMessageService.prepareLLMSimpleMessages({
			simpleMessages: [{ role: 'user', content: opts.userPrompt }],
			systemMessage: opts.systemMessage,
			modelSelection: opts.modelSelection,
			featureName,
			includeAIInstructions: false,
		});
		const turboOpts = this._settingsService.state.optionsOfModelSelection[featureName]
			?.[opts.modelSelection.providerName]
			?.[opts.modelSelection.modelName];
		const chatOpts = this._settingsService.state.optionsOfModelSelection['Chat']
			?.[opts.modelSelection.providerName]
			?.[opts.modelSelection.modelName];
		const modelSelectionOptions = turboOpts ?? chatOpts;

		this._patchDetail(opts.runGen, {
			promptTokens: estimateTokens(opts.systemMessage) + estimateTokens(opts.userPrompt),
		});

		this._requestId = this._llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			logging: { loggingName: opts.isRepair ? 'TurboDraftRepair' : 'TurboDraft' },
			messages,
			modelSelection: opts.modelSelection,
			modelSelectionOptions,
			overridesOfModel: this._settingsService.state.overridesOfModel,
			separateSystemMessage,
			chatMode: null,
			onText: ({ fullText }) => {
				if (opts.runGen !== this._runGen || opts.attemptId !== this._attemptId) { return; }
				this._patchDetail(opts.runGen, { streamedChars: fullText.length });
				if (this._session && this._session.phase !== 'restructuring' && this._session.phase !== 'repairing') {
					this._checkpoint(opts.runGen, opts.isRepair ? 'repairing' : 'restructuring');
				}
			},
			onFinalMessage: ({ fullText, fullReasoning }) => {
				this._requestId = null;
				if (opts.runGen !== this._runGen || opts.attemptId !== this._attemptId) { return; }
				void this._handleModelResult({
					runGen: opts.runGen,
					attemptId: opts.attemptId,
					uri: opts.uri,
					fileContents: opts.fileContents,
					modelSelection: opts.modelSelection,
					fullText,
					fullReasoning,
					alreadyRepaired: opts.isRepair,
					salvage: opts.salvage,
				});
			},
			onError: ({ message }) => {
				this._requestId = null;
				if (opts.runGen !== this._runGen || opts.attemptId !== this._attemptId) { return; }
				this._fail(opts.runGen, message || localize('turboDraft.llmError', "Turbo Draft model error."), opts.isRepair ? 'repairing' : 'restructuring');
			},
			onAbort: () => {
				this._requestId = null;
				if (opts.runGen === this._runGen && opts.attemptId === this._attemptId) {
					this._finishTerminal(opts.runGen, 'cancelled');
				}
			},
		});
	}

	private async _handleModelResult(opts: {
		runGen: number;
		attemptId: number;
		uri: URI;
		fileContents: string;
		modelSelection: ModelSelection;
		fullText: string;
		fullReasoning: string;
		alreadyRepaired: boolean;
		/** Valid blocks carried over from the attempt this one is repairing. */
		salvage?: ExtractedSearchReplaceBlock[];
	}): Promise<void> {
		this._checkpoint(opts.runGen, 'validating');
		const classification = classifyTurboDraftResponse(opts.fullText, {
			hasReasoning: !!(opts.fullReasoning && opts.fullReasoning.trim()),
		});
		this._log(`classify=${classification.kind} detail=${classification.detail} chars=${classification.text.length}`);

		if (classification.kind === 'no-changes') {
			// A repair that answers NO_CHANGES has given up, not found peace: the attempt it is
			// repairing proposed edits. Ship the blocks that were already valid rather than nothing.
			if (await this._trySalvage(opts, 'repair returned NO_CHANGES')) { return; }
			this._finishTerminal(opts.runGen, 'noChanges', localize('turboDraft.noUseful', 'No useful edits found.'));
			return;
		}

		const needsRepair = classification.kind === 'empty'
			|| classification.kind === 'reasoning-only'
			|| classification.kind === 'malformed';

		let blocksText = classification.text;
		if (classification.kind === 'valid-blocks') {
			const report = scoreTurboDraftBlocks(opts.fileContents, blocksText);
			if (!report.ok) {
				const reasons = Object.entries(report.rejectSummary).map(([k, v]) => `${k}=${v}`).join(', ');
				this._log(`quality fail ${reasons}`);
				if (!opts.alreadyRepaired) {
					await this._runRepair(
						opts,
						blocksText,
						localize('turboDraft.qualityFail', 'Hunk quality failed ({0}).', reasons || 'parse'),
						{ rejectReasons: Object.keys(report.rejectSummary), salvage: report.salvageableBlocks },
					);
					return;
				}
				if (await this._trySalvage(opts, `invalid after repair (${reasons || 'parse failed'})`)) { return; }
				this._fail(opts.runGen, localize('turboDraft.badHunks', "Turbo Draft: invalid edits after repair ({0}).", reasons || 'parse failed'), 'validating');
				return;
			}
			this._patchDetail(opts.runGen, { validHunkCount: report.acceptedBlocks.length });
			await this._applyOwnedReview(opts.runGen, opts.uri, opts.fileContents, serializeTurboDraftBlocks(report.acceptedBlocks));
			return;
		}

		if (needsRepair && !opts.alreadyRepaired) {
			await this._runRepair(opts, opts.fullText || opts.fullReasoning || '', classification.detail);
			return;
		}

		if (await this._trySalvage(opts, `repair failed (${classification.kind})`)) { return; }

		this._fail(
			opts.runGen,
			classification.kind === 'reasoning-only'
				? localize('turboDraft.reasoningOnly', 'Turbo Draft: model returned reasoning without edits.')
				: classification.kind === 'empty'
					? localize('turboDraft.empty', 'Turbo Draft: model returned an empty response.')
					: localize('turboDraft.malformed', 'Turbo Draft: {0}', classification.detail),
			'validating',
		);
	}

	/**
	 * Last resort when a repair pass fails: apply the blocks the first attempt already got
	 * right. Each was checked for uniqueness, size and overlap on its own, so a subset is
	 * safe to apply — and a partial draft the developer can review beats "No useful edits".
	 * Returns true when it took over the run.
	 */
	private async _trySalvage(
		opts: {
			runGen: number;
			uri: URI;
			fileContents: string;
			salvage?: ExtractedSearchReplaceBlock[];
		},
		why: string,
	): Promise<boolean> {
		const blocks = opts.salvage ?? [];
		if (!blocks.length) { return false; }
		if (opts.runGen !== this._runGen) { return true; }
		this._log(`salvage ${blocks.length} block(s) from the first attempt: ${why}`);
		this._patchDetail(opts.runGen, { validHunkCount: blocks.length });
		await this._applyOwnedReview(opts.runGen, opts.uri, opts.fileContents, serializeTurboDraftBlocks(blocks));
		return true;
	}

	private async _runRepair(
		opts: {
			runGen: number;
			attemptId: number;
			uri: URI;
			fileContents: string;
			modelSelection: ModelSelection;
		},
		previousResponse: string,
		why: string,
		detail?: { rejectReasons?: string[]; salvage?: ExtractedSearchReplaceBlock[] },
	): Promise<void> {
		if (opts.runGen !== this._runGen) { return; }
		this._checkpoint(opts.runGen, 'repairing', why);
		this._log(`repair start reason=${why}`);
		const attemptId = ++this._attemptId;
		const repairPrompt = buildTurboDraftRepairPrompt({
			filePath: opts.uri.fsPath,
			fileContents: opts.fileContents,
			previousResponse,
			rejectReasons: detail?.rejectReasons,
			// Only a response that actually contained edits earns the stricter "do not give up"
			// ending; a malformed blob with no blocks may genuinely have nothing to say.
			hadEdits: previousResponse.includes(ORIGINAL) && previousResponse.includes(FINAL),
		});
		await this._callModel({
			runGen: opts.runGen,
			attemptId,
			uri: opts.uri,
			fileContents: opts.fileContents,
			modelSelection: opts.modelSelection,
			systemMessage: TURBO_DRAFT_REPAIR_SYSTEM_PROMPT,
			userPrompt: repairPrompt,
			isRepair: true,
			salvage: detail?.salvage,
		});
	}

	private async _applyOwnedReview(runGen: number, uri: URI, expectedSource: string, blocksStr: string): Promise<void> {
		if (runGen !== this._runGen || !this._session) { return; }
		const live = this._liveSource(uri);
		if (live === null) {
			this._fail(runGen, localize('turboDraft.missingModel', 'File is no longer open.'), 'creatingTabs');
			return;
		}
		if (hashSource(live) !== this._session.sourceHash) {
			this._finishTerminal(runGen, 'sourceChanged', localize('turboDraft.sourceChanged', 'File changed while Turbo Draft was running — draft discarded to preserve your edits.'));
			return;
		}

		this._checkpoint(runGen, 'creatingTabs');
		const result = this._editCodeService.applyTurboDraftReview({
			uri,
			searchReplaceBlocks: blocksStr,
			expectedSource,
			turboRunId: this._session.id,
		});
		this._log(`apply result ok=${result.ok} ${result.ok ? `diffs=${result.pendingDiffs} area=${result.diffAreaId}` : `reason=${result.reason} ${result.message}`}`);

		if (!result.ok) {
			if (result.reason === 'source-changed') {
				this._finishTerminal(runGen, 'sourceChanged', result.message);
				return;
			}
			this._fail(runGen, localize('turboDraft.applyFail', 'Turbo Draft apply failed: {0}', result.message), 'creatingTabs');
			return;
		}

		if (runGen !== this._runGen || !this._session) { return; }
		this._session = {
			...this._session,
			phase: 'ready',
			ownedDiffAreaId: result.diffAreaId,
			pendingHunks: result.pendingDiffs,
			hunkIdx: 0,
			acceptedHunks: 0,
			rejectedHunks: 0,
			stageHistory: appendStageHistory(this._session.stageHistory, 'ready', Date.now(), `${result.pendingDiffs} hunks`),
			detail: {
				...this._session.detail,
				validHunkCount: result.pendingDiffs,
				pendingHunks: result.pendingDiffs,
				currentHunkIndex: 0,
			},
		};
		this._updateReviewingKey();
		this._fire();
		this._flashTabReady();
		await this._editorService.openEditor({ resource: uri, options: { preserveFocus: false, revealIfOpened: true } });
		this._revealOwnedHunk(0);
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize('turboDraft.ready', "Turbo Draft ready — {0} tab(s). Tab accept · Del reject · Esc discard.", result.pendingDiffs),
		});
	}

	/**
	 * After the developer finishes reviewing, ask the language server whether the draft
	 * broke anything, and offer one targeted repair pass if it did.
	 *
	 * Only NEW errors count - files routinely have pre-existing problems, and reporting
	 * those would train the user to ignore this. Every failure path still completes the
	 * session: verification is a safety net, never a gate.
	 */
	private async _verifyThenComplete(runGen: number): Promise<void> {
		const session = this._session;
		const complete = () => {
			this._finishTerminal(runGen, 'completed', localize('turboDraft.completed', 'Turbo Draft review complete.'));
			this._advanceFileQueue();
		};

		if (!session || runGen !== this._runGen || this._verifiedRunGen === runGen) { complete(); return; }
		this._verifiedRunGen = runGen;

		// Nothing was accepted, verification disabled, or no model to repair with: just finish.
		if (session.acceptedHunks === 0
			|| this._settingsService.state.globalSettings.turboDraftVerifyDraft === false
			|| !this._runModelSelection) {
			complete();
			return;
		}

		this._checkpoint(runGen, 'verifying');
		let after: TurboVerifyProblem[] | null = null;
		try {
			// alwaysWaitForChange: the marker set right after an edit is the STALE pre-edit
			// one, and trusting it would report a clean draft (or blame the wrong lines).
			after = await this._markerCheckService.collectDiagnosticsWithWait(
				session.uri,
				VERIFY_WAIT_MS,
				{ alwaysWaitForChange: true },
			);
		} catch (e) {
			this._log(`verify failed: ${e instanceof Error ? e.message : String(e)}`);
			complete();
			return;
		}
		if (runGen !== this._runGen) { return; }

		const { newErrors, clean } = diffTurboProblems(this._baselineProblems, after);
		this._log(`verify newErrors=${newErrors.length} clean=${clean}`);
		if (clean) { complete(); return; }

		const live = this._liveSource(session.uri);
		if (live === null) { complete(); return; }

		this._patchDetail(runGen, { newErrorCount: newErrors.length });
		this._checkpoint(runGen, 'autoFixing');
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'turboDraft.autoFix',
				"Turbo Draft introduced {0} new error(s) - drafting a fix for you to review.",
				newErrors.length,
			),
		});

		// The fix is presented as a normal reviewable draft. Silently rewriting the file
		// after the user already finished reviewing would be the worst possible surprise.
		const attemptId = ++this._attemptId;
		this._session = { ...this._session!, sourceHash: hashSource(live), acceptedHunks: 0, rejectedHunks: 0 };
		await this._callModel({
			runGen,
			attemptId,
			uri: session.uri,
			fileContents: live,
			modelSelection: this._runModelSelection,
			systemMessage: turboDraftSystemPromptFor(this._lspBridgeAdapter.relativize(session.uri)),
			userPrompt: buildTurboDraftFixPrompt({
				filePath: session.uri.fsPath,
				fileContents: live,
				newErrors,
			}),
			isRepair: false,
		});
	}

	private _afterHunkOp(keptIdx: number): void {
		const diffs = this._ownedSortedDiffIds();
		if (!this._session) { return; }
		if (diffs.length === 0) {
			void this._verifyThenComplete(this._runGen);
			return;
		}
		const nextIdx = Math.min(keptIdx, diffs.length - 1);
		this._session = {
			...this._session,
			pendingHunks: diffs.length,
			hunkIdx: nextIdx,
			detail: {
				...this._session.detail,
				pendingHunks: diffs.length,
				currentHunkIndex: nextIdx,
			},
		};
		this._updateReviewingKey();
		this._fire();
		this._revealOwnedHunk(nextIdx);
	}

	private _syncOwnedReview(): void {
		if (!this._session || this._session.phase !== 'ready') { return; }
		// Resolving the last hunk deletes the zone outright, so the common exit is the
		// missing-zone branch, not the empty-diffs one. Both must go through verification:
		// this listener beats _afterHunkOp, and completing here would leave the later
		// verify as an illegal completed -> verifying transition that is silently dropped.
		const zone = this._ownedZone();
		if (!zone) {
			void this._verifyThenComplete(this._runGen);
			return;
		}
		const diffs = this._ownedSortedDiffIds();
		if (diffs.length === 0) {
			void this._verifyThenComplete(this._runGen);
			return;
		}
		const hunkIdx = Math.min(this._session.hunkIdx, diffs.length - 1);
		this._session = {
			...this._session,
			pendingHunks: diffs.length,
			hunkIdx,
			detail: { ...this._session.detail, pendingHunks: diffs.length, currentHunkIndex: hunkIdx },
		};
		this._updateReviewingKey();
		this._fire();
	}

	private _ownedZone(): DiffZone | undefined {
		const id = this._session?.ownedDiffAreaId;
		if (id === null || id === undefined) { return undefined; }
		const area = this._editCodeService.diffAreaOfId[String(id)];
		if (!area || area.type !== 'DiffZone') { return undefined; }
		if (this._session && area.turboRunId && area.turboRunId !== this._session.id) { return undefined; }
		return area;
	}

	private _ownedSortedDiffIds(): number[] {
		const zone = this._ownedZone();
		if (!zone) { return []; }
		return Object.values(zone._diffOfId)
			.sort((a, b) => a.startLine - b.startLine)
			.map(d => d.diffid);
	}

	private _revealOwnedHunk(idx: number): void {
		const diffs = this._ownedSortedDiffIds();
		const diffid = diffs[idx];
		if (diffid === undefined) { return; }
		const diff = this._editCodeService.diffOfId[diffid];
		if (!diff) { return; }
		const editor = this._codeEditorService.getFocusedCodeEditor() ?? this._codeEditorService.getActiveCodeEditor();
		if (!editor || editor.getModel()?.uri.toString() !== this._session?.uri.toString()) { return; }
		editor.revealLineInCenter(diff.startLine);
		editor.setPosition({ lineNumber: diff.startLine, column: 1 });
	}

	private _isActiveOwnedReview(): boolean {
		if (!this._session || this._session.phase !== 'ready' || this._session.ownedDiffAreaId === null) {
			return false;
		}
		const active = this._activeEditorUri();
		return !!active && active.toString() === this._session.uri.toString();
	}

	private _activeEditorUri(): URI | undefined {
		const editor = this._codeEditorService.getFocusedCodeEditor() ?? this._codeEditorService.getActiveCodeEditor();
		return editor?.getModel()?.uri;
	}

	private _updateReviewingKey(): void {
		this._reviewingKey.set(this._isActiveOwnedReview() && this._ownedSortedDiffIds().length > 0);
	}

	private _abortInFlight(terminal?: 'cancelled', opts?: { clearSession?: boolean }): void {
		this._runGen++;
		if (terminal === 'cancelled') {
			// Backing out of one file abandons the rest of the multi-file run; opening more
			// files after the user hit Esc is the opposite of what they asked for.
			this._fileQueue = [];
			this._queueTotal = 0;
			this._queueIntent = undefined;
		}
		if (this._requestId) {
			this._llmMessageService.abort(this._requestId);
			this._requestId = null;
		}
		if (opts?.clearSession || !this._session) {
			this._session = undefined;
			this._updateReviewingKey();
			this._fire();
			return;
		}
		if (terminal && this._session && !isTurboDraftTerminalPhase(this._session.phase)) {
			this._finishTerminal(this._runGen, terminal);
			return;
		}
		this._session = undefined;
		this._updateReviewingKey();
		this._fire();
	}

	private _checkpoint(runGen: number, phase: TurboDraftPhase, detail?: string): void {
		if (runGen !== this._runGen || !this._session) { return; }
		if (!canTransitionTurboDraftPhase(this._session.phase, phase)) {
			this._log(`ignored illegal transition ${this._session.phase} → ${phase}`);
			return;
		}
		this._session = {
			...this._session,
			phase,
			stageHistory: appendStageHistory(this._session.stageHistory, phase, Date.now(), detail),
			detail: detail ? { ...this._session.detail, message: detail } : this._session.detail,
		};
		this._fire();
	}

	private _patchDetail(runGen: number, patch: Partial<TurboDraftStageDetail>): void {
		if (runGen !== this._runGen || !this._session) { return; }
		this._session = { ...this._session, detail: { ...this._session.detail, ...patch } };
		this._fire();
	}

	private _finishTerminal(runGen: number, phase: TurboDraftPhase, message?: string): void {
		if (!this._session) { return; }
		if (runGen !== this._runGen) { return; }
		if (isTurboDraftTerminalPhase(this._session.phase) && this._session.phase !== 'ready' && this._session.phase !== phase) {
			return;
		}
		if (!canTransitionTurboDraftPhase(this._session.phase, phase) && this._session.phase !== phase) {
			this._log(`ignored terminal ${this._session.phase} → ${phase}`);
			return;
		}
		this._session = {
			...this._session,
			phase,
			pendingHunks: phase === 'ready' ? this._session.pendingHunks : 0,
			ownedDiffAreaId: phase === 'ready' ? this._session.ownedDiffAreaId : null,
			errorMessage: message ?? this._session.errorMessage,
			stageHistory: appendStageHistory(this._session.stageHistory, phase, Date.now(), message),
			detail: { ...this._session.detail, message, pendingHunks: phase === 'ready' ? this._session.pendingHunks : 0 },
		};
		this._updateReviewingKey();
		this._fire();
		this._log(`terminal ${phase}${message ? `: ${message}` : ''}`);
		if (phase === 'noChanges') {
			this._notificationService.notify({ severity: Severity.Info, message: message || localize('turboDraft.noUseful', 'No useful edits found.') });
		} else if (phase === 'sourceChanged') {
			this._notificationService.notify({ severity: Severity.Warning, message: message || localize('turboDraft.sourceChanged', 'File changed — draft discarded.') });
		}
	}

	private _fail(runGen: number, message: string, failedPhase?: TurboDraftPhase): void {
		if (runGen !== this._runGen || !this._session) { return; }
		const from = this._session.phase;
		this._session = {
			...this._session,
			phase: 'error',
			errorMessage: message,
			failedPhase: failedPhase ?? from,
			pendingHunks: 0,
			ownedDiffAreaId: null,
			stageHistory: appendStageHistory(this._session.stageHistory, 'error', Date.now(), message),
			detail: { ...this._session.detail, message },
		};
		this._updateReviewingKey();
		this._fire();
		this._log(`error ${message}`);
		this._notificationService.notify({ severity: Severity.Warning, message });
	}

	private _fire(): void {
		this._onDidChangeSession.fire(this._session);
	}

	private _flashTabReady(): void {
		const editor = this._codeEditorService.getFocusedCodeEditor()
			?? this._codeEditorService.getActiveCodeEditor();
		const domNode = editor?.getDomNode();
		if (!domNode) { return; }
		domNode.classList.remove('void-turbo-tab-ready');
		void domNode.offsetWidth;
		domNode.classList.add('void-turbo-tab-ready');
		mainWindow.setTimeout(() => domNode.classList.remove('void-turbo-tab-ready'), 700);
	}

	/**
	 * The files a change here actually reaches: the callers of the symbols around the
	 * cursor, from the LSP call graph. Time-boxed and capped - Deep multi-file should feel
	 * like "finish the feature", not "rewrite the repo". Returns [] on any failure.
	 */
	private async _computeBlastRadius(fileUri: URI, cursorLine: number): Promise<URI[]> {
		const deadline = Date.now() + BLAST_RADIUS_BUDGET_MS;
		const out: URI[] = [];
		const seen = new Set<string>([fileUri.toString()]);
		try {
			const filePath = this._lspBridgeAdapter.relativize(fileUri);
			const symbols = pickNearbySymbols(
				await this._lspBridgeAdapter.getDocumentSymbols(filePath),
				Math.max(0, cursorLine - 1),
				BLAST_RADIUS_SYMBOLS,
			);
			for (const sym of symbols) {
				if (Date.now() > deadline || out.length >= MAX_QUEUE_FILES) { break; }
				const callers = await this._lspBridgeAdapter.getIncomingCalls(filePath, sym.line, sym.character);
				for (const caller of callers) {
					if (out.length >= MAX_QUEUE_FILES) { break; }
					const uri = this._lspBridgeAdapter.resolveFile(caller.filePath);
					if (!uri || seen.has(uri.toString())) { continue; }
					// Generated output and dependencies are not ours to draft.
					if (/(^|\/)(node_modules|out|dist|build|\.git)(\/|$)/.test(uri.path)) { continue; }
					seen.add(uri.toString());
					out.push(uri);
				}
			}
		} catch (e) {
			this._log(`blast radius unavailable: ${e instanceof Error ? e.message : String(e)}`);
			return [];
		}
		return out;
	}

	/**
	 * Move to the next file of a multi-file run. Only a genuinely completed review
	 * advances; cancelling or erroring drops the rest of the queue, because continuing to
	 * open files after the user backed out would be the opposite of what they asked for.
	 */
	private _advanceFileQueue(): void {
		const next = this._fileQueue.shift();
		if (!next) {
			this._queueTotal = 0;
			this._queueIntent = undefined;
			return;
		}
		const remaining = this._fileQueue.length;
		this._log(`multi-file advance -> ${next.path} (${remaining} left)`);
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'turboDraft.nextFile',
				"Turbo Draft: next file ({0} of {1}) - {2}",
				this._queueTotal - remaining,
				this._queueTotal,
				next.path.split('/').pop() ?? next.path,
			),
		});
		void this.startDraft({ uri: next, mode: 'deep', multiFile: true, _continueQueue: true });
	}

	/** Best-effort compiler truth. Null when disabled or the language server has nothing. */
	/** Problems in the drafted file BEFORE the draft was applied, for the post-review diff. */
	private _baselineProblems: TurboVerifyProblem[] | null = null;
	/** Model used by the current run, reused for the single auto-fix pass. */
	private _runModelSelection: ModelSelection | null = null;
	/** Run generation already verified, so a re-entrant completion cannot verify twice. */
	private _verifiedRunGen = -1;
	/** Files still to draft in a multi-file Deep run, in call-graph order. */
	private _fileQueue: URI[] = [];
	/** Total files in the current multi-file run (including the one being drafted). */
	private _queueTotal = 0;
	/** Intent carried across the whole multi-file run so every file serves one goal. */
	private _queueIntent: string | undefined;

	private async _gatherCompilerTruth(
		fileUri: URI,
		cursorLine: number,
		mode: TurboDraftMode,
	): Promise<TurboCompilerTruth | null> {
		if (this._settingsService.state.globalSettings.turboDraftCompilerTruth === false) {
			return null;
		}
		try {
			const truth = await gatherTurboCompilerTruth(this._lspBridgeAdapter, {
				filePath: this._lspBridgeAdapter.relativize(fileUri),
				cursorLine,
				mode,
			});
			const empty = !truth.diagnostics.length && !truth.signatures.length && !truth.callSites.length;
			return empty ? null : truth;
		} catch (e) {
			this._log(`compiler truth unavailable: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	/**
	 * Promptless intent: selection > nearest TODO > an open plan/spec markdown doc.
	 * An explicit caller intent (command palette / API) always wins.
	 */
	private _deriveIntent(
		editor: ICodeEditor | null,
		fileModel: ITextModel,
		fileContents: string,
		explicitIntent?: string,
	): TurboDraftIntent {
		const explicit = (explicitIntent ?? '').trim();
		if (explicit) {
			return { text: explicit, source: 'selection', label: 'From your request' };
		}
		try {
			const selection = editor?.getSelection();
			const selectionText = selection && !selection.isEmpty()
				? fileModel.getValueInRange(selection)
				: undefined;
			return deriveTurboIntent({
				selectionText,
				fileText: fileContents,
				cursorLine: editor?.getPosition()?.lineNumber ?? 1,
				planDocs: this._openPlanDocs(fileModel.uri),
			});
		} catch {
			return { text: '', source: 'none', label: 'Whole-file pass' };
		}
	}

	/** Open markdown editors (excluding the drafted file), newest group order, capped. */
	private _openPlanDocs(exclude: URI): { path: string; text: string }[] {
		const docs: { path: string; text: string }[] = [];
		for (const input of this._editorService.editors) {
			if (docs.length >= MAX_PLAN_DOCS) { break; }
			const uri = input.resource;
			if (!uri || uri.toString() === exclude.toString()) { continue; }
			if (!/\.(md|markdown)$/i.test(uri.path)) { continue; }
			const { model } = this._voidModelService.getModel(uri);
			if (!model) { continue; }  // not materialized: never block Shift+Tab on file IO
			const text = model.getValue();
			if (!text.trim()) { continue; }
			docs.push({ path: uri.path, text: text.slice(0, PLAN_DOC_CHARS) });
		}
		return docs;
	}

	private _summarizeChat(): string {
		try {
			const thread = this._chatThreadService.getCurrentThread();
			const msgs = thread?.messages ?? [];
			const turns: string[] = [];
			for (let i = msgs.length - 1; i >= 0 && turns.length < CHAT_TURNS; i--) {
				const m = msgs[i];
				if (m.role === 'user' && 'displayContent' in m && typeof m.displayContent === 'string') {
					turns.push(`User: ${m.displayContent.trim().slice(0, CHAT_TURN_CHARS)}`);
				} else if (m.role === 'assistant' && 'displayContent' in m && typeof m.displayContent === 'string' && m.displayContent.trim()) {
					turns.push(`Assistant: ${m.displayContent.trim().slice(0, CHAT_TURN_CHARS)}`);
				}
			}
			return turns.reverse().join('\n');
		} catch {
			return '';
		}
	}

	/**
	 * Resolve Turbo's model: dedicated TurboDraft slot (Settings → Features), or Chat when
	 * "Same as Chat" is on. Never uses local FIM (v3code-local) — that path fails silently
	 * as malformed/no-op for whole-file drafts.
	 */
	private _resolveChatModelSelection(): ModelSelection | null {
		const ofFeature = this._settingsService.state.modelSelectionOfFeature;
		const sync = this._settingsService.state.globalSettings.syncTurboDraftToChat;
		const preferCloud = (sel: ModelSelection | null | undefined): ModelSelection | null => {
			if (!sel || sel.providerName === 'v3code-local') { return null; }
			return sel;
		};
		if (sync) {
			return preferCloud(ofFeature['Chat']) ?? preferCloud(ofFeature['TurboDraft']) ?? preferCloud(ofFeature['Apply']);
		}
		return preferCloud(ofFeature['TurboDraft']) ?? preferCloud(ofFeature['Chat']) ?? preferCloud(ofFeature['Apply']);
	}

	private _buildRetrieveQuery(
		uri: URI,
		fileContents: string,
		cursorLine: number,
		editSummaries: string[],
		chat: string,
	): string {
		const rel = this._relativePath(uri) ?? uri.fsPath;
		const cursor = fileContents.split('\n')[cursorLine - 1] ?? '';
		const parts = [rel, cursor.trim(), ...editSummaries.slice(-4), chat.slice(0, 200)];
		return parts.filter(Boolean).join('\n').slice(0, 800);
	}

	private async _gatherContext(query: string, uri: URI, mode: TurboDraftMode): Promise<{ path: string; content: string }[]> {
		try {
			const timeout = mode === 'deep' ? CONTEXT_TIMEOUT_DEEP_MS : CONTEXT_TIMEOUT_FAST_MS;
			const topK = mode === 'deep' ? RETRIEVE_TOP_K_DEEP : RETRIEVE_TOP_K_FAST;
			const budgetTotal = mode === 'deep' ? TOTAL_CONTEXT_CHARS_DEEP : TOTAL_CONTEXT_CHARS_FAST;
			const deadline = <T,>(p: Promise<T>, fallback: T) => Promise.race([
				p.catch(() => fallback),
				new Promise<T>(resolve => setTimeout(() => resolve(fallback), timeout)),
			]);
			const rel = this._relativePath(uri);
			const hits = query.trim()
				? await deadline(this._semanticIndexService.retrieve(query.trim(), { topK }), [])
				: [];
			const snippets: { path: string; content: string }[] = [];
			let budget = budgetTotal;
			for (const h of hits) {
				if (budget <= 0) { break; }
				const content = h.content?.trim();
				if (!content || !h.chunk?.file) { continue; }
				if (rel && h.chunk.file === rel) { continue; }
				const sliced = content.slice(0, Math.min(PER_SNIPPET_CHARS, budget));
				snippets.push({ path: h.chunk.file, content: sliced });
				budget -= sliced.length;
			}
			return snippets;
		} catch {
			return [];
		}
	}

	private _relativePath(uri: URI): string | undefined {
		return workspaceIndexPath(this._workspaceContextService.getWorkspace().folders, uri);
	}

	private _liveSource(uri: URI): string | null {
		const editors = this._codeEditorService.listCodeEditors();
		for (const ed of editors) {
			const m = ed.getModel();
			if (m && m.uri.toString() === uri.toString()) {
				return m.getValue();
			}
		}
		return null;
	}

	private _ensureOutputChannel(): void {
		const registry = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
		if (!registry.getChannel(OUTPUT_CHANNEL_ID)) {
			registry.registerChannel({
				id: OUTPUT_CHANNEL_ID,
				label: localize('turboDraft.output', 'Turbo Draft'),
				log: false,
			});
		}
	}

	private _log(line: string): void {
		const msg = `[TurboDraft] ${line}`;
		this._logService.info(msg);
		try {
			this._ensureOutputChannel();
			this._outputService.getChannel(OUTPUT_CHANNEL_ID)?.append(`${new Date().toISOString()} ${line}\n`);
		} catch {
			/* best-effort */
		}
	}
}

registerSingleton(ITurboDraftService, TurboDraftService, InstantiationType.Delayed);
