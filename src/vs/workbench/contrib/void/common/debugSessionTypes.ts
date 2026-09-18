/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Shared contract for the Debug mode runtime-evidence sink.
//
// The idea in one line: the editor — not the model — owns a loopback HTTP log sink for
// the duration of a Debug chat, hands the model its endpoint plus the file path, and the
// model is required to instrument the app against THAT endpoint. Runtime evidence then
// arrives in the transcript as it happens, instead of the model guessing and re-reading
// a file it hoped someone would write.
//
// Everything here is pure data + pure helpers so both the electron-main channel and the
// browser service (and the tests) can share it without pulling in a Node or DOM surface.

/** Channel registered in app.ts; the browser service is its only consumer. */
export const V3_DEBUG_COLLECTOR_CHANNEL = 'void-channel-debugCollector';

/** Directory (relative to a workspace root) the collector writes into. */
export const V3_DEBUG_LOG_DIR_NAME = '.v3code';

/**
 * Session ids become part of a filename, so this pattern is the path-traversal guard.
 * Enforced in three places on purpose: here (caller), in the channel (before spawn), and
 * inside the collector itself (before it touches the filesystem) — a single check on one
 * side of an IPC boundary is not a guard.
 */
export const V3_DEBUG_SESSION_ID_PATTERN = /^[a-z0-9]{6,32}$/;

/**
 * The port the sink tries first, deliberately offset from the range the other editor on this
 * machine uses so two running editors do not compete for the same ports and produce retries
 * that look like bugs.
 *
 * The fallback range (7642-8342) is NOT mirrored here. Only the collector allocates the port,
 * and its handshake reports whichever one it actually got, so the editor needs the live port
 * rather than the range it came from. A second copy of the range on this side of the process
 * boundary could only ever drift out of agreement with the one that is enforced.
 */
export const V3_DEBUG_COLLECTOR_PORT = 7642;

/** How many evidence lines the transcript keeps live. The file keeps everything. */
export const V3_DEBUG_TAIL_LINES = 40;

/** How often the browser polls for new evidence while a Debug response is streaming. */
export const V3_DEBUG_POLL_INTERVAL_MS = 1_200;

/**
 * Poll cadence once a Debug response has stopped streaming. The sink deliberately outlives the
 * turn that started it — the model instruments the app, tells the user to reproduce, and stops
 * talking — so a finished response keeps watching at a slow cadence instead of freezing on the
 * evidence it happened to have when the turn ended.
 */
export const V3_DEBUG_IDLE_POLL_INTERVAL_MS = 5_000;

/** A live ingest session. Handed to the model verbatim (minus `configPath`/`port`). */
export interface V3DebugSessionConfig {
	readonly sessionId: string;
	/** The URL the instrumented app POSTs to. Loopback, bound on 127.0.0.1 only. */
	readonly endpoint: string;
	/** Absolute path of the NDJSON file the collector appends to. */
	readonly logPath: string;
	/** Absolute path of the collector's own status record (crash recovery reads this). */
	readonly configPath: string;
	readonly port: number;
	/** Workspace root this session is scoped to. One session per root. */
	readonly workspaceRoot: string;
	readonly startedAt: number;
}

export type V3DebugSessionPhase = 'idle' | 'starting' | 'running' | 'stopped' | 'unavailable';

export interface V3DebugSessionState {
	readonly phase: V3DebugSessionPhase;
	readonly config?: V3DebugSessionConfig;
	/** Log line count at the moment the current user turn began — the run boundary. */
	readonly runMark: number;
	readonly lineCount: number;
	/** Human-readable reason when the sink is stopped or unavailable. */
	readonly reason?: string;
}

/** One parsed evidence line. Anything unparseable is preserved as raw text, never dropped. */
export interface V3DebugEvidenceLine {
	readonly index: number;
	readonly message: string;
	readonly location?: string;
	readonly hypothesisId?: string;
	readonly runId?: string;
	readonly data?: unknown;
	readonly timestamp?: number;
	/** True when the line is only part of a run the user already moved past. */
	readonly beforeRunMark?: boolean;
}

export function isUsableDebugSessionId(id: unknown): id is string {
	return typeof id === 'string' && V3_DEBUG_SESSION_ID_PATTERN.test(id);
}

/** Result of asking the channel to bring the sink up for a workspace. */
export type V3DebugStartResult =
	| { readonly ok: true; readonly config: V3DebugSessionConfig }
	| { readonly ok: false; readonly reason: string };

/** Snapshot of the sink for the transcript. `lines` is raw NDJSON, newest-run-aware. */
export interface V3DebugTailResult {
	readonly lines: string;
	readonly lineCount: number;
	readonly running: boolean;
}

/** Compact, single-line rendering of a payload for the transcript. Never throws. */
export function formatEvidenceData(data: unknown): string | undefined {
	if (data === undefined || data === null) {
		return undefined;
	}
	let text: string;
	if (typeof data === 'string') {
		text = data;
	} else {
		try {
			text = JSON.stringify(data);
		} catch {
			text = String(data);
		}
	}
	if (!text || text === '{}' || text === 'undefined') {
		return undefined;
	}
	return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/**
 * Parse one NDJSON line into evidence. The collector already validated JSON on ingest, but
 * the file is also an ordinary file a user can open and edit, so a bad line must render as
 * text rather than vanish: evidence silently disappearing is the exact failure this whole
 * feature exists to prevent.
 */
export function parseEvidenceLine(raw: string, index: number, runMark = 0): V3DebugEvidenceLine {
	const trimmed = raw.trim();
	const beforeRunMark = index < runMark;
	if (!trimmed) {
		return { index, message: '', beforeRunMark };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { index, message: trimmed, beforeRunMark };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { index, message: trimmed, beforeRunMark };
	}
	const record = parsed as Record<string, unknown>;
	const message =
		typeof record.message === 'string' ? record.message
			: typeof record.msg === 'string' ? record.msg
				: typeof record.event === 'string' ? record.event
					: typeof record.raw === 'string' ? record.raw
						: trimmed;
	return {
		index,
		message,
		location: typeof record.location === 'string' ? record.location : undefined,
		hypothesisId: typeof record.hypothesisId === 'string' ? record.hypothesisId : undefined,
		runId: typeof record.runId === 'string' ? record.runId : undefined,
		data: record.data,
		timestamp: typeof record.timestamp === 'number' ? record.timestamp : undefined,
		beforeRunMark,
	};
}

/** Split raw log text into evidence lines, applying a run boundary. */
export function parseEvidenceLog(text: string, runMark = 0): V3DebugEvidenceLine[] {
	const lines = text.split('\n').filter(l => l.trim().length > 0);
	return lines.map((line, index) => parseEvidenceLine(line, index, runMark));
}
