/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — persistent findings journal (the cross-session memory).
 *
 * This is the piece that makes Sentinel REMEMBER. A scan doesn't just print results and forget —
 * it's diffed against the previous scan's state and folded into a durable journal, so across
 * sessions / restarts / reboots the tool can answer "what's NEW since last time, what got FIXED,
 * what's still OPEN, and is the codebase getting safer or worse?"
 *
 * The engine here is PURE: it takes the prior {@link JournalState} (which the editor layer loads
 * from disk / workspace storage) plus this scan's findings, and returns the next state + a
 * {@link ScanDiff}. Serialization is plain JSON so the host can persist it anywhere (a
 * .v3code/sentinel/journal.json, workspace storage, etc.). No fs, no editor imports here.
 *
 * Identity is by {@link ReportedFinding.fingerprint} (pack+file+sink+source), so a finding is
 * "the same bug" across scans even when line numbers move — the whole point of stable diffing.
 */

import { ReportedFinding, severityCounts } from './reporter.js';
import { Severity } from './taintSpec.js';

/** A finding as stored in the journal, with first/last-seen bookkeeping for lifecycle tracking. */
export interface JournalEntry {
	readonly fingerprint: string;
	readonly packId: string;
	readonly title: string;
	readonly severity: Severity;
	readonly file: string;
	readonly line: number;
	readonly sinkName: string;
	readonly sourceName: string;
	/** Epoch ms when this fingerprint was first seen. */
	readonly firstSeen: number;
	/** Epoch ms of the most recent scan that still found it. */
	readonly lastSeen: number;
	/** 'open' = seen in the latest scan; 'fixed' = previously seen, absent in the latest scan. */
	readonly status: 'open' | 'fixed';
	/** How many scans have observed this fingerprint (persistence signal). */
	readonly timesSeen: number;
}

/** One recorded scan in the journal's history (for trend lines). */
export interface ScanRecord {
	readonly at: number;
	readonly total: number;
	readonly bySeverity: Record<Severity, number>;
	/** Which packs (and versions) ran — so we can say "coverage improved since last scan". */
	readonly packs: readonly { id: string; version: number }[];
}

/** The full durable journal state persisted between sessions. */
export interface JournalState {
	readonly version: 1;
	readonly workspace: string;
	readonly entries: readonly JournalEntry[];
	readonly history: readonly ScanRecord[];
	readonly updatedAt: number;
}

/** The human-facing delta produced by a scan, relative to the previous journal state. */
export interface ScanDiff {
	readonly newFindings: readonly JournalEntry[];
	readonly fixedFindings: readonly JournalEntry[];
	readonly stillOpen: readonly JournalEntry[];
	/** Change in total open count vs the previous scan (negative = improving). */
	readonly openDelta: number;
	/** True when this is the very first scan of the workspace (no prior state). */
	readonly firstScan: boolean;
}

/** An empty journal for a workspace that has never been scanned. */
export function emptyJournal(workspace: string): JournalState {
	return { version: 1, workspace, entries: [], history: [], updatedAt: 0 };
}

/**
 * Fold a scan's findings into the journal. Returns the NEXT state (to persist) and the diff (to
 * show). Pure and deterministic given (prior, findings, now):
 *   • a fingerprint present now and before  → still open (bump lastSeen/timesSeen).
 *   • a fingerprint present now but not before → NEW (firstSeen = now).
 *   • a fingerprint previously OPEN but absent now → FIXED.
 *   • a fingerprint already FIXED and still absent → retained as fixed (history), not re-counted.
 */
