/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Design RAG active selection — when the user picked a plugin in the local gallery
 * (`design-rag/.selection.json`), inject a compact block so the agent follows that
 * spec without needing to read_skill + read_file every turn (D3 in docs/DESIGN-RAG.md).
 */

import { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';

export const DESIGN_RAG_FOLDER = 'design-rag';
export const DESIGN_SELECTION_FILE = '.selection.json';
export const DESIGN_ACTIVE_INJECT_CAP = 8_000;

/** Injected on every turn while Design mode is on (model picker toggle). */
export const DESIGN_MODE_INJECT = `\n\n<design_mode>\nDesign mode is ON. The user wants the full visual design workflow.\n- If the user wants to CLONE / replicate / "make my site like" an EXISTING site or drops a site URL: that is the \`clone-site\` skill, NOT the gallery — \`read_skill clone-site\` and follow it (mirror the target as a source oracle, rebuild editable source, serve on localhost). Skip the gallery ask for this.\n- Otherwise, on the first UI-related turn: call \`ask_user\` with 2-3 short options (design gallery / token discipline only / I will describe the aesthetic). Wait for the button answer — do not ask in prose alone.\n- Gallery path: \`read_skill v3code-design-rag\`, clone \`design-rag/\` if missing, start the server, \`open_browser_page\` → http://localhost:7341/browse.\n- When \`design-rag/.selection.json\` exists, \`<design_system_active>\` carries the pick — build from it.\n- Never invent spacing, palette, or type from scratch while this mode is on.\n</design_mode>`;

export type DesignSelection = {
	title?: string;
	pluginId?: string;
	skill?: string;
	query?: string;
	brief?: string;
	reactions?: Array<{ title?: string; reaction?: string; note?: string }>;
};

export function formatDesignActiveBlock(selection: DesignSelection, skillExcerpt?: string): string {
	const title = (selection.title ?? selection.pluginId ?? 'selected plugin').trim();
	const lines: string[] = [
		`Plugin: ${title}`,
	];
	if (selection.query?.trim()) {
		lines.push(`Query: ${selection.query.trim()}`);
	}
	if (selection.brief?.trim()) {
		lines.push(`Brief: ${selection.brief.trim()}`);
	}
	if (selection.skill?.trim()) {
		lines.push(`Plugin spec: ${selection.skill.trim()}`);
	}
	const reactions = Array.isArray(selection.reactions) ? selection.reactions : [];
	const reactionLines = reactions
		.filter(r => r && (r.title || r.reaction || r.note))
		.slice(-6)
		.map(r => `- ${[r.title, r.reaction, r.note].filter(Boolean).join(' — ')}`);
	if (reactionLines.length) {
		lines.push('Reactions:', ...reactionLines);
	}
	if (skillExcerpt?.trim()) {
		lines.push('', 'Plugin SKILL excerpt:', skillExcerpt.trim());
	}
	const body = lines.join('\n').trim();
	return `\n\n<design_system_active>\nThe user picked a design direction in the V3Code design gallery. Follow this plugin spec + craft laws — do not invent a new visual direction. Use read_skill v3code-design-rag for the full gallery/build loop if you need the API steps.\n\n${body}\n</design_system_active>`;
}

export function capDesignBlock(text: string, maxChars: number): string {
	const t = (text ?? '').trim();
	if (t.length <= maxChars) { return t; }
	return `${t.slice(0, maxChars)}\n…[design context truncated at ${maxChars} chars — read_file design-rag/.selection.json and the plugin SKILL for full detail]`;
}

export async function readDesignSelection(
	fileService: IFileService,
	workspaceRoot: URI,
): Promise<DesignSelection | null> {
	const uri = URI.joinPath(workspaceRoot, DESIGN_RAG_FOLDER, DESIGN_SELECTION_FILE);
	try {
		if (!(await fileService.exists(uri))) { return null; }
		const raw = (await fileService.readFile(uri)).value.toString().trim();
		if (!raw) { return null; }
		const data = JSON.parse(raw) as DesignSelection;
		if (!data || typeof data !== 'object') { return null; }
		if (!data.title && !data.pluginId && !data.skill && !data.query) { return null; }
		return data;
	} catch {
		return null;
	}
}

/** Optional SKILL.md excerpt referenced by selection.skill (workspace-relative path). */
export async function readDesignSkillExcerpt(
	fileService: IFileService,
	workspaceRoot: URI,
	skillPath: string | undefined,
	maxChars: number,
): Promise<string> {
	const rel = (skillPath ?? '').trim().replace(/^\/+/, '');
	if (!rel) { return ''; }
	const uri = URI.joinPath(workspaceRoot, rel);
	try {
		if (!(await fileService.exists(uri))) { return ''; }
		const raw = (await fileService.readFile(uri)).value.toString().trim();
		if (!raw) { return ''; }
		return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
	} catch {
		return '';
	}
}

export async function buildDesignActiveContext(
	fileService: IFileService,
	workspaceRoot: URI,
): Promise<string> {
	const selection = await readDesignSelection(fileService, workspaceRoot);
	if (!selection) { return ''; }
	const excerptBudget = Math.max(500, DESIGN_ACTIVE_INJECT_CAP - 1_500);
	const skillExcerpt = await readDesignSkillExcerpt(fileService, workspaceRoot, selection.skill, excerptBudget);
	return capDesignBlock(formatDesignActiveBlock(selection, skillExcerpt), DESIGN_ACTIVE_INJECT_CAP);
}
