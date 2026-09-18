/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Host-side safety policy for the V3Code local agent runtime.
 *
 * The lifecycle deliberately follows Cline AgentRuntime's useful boundary:
 * model turn -> zero or more tool calls -> tool results -> next model turn. V3Code keeps
 * ownership of the model transport, native tool cards, approvals, MCP, prompt assembly and
 * cancellation; this small policy layer supplies the finite iteration and loop/mistake guards
 * which Cline Core layers around its low-level runtime.
 *
 * Adapted for V3Code from the Apache-2.0 Cline SDK design (sdk/v0.0.65, commit
 * f33ab3a872091952f44e43d0c8f5438099a60ada). See NOTICE.txt.
 */

export const LOCAL_AGENT_REPEAT_SOFT_THRESHOLD = 3;
export const LOCAL_AGENT_REPEAT_HARD_THRESHOLD = 5;

const COMPACT_LOCAL_MAX_ITERATIONS = 12;
const STANDARD_LOCAL_MAX_ITERATIONS = 20;
const LARGE_LOCAL_MAX_ITERATIONS = 40;

const COMPACT_LOCAL_MISTAKE_LIMIT = 2;
const STANDARD_LOCAL_MISTAKE_LIMIT = 3;

export const isLocalAgentProvider = (providerName: string | undefined): boolean =>
	providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio' || providerName === 'v3code-local';

