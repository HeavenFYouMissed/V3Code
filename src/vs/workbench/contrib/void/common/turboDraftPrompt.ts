/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Turbo Draft — whole-file rewrite prompt + response classification (headless / unit-testable).
 * Output format matches edit_file markers in prompts.ts (ORIGINAL / DIVIDER / UPDATED).
 */

import { EditEntry } from './recentEditsTypes.js';
import { DIVIDER, FINAL, ORIGINAL } from './prompt/prompts.js';

export type TurboDraftMode = 'fast' | 'deep';
export type TurboDraftHunkKind = 'add' | 'change' | 'remove';

export interface TurboDraftContextSnippet {
    path: string;
    content: string;
}

export interface TurboDraftInput {
    filePath: string;
    fileContents: string;
    cursorLine: number;
    editHistory: EditEntry[]; // oldest → newest
    contextSnippets: TurboDraftContextSnippet[];
    recentChatSummary?: string;
    mode: TurboDraftMode;
    userIntent?: string;
    compilerTruth?: TurboDraftCompilerTruthInput;
}

/** Language-server facts about the drafted file. All fields optional / best-effort. */
export interface TurboDraftCompilerTruthInput {
    diagnostics?: string[];
    signatures?: string[];
    callSites?: string[];
    partial?: boolean;
}

/** Above this, the file is sent as a cursor-centered window instead of whole. */
export const TURBO_DRAFT_MAX_INLINE_LINES = 900;

export interface TurboDraftFileWindow {
    text: string;
    windowed: boolean;
    /** 1-based inclusive bounds of what `text` covers. */
    startLine: number;
    endLine: number;
    totalLines: number;
}

/**
 * Keep whole-file drafts affordable. Under the cap the file goes in untouched; over it we
 * send a cursor-centered slice snapped to blank lines, with explicit elision markers so the
 * model knows it is not seeing everything. Block validation still runs against the FULL
 * source, so a block matching outside the window is rejected rather than misapplied.
 */
export function windowFileForTurbo(contents: string, cursorLine: number, maxLines = TURBO_DRAFT_MAX_INLINE_LINES): TurboDraftFileWindow {
    const lines = contents.split('\n');
    const totalLines = lines.length;
    if (totalLines <= maxLines || maxLines <= 0) {
        return { text: contents, windowed: false, startLine: 1, endLine: totalLines, totalLines };
    }

    const cursor = Math.min(Math.max(1, Math.floor(cursorLine) || 1), totalLines);
    const half = Math.floor(maxLines / 2);
    let start = Math.max(1, cursor - half);
    let end = Math.min(totalLines, start + maxLines - 1);
    start = Math.max(1, end - maxLines + 1); // re-pin when the cursor sits near EOF

    // Snap outward to a blank line so we do not cut mid-statement (bounded search).
    const SNAP = 40;
    for (let i = start; i > Math.max(1, start - SNAP); i--) {
        if ((lines[i - 1] ?? '').trim() === '') { start = i; break; }
    }
    for (let i = end; i < Math.min(totalLines, end + SNAP); i++) {
        if ((lines[i - 1] ?? '').trim() === '') { end = i; break; }
    }

    const body = lines.slice(start - 1, end).join('\n');
    const head = start > 1 ? `/* ... lines 1-${start - 1} omitted ... */\n` : '';
    const tail = end < totalLines ? `\n/* ... lines ${end + 1}-${totalLines} omitted ... */` : '';
    return { text: `${head}${body}${tail}`, windowed: true, startLine: start, endLine: end, totalLines };
}

export type TurboDraftResponseKind =
    | 'no-changes'
    | 'empty'
    | 'reasoning-only'
    | 'malformed'
    | 'valid-blocks';

export interface TurboDraftResponseClassification {
    kind: TurboDraftResponseKind;
    /** Trimmed visible text used for parsing. */
    text: string;
    detail: string;
}

