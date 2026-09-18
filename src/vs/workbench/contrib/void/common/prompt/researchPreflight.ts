/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * `research` only counts when it is an INSTRUCTION, so it must be followed by an object
 * (determiner / quantifier / wh-word). A bare \b research \b matched the NOUN too, which gated
 * ordinary code work behind a web search: "I do anti-cheat research, fix this bug", "the research
 * team wants this faster", "my research paper build is broken". Those users never asked for the web
 * and got every mutating tool refused until they searched.
 *
 * `latest status` was dropped for the same reason — "check the latest status of the build" is a
 * local question. `latest version/release/docs` stay, since those are genuinely dated claims.
 */
const EXPLICIT_CURRENT_RESEARCH_RE = /\b(?:research\s+(?:the|a|an|this|that|it|current|latest|best|existing|everything|all|how|what|which|who|whether|why|where|when|options?|alternatives?|libraries|libs)\b|web[ -]?search|search (?:the )?web|browse (?:the )?web|look (?:this|that|it) up|as of (?:today|now)|latest (?:version|release|docs?|documentation)\b)/i;

/**
 * Identifies a direct request for current external evidence. This deliberately
 * excludes generic words such as "check" or "investigate" so normal code work
 * is not forced through the web preflight.
 */
export function explicitlyRequestsCurrentResearch(userText: string): boolean {
	return EXPLICIT_CURRENT_RESEARCH_RE.test(userText);
}
