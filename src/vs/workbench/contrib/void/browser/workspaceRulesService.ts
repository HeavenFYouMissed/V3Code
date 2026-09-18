/*--------------------------------------------------------------------------------------
 *  Copyright (c) V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { join } from '../../../../base/common/path.js';

// ---- Types ----

export interface WorkspaceRule {
	name: string;
	description: string;
	globs: string[];
	alwaysApply: boolean;
	content: string;
	filePath: string;
	/** True when the rule ships with the product install (editor identity), false when workspace-authored. */
	bundled: boolean;
}

export interface IWorkspaceRulesService {
	readonly _serviceBrand: undefined;
	getMatchingRules(activeFilePath: string | undefined, openFilePaths: string[], opts?: { excludeBundled?: boolean }): Promise<string>;
	invalidateCache(): void;
}

export const IWorkspaceRulesService = createDecorator<IWorkspaceRulesService>('workspaceRulesService');

// ---- Frontmatter parser ----

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };

	const raw = match[1];
	const body = match[2];
	const meta: Record<string, any> = {};

	for (const line of raw.split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value: any = line.slice(colonIdx + 1).trim();

		if (value === 'true') value = true;
		else if (value === 'false') value = false;
		else if (value.startsWith('[') && value.endsWith(']')) {
			try { value = JSON.parse(value); } catch { /* keep as string */ }
		} else if (value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		meta[key] = value;
	}

	return { meta, body };
}

// ---- Glob matching (simple, no external deps) ----

function matchGlob(pattern: string, filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	const regexStr = pattern
		.replace(/\./g, '\\.')
		.replace(/\*\*/g, '{{GLOBSTAR}}')
		.replace(/\*/g, '[^/]*')
		.replace(/\{\{GLOBSTAR\}\}/g, '.*')
		.replace(/\?/g, '[^/]');
	const regex = new RegExp(`(^|/)${regexStr}$`, 'i');
	return regex.test(normalized);
}

// ---- Service ----

const RULES_DIR = '.v3code/rules';
const MAX_TOTAL_RULES_CHARS = 12_000;
const MAX_SINGLE_RULE_CHARS = 4_000;

class WorkspaceRulesService extends Disposable implements IWorkspaceRulesService {
	readonly _serviceBrand: undefined;