export const TURBO_DRAFT_SYSTEM_PROMPT = `You are a whole-file rewrite agent — a file-writing autocomplete that decides which edits fit, which don't, what is wrong or incomplete, and what the file needs to be finished. You are given: the current file, the developer's recent Tab/NES accepts, optional agent chat, and related code.

Return changes ONLY as search/replace blocks using these exact markers:

${ORIGINAL}
// original code that uniquely exists in the file
${DIVIDER}
// updated code
${FINAL}

Rules:
- Every ORIGINAL must uniquely match existing file text (include enough neighboring context).
- Never use an empty ORIGINAL. Insertions must keep a unique neighboring anchor in ORIGINAL and include the new text in UPDATED.
- Empty UPDATED body = remove/flag wrong code.
- Prefer minimal, correct, idiomatic edits that match the file's style.
- Do not rewrite what already works.
- Deletions in the edit trail are intentional. Never restore code the developer just removed - treat the removal as a signal about the direction they want.
- When a "Compiler truth" section is present it comes from the language server and outranks any snippet. Match those signatures exactly, fix the listed problems, and do not break the listed callers.
- Never invent marker lines inside the ORIGINAL/UPDATED bodies.
- Never wrap markers in markdown fences.
- If truly nothing should change, output exactly: NO_CHANGES
- Do not write explanations outside the blocks.

Documentation you write:
- Give a new or substantially rewritten function, class or module a short header that says WHY it exists and what a caller must know - constraints, units, ownership, failure behaviour, edge cases. One or two sentences, in the file's existing comment style.
- Never narrate the code ("// increment the counter", "// import the module") and never describe your own edit ("// added error handling"). If the header only repeats the signature, leave it out.
- Do not add or reformat headers on code you are not otherwise changing.`;

/**
 * Markdown/plain-text drafting. The code contract (unique anchors, exact markers) is
 * identical, but the editorial rules are the opposite of code rules, and applying
 * "idiomatic, minimal, do not rewrite what works" to prose produced timid, useless passes.
 */
export const TURBO_DRAFT_PROSE_SYSTEM_PROMPT = `You are a whole-document editor for prose and documentation - a writing autocomplete that finishes what the author started. You are given: the current document, the author's recent edits, optional agent chat, and related context.

Return changes ONLY as search/replace blocks using these exact markers:

${ORIGINAL}
// text that uniquely exists in the document
${DIVIDER}
// updated text
${FINAL}

Rules:
- Every ORIGINAL must uniquely match existing document text (include enough neighboring context).
- Never use an empty ORIGINAL. Insertions must keep a unique neighboring anchor in ORIGINAL and include the new text in UPDATED.
- Empty UPDATED body = delete that passage.
- Match the document's existing voice, person, tense and heading style. Do not restyle sections you are not asked to change.
- Finish what is unfinished: fill placeholder sections, complete half-written sentences and lists, resolve TODO markers, and make the structure consistent.
- Preserve every code block, command, path, link, number and proper noun exactly unless the surrounding text is clearly wrong. Never invent facts, versions, URLs or API names.
- Prefer plain, concrete sentences over filler. Do not add throat-clearing intros, marketing adjectives or summaries of what the document is about to say.
- Deletions in the edit trail are intentional. Never restore text the author just removed.
- Never invent marker lines inside the ORIGINAL/UPDATED bodies.
- Never wrap markers in markdown fences.
- If truly nothing should change, output exactly: NO_CHANGES
- Do not write explanations outside the blocks.`;

/** Extensions Turbo Draft treats as prose rather than code. */
const PROSE_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'];

export function isProsePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) { return false; }
    return PROSE_EXTENSIONS.includes(lower.slice(dot));
}

/** The system prompt that matches what is actually being drafted. */
export function turboDraftSystemPromptFor(filePath: string): string {
    return isProsePath(filePath) ? TURBO_DRAFT_PROSE_SYSTEM_PROMPT : TURBO_DRAFT_SYSTEM_PROMPT;
}

