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
import { IPathService } from '../../../services/path/common/pathService.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { join } from '../../../../base/common/path.js';

// ---- Types ----

export interface SkillDescriptor {
	name: string;
	description: string;
	/** When false, omitted from <skills_index> but still loadable via read_file / globs. */
	showInCatalog: boolean;
	triggers: {
		globs?: string[];
		keywords?: string[];
		alwaysApply?: boolean;
		/** When true, inject only a pointer; agent must read_file the full SKILL.md before acting. */
		loadOnDemand?: boolean;
	};
	content: string;
	filePath: string;
}

export interface ISkillsService {
	readonly _serviceBrand: undefined;
	getMatchingSkills(activeFilePath: string | undefined): Promise<string>;
	getSkillsCatalog(): Promise<string>;
	/** Cheap one-line workhorse-skill pointer for presets that skip the full catalog. */
	getMostUsedPointer(): Promise<string>;
	getAvailableSkillsList(): Promise<Array<{ name: string; description: string }>>;
	/** Full descriptor (incl. content) for one skill by exact name, or undefined if not found. */
	getSkillByName(name: string): Promise<SkillDescriptor | undefined>;
	invalidateCache(): void;
}

export const ISkillsService = createDecorator<ISkillsService>('skillsService');

// ---- Frontmatter parser ----

function parseSkillFrontmatter(content: string): { meta: Record<string, any>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };

	const raw = match[1];
	const body = match[2];
	const meta: Record<string, any> = {};

	let currentKey = '';
	let currentArray: string[] | null = null;
	// Block-scalar state: `description: >-` / `key: |` put the value on the following indented lines.
	let blockLines: string[] | null = null;
	let blockFold = false;

	const flushBlock = () => {
		if (blockLines === null) return;
		const joined = blockFold
			? blockLines.map(l => l.trim()).filter(l => l.length > 0).join(' ')
			: blockLines.join('\n');
		meta[currentKey] = joined.trim();
		blockLines = null;
	};

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();

		// Block-scalar continuation: any indented line belongs to the block we are collecting.
		//
		// Without this, `description: >-` stored the literal marker `>-` as the description and dropped
		// every continuation line (they contain no colon, so the key/value branch skipped them). Twenty
		// bundled skills are written that way, which meant the matcher — whose primary signal IS the
		// description — was matching against two punctuation characters. Valid YAML should not be a trap
		// for skill authors, so the parser learns the syntax rather than the skills avoiding it.
		if (blockLines !== null) {
			if (trimmed === '' || /^\s/.test(line)) {
				blockLines.push(line.replace(/^\s{1,4}/, ''));
				continue;
			}
			flushBlock();
		}

		// Array continuation
		if (trimmed.startsWith('- ') && currentArray !== null) {
			let val = trimmed.slice(2).trim();
			if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
			currentArray.push(val);
			continue;
		}

		// Save previous array
		if (currentArray !== null) {
			meta[currentKey] = currentArray;
			currentArray = null;
		}

		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value: any = line.slice(colonIdx + 1).trim();

		// `>` folds newlines into spaces, `|` keeps them; the trailing `-` (or `+`) is chomping, which
		// only affects trailing newlines and so does not change what we store.
		if (value === '>' || value === '>-' || value === '>+' || value === '|' || value === '|-' || value === '|+') {
			currentKey = key;
			blockFold = value.startsWith('>');
			blockLines = [];
			continue;
		}

		if (value === '' || value === undefined) {
			// Might be start of an array
			currentKey = key;
			currentArray = [];
			continue;
		}

		if (value === 'true') value = true;
		else if (value === 'false') value = false;
		else if (value.startsWith('[') && value.endsWith(']')) {
			try { value = JSON.parse(value); } catch { /* keep as string */ }
		} else if (value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		meta[key] = value;
	}

	// Final flushes — a block or array that runs to the end of the frontmatter has no following line
	// to trigger its flush.
	flushBlock();
	if (currentArray !== null) {
		meta[currentKey] = currentArray;
	}

	return { meta, body };
}

