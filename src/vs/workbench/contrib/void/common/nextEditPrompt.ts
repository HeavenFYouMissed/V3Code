/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Next-Edit-Prediction (NES) IO formats + the suppression gate.
 *
 * Two prompt formats:
 * - 'zeta' (default): the Zed "Zeta" scheme — recent edits as diffs + related context + the cursor
 *   region wrapped in git-merge-conflict markers with a cursor marker. Works with any chat model.
 * - 'instinct': the native training format of Continue.dev's Instinct model (Apache-2.0,
 *   Qwen2.5-Coder-7B fine-tune, `ollama run nate/instinct`) — editable-region tokens, context
 *   snippets with <|context_file|>/<|snippet|> markers, edit history newest-first as fenced diffs.
 *   System prompt + template mirror Continue's core/nextEdit (Apache-2.0).
 *
 * Output = the UPDATED region (a replace, which is why NES can delete / rewrite, unlike FIM's
 * insert-only), or NO_EDITS. Pure string logic so it is unit-testable headless; the service
 * (browser) feeds it real edits + context.
 */

import { EditEntry } from './recentEditsTypes.js';

export const NES_CURSOR_MARKER = '<|user_cursor|>';
export const NES_NO_EDITS = 'NO_EDITS';
const M_CURRENT = '<<<<<<< CURRENT';
const M_DIVIDER = '=======';
const M_UPDATED = '>>>>>>> UPDATED';

// Instinct-native tokens (must match the model's training data — from Continue's core/nextEdit)
const I_CURSOR = '<|user_cursor_is_here|>';
const I_REGION_START = '<|editable_region_start|>';
const I_REGION_END = '<|editable_region_end|>';
const I_CONTEXT_FILE = '<|context_file|>';
const I_SNIPPET = '<|snippet|>';

export type NextEditPromptFormat = 'zeta' | 'instinct';

/** One related-context item (semantic-index hit or LSP symbol context). */
export interface NextEditContextSnippet {
	path: string;    // workspace-relative path the snippet came from
	content: string; // the snippet itself (already budgeted by the caller)
}

export interface NextEditInput {
	editHistory: EditEntry[];   // oldest -> newest (the time dimension FIM lacks)
	contextSnippets: NextEditContextSnippet[]; // related code (index / symbol context)
	filePath: string;
	beforeRegion: string;       // lines above the editable region
	editableRegion: string;     // the editable region WITH NES_CURSOR_MARKER already inserted
	afterRegion: string;        // lines below
}

function oneLine(s: string): string { return s.replace(/\r/g, '').replace(/\n/g, '\\n'); }

export function buildNextEditPrompt(input: NextEditInput): string {
	const history = input.editHistory.length
		? input.editHistory.map(e => `--- ${e.summary}\n- ${oneLine(e.oldText)}\n+ ${oneLine(e.newText)}`).join('\n')
		: '(none)';
	const snippets = input.contextSnippets.filter(s => s.content.trim());
	const ctx = snippets.length ? snippets.map(s => `--- ${s.path}\n${s.content}`).join('\n\n') : '(none)';
	return [
		`You predict the user's NEXT code edit. Using their recent edits and the cursor region below, output ONLY the UPDATED version of the region between ${M_CURRENT} and ${M_DIVIDER} — i.e. what that region should become next. If no edit is warranted, output exactly ${NES_NO_EDITS}. Keep it minimal; do not rewrite unrelated code; never revert the user's own edits.`,
		`### Recent edits (oldest to newest)\n${history}`,
		`### Related context\n${ctx}`,
		`### File: ${input.filePath}\n${input.beforeRegion}\n${M_CURRENT}\n${input.editableRegion}\n${M_DIVIDER}\n${M_UPDATED}\n${input.afterRegion}`,
		`### Output the UPDATED region only (or ${NES_NO_EDITS}):`,
	].join('\n\n');
}

// ---- Instinct format (Continue.dev, Apache-2.0 — mirrors core/nextEdit/constants.ts + templating/instinct.ts) ----