export const TURBO_DRAFT_REPAIR_SYSTEM_PROMPT = `You previously returned an invalid Turbo Draft response. Convert it into valid search/replace blocks only, using these exact markers:

${ORIGINAL}
// original code that uniquely exists in the file
${DIVIDER}
// updated code
${FINAL}

Rules:
- Output ONLY blocks or exactly NO_CHANGES.
- Every ORIGINAL must uniquely match the provided file.
- Never use an empty ORIGINAL.
- No markdown fences, no prose outside blocks.`;

/**
 * The compiler-truth section. Returns '' when the language server gave us nothing, so an
 * empty "Compiler truth: (none)" block never teaches the model that facts are optional.
 */
export function renderCompilerTruth(truth: TurboDraftCompilerTruthInput | undefined): string {
    const diagnostics = truth?.diagnostics?.filter(Boolean) ?? [];
    const signatures = truth?.signatures?.filter(Boolean) ?? [];
    const callSites = truth?.callSites?.filter(Boolean) ?? [];
    if (!diagnostics.length && !signatures.length && !callSites.length) { return ''; }

    const parts = ['### Compiler truth (from the language server - authoritative, outranks the snippets below)'];
    if (diagnostics.length) {
        parts.push(`Live problems in this file:\n${diagnostics.map(d => `- ${d}`).join('\n')}`);
    }
    if (signatures.length) {
        parts.push(`Real signatures near the cursor - call them exactly like this:\n${signatures.map(s => `- ${s}`).join('\n')}`);
    }
    if (callSites.length) {
        parts.push(`Existing callers - do not break these:\n${callSites.map(c => `- ${c}`).join('\n')}`);
    }
    if (truth?.partial) {
        parts.push('(Partial: the language server did not answer everything in time. Absence of a problem here is not proof there is none.)');
    }
    return parts.join('\n\n');
}

/** At or under this many real lines, the file is being created rather than edited. */
export const TURBO_DRAFT_SCAFFOLD_MAX_LINES = 8;

/**
 * True for a file the developer has just opened and described but not written yet.
 * Requires at least one real line: every ORIGINAL must anchor on existing text, so a
 * completely empty file has nothing to attach a block to.
 */
export function isScaffoldFile(contents: string): boolean {
    const real = contents.split('\n').filter(l => l.trim()).length;
    return real >= 1 && real <= TURBO_DRAFT_SCAFFOLD_MAX_LINES;
}

