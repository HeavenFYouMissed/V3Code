/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure selection/rendering rules for Turbo Draft's compiler-truth packet.
 *
 * Kept in `common` (no editor or DOM imports) so the ranking logic — which decides what a
 * model gets to see — is unit-testable in Node. The browser side owns only the IO:
 * `browser/turboDraftCompilerContext.ts`.
 */

import { DiagnosticEntry, SymbolEntry } from './contextBridge/contextBridgeTypes.js';

export const MAX_DIAGNOSTICS = 12;
export const MAX_SIGNATURES = 8;
export const MAX_CALL_SITES = 6;
/** Symbols within this many lines of the cursor count as "what you are working on". */
export const NEAR_CURSOR_LINES = 60;
export const HOVER_SIGNATURE_CAP = 400;

const SEVERITY_RANK: Record<DiagnosticEntry['severity'], number> = { error: 0, warning: 1, info: 2, hint: 3 };

export function renderDiagnostic(d: DiagnosticEntry): string {
	const source = d.source ? ` (${d.source})` : '';
	return `line ${d.line + 1} [${d.severity}]${source} ${d.message.replace(/\s+/g, ' ').trim()}`;
}

/** Errors first, then by line — a 200-warning file must still surface its 2 errors. */
export function pickDiagnostics(all: DiagnosticEntry[], max = MAX_DIAGNOSTICS): DiagnosticEntry[] {
	return [...all]
		.filter(d => d.severity === 'error' || d.severity === 'warning')
		.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (a.line - b.line))
		.slice(0, max);
}

/** Symbols nearest the cursor first; that is what the developer is actually editing. */
export function pickNearbySymbols(symbols: SymbolEntry[], cursorLine0: number, max = MAX_SIGNATURES): SymbolEntry[] {
	return symbols
		.filter(s => s.kind !== 'variable' && Math.abs(s.line - cursorLine0) <= NEAR_CURSOR_LINES)
		.sort((a, b) => Math.abs(a.line - cursorLine0) - Math.abs(b.line - cursorLine0))
		.slice(0, max);
}

/**
 * Hover markdown -> just the declaration. Keeps fenced code (the actual signature) and
 * falls back to the first prose line when a provider returns no fence.
 */
export function extractHoverSignature(contents: string[], cap = HOVER_SIGNATURE_CAP): string {
	const fenced: string[] = [];
	for (const raw of contents) {
		const fenceRe = /```[\w-]*\n([\s\S]*?)```/g;
		let m: RegExpExecArray | null;
		while ((m = fenceRe.exec(raw)) !== null) {
			const body = (m[1] ?? '').trim();
			if (body) { fenced.push(body); }
		}
	}
	if (fenced.length === 0) {
		const prose = contents.join('\n').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('---'));
		return (prose ?? '').slice(0, cap);
	}
	const joined = fenced.join('\n');
	return joined.length <= cap ? joined : `${joined.slice(0, cap)}...`;
}