export const INSTINCT_SYSTEM_PROMPT = `You are Instinct, an intelligent next-edit predictor developed by Continue.dev. Your role as an AI agent is to help developers complete their code tasks by predicting the next edit that they will make within the section of code marked by <|editable_region_start|> and <|editable_region_end|> tags.

You have access to the following information to help you make informed suggestions:

- Context: In the section marked "### Context", there are context items from potentially relevant files in the developer's codebase. Each context item consists of a <|context_file|> marker, the filepath, a <|snippet|> marker, and then some content from that file, in that order. Keep in mind that not all of the context information may be relevant to the task, so use your judgement to determine which parts to consider.
- User Edits: In the section marked "### User Edits:", there is a record of the most recent changes made to the code, helping you understand the evolution of the code and the developer's intentions. These changes are listed from most recent to least recent. It's possible that some of the edit diff history is entirely irrelevant to the developer's change. The changes are provided in a unified line-diff format, i.e. with pluses and minuses for additions and deletions to the code.
- User Excerpt: In the section marked "### User Excerpt:", there is a filepath to the developer's current file, and then an excerpt from that file. The <|editable_region_start|> and <|editable_region_end|> markers are within this excerpt. Your job is to rewrite only this editable region, not the whole excerpt. The excerpt provides additional context on the surroundings of the developer's edit.
- Cursor Position: Within the user excerpt's editable region, the <|user_cursor_is_here|> flag indicates where the developer's cursor is currently located, which can be crucial for understanding what part of the code they are focusing on. Do not produce this marker in your output; simply take it into account.

Your task is to predict and complete the changes the developer would have made next in the editable region. The developer may have stopped in the middle of typing. Your goal is to keep the developer on the path that you think they're following. Some examples include further implementing a class, method, or variable, or improving the quality of the code. Make sure the developer doesn't get distracted by ensuring your suggestion is relevant. Consider what changes need to be made next, if any. If you think changes should be made, ask yourself if this is truly what needs to happen. If you are confident about it, then proceed with the changes.

# Steps

1. **Review Context**: Analyze the context from the resources provided, such as recently viewed snippets, edit history, surrounding code, and cursor location.
2. **Evaluate Current Code**: Determine if the current code within the tags requires any corrections or enhancements.
3. **Suggest Edits**: If changes are required, ensure they align with the developer's patterns and improve code quality.
4. **Maintain Consistency**: Ensure indentation and formatting follow the existing code style.

# Output Format

- Provide only the revised code within the tags. Do not include the tags in your output.
- Ensure that you do not output duplicate code that exists outside of these tags.
- Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;

const INSTINCT_USER_PROMPT_PREFIX = 'Reference the user excerpt, user edits, and the snippets to understand the developer\'s intent. Update the editable region of the user excerpt by predicting and completing the changes they would have made next. This may be a deletion, addition, or modification of code.';

/** One edit as a fenced unified-diff block, the way Instinct saw them in training. */
function instinctDiffBlock(e: EditEntry): string {
	const minus = e.oldText ? e.oldText.replace(/\r/g, '').split('\n').map(l => `-${l}`) : [];
	const plus = e.newText ? e.newText.replace(/\r/g, '').split('\n').map(l => `+${l}`) : [];
	return `User edited file "${e.relativePath}"\n\n\`\`\`diff\n${[...minus, ...plus].join('\n')}\n\`\`\``;
}

/**
 * Instinct's user prompt. Same NextEditInput as the zeta builder — the NES_CURSOR_MARKER in
 * editableRegion is transposed to Instinct's cursor token. (The lone trailing fence after the
 * excerpt is faithful to Continue's template, quirk included.)
 */
export function buildNextEditPromptInstinct(input: NextEditInput): string {
	const ctx = input.contextSnippets
		.filter(s => s.content.trim())
		.map(s => `${I_CONTEXT_FILE}: ${s.path}\n${I_SNIPPET}\n${s.content}`)
		.join('\n');
	const history = input.editHistory.slice().reverse().map(instinctDiffBlock).join('\n'); // newest first
	const region = input.editableRegion.split(NES_CURSOR_MARKER).join(I_CURSOR);
	const excerpt = [
		...(input.beforeRegion ? [input.beforeRegion] : []),
		I_REGION_START,
		region,
		I_REGION_END,
		...(input.afterRegion ? [input.afterRegion] : []),
	].join('\n');
	return `${INSTINCT_USER_PROMPT_PREFIX}\n\n### Context:\n${ctx}\n\n### User Edits:\n\n${history}\n\n### User Excerpt:\n${input.filePath}\n\n${excerpt}\`\`\`\n### Response:`;
}

export interface NextEditResult { updated: string | null; } // null = NO_EDITS / nothing to suggest