export function buildTurboDraftPrompt(input: TurboDraftInput): string {
    const history = input.editHistory.length
        ? input.editHistory.map(e => `--- ${editTrailLabel(e)} ${e.summary}\n- ${oneLine(e.oldText)}\n+ ${oneLine(e.newText)}`).join('\n')
        : '(none)';
    const snippets = input.contextSnippets.filter(s => s.content.trim());
    const ctx = snippets.length
        ? snippets.map(s => `--- ${s.path}\n${s.content}`).join('\n\n')
        : '(none)';
    const chat = (input.recentChatSummary ?? '').trim() || '(none)';
    const intent = (input.userIntent ?? '').trim() || '(none)';
    const prose = isProsePath(input.filePath);
    const modeHint = prose
        ? (input.mode === 'deep'
            ? 'Mode: DEEP — finish the whole document. Fill placeholder sections, complete unfinished passages, use chat + related files aggressively.'
            : 'Mode: FAST — whole-document high-confidence pass. Finish half-written sentences and lists, fix obvious gaps; keep the existing voice.')
        : (input.mode === 'deep'
            ? 'Mode: DEEP — finish the whole page. Wire gaps, complete unfinished work, use chat + related files aggressively.'
            : 'Mode: FAST — whole-file high-confidence completion pass. Fix incomplete/broken code and obvious missing pieces; stay idiomatic and tight.');

    const win = windowFileForTurbo(input.fileContents, input.cursorLine);
    const noun = prose ? 'document' : 'file';
    const fileHeader = win.windowed
        ? `### File: ${input.filePath} (lines ${win.startLine}-${win.endLine} of ${win.totalLines}, cursor ~line ${input.cursorLine})\nYou are seeing part of this ${noun}. Every ORIGINAL must match text inside the shown window.`
        : `### File: ${input.filePath} (cursor ~line ${input.cursorLine})`;

    const sections = [
        modeHint,
    ];

    // "Do not rewrite what already works" is true of a real file and actively wrong for an
    // empty one: models read a lone header comment as working code and answered NO_CHANGES.
    if (!win.windowed && isScaffoldFile(input.fileContents)) {
        sections.push(
            `### This ${noun} is empty apart from a note\n`
            + `The developer opened it and described what it should be. Write its full intended contents. `
            + `Anchor ORIGINAL on a line that really exists (the note itself) and put the complete ${noun} in UPDATED. `
            + `NO_CHANGES is wrong here: a described but unwritten ${noun} is a request to write it.`
        );
    }

    sections.push(
        `### User intent\n${intent}`,
        `### What the developer just did (oldest -> newest)\n${history}`,
        `### Recent agent chat\n${chat}`,
    );

    const truth = renderCompilerTruth(input.compilerTruth);
    if (truth) { sections.push(truth); }

    sections.push(
        `### Related context\n${ctx}`,
        `${fileHeader}\n\`\`\`\n${win.text}\n\`\`\``,
        `### Output\nSearch/replace blocks only using ${ORIGINAL} / ${DIVIDER} / ${FINAL} (or exactly NO_CHANGES):`,
    );
    return sections.join('\n\n');
}

/**
 * Turn the quality gate's reject reasons into instructions the model can act on. Naming the
 * failure is the whole point of a repair pass: told only "that was invalid", models routinely
 * answered NO_CHANGES and the developer got nothing.
 */
const REPAIR_GUIDANCE: Record<string, string> = {
	'too-large': 'At least one block was too big. Split the work into several small blocks, each under 12000 characters, instead of replacing a huge span at once.',
	'not-found': 'At least one ORIGINAL did not appear in the file. Copy ORIGINAL text character-for-character out of the file below.',
	'not-unique': 'At least one ORIGINAL matched the file in more than one place. Add neighbouring lines until each ORIGINAL is unique.',
	'unanchored-insertion': 'You used an empty ORIGINAL. Anchor every insertion on a real neighbouring line and repeat that line in UPDATED.',
	'empty-orig-and-final': 'At least one block was completely empty. Remove it.',
	'unchanged': 'At least one block had UPDATED identical to ORIGINAL. Drop those blocks and keep only real edits.',
	'overlap': 'Two blocks covered the same region of the file. Merge them into one block.',
	'aggregate-noop': 'Applying your blocks left the file byte-identical. Make the edits real or say NO_CHANGES.',
	'no-blocks': 'No complete block was found. Emit the markers exactly as shown, each on its own line.',
	'ambiguous-markers': 'The marker counts did not line up. Every block needs exactly one ORIGINAL, one DIVIDER and one UPDATED, and markers must never appear inside block bodies.',
	'partial-reject': 'Some of your blocks were fine and some were not; the whole response was rejected. Keep the good edits and fix only the broken ones.',
};

