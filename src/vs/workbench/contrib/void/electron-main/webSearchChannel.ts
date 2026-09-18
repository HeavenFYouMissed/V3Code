/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { readWebSearchSettings } from '../common/webSearchConfiguration.js';

export type WebSearchResult = { title: string; url: string; snippet: string };

// Enterprise/dev override. Packaged GUI users get the visible Settings-backed
// managed default instead of depending on a shell environment they never see.
const ENVIRONMENT_SEARXNG = process.env.SEARXNG_BASE_URL || process.env.V3CODE_SEARXNG_URL || '';

// In-memory cache to avoid hammering search on repeat queries
const cache = new Map<string, { results: WebSearchResult[]; ts: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cacheKey(endpoint: string, query: string): string {
	return `${endpoint}\n${query.toLowerCase().trim()}`;
}

function getCached(endpoint: string, query: string, maxResults: number): WebSearchResult[] | null {
	const key = cacheKey(endpoint, query);
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
	return entry.results.slice(0, maxResults);
}

function setCache(endpoint: string, query: string, results: WebSearchResult[]): void {
	const key = cacheKey(endpoint, query);
	cache.set(key, { results, ts: Date.now() });
	// Lazy cleanup: prune old entries when cache gets large
	if (cache.size > 500) {
		const now = Date.now();
		for (const [k, v] of cache) { if (now - v.ts > CACHE_TTL) cache.delete(k); }
	}
}

async function fetchSearXNG(base: string, query: string, maxResults: number, timeoutMs = 10_000): Promise<WebSearchResult[]> {
	const params = new URLSearchParams({ q: query, format: 'json', language: 'en', safesearch: '1' });
	try {
		const res = await fetch(`${base}/search?${params}`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Accept: 'application/json' },
		});
		if (res.status === 200) {
			const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
			if (Array.isArray(data.results) && data.results.length > 0) {
				return data.results
					.filter(r => r.url && r.title)
					.slice(0, maxResults)
					.map(r => ({
						title: String(r.title || ''),
						url: String(r.url || ''),
						snippet: String(r.content || '').slice(0, 500),
					}));
			}
		}
	} catch { /* JSON format may be disabled — fall through to HTML */ }

	// Fallback: fetch as HTML and parse <article> blocks (works even when format=json is 403)
	const htmlParams = new URLSearchParams({ q: query, language: 'en', safesearch: '1' });
	const res = await fetch(`${base}/search?${htmlParams}`, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: { Accept: 'text/html' },
	});
	if (res.status !== 200) throw new Error(`SearXNG HTML search returned HTTP ${res.status}`);
	const html = await res.text();
	return parseSearXNGHTML(html, maxResults);
}

function parseSearXNGHTML(html: string, maxResults: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	// Each result: <article class="result result-default ..."><h3><a href="URL">TITLE</a></h3><p class="content">SNIPPET</p>
	const articleRegex = /<article[^>]+class="result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
	let match: RegExpExecArray | null;
	while ((match = articleRegex.exec(html)) !== null && results.length < maxResults) {
		const block = match[1];
		// Extract URL + title from <h3><a href="...">...</a></h3>
		const h3Match = /<h3[^>]*><a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h3>/i.exec(block);
		if (!h3Match) continue;
		const url = h3Match[1];
		const title = h3Match[2].replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&').trim();
		if (!url || !title || url.startsWith('/')) continue;
		// Extract snippet from <p class="content">...</p>
		const snippetMatch = /<p\s+class="content"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
		const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';
		results.push({ title, url, snippet });
	}
	return results;
}