/** Extract the UPDATED region from the model's raw output (tolerant of fences + echoed markers, zeta or instinct). */
export function parseNextEdit(output: string): NextEditResult {
	let s = (output ?? '').trim();
	// strip a single surrounding code fence
	s = s.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
	if (!s || /^NO_EDITS\b/i.test(s)) { return { updated: null }; }

	// if the model echoed the conflict markers, take what's on the UPDATED side
	const divIdx = s.indexOf(M_DIVIDER);
	const updIdx = s.indexOf(M_UPDATED);
	if (divIdx >= 0 && updIdx > divIdx) {
		s = s.slice(divIdx + M_DIVIDER.length, updIdx);
	} else if (updIdx >= 0) {
		s = s.slice(0, updIdx); // "<updated>\n>>>>>>> UPDATED"
	}

	// drop any stray marker lines (zeta conflict markers + instinct region tokens) + cursor markers
	s = s.split('\n').filter(l => {
		const t = l.trim();
		return !t.startsWith(M_CURRENT) && !t.startsWith(M_DIVIDER) && !t.startsWith(M_UPDATED)
			&& t !== I_REGION_START && t !== I_REGION_END;
	}).join('\n');
	s = s.split(NES_CURSOR_MARKER).join('');
	s = s.split(I_CURSOR).join('').trim();

	if (!s || /^NO_EDITS\b/i.test(s)) { return { updated: null }; }
	return { updated: s };
}

// ---- Suppression gate (packet sec.3: "the single biggest perceived-quality lever") ----
//
// A prediction only surfaces if NO heuristic flags it. Each check catches a real small-model
// failure mode; the cost of a false suppression (a missed suggestion) is much lower than the
// cost of a bad interruption, so every check errs toward suppressing.

export interface NextEditGateInput {
	updated: string;        // the parsed prediction
	currentRegion: string;  // what the editable region looks like now
	beforeRegion: string;   // context lines above (as sent to the model)
	afterRegion: string;    // context lines below (as sent to the model)
	recentEdits: EditEntry[]; // newest first (getRecentEdits order)
}

const stripAllWhitespace = (s: string) => s.replace(/\s+/g, '');
const nonEmptyTrimmedLines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean);

/** Why a prediction should be suppressed, or null to let it surface. The reason is for logging. */
export function nextEditSuppressionReason(g: NextEditGateInput): string | null {
	const updated = g.updated;
	const current = g.currentRegion;

	// exact no-op
	if (updated.trim() === current.trim()) { return 'no-op'; }

	// formatting-only churn isn't worth an interruption
	if (stripAllWhitespace(updated) === stripAllWhitespace(current)) { return 'whitespace-only'; }

	// marker/token garbage survived parsing => the output shape is untrustworthy
	if (/<{7} |>{7} |<\|user_cursor|<\|editable_region|<\|snippet\|>|<\|context_file\|>/.test(updated)) { return 'marker-echo'; }

	// an empty rewrite of a substantial region is almost always a degenerate output, not a real edit
	// (small deletions still pass — NES is allowed to delete)
	if (updated.trim() === '' && current.trim().length > 120) { return 'mass-delete'; }

	// runaway generation: the region ballooned far past any plausible next edit
	if (updated.length > current.length * 4 + 200) { return 'runaway-growth'; }

	// the model re-emitted a neighbor line from outside the region (accepting would duplicate it)
	const updatedLines = nonEmptyTrimmedLines(updated);
	const afterFirst = nonEmptyTrimmedLines(g.afterRegion)[0] ?? '';
	if (afterFirst.length >= 8 && updatedLines[updatedLines.length - 1] === afterFirst && !current.includes(afterFirst)) { return 'echoes-after-context'; }
	const beforeLines = nonEmptyTrimmedLines(g.beforeRegion);
	const beforeLast = beforeLines[beforeLines.length - 1] ?? '';
	if (beforeLast.length >= 8 && updatedLines[0] === beforeLast && !current.includes(beforeLast)) { return 'echoes-before-context'; }

	// never revert the user's own latest edit (the one thing the prompt forbids most explicitly)
	const latest = g.recentEdits[0];
	if (latest) {
		const oldT = latest.oldText.trim();
		const newT = latest.newText.trim();
		if (oldT.length >= 3 && oldT !== newT) {
			const reintroducesOld = updated.includes(oldT) && !current.includes(oldT);
			const dropsNew = newT.length > 0 ? (current.includes(newT) && !updated.includes(newT)) : true;
			if (reintroducesOld && dropsNew) { return 'reverts-user-edit'; }
		}
	}

	// low confidence: real next-edits are local — if a large region shares almost no
	// prefix/suffix with the prediction, the model rewrote wholesale (likely hallucinated)
	if (current.length > 200) {
		const n = Math.min(current.length, updated.length);
		let prefix = 0;
		while (prefix < n && current[prefix] === updated[prefix]) { prefix++; }
		let suffix = 0;
		while (suffix < n - prefix && current[current.length - 1 - suffix] === updated[updated.length - 1 - suffix]) { suffix++; }
		if ((prefix + suffix) / current.length < 0.2) { return 'wholesale-rewrite'; }
	}

	return null;
}