export function buildTurboDraftRepairPrompt(opts: {
	filePath: string;
	fileContents: string;
	previousResponse: string;
	/** Reject-reason keys from the quality gate, e.g. ['too-large', 'partial-reject']. */
	rejectReasons?: string[];
	/** True when the previous attempt did propose edits, so giving up is not a valid answer. */
	hadEdits?: boolean;
}): string {
	const reasons = (opts.rejectReasons ?? []).filter(r => REPAIR_GUIDANCE[r]);
	const diagnosis = reasons.length
		? `### Why it was rejected\n${reasons.map(r => `- ${REPAIR_GUIDANCE[r]}`).join('\n')}`
		: undefined;

	// A model that just proposed edits and is now asked to fix their format has no honest
	// reason to conclude the file is perfect. Leaving the escape hatch open is how a rejected
	// draft turned into "No useful edits found".
	const ending = opts.hadEdits
		? `### Output\nReturn valid ${ORIGINAL}/${DIVIDER}/${FINAL} blocks. Do NOT answer NO_CHANGES: you already found work to do, so return the smallest correct version of it. If one edit cannot be made to fit the rules, drop that edit and return the rest.`
		: `### Output\nReturn valid ${ORIGINAL}/${DIVIDER}/${FINAL} blocks only, or exactly NO_CHANGES.`;

	return [
		`The previous response was invalid for Turbo Draft.`,
		diagnosis,
		`### Previous response\n\`\`\`\n${opts.previousResponse.slice(0, 12_000)}\n\`\`\``,
		`### File: ${opts.filePath}\n\`\`\`\n${opts.fileContents}\n\`\`\``,
		ending,
	].filter(Boolean).join('\n\n');
}

function oneLine(s: string): string {
    return s.replace(/\r/g, '').replace(/\n/g, '\\n');
}

/**
 * Say WHY an edit happened, not just where it came from. A deletion rendered as
 * `- code` / `+ (empty)` reads like noise; models routinely "helpfully" restored code
 * the developer had just removed on purpose.
 */
export function editTrailLabel(e: EditEntry): string {
    const removedEverything = e.oldText.trim() !== '' && e.newText.trim() === '';
    if (removedEverything) { return '[developer deleted]'; }
    if (e.source === 'tab' || e.source === 'nes') { return `[accepted ${e.source}]`; }
    return '[developer typed]';
}

/**
 * Classify a model completion for Turbo Draft.
 * Exact trimmed NO_CHANGES is the only calm "no edits" success.
 */
export function classifyTurboDraftResponse(raw: string, opts?: { hasReasoning?: boolean }): TurboDraftResponseClassification {
    const text = (raw ?? '').trim();
    if (!text) {
        if (opts?.hasReasoning) {
            return { kind: 'reasoning-only', text, detail: 'Model returned reasoning without a final answer.' };
        }
        return { kind: 'empty', text, detail: 'Model returned an empty response.' };
    }
    if (text === 'NO_CHANGES' || /^NO_CHANGES$/i.test(text)) {
        return { kind: 'no-changes', text: 'NO_CHANGES', detail: 'Model found no useful edits.' };
    }
    if (/^NO_CHANGES\b/i.test(text) && (text.includes(ORIGINAL) || text.includes(FINAL))) {
        return { kind: 'malformed', text, detail: 'Response mixed NO_CHANGES with edit blocks.' };
    }
    if (/^NO_CHANGES\b/i.test(text)) {
        return { kind: 'malformed', text, detail: 'Response started with NO_CHANGES but was not exact.' };
    }
    if (text.includes(ORIGINAL) && text.includes(FINAL)) {
        return { kind: 'valid-blocks', text, detail: 'Response contains search/replace markers.' };
    }
    return { kind: 'malformed', text, detail: 'Response was not NO_CHANGES and lacked ORIGINAL/UPDATED markers.' };
}

/** @deprecated Prefer classifyTurboDraftResponse — kept for older call sites/tests. */
export function isTurboDraftNoChanges(raw: string): boolean {
    return classifyTurboDraftResponse(raw).kind === 'no-changes';
}

/**
 * Soft classification of a block for UI (progress / red-dark). Heuristic only —
 * empty FINAL => remove; empty ORIGINAL => add; else change.
 */
export function classifyTurboDraftHunk(orig: string, final: string): TurboDraftHunkKind {
    const o = orig.trim();
    const f = final.trim();
    if (o && !f) { return 'remove'; }
    if (!o && f) { return 'add'; }
    return 'change';
}
