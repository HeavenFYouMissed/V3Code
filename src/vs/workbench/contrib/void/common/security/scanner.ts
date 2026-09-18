/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — scan orchestrator (the one entry point the editor tool calls).
 *
 * Ties the whole engine together for a workspace scan, but stays PURE by taking its editor
 * couplings as injected callbacks (a {@link ScanHost}) instead of importing VS Code services:
 *   • listFiles  — enumerate candidate source files (host applies .gitignore / security-ignore).
 *   • readFile   — read a file's text.
 *   • parse      — turn (source, languageId) into a normalized {@link AstNode} root, or null.
 *                  In production this wraps tree-sitter (treeSitterAdapter.wrapTsNode); in tests
 *                  it's a synthetic parser. Sentinel never imports tree-sitter itself.
 *   • loadJournal / saveJournal — persist the cross-session journal (host owns storage).
 *
 * This keeps the entire scan pipeline unit-testable headless while the browser layer supplies a
 * ~30-line host. It also means the scanner works the same whether driven by the tool, a CLI, or
 * CI — the host just differs.
 */

import { AstNode } from './astTypes.js';
import { CpgLifter } from './cpgLifter.js';
import { languageIdFromPath } from './languages.js';
import { runPacks } from './taintEngine.js';
import { VulnPack } from './taintSpec.js';
import { BUILTIN_PACKS } from './packs/builtinPacks.js';
import { ReportedFinding, renderHuman, renderSarif, toReportedFindings } from './reporter.js';
import { JournalState, ScanDiff, emptyJournal, recordScan, renderDiff, serializeJournal } from './journal.js';

/** The editor couplings the scanner needs, injected so the engine stays pure/testable. */
export interface ScanHost {
	/** Enumerate scannable source files (workspace-relative paths). Host applies ignore rules. */
	listFiles(): Promise<readonly string[]>;
	/** Read a file's UTF-8 text, or null if unreadable. */
	readFile(path: string): Promise<string | null>;
	/** Parse source into a normalized AST root, or null if the language/grammar is unavailable. */
	parse(source: string, languageId: string): Promise<AstNode | null>;
	/** Load the persisted journal JSON for this workspace (or undefined if none yet). */
	loadJournal(): Promise<string | undefined>;
	/** Persist the journal JSON. */
	saveJournal(json: string): Promise<void>;
	/** Wall-clock now (injectable for deterministic tests). Defaults to Date.now(). */
	now?(): number;
	/** Optional progress log. */
	log?(message: string): void;
}

/** Options controlling a scan run. */
export interface ScanOptions {
	/** Restrict to these pack ids (default: all built-ins). */
	readonly packIds?: readonly string[];
	/** Extra user/framework packs to run alongside the built-ins (Phase 8 feeds these). */
	readonly extraPacks?: readonly VulnPack[];
	/** Cap files scanned (safety valve for huge repos); 0/undefined = no cap. */
	readonly maxFiles?: number;
	/** Skip files larger than this many bytes (parse cost guard). Default 512 KiB. */
	readonly maxFileBytes?: number;
}

/** The full result of a scan: findings + the memory diff + prebuilt report renderings. */
export interface ScanResult {
	readonly findings: readonly ReportedFinding[];
	readonly diff: ScanDiff;
	readonly filesScanned: number;
	readonly filesSkipped: number;
	readonly packIds: readonly string[];
	/** Plain-English report (human summary of findings). */
	readonly human: string;
	/** Plain-English "since last scan" memory summary. */
	readonly memory: string;
	/** SARIF 2.1.0 JSON (for GitHub code scanning / external viewers). */
	readonly sarif: string;
	readonly workspace: string;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/**
 * Run a full workspace scan and fold results into the persistent journal.
 * Deterministic given the host's inputs; all editor access goes through {@link ScanHost}.
 */
export async function runScan(host: ScanHost, workspace: string, options: ScanOptions = {}): Promise<ScanResult> {
	const now = host.now ? host.now() : Date.now();
	const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

	// Resolve the pack set.
	let packs: VulnPack[] = [...BUILTIN_PACKS];
	if (options.packIds && options.packIds.length) {
		const want = new Set(options.packIds);
		packs = packs.filter(p => want.has(p.id));
	}
	if (options.extraPacks && options.extraPacks.length) {
		packs = [...packs, ...options.extraPacks];
	}

	const files = await host.listFiles();
	const limit = options.maxFiles && options.maxFiles > 0 ? Math.min(files.length, options.maxFiles) : files.length;

	const allFindings = [];
	let filesScanned = 0;
	let filesSkipped = 0;

	for (let i = 0; i < limit; i++) {
		const path = files[i];
		const languageId = languageIdFromPath(path);
		if (!languageId) { filesSkipped++; continue; } // unsupported extension
		const source = await host.readFile(path);
		if (source === null) { filesSkipped++; continue; }
		if (byteLength(source) > maxBytes) { filesSkipped++; continue; }
		let root: AstNode | null;
		try {
			root = await host.parse(source, languageId);
		} catch (e) {
			host.log?.(`[sentinel] parse failed for ${path}: ${e}`);
			filesSkipped++;
			continue;
		}
		if (!root) { filesSkipped++; continue; }
		try {
			const cpg = CpgLifter.lift(root, path, languageId);
			const found = runPacks(cpg, packs);
			for (const f of found) { allFindings.push(f); }
			filesScanned++;
		} catch (e) {
			// A single file's analysis failure must never abort the whole scan.
			host.log?.(`[sentinel] analysis failed for ${path}: ${e}`);
			filesSkipped++;
		}
	}

	const reported = toReportedFindings(allFindings);

	// Fold into the persistent journal (the memory).
	const priorJson = await host.loadJournal();
	const prior: JournalState = priorJson ? safeParseJournal(priorJson, workspace) : emptyJournal(workspace);
	const packsRun = packs.map(p => ({ id: p.id, version: p.version }));
	const { state, diff } = recordScan(prior, reported, packsRun, now);
	await host.saveJournal(serializeJournal(state));

	return {
		findings: reported,
		diff,
		filesScanned,
		filesSkipped,
		packIds: packs.map(p => p.id),
		human: renderHuman(reported),
		memory: renderDiff(diff),
		sarif: renderSarif(reported),
		workspace,
	};
}

function byteLength(s: string): number {
	// Avoid Buffer (may be absent in the renderer). Approximate UTF-8 length.
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) { bytes += 1; }
		else if (c < 0x800) { bytes += 2; }
		else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; } // surrogate pair
		else { bytes += 3; }
	}
	return bytes;
}

function safeParseJournal(json: string, workspace: string): JournalState {
	try {
		const parsed = JSON.parse(json) as JournalState;
		if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) { return parsed; }
	} catch { /* fall through */ }
	return emptyJournal(workspace);
}
