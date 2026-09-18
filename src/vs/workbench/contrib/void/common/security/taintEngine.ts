/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — taint engine: runs vuln packs over a CPG and reports source→sink flows.
 *
 * This is Phase 2's core detection loop. Given a {@link CpgGraph} and a {@link VulnPack}, it:
 *   1. Finds SOURCE nodes (matcher hit) and seeds each with the pack's taint labels.
 *   2. Propagates taint FORWARD along DDG edges (that's why Phase 1's DDG is the spine), passing
 *      through PROPAGATOR calls (optionally transforming labels), and STOPPING at SANITIZERs.
 *   3. When tainted data reaches a SINK node (with a required label, if the sink demands one),
 *      it records a {@link TaintFinding} carrying the full node path for a readable trace.
 *
 * Also handles `sinkOnly` packs (secrets / weak crypto / wildcard CORS): those don't need a
 * flow — any node matching a sink matcher is reported directly. One engine, both rule styles.
 *
 * PRECISION HONESTY (v1): forward reachability over DDG is flow-INsensitive within a function
 * and intraprocedural. It favors recall (find the bug) and relies on sanitizers + labels to trim
 * false positives. Phase 6 swaps the reachability core for path-sensitive, interprocedural
 * propagation WITHOUT changing this file's inputs/outputs — packs and reporting are unaffected.
 *
 * PURE: depends only on the CPG model + spec schema. No editor imports. Headless-testable.
 */

import { CpgGraph, CpgNode } from './cpgTypes.js';
import { ANY_LABEL, NodeMatcher, PropagatorSpec, SanitizerSpec, SinkSpec, SourceSpec, TaintLabel, TrustTier, VulnPack, trustRank } from './taintSpec.js';

/** One step in a taint trace — a node on the path from source to sink (for readable reports). */
export interface TraceStep {
	readonly nodeId: string;
	readonly file: string;
	readonly line: number;
	readonly col: number;
	readonly kind: string;
	readonly name: string;
	readonly snippet: string;
}

/** A confirmed vulnerability: tainted data flowed from `source` to `sink` with no sanitizer. */
export interface TaintFinding {
	readonly packId: string;
	readonly title: string;
	readonly severity: VulnPack['severity'];
	readonly cwe?: string;
	readonly owasp?: string;
	readonly description: string;
	readonly remediation: string;
	/** The sink node — where the report points the user (file:line). */
	readonly sink: TraceStep;
	/** The source node — where the tainted data entered. */
	readonly source: TraceStep;
	/** Full node path source→…→sink (deduped, in flow order) for the "why" trace. */
	readonly trace: readonly TraceStep[];
	/** Labels present at the sink (for multi-step / labeled findings). */
	readonly labels: readonly TaintLabel[];
}

/** Compile a NodeMatcher's regex fields once (perf + validates the pattern up front). */
interface CompiledMatcher {
	readonly m: NodeMatcher;
	readonly nameRe?: RegExp;
	readonly textRe?: RegExp;
}

function compileMatcher(m: NodeMatcher): CompiledMatcher {
	return {
		m,
		nameRe: m.namePattern ? new RegExp(m.namePattern, 'i') : undefined,
		textRe: m.textPattern ? new RegExp(m.textPattern, 'i') : undefined,
	};
}

/** Does a CPG node satisfy a compiled matcher? All present constraints must hold (AND). */
function matches(node: CpgNode, cm: CompiledMatcher): boolean {
	const m = cm.m;
	if (m.kind !== undefined && node.kind !== m.kind) { return false; }
	if (m.name !== undefined && node.name !== m.name) { return false; }
	if (cm.nameRe && !cm.nameRe.test(node.name)) { return false; }
	if (m.nameEndsWith !== undefined) {
		const n = node.name;
		const suf = m.nameEndsWith;
		if (n !== suf && !n.endsWith('.' + suf)) { return false; }
	}
	if (cm.textRe && !cm.textRe.test(node.text)) { return false; }
	if (m.isWriteTarget !== undefined && (node.props.writeTarget === true) !== m.isWriteTarget) { return false; }
	return true;
}

function toStep(node: CpgNode): TraceStep {
	return {
		nodeId: node.id,
		file: node.file,
		line: node.line,
		col: node.col,
		kind: node.kind,
		name: node.name,
		snippet: node.text.split('\n')[0].slice(0, 160),
	};
}

/** Labels a source emits (defaulting to the generic ANY_LABEL when unspecified). */
function sourceLabels(s: SourceSpec): readonly TaintLabel[] {
	return s.labels && s.labels.length ? s.labels : [ANY_LABEL];
}