// ---- Glob matching ----

function matchSkillGlob(pattern: string, filePath: string): boolean {
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

const SKILLS_DIR_NAME = '.v3code/skills';
/** Route-first workhorse skills, surfaced ahead of the full index (and injected as a
 *  standalone pointer on presets that skip the catalog). Filtered against the loaded
 *  catalog at use so a pruned bundle never advertises a dead name. */
const MOST_USED_SKILL_NAMES = ['debug-user-app', 'debug-v3code-internals', 'runtime-first-build', 'v3code-design-rag', 'ux-design-system', 'integrated-browser-agent', 'clone-site', 'v3code-harness'];
const MAX_TOTAL_SKILLS_CHARS = 16_000;
const MAX_SINGLE_SKILL_CHARS = 4_000;

class SkillsService extends Disposable implements ISkillsService {
	readonly _serviceBrand: undefined;

	private _cachedSkills: SkillDescriptor[] | null = null;
	private _cacheTimestamp = 0;
	private static readonly CACHE_TTL_MS = 30_000;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ILogService _logService: ILogService,
	) {
		super();
	}

	invalidateCache(): void {
		this._cachedSkills = null;
		this._cacheTimestamp = 0;
	}

	async getAvailableSkillsList(): Promise<Array<{ name: string; description: string }>> {
		const skills = await this._loadSkills();
		return skills.map(s => ({ name: s.name, description: s.description }));
	}

	async getSkillByName(name: string): Promise<SkillDescriptor | undefined> {
		const skills = await this._loadSkills();
		// Exact match first; fall back to case-insensitive so the model isn't punished for casing.
		return skills.find(s => s.name === name) ?? skills.find(s => s.name.toLowerCase() === name.toLowerCase());
	}

	async getSkillsCatalog(): Promise<string> {
		const skills = await this._loadSkills();
		const catalogSkills = skills.filter(s => s.showInCatalog);
		if (catalogSkills.length === 0) return '';

		// Include a short one-line description next to each name so the model can pick the right
		// skill without having to read every SKILL.md first. Descriptions are collapsed to a single
		// line and truncated to keep the always-injected index from bloating the prompt.
		const oneLine = (desc: string): string => {
			const flat = (desc || '').replace(/\s+/g, ' ').trim();
			// 250 chars — enough for a trigger-shaped description ("Use when …: examples"),
			// which is what makes the index matchable instead of a label list.
			return flat.length > 250 ? `${flat.slice(0, 249)}…` : flat;
		};
		const lines = catalogSkills.map(s => {
			const d = oneLine(s.description);
			return d ? `- ${s.name}: ${d}` : `- ${s.name}`;
		});

		// Route-first shortcut ahead of the full list: the workhorse skills the OS prompt
		// routes to most. A 40+ entry index is expensive to scan every turn and small models
		// pick near-misses from it; naming the big seven first makes the common case one
		// glance. Filtered against the loaded catalog so a pruned bundle never advertises a
		// dead name.
		const presentMostUsed = MOST_USED_SKILL_NAMES.filter(n => catalogSkills.some(s => s.name === n));
		const mostUsedLine = presentMostUsed.length > 0 ? `Most-used (when in doubt, start here): ${presentMostUsed.join(', ')}.\n\n` : '';

		return `\n\n<skills_index>\nV3Code agent skills (.v3code/skills/). Authoritative list for the V3Code agent — not the Copilot catalog.\n\nLoad order when names collide (later wins): bundled product → ~/.v3code/skills → workspace .v3code/skills\n\n${mostUsedLine}${catalogSkills.length} skills (name: one-line summary). Matched skills appear in <active_skills>; otherwise load one with the read_skill tool (by name) when it fits your task. Use read_skill, NOT read_file — bundled and user-level skills are not reachable by file path:\n\n${lines.join('\n')}\n</skills_index>`;
	}

	/**
	 * A one-line pointer to the workhorse skills. The lean/minimal assembly presets skip the
	 * full catalog to save tokens — but then a small (often non-vision) model can't discover
	 * ANY skill by name (e.g. clone-site). Inject this cheap pointer on those presets so every
	 * model still knows the common skills exist and can `read_skill` them.
	 */
	async getMostUsedPointer(): Promise<string> {
		const skills = await this._loadSkills();
		const present = MOST_USED_SKILL_NAMES.filter(n => skills.some(s => s.showInCatalog && s.name === n));
		if (present.length === 0) { return ''; }
		return `\n\n<skills_index>\nV3Code agent skills — load one with the read_skill tool (by name, NOT read_file) when it fits the task. Most-used: ${present.join(', ')}.\n</skills_index>`;
	}

	// Progressive disclosure: skills auto-load ONLY when they declare alwaysApply or when an
	// active-file glob matches. Discovery of everything else is the model's job — it reads the
	// catalog (name + description, in the cached prefix) and read_files a skill on demand. There
	// is deliberately NO keyword/message auto-injection: it bloated context, fired on false
	// positives, and (because it depended on the latest message) it changed the prompt tail every
	// turn for no benefit.
	async getMatchingSkills(activeFilePath: string | undefined): Promise<string> {
		const skills = await this._loadSkills();
		if (skills.length === 0) return '';

		const sections: string[] = [];
		let totalChars = 0;
		const loaded = new Set<string>();

		const tryAdd = (skill: SkillDescriptor, reason: string): boolean => {
			if (loaded.has(skill.name)) return true;
			const section = this._formatSkillSection(skill, reason);
			if (totalChars + section.length > MAX_TOTAL_SKILLS_CHARS) return false;
			sections.push(section);
			totalChars += section.length;
			loaded.add(skill.name);
			return true;
		};

		// Priority 1: alwaysApply skills
		for (const skill of skills) {
			if (!skill.triggers.alwaysApply) continue;
			if (!tryAdd(skill, 'always')) break;
		}

		// Priority 2: glob-matching skills (active file only — not sticky)
		if (activeFilePath) {
			for (const skill of skills) {
				if (skill.triggers.alwaysApply) continue;
				if (!skill.triggers.globs || skill.triggers.globs.length === 0) continue;
				if (!skill.triggers.globs.some(g => matchSkillGlob(g, activeFilePath))) continue;
				if (!tryAdd(skill, 'file match')) break;
			}
		}

		if (sections.length === 0) return '';
		return `\n\n<active_skills>\nThe following skills are loaded for this context. If a skill says to read_skill it first, do that FIRST before acting.\n\n${sections.join('\n\n')}\n</active_skills>`;
	}

	private _formatSkillSection(skill: SkillDescriptor, reason: string): string {
		if (skill.triggers.loadOnDemand) {
			return [
				`<!-- Skill: ${skill.name} (${reason}, on-demand) -->`,
				skill.description,
				'',
				`**Required first step:** \`read_skill ${skill.name}\` — load the full skill before any work it covers.`,
				'',
				'Do not guess the workflow from memory — read the skill, then follow it exactly.',
			].join('\n');
		}

		const truncated = skill.content.slice(0, MAX_SINGLE_SKILL_CHARS);
		const wasTruncated = skill.content.length > MAX_SINGLE_SKILL_CHARS;
		let section = `<!-- Skill: ${skill.name} (${reason}) -->\n${truncated}`;
		if (wasTruncated) {
			section += `\n\n[Skill truncated at ${MAX_SINGLE_SKILL_CHARS} chars — \`read_skill ${skill.name}\` for full instructions]`;
		} else {
			section += `\n\n[Skill path: \`${skill.filePath}\`]`;
		}
		return section;
	}

	private async _loadSkills(): Promise<SkillDescriptor[]> {
		const now = Date.now();
		if (this._cachedSkills && (now - this._cacheTimestamp) < SkillsService.CACHE_TTL_MS) {
			return this._cachedSkills;
		}

		const skills: SkillDescriptor[] = [];

		// Load bundled product skills (shipped with V3Code — not tied to workspace root)
		for (const bundledDir of this._getBundledSkillsDirs()) {
			await this._loadSkillsFromDir(bundledDir, skills);
		}

		// Load from user-level: ~/.v3code/skills/ (overrides bundled by name)
		try {
			const userHome = this.pathService.userHome({ preferLocal: true });
			const userSkillsDir = URI.joinPath(userHome, '.v3code', 'skills');
			await this._loadSkillsFromDir(userSkillsDir, skills);
		} catch { /* user skills dir doesn't exist */ }

		// Load from workspace-level: .v3code/skills/ (overrides bundled + user by name)
		const folders = this.workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			const wsSkillsDir = URI.joinPath(folder.uri, SKILLS_DIR_NAME);
			await this._loadSkillsFromDir(wsSkillsDir, skills);

			// Monorepo: also scan immediate child folders (e.g. mcp/vselite/.v3code/skills)
			try {
				const stat = await this.fileService.resolve(folder.uri);
				for (const child of stat.children ?? []) {
					if (!child.isDirectory) {
						continue;
					}
					const nestedSkillsDir = URI.joinPath(child.resource, '.v3code', 'skills');
					await this._loadSkillsFromDir(nestedSkillsDir, skills);
				}
			} catch { /* ignore */ }
		}

		// Deterministic order: the catalog lives in the cached system-prompt prefix, so its
		// text must be byte-stable across reloads/restarts/machines. Filesystem iteration
		// order is NOT stable, so sort by name before caching.
		skills.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

		this._cachedSkills = skills;
		this._cacheTimestamp = now;
		return skills;
	}

	/** Product-shipped skills live next to the app install (or repo root in dev). */
	private _getBundledSkillsDirs(): URI[] {
		const appRoot = this.environmentService.appRoot;
		const candidates = [
			join(appRoot, '.v3code', 'skills'),
			join(appRoot, '..', '.v3code', 'skills'),
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

	private async _loadSkillsFromDir(dir: URI, skills: SkillDescriptor[]): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dir);
			if (!stat.children) return;

			for (const child of stat.children) {
				if (child.isDirectory) {
					// Skill directories contain SKILL.md
					const skillFile = URI.joinPath(child.resource, 'SKILL.md');
					try {
						const content = (await this.fileService.readFile(skillFile)).value.toString();
						const skill = this._parseSkill(content, child.name, skillFile.fsPath);
						if (skill) {
							// Later sources override earlier ones with the same name (workspace > user > bundled)
							const existingIdx = skills.findIndex(s => s.name === skill.name);
							if (existingIdx >= 0) skills[existingIdx] = skill;
							else skills.push(skill);
						}
					} catch { /* SKILL.md doesn't exist in this dir */ }
				} else if (child.name.endsWith('.md') || child.name.endsWith('.mdc')) {
					// Single-file skills
					try {
						const content = (await this.fileService.readFile(child.resource)).value.toString();
						const name = child.name.replace(/\.(md|mdc)$/, '');
						const skill = this._parseSkill(content, name, child.resource.fsPath);
						if (skill) {
							const existingIdx = skills.findIndex(s => s.name === skill.name);
							if (existingIdx >= 0) skills[existingIdx] = skill;
							else skills.push(skill);
						}
					} catch { /* read error */ }
				}
			}
		} catch { /* directory doesn't exist */ }
	}

	private _parseSkill(content: string, fallbackName: string, filePath: string): SkillDescriptor | null {
		const { meta, body } = parseSkillFrontmatter(content);
		if (!body.trim()) return null;

		return {
			name: meta.name || fallbackName,
			description: meta.description || '',
			showInCatalog: meta.catalog !== false,
			triggers: {
				globs: Array.isArray(meta.globs) ? meta.globs : (meta.glob ? [meta.glob] : undefined),
				keywords: Array.isArray(meta.keywords) ? meta.keywords : undefined,
				alwaysApply: meta.alwaysApply === true,
				loadOnDemand: meta.loadOnDemand === true,
			},
			content: body.trim(),
			filePath,
		};
	}
}

registerSingleton(ISkillsService, SkillsService, InstantiationType.Delayed);
