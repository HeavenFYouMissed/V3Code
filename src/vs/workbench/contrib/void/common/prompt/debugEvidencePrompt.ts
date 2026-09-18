/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// The prompt block that hands a Debug session its runtime-evidence sink.
//
// This is the whole reason Debug mode can be fast. Without it the model has no endpoint,
// so it either instruments nothing or invents somewhere to write — and the transcript the
// user watches fills with plausible reasoning that no observation ever confirmed. With it
// the model instruments the running app and reads back what actually happened.
//
// Two variants, deliberately (a context-budget pattern): the FULL block on the first turn
// of a session, where the endpoint and the rules have to land, and a SHORT re-assertion on
// every turn after, so the constraint survives a long conversation without paying for the
// whole doctrine each message.
//
// Pure and dependency-free so the wording is unit-testable — the failure mode of a prompt
// block is not a crash, it is a confidently wrong instruction nobody notices for a week.

/** Endpoint + session, as the model needs them to build one instrumentation line. */
export function buildDebugFetchTemplate(endpoint: string, sessionId: string): string {
	return [
		`fetch('${endpoint}', {`,
		`  method: 'POST',`,
		`  headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '${sessionId}' },`,
		`  body: JSON.stringify({`,
		`    sessionId: '${sessionId}',`,
		`    location: 'FILE:LINE',`,
		`    message: 'what you observed here',`,
		`    data: { /* the values that decide your hypothesis */ },`,
		`    hypothesisId: 'H1',`,
		`    timestamp: Date.now()`,
		`  })`,
		`}).catch(() => {});`,
	].join('\n');
}

export interface V3DebugEvidencePromptInput {
	/** Live sink, when one is running. */
	readonly endpoint?: string;
	readonly logPath?: string;
	readonly sessionId?: string;
	/** Lines already recorded when this run began. */
	readonly runMark: number;
	readonly lineCount: number;
	/** Full doctrine on the first turn of a session, short reminder afterwards. */
	readonly isFirstTurn: boolean;
	/** Set when no sink could be started — the model must be told, not left to assume. */
	readonly unavailableReason?: string;
}

/**
 * The block appended to the per-turn volatile context.
 *
 * It intentionally lives OUTSIDE the cached system prefix: the run mark and the line count
 * change every turn, and mutating the cached prefix would break provider-side prompt
 * caching for the whole conversation.
 */
export function buildDebugEvidenceBlock(input: V3DebugEvidencePromptInput): string {
	const { endpoint, logPath, sessionId, runMark, lineCount, isFirstTurn, unavailableReason } = input;

	if (!endpoint || !logPath || !sessionId) {
		return [
			'<DEBUG_RUNTIME_EVIDENCE_UNAVAILABLE>',
			'No runtime-evidence sink is running for this session, so you have NO runtime instrumentation available.',
			unavailableReason ? `Reason: ${unavailableReason}` : '',
			'Tell the user this in one line, then continue with static investigation (reading the code, a targeted test, a reproduction by command).',
			'Do NOT claim to have collected runtime logs. Do NOT instrument against an endpoint, port, or file path you were not given here, and do not invent one.',
			'</DEBUG_RUNTIME_EVIDENCE_UNAVAILABLE>',
		].filter(Boolean).join('\n');
	}

	const newLines = Math.max(0, lineCount - runMark);

	if (!isFirstTurn) {
		return [
			'<DEBUG_RUNTIME_EVIDENCE_REMINDER>',
			`The runtime-evidence sink is still running. Endpoint: ${endpoint}`,
			`Evidence file: ${logPath}`,
			`This run begins at line ${runMark} (${newLines} line${newLines === 1 ? '' : 's'} recorded in it so far). Lines before that belong to the previous run.`,
			'Keep instrumentation pointed at that endpoint, cite the evidence line behind every verdict, and do not clear the file with a shell command.',
			'</DEBUG_RUNTIME_EVIDENCE_REMINDER>',
		].join('\n');
	}

	return [
		'<DEBUG_RUNTIME_EVIDENCE>',
		'A runtime-evidence sink is running for this Debug session, and it is the difference between an investigation and a story. Instrument the running app against it and read back what actually happened.',
		'',
		`- Ingest endpoint: ${endpoint}`,
		`- Evidence file: ${logPath}`,
		`- Session id: ${sessionId}`,
		`- This run begins at line ${runMark} of the evidence file. Lines at or after it are the run you are asking for now; earlier lines are the previous run, and keeping them is what lets you compare before and after.`,
		'',
		'**JavaScript / TypeScript — POST to the endpoint. Do not write to disk and do not use console.log.** The sink is preferred over a file write precisely because it also works where there is no filesystem: a browser tab, a worker, a sandboxed runtime.',
		'',
		buildDebugFetchTemplate(endpoint, sessionId),
		'',
		'**Languages with no fetch** (Python, Go, Rust, Java, C, C++, Ruby, ...) — append NDJSON lines to the evidence file above with that language\'s own file I/O.',
		'',
		'Rules for this session:',
		'- Use the endpoint above exactly. Never hardcode a URL, never pick your own port, and never instrument against a different sink.',
		'- 1 line is the minimum — never skip instrumentation. Do not exceed 10 without narrowing your hypotheses first; 2-6 is the typical number.',
		'- Give every line a `location` of FILE:LINE and a `hypothesisId`, so a verdict can cite the exact evidence behind it.',
		'- Read the evidence file with read_file after the user confirms a run. Never clear it with a shell command (no rm, no `>` redirect) — the previous run is the thing you compare against.',
		'- No verdict without a cited evidence line. Confirmed, refuted, and unresolved each need one.',
		'- The evidence stream is rendered live in the transcript as it arrives, so the user is reading it too. Do not narrate the lines they can already see — cite the line number and say what it means.',
		'</DEBUG_RUNTIME_EVIDENCE>',
	].join('\n');
}