/** The trust tier a source carries (default 'remote' — the standard untrusted-input assumption). */
function sourceTrust(s: SourceSpec): TrustTier {
	return s.trust ?? 'remote';
}

/** True if a flow originating at `srcTrust` is allowed to fire a sink demanding `minTrust`. */
function trustSatisfies(srcTrust: TrustTier, minTrust?: TrustTier): boolean {
	return trustRank(srcTrust) >= trustRank(minTrust ?? 'remote');
}

/** True if the incoming label set satisfies a `requires` constraint (ANY_LABEL is a wildcard). */
function labelsSatisfy(have: ReadonlySet<TaintLabel>, requires?: readonly TaintLabel[]): boolean {
	if (!requires || requires.length === 0) { return true; }
	if (have.has(ANY_LABEL)) { return true; }
	for (const r of requires) { if (r === ANY_LABEL || have.has(r)) { return true; } }
	return false;
}

/**
 * Run one vuln pack over one CPG, returning every finding. Sink-only packs short-circuit to a
 * direct node match; flow packs run labeled forward taint propagation over the DDG.
 */
export function runPack(cpg: CpgGraph, pack: VulnPack): TaintFinding[] {
	const findings: TaintFinding[] = [];
	const sinks = pack.sinks.map(s => ({ spec: s, cm: compileMatcher(s.match) }));

	// --- sink-only packs: report any matching node directly (secrets, weak crypto, CORS *) ---
	if (pack.sinkOnly) {
		for (const id of cpg.nodes.keys()) {
			const node = cpg.node(id)!;
			for (const { cm } of sinks) {
				if (matches(node, cm)) {
					const step = toStep(node);
					findings.push(mkFinding(pack, step, step, [step], [ANY_LABEL]));
					break;
				}
			}
		}
		return findings;
	}

	const sources = pack.sources.map(s => ({ spec: s, cm: compileMatcher(s.match) }));
	const propagators = (pack.propagators ?? []).map(p => ({ spec: p, cm: compileMatcher(p.match) }));
	const sanitizers = (pack.sanitizers ?? []).map(s => ({ spec: s, cm: compileMatcher(s.match) }));

	// Pre-classify every node once so the per-source BFS is cheap.
	const sinkOf = new Map<string, SinkSpec>();
	const propOf = new Map<string, PropagatorSpec>();
	const sanitizerOf = new Map<string, SanitizerSpec>();
	for (const id of cpg.nodes.keys()) {
		const node = cpg.node(id)!;
		for (const { spec, cm } of sinks) { if (matches(node, cm)) { sinkOf.set(id, spec); break; } }
		for (const { spec, cm } of propagators) { if (matches(node, cm)) { propOf.set(id, spec); break; } }
		for (const { spec, cm } of sanitizers) { if (matches(node, cm)) { sanitizerOf.set(id, spec); break; } }
	}

	// For each source, run a labeled forward walk along DDG edges. Each walk carries the SOURCE's
	// trust tier (fixed at origin — trust never changes along the flow) so the sink can require a
	// minimum trust and stay silent for ambient (process.env/argv) taint by default.
	for (const id of cpg.nodes.keys()) {
		const node = cpg.node(id)!;
		let srcSpec: SourceSpec | undefined;
		for (const { spec, cm } of sources) { if (matches(node, cm)) { srcSpec = spec; break; } }
		if (!srcSpec) { continue; }
		propagateFrom(cpg, id, new Set(sourceLabels(srcSpec)), sourceTrust(srcSpec), sinkOf, propOf, sanitizerOf, pack, findings);
	}

	// Dedup: many DDG paths can reach the same sink from the same source. Report each distinct
	// (source, sink) pair ONCE, keeping the SHORTEST trace (clearest to read). Without this a
	// diamond-shaped flow produces N identical findings.
	return dedupeFindings(findings);
}

/**
 * Collapse duplicate findings. Two layers:
 *   1. Exact (source, sink) pairs → keep the shortest trace.
 *   2. Prefix-source suppression: the DDG carries taint through both a full member path
 *      (`req.query.id`) AND its prefix (`req.query`), so the SAME sink gets reported once per
 *      nesting level. When two findings hit the same sink and one source NAME is a dotted prefix
 *      of the other, keep only the MOST SPECIFIC source — that's the real, single bug.
 */