export function recordScan(
	prior: JournalState,
	findings: readonly ReportedFinding[],
	packsRun: readonly { id: string; version: number }[],
	now: number,
): { state: JournalState; diff: ScanDiff } {
	const priorByFp = new Map(prior.entries.map(e => [e.fingerprint, e]));
	const scanFps = new Set(findings.map(f => f.fingerprint));
	// Dedup findings by fingerprint for the journal (report layer may have several instances).
	const uniqueNow = new Map<string, ReportedFinding>();
	for (const f of findings) { if (!uniqueNow.has(f.fingerprint)) { uniqueNow.set(f.fingerprint, f); } }

	const nextEntries: JournalEntry[] = [];
	const newFindings: JournalEntry[] = [];
	const stillOpen: JournalEntry[] = [];
	const fixedFindings: JournalEntry[] = [];

	// Present in this scan → open (new or continuing).
	for (const f of uniqueNow.values()) {
		const was = priorByFp.get(f.fingerprint);
		const entry: JournalEntry = {
			fingerprint: f.fingerprint,
			packId: f.packId,
			title: f.title,
			severity: f.severity,
			file: f.file,
			line: f.line,
			sinkName: f.sinkName,
			sourceName: f.sourceName,
			firstSeen: was ? was.firstSeen : now,
			lastSeen: now,
			status: 'open',
			timesSeen: (was ? was.timesSeen : 0) + 1,
		};
		nextEntries.push(entry);
		if (was && was.status === 'open') { stillOpen.push(entry); } else { newFindings.push(entry); }
	}

	// Previously open, absent now → newly fixed. Previously fixed & still absent → keep as fixed.
	for (const e of prior.entries) {
		if (scanFps.has(e.fingerprint)) { continue; }
		if (e.status === 'open') {
			const fixed: JournalEntry = { ...e, status: 'fixed' };
			nextEntries.push(fixed);
			fixedFindings.push(fixed);
		} else {
			nextEntries.push(e); // already fixed; retain for history
		}
	}

	const priorOpen = prior.entries.filter(e => e.status === 'open').length;
	const nowOpen = uniqueNow.size;
	const record: ScanRecord = {
		at: now,
		total: nowOpen,
		bySeverity: severityCounts([...uniqueNow.values()]),
		packs: packsRun,
	};
	const state: JournalState = {
		version: 1,
		workspace: prior.workspace,
		entries: nextEntries,
		history: [...prior.history, record].slice(-50), // keep last 50 scans
		updatedAt: now,
	};
	const diff: ScanDiff = {
		newFindings,
		fixedFindings,
		stillOpen,
		openDelta: nowOpen - priorOpen,
		firstScan: prior.updatedAt === 0,
	};
	return { state, diff };
}

/**
 * A plain-English "what changed since last scan" summary — the memory payoff the user sees.
 * Reads like a teammate catching you up: what's new, what you fixed, and the trend.
 */
export function renderDiff(diff: ScanDiff): string {
	if (diff.firstScan) {
		return `First Sentinel scan recorded. Tracking ${diff.newFindings.length} finding${diff.newFindings.length === 1 ? '' : 's'} from now on — next scan will show what's new and what you've fixed.`;
	}
	const parts: string[] = [];
	if (diff.newFindings.length) { parts.push(`\u{1F53A} ${diff.newFindings.length} new`); }
	if (diff.fixedFindings.length) { parts.push(`\u2705 ${diff.fixedFindings.length} fixed since last scan`); }
	parts.push(`${diff.stillOpen.length} still open`);
	let trend: string;
	if (diff.openDelta < 0) { trend = `Codebase is getting safer (${-diff.openDelta} fewer open than last scan).`; }
	else if (diff.openDelta > 0) { trend = `Heads up — ${diff.openDelta} more open than last scan.`; }
	else { trend = 'No change in open count since last scan.'; }
	const newList = diff.newFindings.slice(0, 5).map(e => `   • ${e.title} @ ${e.file}:${e.line}`).join('\n');
	return `Since last scan: ${parts.join(', ')}. ${trend}` + (newList ? `\nNew issues:\n${newList}` : '');
}

/** Load a JournalState from persisted JSON, tolerating a missing/corrupt file (→ empty). */
export function parseJournal(json: string | undefined, workspace: string): JournalState {
	if (!json) { return emptyJournal(workspace); }
	try {
		const parsed = JSON.parse(json) as JournalState;
		if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) { return parsed; }
	} catch {
		// Corrupt journal must never break a scan — start fresh.
	}
	return emptyJournal(workspace);
}

/** Serialize a JournalState for persistence. */
export function serializeJournal(state: JournalState): string {
	return JSON.stringify(state);
}
