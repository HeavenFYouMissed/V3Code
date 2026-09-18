/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — finding reporter (human summary, JSON, and SARIF 2.1.0).
 *
 * Turns raw {@link TaintFinding}s into the three shapes callers need:
 *   • human  — a plain-English report (what/why/where/how-to-fix) for the user and the agent.
 *   • json   — a stable machine shape for the persistent journal + the security tool's payload.
 *   • sarif  — SARIF 2.1.0, the industry-standard static-analysis format, so results drop into
 *              GitHub code scanning, weAudit, and any SARIF viewer with zero glue.
 *
 * A finding also gets a STABLE FINGERPRINT (pack + file + a normalized location + sink name).
 * The journal keys on this so "the same bug" is recognized across scans even as line numbers
 * shift — that's what powers new/fixed/still-open diffing across sessions.
 *
 * PURE: string/JSON building only. No editor imports, no fs. The caller owns persistence.
 */

import { Severity } from './taintSpec.js';
import { TaintFinding, TraceStep } from './taintEngine.js';

/** Severity → sort weight (higher = worse) so reports lead with the scariest findings. */
const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** Severity → the plain-English label shown to non-expert users. */
const SEVERITY_LABEL: Record<Severity, string> = {
	critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info',
};

/**
 * A journal-ready, serializable finding. Everything the persistent journal and the tool payload
 * need, with a stable `fingerprint` for cross-scan identity.
 */
export interface ReportedFinding {
	readonly fingerprint: string;
	readonly packId: string;
	readonly title: string;
	readonly severity: Severity;
	readonly cwe?: string;
	readonly owasp?: string;
	readonly description: string;
	readonly remediation: string;
	readonly file: string;
	readonly line: number;
	readonly col: number;
	readonly sinkName: string;
	readonly sourceName: string;
	readonly snippet: string;
	readonly labels: readonly string[];
	/** Compact source→sink trace (file:line + snippet per step) for the "why" explanation. */
	readonly trace: readonly { file: string; line: number; name: string; snippet: string }[];
}

/**
 * Stable identity for a finding across scans. Uses pack + file + sink name + the SOURCE name
 * rather than the raw line, so an unrelated edit above the bug doesn't make it look "new". Line
 * is included only coarsely (the sink's name + file is usually enough to be unique per file).
 */
export function fingerprintOf(f: TaintFinding): string {
	return [f.packId, f.sink.file, f.sink.name, f.source.name].join('\u0000');
}

function toReported(f: TaintFinding): ReportedFinding {
	return {
		fingerprint: fingerprintOf(f),
		packId: f.packId,
		title: f.title,
		severity: f.severity,
		cwe: f.cwe,
		owasp: f.owasp,
		description: f.description,
		remediation: f.remediation,
		file: f.sink.file,
		line: f.sink.line,
		col: f.sink.col,
		sinkName: f.sink.name,
		sourceName: f.source.name,
		snippet: f.sink.snippet,
		labels: f.labels.filter(l => l !== '*'),
		trace: f.trace.map((t: TraceStep) => ({ file: t.file, line: t.line, name: t.name, snippet: t.snippet })),
	};
}

/** Convert raw findings to journal/tool-ready form, sorted worst-first then by file:line. */
export function toReportedFindings(findings: readonly TaintFinding[]): ReportedFinding[] {
	return findings.map(toReported).sort((a, b) => {
		const w = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
		if (w !== 0) { return w; }
		if (a.file !== b.file) { return a.file < b.file ? -1 : 1; }
		return a.line - b.line;
	});
}

/** Count findings per severity (for the summary header + the journal's trend line). */
export function severityCounts(findings: readonly ReportedFinding[]): Record<Severity, number> {
	const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	for (const f of findings) { counts[f.severity]++; }
	return counts;
}

/**
 * Render a plain-English report a non-expert can act on. Leads with a one-line risk summary,
 * then each finding as: severity + title, where it is (file:line), why it's dangerous, the flow
 * trace, and the concrete fix. This is what the agent shows the user and reasons over.
 */