function dedupeFindings(findings: readonly TaintFinding[]): TaintFinding[] {
	// Layer 1: exact (source, sink).
	const best = new Map<string, TaintFinding>();
	for (const f of findings) {
		const k = `${f.source.nodeId}\u0000${f.sink.nodeId}`;
		const prev = best.get(k);
		if (!prev || f.trace.length < prev.trace.length) { best.set(k, f); }
	}
	// Layer 2: per sink, drop a finding whose source name is a strict dotted prefix of another
	// finding's source name at the same sink.
	const bySink = new Map<string, TaintFinding[]>();
	for (const f of best.values()) {
		const arr = bySink.get(f.sink.nodeId) ?? [];
		arr.push(f);
		bySink.set(f.sink.nodeId, arr);
	}
	const dropped = new Set<TaintFinding>();
	for (const group of bySink.values()) {
		for (const a of group) {
			for (const b of group) {
				if (a === b) { continue; }
				// a.source is a strict prefix of b.source (e.g. 'req.query' within 'req.query.id') -> drop a.
				if (b.source.name !== a.source.name && b.source.name.startsWith(a.source.name + '.')) {
					dropped.add(a);
				}
			}
		}
	}
	return [...best.values()].filter(f => !dropped.has(f));
}

/**
 * BFS forward over DDG from a source node, carrying a label set. Sanitizers stop the walk;
 * propagators can require/add labels; reaching a sink whose `requires` is satisfied is a finding.
 * `path` is threaded so findings carry a real source→sink trace.
 */
function propagateFrom(
	cpg: CpgGraph,
	sourceId: string,
	seedLabels: ReadonlySet<TaintLabel>,
	srcTrust: TrustTier,
	sinkOf: ReadonlyMap<string, SinkSpec>,
	propOf: ReadonlyMap<string, PropagatorSpec>,
	sanitizerOf: ReadonlyMap<string, SanitizerSpec>,
	pack: VulnPack,
	out: TaintFinding[],
): void {
	const sourceNode = cpg.node(sourceId)!;
	// Visited keyed by (node + serialized labels) so a node can be re-reached with new labels
	// (multi-step vulns) but we still terminate. Path stored for trace reconstruction.
	interface Frame { readonly id: string; readonly labels: ReadonlySet<TaintLabel>; readonly path: readonly string[]; }
	const start: Frame = { id: sourceId, labels: seedLabels, path: [sourceId] };
	const seen = new Set<string>();
	const key = (id: string, labels: ReadonlySet<TaintLabel>) => id + '\u0000' + [...labels].sort().join(',');
	const queue: Frame[] = [start];
	seen.add(key(sourceId, seedLabels));

	while (queue.length) {
		const cur = queue.shift()!;

		// Sanitizer on the path: taint dies here (for the labels it clears).
		const san = sanitizerOf.get(cur.id);
		let labels = cur.labels;
		if (san) {
			if (!san.labels || san.labels.length === 0) { continue; } // clears everything → stop
			const cleared = new Set(labels);
			for (const l of san.labels) { cleared.delete(l); }
			if (cleared.size === 0) { continue; }
			labels = cleared;
		}

		// Sink reached with satisfying labels → record a finding (but keep walking; a later sink
		// can also be tainted by the same source).
		const sink = sinkOf.get(cur.id);
		if (sink && cur.id !== sourceId && labelsSatisfy(labels, sink.requires) && trustSatisfies(srcTrust, sink.minTrust)) {
			const trace = cur.path.map(pid => toStep(cpg.node(pid)!));
			out.push(mkFinding(pack, toStep(cpg.node(cur.id)!), toStep(sourceNode), trace, [...labels]));
		}

		// Propagator: optionally require an incoming label and add new ones (multi-step).
		const prop = propOf.get(cur.id);
		let outLabels = labels;
		if (prop) {
			if (!labelsSatisfy(labels, prop.requires)) {
				// This propagator needs a label we don't carry — don't extend through it.
				continue;
			}
			if (prop.adds && prop.adds.length) {
				outLabels = new Set([...labels, ...prop.adds]);
			}
		}

		for (const nxt of cpg.succ(cur.id, 'DDG')) {
			const k = key(nxt, outLabels);
			if (seen.has(k)) { continue; }
			seen.add(k);
			queue.push({ id: nxt, labels: outLabels, path: [...cur.path, nxt] });
		}
	}
}

function mkFinding(pack: VulnPack, sink: TraceStep, source: TraceStep, trace: readonly TraceStep[], labels: readonly TaintLabel[]): TaintFinding {
	return {
		packId: pack.id,
		title: pack.title,
		severity: pack.severity,
		cwe: pack.cwe,
		owasp: pack.owasp,
		description: pack.description,
		remediation: pack.remediation,
		sink,
		source,
		trace,
		labels,
	};
}

/** Run several packs over one CPG and concatenate findings (stable pack order). */
export function runPacks(cpg: CpgGraph, packs: readonly VulnPack[]): TaintFinding[] {
	const all: TaintFinding[] = [];
	for (const pack of packs) { all.push(...runPack(cpg, pack)); }
	return all;
}
