/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Phase 1 shadow workspace.
 *
 * Rollback depends on LSP markers (TypeScript/ESLint). If the language server reports
 * nothing for a file, shadow verify cannot trigger — see `noDiagnosticsReported`.
 */

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { LintErrorItem } from '../common/toolsServiceTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { IMarkerCheckService } from './_markerCheckService.js';

export interface ShadowVerifyResult {
	lintErrors: LintErrorItem[] | null;
	rolledBack: boolean;
	/** Shadow on, but zero markers on this file after wait — rollback cannot be proven/triggered. */
	noDiagnosticsReported?: boolean;
}

export interface IShadowWorkspaceService {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	openSession(): string;
	stageContent(uri: URI, content: string): void;
	getStagedContent(uri: URI): string | undefined;
	discard(uri: URI): void;
	discardSession(): void;
	verifyAndCommitContent(
		uri: URI,
		newContent: string,
		apply: (content: string) => void | Promise<void>,
	): Promise<ShadowVerifyResult>;
}

export const IShadowWorkspaceService = createDecorator<IShadowWorkspaceService>('shadowWorkspaceService');

const LINT_WAIT_MS = 5000;

const isTypeScriptLike = (uri: URI): boolean => /\.(ts|tsx|mts|cts)$/i.test(uri.fsPath);

class ShadowWorkspaceService implements IShadowWorkspaceService {
	_serviceBrand: undefined;

	private sessionId: string | null = null;
	private readonly staged = new Map<string, string>();

	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IEditCodeService private readonly editCodeService: IEditCodeService,
		@IMarkerCheckService private readonly markerCheckService: IMarkerCheckService,
	) { }

	isEnabled(): boolean {
		return this.voidSettingsService.state.globalSettings.shadowVerify;
	}

	openSession(): string {
		this.discardSession();
		this.sessionId = generateUuid();
		return this.sessionId;
	}

	stageContent(uri: URI, content: string): void {
		this.staged.set(uri.fsPath, content);
	}

	getStagedContent(uri: URI): string | undefined {
		return this.staged.get(uri.fsPath);
	}

	discard(uri: URI): void {
		this.staged.delete(uri.fsPath);
	}

	discardSession(): void {
		this.staged.clear();
		this.sessionId = null;
	}

	async verifyAndCommitContent(
		uri: URI,
		newContent: string,
		apply: (content: string) => void | Promise<void>,
	): Promise<ShadowVerifyResult> {
		this.stageContent(uri, newContent);
		const enabled = this.isEnabled();

		if (!enabled) {
			await apply(newContent);
			const lintErrors = await this.markerCheckService.collectDiagnosticsWithWait(uri, LINT_WAIT_MS);
			// Compute this here too, not just on the verified path. With shadow verify off it was
			// never set, so a TypeScript file the language server had never analyzed came back
			// with an empty error list and the write tool reported "No lint errors found."
			const noDiagnosticsReported = isTypeScriptLike(uri) && this.markerCheckService.markerCount(uri) === 0;
			return { lintErrors, rolledBack: false, noDiagnosticsReported };
		}

		const snapshot = this.editCodeService.getVoidFileSnapshot(uri);
		// Baseline the errors that existed BEFORE this edit. Rolling back on ANY error had two
		// failure modes: (1) the agent edits a file to FIX an error — the stale pre-edit markers
		// are still registered the instant after apply, so the fix got rolled back and the model
		// was told "rolled back due to: <the very error it was fixing>", looping forever;
		// (2) any pre-existing unrelated error in a file permanently blocked all future edits to it.
		// Only NEW errors (not present before the edit) may trigger rollback.
		const errorKey = (e: LintErrorItem) => `${e.code}|${e.message}`;
		const baselineErrorKeys = new Set(
			(this.markerCheckService.collectDiagnostics(uri) ?? [])
				.filter(e => e.message.startsWith('(error)'))
				.map(errorKey)
		);
		try {
			await apply(newContent);
			// alwaysWaitForChange: the immediate marker set is the stale pre-edit state — wait for
			// the language server to re-diagnose (or time out) before judging the edit.
			const lintErrors = await this.markerCheckService.collectDiagnosticsWithWait(uri, LINT_WAIT_MS, { alwaysWaitForChange: baselineErrorKeys.size > 0 });
			const hasBlockingErrors = lintErrors?.some(e => e.message.startsWith('(error)') && !baselineErrorKeys.has(errorKey(e)));
			const noDiagnosticsReported = isTypeScriptLike(uri) && this.markerCheckService.markerCount(uri) === 0;

			if (hasBlockingErrors) {
				this.editCodeService.restoreVoidFileSnapshot(uri, snapshot);
				return { lintErrors, rolledBack: true, noDiagnosticsReported };
			}
			this.staged.delete(uri.fsPath);
			return { lintErrors, rolledBack: false, noDiagnosticsReported };
		} catch (e) {
			this.editCodeService.restoreVoidFileSnapshot(uri, snapshot);
			throw e;
		}
	}
}

registerSingleton(IShadowWorkspaceService, ShadowWorkspaceService, InstantiationType.Delayed);
