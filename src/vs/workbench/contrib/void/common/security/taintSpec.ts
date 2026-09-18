/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — taint specification schema (the data language vuln packs are written in).
 *
 * This is the schema modeled on Semgrep's real taint engine (sources → propagators →
 * sanitizers → sinks, plus taint LABELS for multi-step vulns). A "spec" is pure DATA — no
 * code — so the rule library grows across sessions without touching the engine. That is the
 * memory-test spine: each session we add specs to packs/, and the engine just runs them.
 *
 * THE FOUR ROLES (why each exists):
 *   • source     — where attacker-controlled data ENTERS (req.body, req.query, process.argv,
 *                  location.hash, a message event). Taint originates here.
 *   • propagator — a call that PASSES taint through (JSON.parse(x), x.trim(), Object.assign(a,x)).
 *                  Without these, taint dies at the first function call and recall collapses.
 *   • sanitizer  — a call that NEUTRALIZES taint (escapeHtml(x), parameterized query, Number(x)).
 *                  Flow through a sanitizer is SAFE — this is what kills false positives.
 *   • sink       — where tainted data does DAMAGE (eval, res.send, db.query, child_process.exec,
 *                  fs.readFile, innerHTML=, res.redirect). A finding = source→…→sink with no
 *                  sanitizer on the path.
 *
 * TAINT LABELS (the master move): a plain source→sink model can't express "becomes dangerous in
 * several steps." Labels let a source emit a specific label (e.g. 'USER_INPUT'), a propagator
 * REQUIRE one label and ADD another (e.g. require 'USER_INPUT', add 'SQL_FRAGMENT'), and a sink
 * REQUIRE a specific label to fire. That models real multi-step bugs precisely and cuts noise.
 *
 * MATCHERS are intentionally small and declarative so a spec is readable and safe to author:
 * match a normalized CpgKind plus a name pattern (dotted callee like 'child_process.exec', a
 * member path like 'req.body', or a regex). No arbitrary code in a spec — ever.
 */

import { CpgKind } from './normalize.js';

/** A taint label — an arbitrary tag threaded through the flow (e.g. 'USER_INPUT', 'HTML', 'SQL'). */
export type TaintLabel = string;

/** The special label meaning "generic taint" — used when a spec doesn't care about label kinds. */
export const ANY_LABEL: TaintLabel = '*';

/**
 * How attacker-controllable a source is — the property the FP corpus run proved we were missing.
 *
 *   • 'remote'  — network attacker-controlled: req.body, req.query, location.hash, a message event.
 *                 The real "untrusted input" a web attacker sends. HIGHEST concern.
 *   • 'ambient' — local environment: process.env, process.argv. Attacker-controlled ONLY if the
 *                 attacker already controls the host/CLI (a much higher bar). On a normal codebase
 *                 (e.g. an editor reading process.env constantly) these flow into spawn/readFile/
 *                 Object.assign legitimately thousands of times — every one a false positive if
 *                 treated like remote input. This was the ROOT of all remaining non-fixture FP.
 *
 * Trust is FIXED at the source and never changes along the flow, so the engine just tags each
 * flow with its source trust and checks it at the sink. A sink declares the minimum trust it
 * fires on (default 'remote'), so ambient env access is silent unless a pack opts in (e.g. a CLI
 * command-injection pack that legitimately cares about process.argv).
 */
export type TrustTier = 'remote' | 'ambient';

/** Rank a trust tier so `sourceTrust >= sink.minTrust` is a numeric compare. remote(2) > ambient(1). */
export function trustRank(t: TrustTier): number {
	return t === 'remote' ? 2 : 1;
}

/**
 * How a spec entry recognizes a CPG node. All present fields must match (AND). Kept declarative:
 * no functions, so specs are pure JSON-able data that can be authored, stored, and grown safely.
 */
