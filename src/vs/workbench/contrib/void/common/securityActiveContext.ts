/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Cyber Protection (Security) mode injection — mirrors designActiveContext.ts.
 *
 * When the user toggles the Cyber Protection button in the model picker, `SECURITY_MODE_INJECT`
 * is added to every turn's system context (see convertToLLMMessageService.ts). It tells the agent
 * to lead with the deterministic Sentinel scanner (the `security_scan` tool — CPG + taint) and
 * then bring its own reasoning to the business-logic bugs the scanner can't pattern-match. That
 * is the hybrid the whole design is built around: fast, reliable, remembered scan first; agent
 * deep-dive second.
 */

export const SECURITY_ACTIVE_INJECT_CAP = 8_000;

/** Injected on every turn while Cyber Protection mode is on (model picker toggle). */
export const SECURITY_MODE_INJECT = `\n\n<security_mode>\nCyber Protection mode is ON. The user wants you to defend this project — hunt the overlooked, exploitable bugs (the "can someone charge/read/act as another user" class), not just lint.\n- FIRST run the deterministic scanner: call the \`security_scan\` tool. It builds a Code Property Graph + taint analysis over the workspace and returns concrete findings (SQL/command injection, XSS, SSRF, path traversal, prototype pollution, insecure deserialization, ReDoS, hardcoded secrets, weak crypto) with file:line, a plain-English why, and a fix — plus a "since last scan" memory diff (new / fixed / still-open).\n- THEN reason about what a pattern scanner CANNOT catch: broken authorization / IDOR (does this endpoint check the object belongs to the caller?), auth bypass, missing rate limits, logic flaws in payment/ownership. Use the scan's findings as a map of where data flows.\n- Report worst-first (critical → low). For each real issue give: where, why it's dangerous in plain words, and the concrete fix. Defense only — explain and patch, never write exploits.\n- The scanner remembers across sessions. If the user asks "what changed" or "is it getting safer", the journal diff answers it.\n- Do NOT weaken or delete a security check to make a scan pass — fix the actual flow.\n</security_mode>`;
