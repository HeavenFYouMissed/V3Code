/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Build the deliberately context-free request used by the composer prompt-expansion action.
 * The selected model gets the draft only: no chat history, tools, memory, or agent loop.
 */
export function buildPromptPolishRequest(draft: string, isRetry = false): string {
	return [
		'You turn rough software ideas into implementation-ready briefs for an autonomous coding agent.',
		'Expand the idea substantially; do not merely correct grammar or lightly rephrase it.',
		'Return only the finished downstream prompt. Do not answer the prompt, introduce your rewrite, or ask the user questions.',
		'Preserve every explicit fact, file path, symbol, command, @ mention, # reference, slash command, constraint, priority, and requested outcome.',
		'Add practical detail a strong product engineering team would normally need, while never inventing company facts, credentials, integrations, legal claims, or irreversible user decisions.',
		'When information is missing, choose reasonable reversible defaults and label them as assumptions. Tell the implementation agent to ask only when alternatives would materially change the product.',
		'Write directly to the implementation agent. Start with a concrete role and mission suited to the work, not hollow hype.',
		'For a short or vague idea, create a substantial build brief with clear sections for:',
		'- product objective, target users, and desired outcome;',
		'- core workflows, features, edge cases, and scope;',
		'- visual direction, interaction quality, responsive behavior, and accessibility;',
		'- repository-first implementation guidance, architecture, data, authentication, security, and performance where relevant;',
		'- acceptance criteria and an explicit verification plan.',
		'Require the agent to inspect the repository and reuse its architecture, components, and conventions before choosing new ones. Require current research when a decision is time-sensitive.',
		'Keep a detailed existing prompt faithful and proportional; make a tiny idea much more actionable. Prefer 300-900 words for a greenfield product idea and less for a focused code change.',
		...(isRetry ? ['The previous attempt was too close to copyediting. This attempt must add the missing product, implementation, and verification substance.'] : []),
		'',
		'<source_idea>',
		draft,
		'</source_idea>',
	].join('\n');
}

/** Remove the two common wrappers models add despite the output-only instruction. */
export function sanitizePromptPolishOutput(value: string): string {
	let result = value.trim();
	const fenced = /^```(?:text|markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(result);
	if (fenced) {
		result = fenced[1].trim();
	}
	result = result.replace(/^(?:rewritten prompt|optimized prompt|polished prompt|expanded prompt|implementation brief|build brief)\s*:\s*/i, '').trim();
	return result;
}

/** A short idea should become a real brief, not come back as a lightly edited sentence. */
export function promptExpansionNeedsRetry(draft: string, expanded: string): boolean {
	const source = draft.trim().replace(/\s+/g, ' ');
	const result = expanded.trim().replace(/\s+/g, ' ');
	if (!result || result.toLocaleLowerCase() === source.toLocaleLowerCase()) {
		return true;
	}
	if (source.length <= 600) {
		return result.length < Math.max(source.length + 180, Math.ceil(source.length * 1.8));
	}
	return false;
}