export interface NodeMatcher {
	/** Match the node's normalized kind (e.g. 'call', 'member', 'identifier', 'assign'). */
	readonly kind?: CpgKind;
	/**
	 * Match the node's name EXACTLY. For calls this is the dotted callee ('child_process.exec',
	 * 'res.send'); for members the property path text; for identifiers the identifier text.
	 */
	readonly name?: string;
	/** Match the node's name against a case-insensitive regex source string (e.g. '^exec').  */
	readonly namePattern?: string;
	/**
	 * Match a dotted member/callee SUFFIX — 'body' matches 'req.body' and 'foo.req.body'. Handy
	 * for framework-agnostic sources where the receiver name varies (req vs request vs ctx.req).
	 */
	readonly nameEndsWith?: string;
	/** Match against the node's raw source text via regex (last resort — e.g. secret patterns). */
	readonly textPattern?: string;
	/** For a call: which argument indices carry the tainted data into the sink (default: all). */
	readonly taintedArgs?: readonly number[];
	/**
	 * Match only nodes that are (or are not) an assignment TARGET — e.g. the `obj[key]` in
	 * `obj[key] = v`. The lifter marks such nodes (props.writeTarget = true). This is what lets the
	 * proto-pollution pack detect a tainted COMPUTED-KEY write (obj[userKey] = v) precisely, instead
	 * of flagging every read `a[b]`. A NodeMatcher sees one node, so the lifter must pre-mark it.
	 */
	readonly isWriteTarget?: boolean;
}

/** A source: nodes matching `match` INTRODUCE taint carrying every label in `labels`. */
export interface SourceSpec {
	readonly match: NodeMatcher;
	/** Labels this source emits. Empty/omitted means [ANY_LABEL]. */
	readonly labels?: readonly TaintLabel[];
	/** How attacker-controllable this source is (default 'remote'). See {@link TrustTier}. */
	readonly trust?: TrustTier;
}

/**
 * A propagator: taint flowing into a matching call comes OUT still tainted. Optionally transform
 * labels — require `requires` on the way in, and emit `adds` on the way out (multi-step vulns).
 */
export interface PropagatorSpec {
	readonly match: NodeMatcher;
	/** If set, only propagate when the incoming taint carries one of these labels. */
	readonly requires?: readonly TaintLabel[];
	/** Labels to ADD to the outgoing taint (defaults to passing incoming labels through). */
	readonly adds?: readonly TaintLabel[];
}

/** A sanitizer: taint flowing through a matching node is CLEARED (optionally only for `labels`). */
export interface SanitizerSpec {
	readonly match: NodeMatcher;
	/** If set, only clears these labels (leaves others tainted). Omitted means clears everything. */
	readonly labels?: readonly TaintLabel[];
}

/** A sink: tainted data reaching a matching node is a FINDING (optionally only for `requires`). */
export interface SinkSpec {
	readonly match: NodeMatcher;
	/** If set, only fires when the arriving taint carries one of these labels. */
	readonly requires?: readonly TaintLabel[];
	/**
	 * Minimum source trust this sink fires on (default 'remote'). A sink left at the default stays
	 * SILENT for ambient (process.env/argv) taint — that's what kills the env-into-spawn FP flood.
	 * A pack that legitimately cares about local input (a CLI arg-injection rule) sets 'ambient'.
	 */
	readonly minTrust?: TrustTier;
}

/** Severity aligned to CVSS bands + a plain-English tier the reporter shows non-experts. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * A vuln pack: a named, versioned bundle of specs for ONE vulnerability class (e.g. "injection").
 * Packs are the unit the rule library grows in and the persistent journal tracks by id+version.
 */
export interface VulnPack {
	/** Stable id, e.g. 'sql-injection', 'proto-pollution'. */
	readonly id: string;
	/** Human title shown in reports. */
	readonly title: string;
	/** Bumped when specs change — the journal uses this to note "rules improved since last scan". */
	readonly version: number;
	readonly severity: Severity;
	/** CWE id for cross-referencing (e.g. 'CWE-89' for SQLi). */
	readonly cwe?: string;
	/** OWASP Top 10 category (e.g. 'A03:2021-Injection'). */
	readonly owasp?: string;
	/** One-sentence plain-English description of the risk (shown to non-expert users). */
	readonly description: string;
	/** Concrete remediation guidance printed with each finding. */
	readonly remediation: string;
	readonly sources: readonly SourceSpec[];
	readonly propagators?: readonly PropagatorSpec[];
	readonly sanitizers?: readonly SanitizerSpec[];
	readonly sinks: readonly SinkSpec[];
	/**
	 * Some packs (secrets, weak crypto, wildcard CORS) aren't data-FLOW bugs — they're a single
	 * dangerous node. When true, the engine reports any matching sink node directly WITHOUT
	 * requiring a source→sink flow. Keeps the schema unified across pattern & taint rules.
	 */
	readonly sinkOnly?: boolean;
}
