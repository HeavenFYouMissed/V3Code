/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, IMarker, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { URI } from '../../../../base/common/uri.js';
import { timeout } from '../../../../base/common/async.js';
import { LintErrorItem, BuildProblem } from '../common/toolsServiceTypes.js';

/** Per-file diagnostic cap. Disclosed in the returned list rather than silently applied. */
const MAX_MARKERS_PER_FILE = 100;

const TS_ONLY_CODES = new Set([
	'1005', '1011', '1029', '1064', '1109', '1184', '1219', '1235', '1340',
	'2307', '2304', '2503', '2580', '2686', '2792', '7026', '7044', '8010', '8017',
	'17004', '17009',
]);

export interface IMarkerCheckService {
	readonly _serviceBrand: undefined;
	collectDiagnostics(uri: URI): LintErrorItem[] | null;
	/** Wait for onMarkerChanged (or timeout) — TS diagnostics are often delayed after edits.
	 *  `alwaysWaitForChange`: do NOT return early on pre-existing errors. Callers that just
	 *  applied an edit need this — the immediate marker set is the STALE pre-edit state, and
	 *  returning it instantly makes shadow-verify roll back the very fix the edit made. */
	collectDiagnosticsWithWait(uri: URI, maxWaitMs?: number, opts?: { alwaysWaitForChange?: boolean }): Promise<LintErrorItem[] | null>;
	markerCount(uri: URI): number;
	/** Every error/warning the language servers currently know about, workspace-wide
	 *  (the editor's live problem list — no recompile). `cap` bounds the returned array;
	 *  the returned `total` is the unbounded count so callers can report truncation. */
	collectAllDiagnostics(opts?: { pathFilter?: string | null; errorsOnly?: boolean; cap?: number }): { problems: BuildProblem[]; total: number };
}

export const IMarkerCheckService = createDecorator<IMarkerCheckService>('markerCheckService');

class MarkerCheckService extends Disposable implements IMarkerCheckService {
	_serviceBrand: undefined;

	constructor(
		@IMarkerService private readonly _markerService: IMarkerService,
	) {
		super();
	}

	markerCount(uri: URI): number {
		return this._markerService.read({ resource: uri }).length;
	}

	/** Shared keep-test: error/warning only, minus JS files' TS-only noise. */
	private _keepMarker(l: IMarker, isJS: boolean): boolean {
		if (l.severity !== MarkerSeverity.Error && l.severity !== MarkerSeverity.Warning) return false;
		if (isJS) {
			const code = typeof l.code === 'string' ? l.code : l.code?.value || '';
			if (l.source === 'ts' || l.source === 'typescript') {
				if (TS_ONLY_CODES.has(String(code))) return false;
				if (/can only be used in typescript/i.test(l.message)) return false;
				if (/decorators are not valid here/i.test(l.message)) return false;
			}
		}
		return true;
	}

	collectDiagnostics(uri: URI): LintErrorItem[] | null {
		const isJS = /\.(js|mjs|cjs|jsx)$/i.test(uri.fsPath);
		const kept = this._markerService
			.read({ resource: uri })
			.filter(l => this._keepMarker(l, isJS));
		const lintErrors = kept
			.slice(0, MAX_MARKERS_PER_FILE)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem));

		if (!lintErrors.length) return null;
		// The cap used to be silent, so a file with 300 problems reported 100 and the model
		// believed it had fixed everything when it had seen a third of them.
		if (kept.length > MAX_MARKERS_PER_FILE) {
			lintErrors.push({
				code: '',
				message: `(warning) ${kept.length - MAX_MARKERS_PER_FILE} more problem(s) in this file are not shown (${kept.length} total). Re-check after fixing these.`,
				startLineNumber: 1,
				endLineNumber: 1,
			});
		}
		return lintErrors;
	}

	collectAllDiagnostics(opts?: { pathFilter?: string | null; errorsOnly?: boolean; cap?: number }): { problems: BuildProblem[]; total: number } {
		const pathFilter = opts?.pathFilter ? opts.pathFilter.toLowerCase() : null;
		const errorsOnly = opts?.errorsOnly ?? true;
		const cap = Math.max(1, Math.min(1000, opts?.cap ?? 200));
		const matched = this._markerService.read({}).filter(l => {
			if (errorsOnly && l.severity !== MarkerSeverity.Error) return false;
			const isJS = /\.(js|mjs|cjs|jsx)$/i.test(l.resource.fsPath);
			if (!this._keepMarker(l, isJS)) return false;
			if (pathFilter && !l.resource.fsPath.toLowerCase().includes(pathFilter)) return false;
			return true;
		});
		// errors before warnings (higher severity first), then by file, then line
		matched.sort((a, b) =>
			(b.severity - a.severity) || a.resource.fsPath.localeCompare(b.resource.fsPath) || (a.startLineNumber - b.startLineNumber));
		const problems: BuildProblem[] = matched.slice(0, cap).map(l => ({
			file: l.resource.fsPath,
			line: l.startLineNumber,
			col: l.startColumn,
			severity: l.severity === MarkerSeverity.Error ? 'error' : 'warning',
			code: typeof l.code === 'string' ? l.code : l.code?.value || '',
			message: l.message,
		}));
		return { problems, total: matched.length };
	}

	async collectDiagnosticsWithWait(uri: URI, maxWaitMs = 5000, opts?: { alwaysWaitForChange?: boolean }): Promise<LintErrorItem[] | null> {
		const immediate = this.collectDiagnostics(uri);
		if (!opts?.alwaysWaitForChange && immediate?.some(e => e.message.startsWith('(error)'))) {
			return immediate;
		}

		return new Promise<LintErrorItem[] | null>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				disposable.dispose();
				resolve(this.collectDiagnostics(uri));
			};

			const disposable = this._markerService.onMarkerChanged((uris) => {
				if (uris.some(u => u.toString() === uri.toString())) {
					finish();
				}
			});

			void timeout(maxWaitMs).then(finish);
		});
	}
}

registerSingleton(IMarkerCheckService, MarkerCheckService, InstantiationType.Eager);