/** Honor explicit autonomous intent by removing ask_user from this local turn's advertised tools. */
export function shouldSuppressLocalAskUser(userMessage: string): boolean {
	const message = userMessage.trim();
	return /\b(?:do\s+not|don['\u2019]?t|never)\s+ask\s+(?:me\b|questions?\b)/i.test(message)
		|| /\b(?:you\s+(?:choose|decide)(?:\s+(?:for\s+me|everything|all\s+of\s+it))?|(?:choose|decide)\s+(?:for\s+me|everything|all\s+of\s+it))\b/i.test(message)
		|| /\b(?:make\s+the\s+decisions?|use\s+your\s+(?:best\s+)?judg(?:e)?ment|just\s+(?:build|do\s+it|make\s+it|go\s+ahead))\b/i.test(message);
}

/** Detect a closing promise of future action, while excluding replies that genuinely await the user. */
export function localNarrationNeedsRecovery(replyText: string): boolean {
	const close = replyText.trim().slice(-400);
	if (!close) {
		return false;
	}
	const awaitingUser = /(?:\?\s*$|\b(?:let me know|your call|want me to|would you like|do you want|if you prefer|awaiting your|ready when you are)\b[^.!?\n]{0,120}[.!?]?\s*$)/i.test(close);
	if (awaitingUser) {
		return false;
	}
	const intentToAct = /\b(?:let me|i['\u2019]?ll|i will|now i|next i|i['\u2019]?m going to|let['\u2019]?s)\b[^.?!\n]{0,100}\b(?:search|look|read|check|find|inspect|edit|fix|open|add|implement|refactor|run|execut|investigat|build|writ|creat|updat|modif|chang|verif|locat|wir)(?:e|es|ed|ing|ion|ions|s|y|ies|ied|ying|ning|ten)?\b/i.test(close);
	const pendingWork = /\b(?:proceed with|next step|next up|next,|then run|remaining(?: work|:)?|still (?:needs?|requires?|left|outstanding)|not yet (?:done|wired|tested|verified|implemented|applied|run)|needs? to be (?:wired|run|tested|verified|implemented|applied|added|done)|to-?do:)\b/i.test(close);
	return intentToAct || pendingWork;
}

/** Parse the largest advertised parameter count from common local tags (4b, 30b-a3b, 70B). */
export function localModelParameterBillions(modelName: string | undefined): number | undefined {
	if (!modelName) { return undefined; }
	const matches = [...modelName.matchAll(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*([bm])(?:[^a-z0-9]|$)/gi)];
	if (matches.length === 0) { return undefined; }
	return Math.max(...matches.map(match => Number(match[1]) * (match[2].toLowerCase() === 'm' ? 0.001 : 1)));
}
export type LocalAgentRuntimeProfile = 'compact' | 'standard' | 'large';

export interface LocalAgentRuntimeLimits {
	profile: LocalAgentRuntimeProfile;
	maxIterations: number;
	mistakeLimit: number;
	parallelReadOnly: boolean;
}

export function localAgentRuntimeLimits(modelName: string | undefined): LocalAgentRuntimeLimits {
	const parameters = localModelParameterBillions(modelName);
	if (parameters !== undefined && parameters < 6) {
		return {
			profile: 'compact',
			maxIterations: COMPACT_LOCAL_MAX_ITERATIONS,
			mistakeLimit: COMPACT_LOCAL_MISTAKE_LIMIT,
			parallelReadOnly: false,
		};
	}
	if (parameters !== undefined && parameters >= 20) {
		return {
			profile: 'large',
			maxIterations: LARGE_LOCAL_MAX_ITERATIONS,
			mistakeLimit: STANDARD_LOCAL_MISTAKE_LIMIT,
			parallelReadOnly: true,
		};
	}
	return {
		profile: 'standard',
		maxIterations: STANDARD_LOCAL_MAX_ITERATIONS,
		mistakeLimit: STANDARD_LOCAL_MISTAKE_LIMIT,
		parallelReadOnly: false,
	};
}

export interface LocalAgentToolBatchControl {
	block: boolean;
	reminder?: string;
}

export interface LocalAgentToolResultControl {
	reminder?: string;
	blockFurtherTools: boolean;
}

/**
 * Stateful controls for one user turn. The class does not execute models or tools; the native
 * chat host does that so there is exactly one owner for UI streaming, approvals and cancellation.
 */
export class V3CodeLocalAgentRuntime {
	readonly limits: LocalAgentRuntimeLimits;

	private previousToolBatch = '';
	private repeatedToolBatchCount = 0;
	private consecutiveMistakes = 0;
	private emptyTurnRecoveryUsed = false;
	private narrationRecoveryUsed = false;
	private successfulAskCount = 0;
	private toolsBlocked = false;

	constructor(modelName: string | undefined) {
		this.limits = localAgentRuntimeLimits(modelName);
	}

	/** Local narration may recover once when its closing sentence promises work that never ran. */
	readonly useNarrationContinuation = true;

	/** A reasoning-only turn gets one correction chance; prose narration never gets auto-pushed. */
	shouldRecoverEmptyTurn(hasReasoning: boolean): boolean {
		if (!hasReasoning || this.emptyTurnRecoveryUsed) { return false; }
		this.emptyTurnRecoveryUsed = true;
		return true;
	}

	/** Spend the single per-turn narration recovery only on a positively classified unfinished reply. */
	shouldRecoverNarration(replyText: string): boolean {
		if (this.narrationRecoveryUsed || !localNarrationNeedsRecovery(replyText)) {
			return false;
		}
		this.narrationRecoveryUsed = true;
		return true;
	}

	/** A completed multiple-choice answer is enough direction for one task turn; later asks are blocked. */
	beforeAskUser(): LocalAgentToolBatchControl {
		return this.successfulAskCount >= 1
			? { block: true, reminder: 'The user already answered one question in this task turn. Use that answer and your best judgment; do not ask another question now.' }
			: { block: false };
	}

	/** Count only an actual clicked answer; a dismissed or failed question does not consume the policy. */
	recordAskUserResult(resultText: string, isError: boolean): void {
		if (!isError && /\bthe user chose:\s*\S/i.test(resultText)) {
			this.successfulAskCount++;
		}
	}

	beforeToolBatch(signatures: readonly string[]): LocalAgentToolBatchControl {
		if (this.toolsBlocked) {
			return {
				block: true,
				reminder: 'Local agent safety stop: the mistake limit was reached. Do not call another tool in this turn; answer with what you know or ask the user for guidance.',
			};
		}

		const signature = signatures.join('\u001e');
		if (signature && signature === this.previousToolBatch) {
			this.repeatedToolBatchCount++;
		} else {
			this.previousToolBatch = signature;
			this.repeatedToolBatchCount = 1;
		}

		if (this.repeatedToolBatchCount >= LOCAL_AGENT_REPEAT_HARD_THRESHOLD) {
			return {
				block: true,
				reminder: `Local agent loop stopped: this exact tool batch was requested ${this.repeatedToolBatchCount} times in a row. Inspect the existing result and change approach; do not repeat it.`,
			};
		}
		if (this.repeatedToolBatchCount === LOCAL_AGENT_REPEAT_SOFT_THRESHOLD) {
			return {
				block: false,
				reminder: 'You have requested the same tool batch three times in a row. Use this result, change the arguments or approach, or answer the user; do not repeat the same call again.',
			};
		}
		return { block: false };
	}

	afterToolBatch(results: readonly { isError: boolean }[]): LocalAgentToolResultControl {
		const allFailed = results.length > 0 && results.every(result => result.isError);
		this.consecutiveMistakes = allFailed ? this.consecutiveMistakes + 1 : 0;
		if (this.consecutiveMistakes >= this.limits.mistakeLimit) {
			this.toolsBlocked = true;
			return {
				blockFurtherTools: true,
				reminder: `Local agent safety stop: every tool in ${this.consecutiveMistakes} consecutive batches failed. Stop retrying tools, explain the blocker from the results, and ask the user only if a decision is required.`,
			};
		}
		if (allFailed) {
			return {
				blockFurtherTools: false,
				reminder: 'That tool batch failed. Read the error and make one materially different correction; do not blindly repeat the same call.',
			};
		}
		return { blockFurtherTools: false };
	}
}
