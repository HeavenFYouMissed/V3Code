/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Turbo Draft intent derivation (headless / unit-testable).
 *
 * The promptless part of the promptless editor: instead of asking what you want, read it
 * off what you already wrote. Priority is strongest-signal-first — an explicit selection
 * beats a TODO you left days ago, which beats a plan document that may describe the whole
 * project rather than this file.
 */

export type TurboIntentSource = 'selection' | 'todo' | 'file-brief' | 'plan-file' | 'none';

export interface TurboDraftIntent {
	/** Empty when nothing was found. */
	text: string;
	source: TurboIntentSource;
	/** Short human line for the dock, e.g. "From TODO on line 42". */
	label: string;
}

export interface TurboDraftIntentInput {
	/** Text of the current editor selection, if any. */
	selectionText?: string;
	fileText: string;
	/** 1-based. */
	cursorLine: number;
	/** Open markdown documents, most-recently-active first. */
	planDocs?: { path: string; text: string }[];
}

const SELECTION_CAP = 1200;
const PLAN_CAP = 1500;
const BRIEF_CAP = 1200;
/** Above this many real lines the file is being edited, not described. */
const BRIEF_MAX_LINES = 8;
const TODO_SEARCH_RADIUS = 40;
const TODO_FOLLOW_LINES = 5;
const PLAN_BULLET_LINES = 15;

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b\s*[:\-]?\s*(.*)$/i;
const COMMENT_CONTINUATION_RE = /^\s*(\/\/|\*|#|--|<!--)\s?(.*)$/;
const PLAN_NAME_RE = /(^|[\\/])(plan|spec|todo|design|readme)\.md$/i;

const NONE: TurboDraftIntent = { text: '', source: 'none', label: 'Whole-file pass' };

/** Strip a leading comment marker so the intent reads as prose, not syntax. */
function stripCommentMarker(line: string): string {
	const m = COMMENT_CONTINUATION_RE.exec(line);
	return (m ? m[2] : line).replace(/-->\s*$/, '').trim();
}

function isCommentLine(line: string): boolean {
	return COMMENT_CONTINUATION_RE.test(line);
}

function findTodo(lines: string[], cursorLine: number): TurboDraftIntent | undefined {
	const cursorIdx = Math.min(Math.max(0, cursorLine - 1), Math.max(0, lines.length - 1));
	// Walk outward from the cursor so the nearest TODO wins regardless of direction.
	for (let dist = 0; dist <= TODO_SEARCH_RADIUS; dist++) {
		for (const idx of dist === 0 ? [cursorIdx] : [cursorIdx - dist, cursorIdx + dist]) {
			if (idx < 0 || idx >= lines.length) { continue; }
			const line = lines[idx] ?? '';
			const m = TODO_RE.exec(line);
			if (!m) { continue; }
			const parts: string[] = [];
			const first = stripCommentMarker(m[2] ?? '').trim();
			if (first) { parts.push(first); }
			// Pull the rest of the comment block so multi-line TODOs survive.
			for (let j = idx + 1; j < Math.min(lines.length, idx + 1 + TODO_FOLLOW_LINES); j++) {
				const next = lines[j] ?? '';
				if (!isCommentLine(next)) { break; }
				if (TODO_RE.test(next)) { break; }
				const cont = stripCommentMarker(next);
				if (!cont) { break; }
				parts.push(cont);
			}
			const text = parts.join(' ').trim();
			if (!text) { continue; }
			return { text, source: 'todo', label: `From TODO on line ${idx + 1}` };
		}
	}
	return undefined;
}

/**
 * A near-empty file whose only content is a comment is a brief, not code: the developer
 * opened a blank file and typed what they want it to be. Read the whole comment as the
 * instruction. Requiring every real line to be a comment keeps this away from files that
 * are actually being written.
 */
function findFileBrief(lines: string[]): TurboDraftIntent | undefined {
	const real = lines.map(l => l.trim()).filter(Boolean);
	if (real.length === 0 || real.length > BRIEF_MAX_LINES) { return undefined; }
	if (!real.every(isCommentLine)) { return undefined; }
	const text = real.map(stripCommentMarker).filter(Boolean).join(' ').trim();
	if (!text) { return undefined; }
	return { text: text.slice(0, BRIEF_CAP), source: 'file-brief', label: 'From your note at the top' };
}

function extractPlan(doc: { path: string; text: string }): string {
	const lines = doc.text.split('\n');
	const out: string[] = [];
	let bullets = 0;
	let seenHeading = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) { continue; }
		if (/^#{1,3}\s+/.test(line)) {
			if (seenHeading && out.length) { break; } // stop at the next section
			seenHeading = true;
			out.push(line.replace(/^#+\s+/, ''));
			continue;
		}
		if (/^([-*+]|\d+\.)\s+/.test(line)) {
			out.push(line);
			if (++bullets >= PLAN_BULLET_LINES) { break; }
			continue;
		}
		if (!seenHeading && out.length === 0) { out.push(line); }
	}
	return out.join('\n').slice(0, PLAN_CAP).trim();
}

function findPlan(docs: { path: string; text: string }[]): TurboDraftIntent | undefined {
	const ordered = [...docs].sort((a, b) => Number(PLAN_NAME_RE.test(b.path)) - Number(PLAN_NAME_RE.test(a.path)));
	for (const doc of ordered) {
		const text = extractPlan(doc);
		if (!text) { continue; }
		const name = doc.path.split(/[\\/]/).pop() || doc.path;
		return { text, source: 'plan-file', label: `From ${name}` };
	}
	return undefined;
}

export function deriveTurboIntent(input: TurboDraftIntentInput): TurboDraftIntent {
	const selection = (input.selectionText ?? '').trim();
	if (selection) {
		return { text: selection.slice(0, SELECTION_CAP), source: 'selection', label: 'From your selection' };
	}

	const lines = (input.fileText ?? '').split('\n');

	const todo = findTodo(lines, input.cursorLine);
	if (todo) { return todo; }

	// Beats a plan file: a note in THIS file is about this file.
	const brief = findFileBrief(lines);
	if (brief) { return brief; }

	const plan = findPlan(input.planDocs ?? []);
	if (plan) { return plan; }

	return NONE;
}
