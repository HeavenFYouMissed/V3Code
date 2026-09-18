/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Turn-intent classification for the agent context wire (see docs/V3CODE-MEMORY-CONTRACT.md section 5).
 * Pure -> headless-testable; extracted from convertToLLMMessageService so the memory contract's
 * turn rules can be tested without the editor. The live user message is classified ONCE per turn
 * and that drives what context gets assembled.
 */

/** Explicit request to resume/switch to a prior or remembered task. */
export const TASK_SWITCH_INTENT_RE = /\b(resume|continue|switch\s+to|go\s+back\s+to|pick\s+up|where\s+were\s+we|previous\s+task|old\s+task|handoff)\b/i;

/** A self-contained task command ("fix the bug", "build X"). Carries its own goal. */
export const TASK_COMMAND_RE = /\b(fix|build|implement|add|remove|refactor|debug|investigate|verify|test|commit|push|research|plan|explain|review)\b/i;

/** The user is asking about the plan / todos / what's next. */
export const ACTIVE_PLAN_INTENT_RE = /\b(active[_ -]?plan|todo(?:s)?|task\s+list|checklist|in[_ -]?progress|current\s+plan|next\s+step|what'?s\s+next|plan)\b/i;

// A short affirmation/approval that carries NO task content of its own ("go for it", "ok do it",
// "yes", "keep going"). On its own it is meaningless, but as a follow-up to an in-progress thread it
// means "continue the task already underway" - it must NOT be treated as a finished conversational
// turn, or the task_kernel + live-turn fence brand the real task "already answered" and the agent
// restarts from scratch (greets, re-researches, re-asks). See classifyContinuation.
//
// Three shapes, all anchored to the WHOLE message: (1) an explicit proceed verb, optionally led by
// filler ("ok, go for it"); (2) a standalone bare affirmative ("yes", "ok", "sure"); (3) an
// affirmation-led message with trailing filler / vocative / light status question ("ok now",
// "ok bro", "ok now what happens", "ok so is it working"). Without (3) the user typing "ok now"
// fell through to chitchat and the kernel branded the in-progress task "already answered" — that
// was the observed "ok bro" drop. Pure acknowledgments that mean "done, good" — "thanks", "cool",
// "nice", "great", "perfect" — are deliberately NOT continuations on their own (only as filler
// before a verb), so the agent doesn't keep working when you're just thanking it.
const PROCEED_VERB_RE = /^(?:(?:ok(?:ay)?|k|yes|yep|yeah|yup|sure|please|pls|plz|cool|great|nice|perfect|right|good|alright|fine|lgtm|now|so|and|then|just)\b[\s,.!-]*)*(?:do\s*it|go\s*for\s*it|go\s*ahead|go|get\s*to\s*it|keep\s*(?:going|building|at\s*it)|carry\s*on|proceed|continue|next|finish(?:\s*(?:it|up))?|make\s*it|build\s*it|ship\s*it|run\s*it|send\s*it|begin|start|let'?s\s*go|that\s*works|works\s*for\s*me)\b[\s.!]*$/i;
const BARE_AFFIRM_RE = /^(?:(?:yes|yep|yeah|yup|ok(?:ay)?|k|sure|please|pls|plz|absolutely|definitely|agreed?|approved?)\b[\s,.!-]*)+$/i;

// (3) AFFIRMATION + TRAILING NOISE. A short message that LEADS with an affirmation ("ok", "yes",
// "alright", "k", "yea") followed only by harmless trailing material — filler ("now", "so",
// "then", "and"), a vocative ("bro", "dude", "man", "buddy"), and/or a light status/progress
// question ("what now", "what's next", "what happens", "is it working", "did it work", "any luck",
// "all good") — must classify as a continuation. Punctuation-only tails ("ok!", "ok.") are
// already handled by BARE_AFFIRM_RE; this regex covers the messages with actual trailing words.
// It deliberately stays narrow: anything that looks like a real new task command or task-switch
// ("ok now fix the picker", "ok go back to the auth task") is filtered upstream by
// classifyContinuation's TASK_COMMAND_RE / TASK_SWITCH_INTENT_RE check, so this regex doesn't have
// to also veto verbs. The lead list mirrors BARE_AFFIRM_RE's "yes-proceed" semantics — pure
// acknowledgments ("cool", "nice", "perfect", "great", "good", "right") are NOT lead words here,
// so "cool now" / "perfect" stay chitchat (the user is reacting, not telling you to keep going).
const AFFIRM_LEAD_RE = /^(?:yes|yep|yeah|yup|yea|ok(?:ay)?|k|sure|alright|absolutely|definitely)\b/i;
const VOCATIVE_RE = /^(?:bro|dude|man|buddy|bud|pal|sir|mate|fam|boss|chief|homie|brother|bossman)$/i;
const FILLER_TOKEN_RE = /^(?:now|so|then|and|just|please|pls|plz|but|well|though|anyway|actually|really|maybe|kinda|sorta)$/i;
const STATUS_QUESTION_RE = /^(?:what(?:'?s)?\s*(?:now|next|happens?|happened|the\s*deal|going\s*on|up|the\s*status|the\s*story|left)|how(?:'?s)?\s*(?:it\s*(?:going|look(?:ing|s)?|comin(?:g)?)?|that\s*go(?:ing)?|things\s*go(?:ing)?|we\s*lookin(?:g)?)|is\s*(?:it|that|this)\s*(?:work(?:ing)?|done|finish(?:ed)?|good|fine|ok(?:ay)?|right|lookin(?:g)?\s*(?:good|right))|did\s*(?:it|that)\s*(?:work|finish|happen|run)|any\s*(?:luck|progress|update|news|good|change|diff(?:erence)?)|all\s*(?:good|set|done|fine)|see\s*(?:it|that|anything)|find\s*anything|anything\s*new|same\s*(?:thing|deal|issue)|whats?\s*different|are\s*(?:we|you)\s*(?:there|done|good|close)|we\s*(?:there|done|good|close))[\s?.!]*$/i;
const PUNCT_OR_TINY_RE = /^[\s,.!?\-—–]*$/;

/** True if the trimmed token is a vocative, filler, or empty. */
function isHarmlessTrailingWord(tok: string): boolean {
	const t = tok.replace(/[\s,.!?\-—–]+$/g, '').replace(/^[\s,.!?\-—–]+/g, '');
	if (!t) { return true; }
	return VOCATIVE_RE.test(t) || FILLER_TOKEN_RE.test(t);
}

/** True if the whole tail is a light status/progress question or harmless filler — not a new task. */
function isHarmlessTrailingTail(tail: string): boolean {
	let t = tail.trim().replace(/^[,\-—–]+/, '').trim();
	if (!t || PUNCT_OR_TINY_RE.test(t)) { return true; }
	// Strip leading harmless filler/vocative tokens ("now", "so", "bro", ...) so a
	// "filler + status-question" pattern (e.g. "ok now what happens" → "what happens") still
	// resolves. Bound the strip to a few tokens so a real sentence can't be fully eaten.
	for (let i = 0; i < 4; i++) {
		const m = /^([A-Za-z][A-Za-z'-]*)\b[\s,.!?\-—–]*/.exec(t);
		if (!m) { break; }
		const word = m[1];
		if (VOCATIVE_RE.test(word) || FILLER_TOKEN_RE.test(word)) {
			t = t.slice(m[0].length).trim();
		} else { break; }
	}
	if (!t || PUNCT_OR_TINY_RE.test(t)) { return true; }
	if (STATUS_QUESTION_RE.test(t)) { return true; }
	// Allow short tails of pure harmless tokens ("bro", "now bro", "so what now").
	const tokens = t.split(/[\s,.!?\-—–]+/).filter(Boolean);
	if (tokens.length === 0) { return true; }
	if (tokens.length <= 4 && tokens.every(isHarmlessTrailingWord)) { return true; }
	return false;
}

/** True if the message is an affirmation-led continuation with only harmless trailing words/question. */
function isAffirmationLedContinuation(message: string): boolean {
	const msg = message.trim();
	if (!msg) { return false; }
	const lead = AFFIRM_LEAD_RE.exec(msg);
	if (!lead) { return false; }
	const tail = msg.slice(lead[0].length);
	return isHarmlessTrailingTail(tail);
}

/** True if the message is purely an affirmation/approval to proceed (no task content of its own). */
export function isContinuationPhrase(message: string): boolean {
	const msg = message.trim();
	if (PROCEED_VERB_RE.test(msg) || BARE_AFFIRM_RE.test(msg)) { return true; }
	return isAffirmationLedContinuation(msg);
}

/** What the live user message means this turn (contract section 5). */
export type TurnKind = 'new_task' | 'continuation' | 'switch' | 'chitchat';

/**
 * True when the live message is an affirmative continuation of work already underway in this
 * thread (a short approval, AND the agent has already produced at least one turn). Such a turn
 * resumes the in-progress task rather than starting or ending one. Excludes messages that carry
 * their own task command (a self-contained new task) or an explicit switch/resume request.
 */
export function classifyContinuation(liveUserMessage: string, hasPriorAssistantTurn: boolean): boolean {
	if (!hasPriorAssistantTurn) { return false; }
	const msg = liveUserMessage.trim();
	if (!msg || msg.length > 60) { return false; }
	if (TASK_COMMAND_RE.test(msg) || TASK_SWITCH_INTENT_RE.test(msg)) { return false; }
	return isContinuationPhrase(msg);
}

/**
 * Single classification of the live turn. Precedence: an explicit switch/resume wins; then an
 * affirmative continuation of the in-progress thread; then a self-contained task command; else
 * chitchat/meta. This is the contract section 5 table as one function so the wire (and tests) agree.
 */
export function classifyTurn(liveUserMessage: string, hasPriorAssistantTurn: boolean): TurnKind {
	const msg = liveUserMessage.trim();
	if (!msg) { return 'chitchat'; }
	if (TASK_SWITCH_INTENT_RE.test(msg)) { return 'switch'; }
	if (classifyContinuation(msg, hasPriorAssistantTurn)) { return 'continuation'; }
	if (TASK_COMMAND_RE.test(msg)) { return 'new_task'; }
	return 'chitchat';
}