export function renderHuman(findings: readonly ReportedFinding[]): string {
	if (findings.length === 0) {
		return 'Sentinel scan complete — no vulnerabilities found in the analyzed files. \u2705';
	}
	const counts = severityCounts(findings);
	const head = `Sentinel found ${findings.length} potential issue${findings.length === 1 ? '' : 's'}: ` +
		(['critical', 'high', 'medium', 'low', 'info'] as Severity[])
			.filter(s => counts[s] > 0).map(s => `${counts[s]} ${SEVERITY_LABEL[s].toLowerCase()}`).join(', ') + '.';
	const lines: string[] = [head, ''];
	let i = 1;
	for (const f of findings) {
		lines.push(`${i}. [${SEVERITY_LABEL[f.severity]}] ${f.title}${f.cwe ? ` (${f.cwe})` : ''}`);
		lines.push(`   Where: ${f.file}:${f.line}   ${f.snippet}`);
		lines.push(`   Why:   ${f.description}`);
		if (f.sourceName && f.sourceName !== f.sinkName) {
			lines.push(`   Flow:  user input \`${f.sourceName}\` → \`${f.sinkName}\`` + (f.labels.length ? `  [${f.labels.join(', ')}]` : ''));
		}
		lines.push(`   Fix:   ${f.remediation}`);
		lines.push('');
		i++;
	}
	return lines.join('\n');
}

/** SARIF 2.1.0 severity mapping (SARIF uses error/warning/note). */
function sarifLevel(sev: Severity): 'error' | 'warning' | 'note' {
	if (sev === 'critical' || sev === 'high') { return 'error'; }
	if (sev === 'medium') { return 'warning'; }
	return 'note';
}

/**
 * Emit SARIF 2.1.0 for the run. One rule per pack; one result per finding, with the sink region
 * and a codeFlow built from the trace so a SARIF viewer shows the full source→sink path.
 */
export function renderSarif(findings: readonly ReportedFinding[], toolVersion = '1.0.0'): string {
	const packIds = [...new Set(findings.map(f => f.packId))];
	const rules = packIds.map(id => {
		const f = findings.find(x => x.packId === id)!;
		return {
			id,
			name: f.title.replace(/\s+/g, ''),
			shortDescription: { text: f.title },
			fullDescription: { text: f.description },
			helpUri: f.cwe ? `https://cwe.mitre.org/data/definitions/${f.cwe.replace('CWE-', '')}.html` : undefined,
			properties: { 'security-severity': securityScore(f.severity), cwe: f.cwe, owasp: f.owasp },
		};
	});
	const results = findings.map(f => ({
		ruleId: f.packId,
		level: sarifLevel(f.severity),
		message: { text: `${f.description} Fix: ${f.remediation}` },
		partialFingerprints: { sentinelFingerprint: hashString(f.fingerprint) },
		locations: [physLoc(f.file, f.line, f.col, f.snippet)],
		codeFlows: f.trace.length > 1 ? [{
			threadFlows: [{ locations: f.trace.map(t => ({ location: physLoc(t.file, t.line, 1, t.snippet) })) }],
		}] : undefined,
	}));
	const sarif = {
		version: '2.1.0',
		$schema: 'https://json.schemastore.org/sarif-2.1.0.json',
		runs: [{
			tool: { driver: { name: 'Sentinel', informationUri: 'https://v3code.dev', version: toolVersion, rules } },
			results,
		}],
	};
	return JSON.stringify(sarif, null, 2);
}

function physLoc(file: string, line: number, col: number, snippet: string) {
	return {
		physicalLocation: {
			artifactLocation: { uri: file },
			region: { startLine: Math.max(1, line), startColumn: Math.max(1, col), snippet: { text: snippet } },
		},
	};
}

/** GitHub code-scanning reads a 0-10 security score from this property. */
function securityScore(sev: Severity): string {
	switch (sev) {
		case 'critical': return '9.5';
		case 'high': return '8.0';
		case 'medium': return '5.0';
		case 'low': return '3.0';
		default: return '1.0';
	}
}

/** Tiny stable string hash (djb2) — for SARIF partial fingerprints; not security-sensitive. */
function hashString(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
	return (h >>> 0).toString(16);
}