/** DuckDuckGo HTML POST — last-resort offline fallback. */
async function fetchDuckDuckGoPost(query: string, maxResults: number): Promise<WebSearchResult[]> {
	const res = await fetch('https://html.duckduckgo.com/html/', {
		method: 'POST',
		signal: AbortSignal.timeout(10_000),
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
			'Accept': 'text/html',
			'Accept-Language': 'en-US,en;q=0.9',
			'Referer': 'https://duckduckgo.com/',
		},
		body: `q=${encodeURIComponent(query)}`,
	});
	if (res.status !== 200) return [];
	const html = await res.text();
	const results: WebSearchResult[] = [];
	const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
		let href = match[1];
		const title = match[2].replace(/<[^>]*>/g, '').trim();
		if (!href || !title) continue;
		if (href.includes('uddg=')) {
			const decoded = decodeURIComponent(href.split('uddg=')[1]?.split('&')[0] ?? '');
			if (decoded) href = decoded;
		}
		if (href.startsWith('/') || href.includes('duckduckgo.com')) continue;
		results.push({ title, url: href, snippet: '' });
	}
	const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	let snippetIdx = 0;
	while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
		results[snippetIdx].snippet = match[1].replace(/<[^>]*>/g, '').trim();
		snippetIdx++;
	}
	return results;
}

// ---------------- web_fetch: URL -> readable text (no browser) ----------------

export type WebFetchResult = { title: string; url: string; text: string; pageNumber: number; totalPages: number; status: number; contentType: string };

/** Chars per web_fetch page — one tool result stays a bounded read; page_number continues. */
const FETCH_PAGE_CHARS = 20_000;
/** Cap on downloaded bytes before text extraction (protects against huge pages). */
const MAX_FETCH_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CACHE_TTL = 15 * 60 * 1000; // 15 minutes — pagination re-reads hit the cache, not the site
const fetchCache = new Map<string, { title: string; text: string; finalUrl: string; status: number; contentType: string; ts: number }>();

const FETCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
		.replace(/&#(\d+);/g, (_m, d: string) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/** Strips an HTML document down to readable text: drops script/style/chrome, prefers <main>/<article> when substantial, converts block ends to newlines. Heuristic, not a DOM — good enough for docs/issues/blogs. */
function htmlToReadableText(html: string): { title: string; text: string } {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';
	let body = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
	const main = /<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i.exec(body);
	if (main && main[1].replace(/<[^>]*>/g, ' ').trim().length > 500) {
		body = main[1];
	} else {
		body = body.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
	}
	body = body
		.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/blockquote|\/pre|\/table)[^>]*>/gi, '\n')
		.replace(/<li[^>]*>/gi, '\n- ')
		.replace(/<[^>]*>/g, ' ');
	const text = decodeEntities(body)
		.split('\n')
		.map(l => l.replace(/[ \t]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return { title, text };
}

/** Fetches a URL and returns one page of readable text (see FETCH_PAGE_CHARS). Errors return { error } so the tool layer can surface a clean message instead of an IPC rejection. */
async function fetchUrlAsText(arg?: { url?: string; pageNumber?: number }): Promise<{ result?: WebFetchResult; error?: string }> {
	const rawUrl = String(arg?.url ?? '').trim();
	const requestedPage = Math.max(1, Number(arg?.pageNumber) || 1);
	let parsed: URL;
	try { parsed = new URL(rawUrl); } catch { return { error: `Invalid URL: "${rawUrl}"` }; }
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { error: `Only http(s) URLs are supported (got "${parsed.protocol}").` };
	}

	let entry = fetchCache.get(rawUrl);
	if (entry && Date.now() - entry.ts > FETCH_CACHE_TTL) { fetchCache.delete(rawUrl); entry = undefined; }
	if (!entry) {
		let res: Response;
		try {
			res = await fetch(parsed.href, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				redirect: 'follow',
				headers: {
					'User-Agent': FETCH_USER_AGENT,
					'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
					'Accept-Language': 'en-US,en;q=0.9',
				},
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { error: `Could not fetch ${parsed.href}: ${msg}` };
		}
		const contentType = (res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
		const buf = await res.arrayBuffer();
		const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_FETCH_BYTES));
		let title = '';
		let text = '';
		if (contentType.includes('html') || (contentType === '' && /<html[\s>]/i.test(raw.slice(0, 2000)))) {
			({ title, text } = htmlToReadableText(raw));
		} else if (contentType.includes('json')) {
			try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { text = raw; }
		} else if (contentType.startsWith('text/') || contentType.includes('xml') || contentType === '') {
			text = raw;
		} else {
			return { error: `Unsupported content type "${contentType}" at ${parsed.href} — web_fetch reads HTML/text/JSON. For rendered or binary content use the browser tools (open_browser_page + read_page).` };
		}
		entry = { title, text, finalUrl: res.url || parsed.href, status: res.status, contentType, ts: Date.now() };
		if (res.status === 200 && text) {
			fetchCache.set(rawUrl, entry);
			if (fetchCache.size > 100) {
				const now = Date.now();
				for (const [k, v] of fetchCache) { if (now - v.ts > FETCH_CACHE_TTL) fetchCache.delete(k); }
			}
		}
	}

	const totalPages = Math.max(1, Math.ceil(entry.text.length / FETCH_PAGE_CHARS));
	const pageNumber = Math.min(requestedPage, totalPages);
	const text = entry.text.slice((pageNumber - 1) * FETCH_PAGE_CHARS, pageNumber * FETCH_PAGE_CHARS);
	return { result: { title: entry.title, url: entry.finalUrl, text, pageNumber, totalPages, status: entry.status, contentType: entry.contentType } };
}

