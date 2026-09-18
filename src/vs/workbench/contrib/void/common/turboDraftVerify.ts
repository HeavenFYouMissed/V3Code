/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Post-draft verification rules for Turbo Draft.
 *
 * The question after a draft is not "does this file have errors" — most real files already
 * do — but "did the draft BREAK something that was fine before". So we diff the problem set
 * against a baseline captured before the edit, and only newly-introduced errors are worth
 * bothering the developer with.
 *
 * Line numbers move when text is inserted, so identity is (code, normalized message), never
 * position. Two errors with the same code and message are the same problem to us even if
 * they slid down 40 lines; the alternative is reporting the whole file as "new" after any
 * insertion, which is worse than not verifying at all.
 */

export interface TurboVerifyProblem {
	code: string;
	/** Pre-formatted "(error) ..." / "(warning) ..." message as the marker service emits. */
	message: string;
	startLineNumber: number;
}

export interface TurboVerifyResult {
	/** Errors present after the draft that were not present before. */
	newErrors: TurboVerifyProblem[];
	/** True when the draft introduced nothing new. */
	clean: boolean;
}

export function isErrorProblem(p: TurboVerifyProblem): boolean {
	return p.message.startsWith('(error)');
}

/** Position-independent identity: same rule, same complaint. */
export function problemKey(p: TurboVerifyProblem): string {
	return `${p.code}::${p.message.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Errors introduced by the draft. Warnings are deliberately ignored: a draft that adds a
 * lint nag is not worth a round trip, one that adds a type error is.
 */
export function diffTurboProblems(
	baseline: readonly TurboVerifyProblem[] | null | undefined,
	after: readonly TurboVerifyProblem[] | null | undefined,
): TurboVerifyResult {
	const afterErrors = (after ?? []).filter(isErrorProblem);
	if (afterErrors.length === 0) {
		return { newErrors: [], clean: true };
	}
	// Count occurrences so 3 copies of the same error where 1 existed still reads as new.
	const before = new Map<string, number>();
	for (const p of baseline ?? []) {
		if (!isErrorProblem(p)) { continue; }
		const k = problemKey(p);
		before.set(k, (before.get(k) ?? 0) + 1);
	}
	const newErrors: TurboVerifyProblem[] = [];
	for (const p of afterErrors) {
		const k = problemKey(p);
		const remaining = before.get(k) ?? 0;
		if (remaining > 0) {
			before.set(k, remaining - 1);
			continue;
		}
		newErrors.push(p);
	}
	return { newErrors, clean: newErrors.length === 0 };
}

const MAX_FIX_PROBLEMS = 8;

/** The follow-up prompt: fix exactly what the draft broke, change nothing else. */
export function buildTurboDraftFixPrompt(opts: {
	filePath: string;
	fileContents: string;
	newErrors: readonly TurboVerifyProblem[];
}): string {
	const list = opts.newErrors.slice(0, MAX_FIX_PROBLEMS)
		.map(e => `- line ${e.startLineNumber}: ${e.message}`)
		.join('\n');
	return [
		'The edits just applied to this file introduced NEW errors that were not there before.',
		'Fix exactly these errors and nothing else. Do not refactor, rename, reformat, or "improve" anything that is not required to clear them.',
		`### New errors\n${list}`,
		`### Current file: ${opts.filePath}\n\`\`\`\n${opts.fileContents}\n\`\`\``,
		'### Output\nSearch/replace blocks only (or exactly NO_CHANGES if the errors cannot be fixed without a larger change):',
	].join('\n\n');
}
