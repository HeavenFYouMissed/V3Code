/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Curated page.evaluate extraction for site replication / security recon.
 * Invoked via Playwright invokeFunction — no arbitrary user code.
 */
export const EXTRACT_PAGE_DATA_FUNCTION = `async (page, args) => {
	const opts = Array.isArray(args) ? (args[0] ?? {}) : (args && typeof args === 'object' ? args : {});
	const focus = opts.focus ?? 'full';
	return await page.evaluate((focusArg) => {
		const cap = (arr, n) => arr.slice(0, n);
		const text = (el) => (el?.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 500);

		const meta = {};
		for (const m of document.querySelectorAll('meta[name], meta[property]')) {
			const key = m.getAttribute('name') || m.getAttribute('property');
			const val = m.getAttribute('content');
			if (key && val) { meta[key] = val.slice(0, 500); }
		}

		const headings = cap([...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({
			tag: h.tagName.toLowerCase(),
			text: text(h),
		})).filter(h => h.text), 40);

		const scripts = cap([...document.querySelectorAll('script[src]')].map(s => s.src).filter(Boolean), 80);
		const stylesheets = cap([...document.querySelectorAll('link[rel="stylesheet"][href]')].map(l => l.href).filter(Boolean), 40);
		const images = cap([...document.querySelectorAll('img[src]')].map(i => ({ src: i.src, alt: (i.alt || '').slice(0, 120) })), 60);

		const jsonLd = [];
		for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
			try { jsonLd.push(JSON.parse(s.textContent || '')); } catch { /* skip */ }
		}

		const frameworks = {};
		if (document.querySelector('#__next')) { frameworks.nextjs = true; }
		if (document.querySelector('#__nuxt')) { frameworks.nuxt = true; }
		if (document.querySelector('[data-reactroot], [data-reactid]')) { frameworks.react = true; }
		if (window.__NEXT_DATA__) { frameworks.nextData = true; }
		if (window.__NUXT__) { frameworks.nuxtData = true; }

		const resources = cap(performance.getEntriesByType('resource').map(e => ({
			url: e.name,
			type: e.initiatorType,
			size: e.transferSize || 0,
			ms: Math.round(e.duration),
		})), 100);

		const cssVars = {};
		const rootStyle = getComputedStyle(document.documentElement);
		for (const prop of rootStyle) {
			if (prop.startsWith('--')) {
				cssVars[prop] = rootStyle.getPropertyValue(prop).trim().slice(0, 120);
			}
		}

		const sampleStyles = {};
		for (const sel of ['body', 'h1', 'h2', 'a', 'button', 'main', 'header', 'nav']) {
			const el = document.querySelector(sel);
			if (!el) { continue; }
			const cs = getComputedStyle(el);
			sampleStyles[sel] = {
				color: cs.color,
				background: cs.backgroundColor,
				fontFamily: cs.fontFamily.slice(0, 80),
				fontSize: cs.fontSize,
				fontWeight: cs.fontWeight,
			};
		}

		const forms = cap([...document.querySelectorAll('form')].map((form, i) => ({
			index: i,
			action: form.action || '',
			method: (form.method || 'get').toLowerCase(),
			fields: cap([...form.querySelectorAll('input,textarea,select')].map(f => ({
				tag: f.tagName.toLowerCase(),
				type: f.type || '',
				name: f.name || '',
				placeholder: (f.placeholder || '').slice(0, 80),
			})), 30),
		})), 10);

		const out = {
			url: location.href,
			title: document.title,
			lang: document.documentElement.lang || '',
		};

		if (focusArg === 'assets' || focusArg === 'full') {
			Object.assign(out, { scripts, stylesheets, images, resources });
		}
		if (focusArg === 'structure' || focusArg === 'full') {
			Object.assign(out, { meta, headings, forms, jsonLd: cap(jsonLd, 5), frameworks });
		}
		if (focusArg === 'styles' || focusArg === 'full') {
			Object.assign(out, { cssVars, sampleStyles });
		}
		if (focusArg === 'network' || focusArg === 'full') {
			Object.assign(out, { resources });
		}

		return out;
	}, focus);
}`;
