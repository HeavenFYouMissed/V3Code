/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Turbo Draft's compiler truth.
 *
 * The semantic index answers "what looks similar"; the language server answers "what is
 * actually true" — the real diagnostics in this buffer, the real signatures of the symbols
 * around the cursor, and who really calls them. Turbo used to draft from similarity alone,
 * which is how it invented plausible-but-wrong call shapes.
 *
 * Everything here is strictly time-boxed and best-effort: a slow or missing language server
 * degrades the prompt, it never delays or fails a draft. Shift+Tab must stay instant.
 */

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ILspBridgeAdapter } from './contextBridge/lspBridgeAdapter.js';
import { DiagnosticEntry, SymbolEntry } from '../common/contextBridge/contextBridgeTypes.js';
import { MAX_CALL_SITES, pickDiagnostics, pickNearbySymbols, renderDiagnostic } from '../common/turboDraftCompilerTruth.js';
import { TurboDraftMode } from '../common/turboDraftPrompt.js';

export interface TurboCompilerTruth {
	/** Rendered "line N [error] message" strings for the drafted file. */
	diagnostics: string[];
	/** Rendered "name: <signature>" for symbols near the cursor. */
	signatures: string[];
	/** Rendered "caller -> symbol (path:line)" for the nearest symbol. */
	callSites: string[];
	/** True when the budget expired before every lookup finished. */
	partial: boolean;
	elapsedMs: number;
}

export interface TurboCompilerTruthRequest {
	/** Workspace-relative POSIX path, as the LSP bridge expects. */
	filePath: string;
	/** 1-based, as reported by the editor. */
	cursorLine: number;
	mode: TurboDraftMode;
	token?: CancellationToken;
}

export const EMPTY_COMPILER_TRUTH: TurboCompilerTruth = {
	diagnostics: [], signatures: [], callSites: [], partial: false, elapsedMs: 0,
};

/** Deep is allowed to think longer; Fast must feel like autocomplete. */
const BUDGET_MS: Record<TurboDraftMode, number> = { fast: 700, deep: 2_000 };

/** Resolve to `fallback` if `p` has not settled when the shared deadline passes. */
function withDeadline<T>(p: Promise<T>, deadline: Promise<void>, fallback: T): Promise<T> {
	return Promise.race([
		p.catch(() => fallback),
		deadline.then(() => fallback),
	]);
}

export async function gatherTurboCompilerTruth(
	lsp: ILspBridgeAdapter,
	req: TurboCompilerTruthRequest,
): Promise<TurboCompilerTruth> {
	const started = Date.now();
	const budget = BUDGET_MS[req.mode] ?? BUDGET_MS.fast;
	const cursorLine0 = Math.max(0, (req.cursorLine || 1) - 1);

	const cts = new CancellationTokenSource(req.token);
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>(resolve => {
		timer = setTimeout(() => { expired = true; resolve(); }, budget);
		cts.token.onCancellationRequested(() => { expired = true; resolve(); });
	});

	try {
		const [rawDiagnostics, symbols] = await Promise.all([
			withDeadline(lsp.getDiagnostics(req.filePath), deadline, [] as DiagnosticEntry[]),
			withDeadline(lsp.getDocumentSymbols(req.filePath), deadline, [] as SymbolEntry[]),
		]);

		const diagnostics = pickDiagnostics(rawDiagnostics).map(renderDiagnostic);
		const nearby = pickNearbySymbols(symbols, cursorLine0);

		// Signatures for everything nearby; call sites only for the single nearest symbol,
		// since call hierarchy is by far the most expensive lookup here.
		const signatures: string[] = [];
		if (!expired && nearby.length) {
			const resolved = await withDeadline(
				Promise.all(nearby.map(async s => {
					const sig = await lsp.getHoverSignature(req.filePath, s.line, s.character).catch(() => '');
					return sig ? `${s.name}: ${sig.replace(/\s+/g, ' ').trim()}` : '';
				})),
				deadline,
				[] as string[],
			);
			signatures.push(...resolved.filter(Boolean));
		}

		const callSites: string[] = [];
		const focus = nearby[0];
		if (!expired && focus) {
			const callers = await withDeadline(
				lsp.getIncomingCalls(req.filePath, focus.line, focus.character),
				deadline,
				[],
			);
			for (const c of callers.slice(0, MAX_CALL_SITES)) {
				callSites.push(`${c.name} -> ${focus.name} (${c.filePath}:${c.line + 1})`);
			}
		}

		return { diagnostics, signatures, callSites, partial: expired, elapsedMs: Date.now() - started };
	} catch {
		// Compiler truth is an enhancement. Losing it must never cost the user a draft.
		return { ...EMPTY_COMPILER_TRUTH, partial: true, elapsedMs: Date.now() - started };
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
		cts.dispose(true);
	}
}
