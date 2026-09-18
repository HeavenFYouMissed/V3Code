/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Pure source-map helpers shared by main-process channel and renderer-side reconstruction.

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_MAP_BYTES = 50 * 1024 * 1024;
export const MAX_RECON_FILES = 2000;
export const FETCH_TIMEOUT_MS = 30_000;

const SOURCE_MAP_URL_RE = /(?:\/\/[@#][ \t]+sourceMappingURL=([^\s'"]+)|\/\*[@#][ \t]+sourceMappingURL=([^*]+)\*\/)\s*$/m;

export interface ISourceMapFile {
	relPath: string;
	content: string;
}

export function resolveUrl(base: string, relative: string): string {
	try {
		return new URL(relative, base).href;
	} catch {
		return relative;
	}
}

export function extractSourceMapUrl(bundleUrl: string, bundleText: string): string | undefined {
	const m = SOURCE_MAP_URL_RE.exec(bundleText);
	const raw = (m?.[1] ?? m?.[2])?.trim();
	if (raw) {
		if (raw.startsWith('data:')) {
			return raw;
		}
		return resolveUrl(bundleUrl, raw);
	}
	try {
		const u = new URL(bundleUrl);
		const basePath = u.pathname.replace(/\.[^/.]+$/, '');
		return `${u.origin}${basePath}.map`;
	} catch {
		return undefined;
	}
}

export function sanitizeSourcePath(raw: string): string | undefined {
	let p = raw.replace(/\\/g, '/');
	p = p.replace(/^webpack:\/\/\/?[^/]*\//, '');
	p = p.replace(/^webpack:\/\//, '');
	p = p.replace(/^\//, '');
	if (!p || p.includes('..') || p.startsWith('node_modules/')) {
		return undefined;
	}
	return p;
}

export function parseSourceMapJson(mapJson: { sources?: string[]; sourcesContent?: Array<string | null> }): ISourceMapFile[] {
	const sources = mapJson.sources ?? [];
	const contents = mapJson.sourcesContent ?? [];
	if (sources.length === 0) {
		return [];
	}
	const out: ISourceMapFile[] = [];
	for (let i = 0; i < sources.length; i++) {
		const rawPath = sources[i];
		const content = contents[i];
		if (typeof content !== 'string' || content.length === 0) {
			continue;
		}
		const relPath = sanitizeSourcePath(rawPath);
		if (!relPath) {
			continue;
		}
		out.push({ relPath, content });
	}
	return out;
}

export async function fetchText(url: string, maxBytes: number): Promise<{ text: string; bytes: number }> {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} for ${url}`);
	}
	const buf = await res.arrayBuffer();
	if (buf.byteLength > maxBytes) {
		throw new Error(`Response too large (${buf.byteLength} bytes, max ${maxBytes})`);
	}
	const text = new TextDecoder().decode(buf);
	return { text, bytes: buf.byteLength };
}

export async function loadSourceMapFiles(mapUrl: string): Promise<ISourceMapFile[] | undefined> {
	if (mapUrl.startsWith('data:')) {
		const comma = mapUrl.indexOf(',');
		if (comma === -1) {
			return undefined;
		}
		const payload = mapUrl.slice(comma + 1);
		const decoded = mapUrl.includes(';base64,')
			? atob(payload)
			: decodeURIComponent(payload);
		return parseSourceMapJson(JSON.parse(decoded));
	}
	try {
		const fetched = await fetchText(mapUrl, MAX_MAP_BYTES);
		return parseSourceMapJson(JSON.parse(fetched.text));
	} catch {
		return undefined;
	}
}

export async function trySourceMapFiles(bundleUrl: string, bundleText: string): Promise<{ mapUrl: string; sources: ISourceMapFile[] } | undefined> {
	const mapUrl = extractSourceMapUrl(bundleUrl, bundleText);
	if (!mapUrl) {
		return undefined;
	}
	const sources = await loadSourceMapFiles(mapUrl);
	if (!sources || sources.length === 0) {
		return undefined;
	}
	return { mapUrl, sources };
}