	private _cachedRules: WorkspaceRule[] | null = null;
	private _cacheTimestamp = 0;
	private static readonly CACHE_TTL_MS = 10_000;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) {
		super();

		this._register(this.fileService.onDidFilesChange(e => {
			const changed = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
			for (const uri of changed) {
				if (uri.path.includes('.v3code/rules') || uri.path.endsWith('.v3coderules')) {
					this.invalidateCache();
					return;
				}
			}
		}));
	}

	invalidateCache(): void {
		this._cachedRules = null;
		this._cacheTimestamp = 0;
	}

	async getMatchingRules(activeFilePath: string | undefined, openFilePaths: string[], opts?: { excludeBundled?: boolean }): Promise<string> {
		// excludeBundled: the OS prompt already bakes the bundled identity rules into the cached
		// prefix on every preset (c317735de), so callers sending a system message skip the bundled
		// copies here to avoid paying for the same static text twice per turn in the ephemeral tail.
		let rules = await this._loadRules();
		if (opts?.excludeBundled) rules = rules.filter(r => !r.bundled);
		// Dedupe: the root .v3coderules file is already carried in the cached prefix by
		// _readWorkspaceInstructions (convertToLLMMessageService) — injecting it again here
		// paid for the same text twice every round start.
		rules = rules.filter(r => r.name !== '.v3coderules');
		if (rules.length === 0) return '';

		const allPaths = [...(activeFilePath ? [activeFilePath] : []), ...openFilePaths];
		const sections: string[] = [];
		let totalChars = 0;

		// Priority 1: alwaysApply rules
		for (const rule of rules) {
			if (!rule.alwaysApply) continue;
			const truncated = rule.content.slice(0, MAX_SINGLE_RULE_CHARS);
			if (totalChars + truncated.length > MAX_TOTAL_RULES_CHARS) break;
			sections.push(`<!-- Rule: ${rule.name} (always) -->\n${truncated}`);
			totalChars += truncated.length;
		}

		// Priority 2: glob-matching rules (active file matches)
		for (const rule of rules) {
			if (rule.alwaysApply) continue;
			if (rule.globs.length === 0) continue;

			const matches = allPaths.some(p => rule.globs.some(g => matchGlob(g, p)));
			if (!matches) continue;

			const truncated = rule.content.slice(0, MAX_SINGLE_RULE_CHARS);
			if (totalChars + truncated.length > MAX_TOTAL_RULES_CHARS) break;
			sections.push(`<!-- Rule: ${rule.name} (matched: ${rule.globs.join(', ')}) -->\n${truncated}`);
			totalChars += truncated.length;
		}

		if (sections.length === 0) return '';
		return `\n\n<workspace_rules>\nThe following workspace rules apply to the current context:\n\n${sections.join('\n\n')}\n</workspace_rules>`;
	}

	private async _loadRules(): Promise<WorkspaceRule[]> {
		const now = Date.now();
		if (this._cachedRules && (now - this._cacheTimestamp) < WorkspaceRulesService.CACHE_TTL_MS) {
			return this._cachedRules;
		}

		const rules: WorkspaceRule[] = [];
		const rulesByName = new Map<string, WorkspaceRule>();

		const pushRule = (rule: WorkspaceRule, allowOverride: boolean) => {
			if (!allowOverride && rulesByName.has(rule.name)) {
				return;
			}
			rulesByName.set(rule.name, rule);
		};

		// Bundled product rules (editor identity — ship with every install)
		for (const bundledDir of this._getBundledRulesDirs()) {
			await this._loadRulesFromDir(bundledDir, pushRule, false, true);
		}

		const folders = this.workspaceContextService.getWorkspace().folders;

		for (const folder of folders) {
			// Load .v3coderules from root
			try {
				const rootRulesUri = URI.joinPath(folder.uri, '.v3coderules');
				const rootContent = (await this.fileService.readFile(rootRulesUri)).value.toString();
				if (rootContent.trim()) {
					pushRule({
						name: '.v3coderules',
						description: 'Workspace root rules',
						globs: [],
						alwaysApply: true,
						content: rootContent,
						filePath: rootRulesUri.fsPath,
						bundled: false,
					}, true);
				}
			} catch { /* file doesn't exist */ }

			// Load .v3code/rules/*.mdc (workspace overrides bundled rules by name)
			const rulesDir = URI.joinPath(folder.uri, RULES_DIR);
			await this._loadRulesFromDir(rulesDir, pushRule, true, false);
		}

		rules.push(...rulesByName.values());
		this._cachedRules = rules;
		this._cacheTimestamp = now;
		return rules;
	}

	/** Product-shipped rules live next to the app install (or repo root in dev). */
	private _getBundledRulesDirs(): URI[] {
		// appRoot exists only on the NATIVE environment service — the browser-safe
		// IEnvironmentService type lacks it (this was a compile error on main).
		// Desktop gets it at runtime; web builds simply have no bundled rules dir.
		const appRoot = this.environmentService.appRoot;
		if (!appRoot) { return []; }
		const candidates = [
			join(appRoot, '.v3code', 'rules'),
			join(appRoot, '..', '.v3code', 'rules'),
		];
		const seen = new Set<string>();
		const dirs: URI[] = [];
		for (const candidate of candidates) {
			const normalized = candidate.replace(/\\/g, '/');
			if (seen.has(normalized)) {
				continue;
			}
			seen.add(normalized);
			dirs.push(URI.file(candidate));
		}
		return dirs;
	}

	private async _loadRulesFromDir(
		dir: URI,
		pushRule: (rule: WorkspaceRule, allowOverride: boolean) => void,
		allowOverride: boolean,
		bundled: boolean,
	): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dir);
			if (!stat.children) {
				return;
			}
			for (const child of stat.children) {
				if (!child.name.endsWith('.mdc') && !child.name.endsWith('.md')) {
					continue;
				}
				try {
					const fileContent = (await this.fileService.readFile(child.resource)).value.toString();
					const { meta, body } = parseFrontmatter(fileContent);

					pushRule({
						name: child.name.replace(/\.(mdc|md)$/, ''),
						description: meta.description || '',
						globs: Array.isArray(meta.globs) ? meta.globs : (meta.glob ? [meta.glob] : []),
						alwaysApply: meta.alwaysApply === true,
						content: body.trim(),
						filePath: child.resource.fsPath,
						bundled,
					}, allowOverride);
				} catch (err) {
					this.logService.warn(`[WorkspaceRules] Failed to load rule: ${child.name}`, err);
				}
			}
		} catch { /* directory doesn't exist */ }
	}
}

registerSingleton(IWorkspaceRulesService, WorkspaceRulesService, InstantiationType.Delayed);