export class WebSearchChannel implements IServerChannel {
	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly environmentEndpoint = ENVIRONMENT_SEARXNG,
	) { }

	listen(): never { throw new Error('WebSearchChannel: no events'); }

	async call(_: unknown, command: string, arg?: { query?: string; maxResults?: number; url?: string; pageNumber?: number }): Promise<any> {
		if (command === 'fetch') { return fetchUrlAsText(arg); }
		if (command !== 'search') { throw new Error(`WebSearchChannel: unknown command ${command}`); }
		const query = String(arg?.query ?? '').trim();
		const maxResults = Math.min(10, Math.max(1, Number(arg?.maxResults) || 5));
		if (!query) { return { results: [] }; }

		const searchSettings = readWebSearchSettings(this.configurationService, this.environmentEndpoint);
		if (!searchSettings.enabled) {
			return {
				results: [],
				error: 'Web search is turned off. Open V3Code Settings, search for "Web search", and enable it. web_fetch still works for direct URLs.',
			};
		}

		// The off switch must win even for a query already present in L1. Keying
		// by endpoint also prevents results from one custom service surviving a
		// provider change for the remainder of the 30-minute cache window.
		const cached = getCached(searchSettings.endpoint, query, maxResults);
		if (cached) return { results: cached };

		let results: WebSearchResult[] = [];
		let configuredServiceFailed = false;

		// 1. The managed V3Code SearXNG service (or the user's visible override).
		// JSON may be rejected by SearXNG's limiter; fetchSearXNG deliberately
		// retries the HTML result page, which is the production endpoint's path.
		try {
			results = await fetchSearXNG(searchSettings.endpoint, query, maxResults);
		} catch { configuredServiceFailed = true; }

		// 2. DDG HTML POST (last resort when the configured instance is down — may get 202 bot page)
		if (results.length === 0) {
			try {
				results = await fetchDuckDuckGoPost(query, maxResults);
			} catch { /* DDG blocked or offline */ }
		}

		if (results.length > 0) {
			setCache(searchSettings.endpoint, query, results);
			return { results };
		}
		if (configuredServiceFailed) {
			return {
				results: [],
				error: 'Web search could not reach the configured service. Open V3Code Settings, search for "Web search", confirm it is enabled, and check the endpoint. web_fetch still works for direct URLs.',
			};
		}
		return { results: [] };
	}
}
