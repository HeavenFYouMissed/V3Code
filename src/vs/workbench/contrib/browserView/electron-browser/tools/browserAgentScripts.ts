/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Curated Playwright snippets — invoked via invokeFunction only. */

// invokeFunction compiles as (fn)(page, ...argsArray) — the second param is the spread
// of the args array, NOT the array itself. Unwrap with this one-liner in every script.
const INVOKE_OPTS_UNWRAP = `const opts = Array.isArray(args) ? (args[0] ?? {}) : (args && typeof args === 'object' ? args : {});`;

export const GET_COMPUTED_STYLES_FUNCTION = `async (page, args) => {
	${INVOKE_OPTS_UNWRAP}
	const selector = opts.selector;
	const ref = opts.ref;
	const sel = ref ? ('aria-ref=' + ref) : selector;
	if (!sel) throw new Error('selector or ref is required');
	const loc = page.locator(sel).first();
	await loc.waitFor({ state: 'attached', timeout: 10000 });
	return await loc.evaluate((node) => {
		const cs = getComputedStyle(node);
		const rect = node.getBoundingClientRect();
		const props = [
			'color','backgroundColor','backgroundImage','border','borderRadius','boxShadow',
			'fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign',
			'display','flexDirection','alignItems','justifyContent','gap','padding','margin',
			'width','height','maxWidth','opacity','transform','transition','zIndex','position',
			'gridTemplateColumns','backdropFilter'
		];
		const computed = {};
		for (const p of props) {
			const v = cs[p];
			if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px') {
				computed[p] = String(v).slice(0, 200);
			}
		}
		let reactComponent;
		const key = Object.keys(node).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
		if (key) {
			let fiber = node[key];
			for (let i = 0; i < 8 && fiber; i++) {
				const t = fiber.type;
				if (typeof t === 'string') { reactComponent = t; break; }
				if (t?.displayName) { reactComponent = t.displayName; break; }
				if (t?.name) { reactComponent = t.name; break; }
				fiber = fiber.return;
			}
		}
		return {
			tag: node.tagName.toLowerCase(),
			id: node.id || undefined,
			className: (typeof node.className === 'string' ? node.className : '').slice(0, 200) || undefined,
			text: (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120) || undefined,
			bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
			computed,
			reactComponent,
		};
	});
}`;

export const WATCH_PAGE_FUNCTION = `async (page, args) => {
	${INVOKE_OPTS_UNWRAP}
	const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 60_000, 1000), 300_000);
	const intervalMs = Math.min(Math.max(Number(opts.intervalMs) || 1000, 200), 10_000);
	const selector = opts.selector;
	const ref = opts.ref;
	const textContains = opts.textContains;
	const sel = ref ? ('aria-ref=' + ref) : selector;
	const deadline = Date.now() + timeoutMs;
	let polls = 0;
	while (Date.now() < deadline) {
		polls++;
		if (textContains) {
			const body = await page.evaluate((t) => (document.body?.innerText || '').includes(t), textContains);
			if (body) return { appeared: true, polls, kind: 'text', waitedMs: Date.now() - (deadline - timeoutMs) };
		}
		if (sel) {
			const count = await page.locator(sel).count();
			if (count > 0) {
				const visible = await page.locator(sel).first().isVisible().catch(() => false);
				if (visible) return { appeared: true, polls, kind: 'selector', selector: sel, waitedMs: Date.now() - (deadline - timeoutMs) };
			}
		}
		await page.waitForTimeout(intervalMs);
	}
	return { appeared: false, timedOut: true, polls, timeoutMs };
}`;

export const FILL_FORM_FUNCTION = `async (page, args) => {
	${INVOKE_OPTS_UNWRAP}
	const fields = Array.isArray(opts.fields) ? opts.fields : [];
	const results = [];
	for (const field of fields) {
		const ref = field.ref;
		const selector = field.selector;
		const label = field.label;
		const value = field.value ?? '';
		let sel = ref ? ('aria-ref=' + ref) : selector;
		if (!sel && label) {
			const esc = label.replace(/"/g, '\\\\"');
			sel = 'label:has-text("' + esc + '") >> input, label:has-text("' + esc + '") >> textarea, label:has-text("' + esc + '") >> select';
		}
		if (!sel) {
			results.push({ ok: false, error: 'field needs ref, selector, or label' });
			continue;
		}
		try {
			const loc = page.locator(sel).first();
			const kind = await loc.evaluate(el => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') }));
			if (kind.tag === 'select') {
				await loc.selectOption(Array.isArray(value) ? value.map(String) : String(value), { timeout: 8000 });
			} else if (kind.tag === 'input' && (kind.type === 'checkbox' || kind.type === 'radio')) {
				if (![true, false, 'true', 'false'].includes(value)) { throw new Error('Checkbox and radio values must be true or false'); }
				await loc.setChecked(value === true || value === 'true', { timeout: 8000 });
			} else {
				await loc.fill(String(value), { timeout: 8000 });
			}
			results.push({ ok: true, ref, label, selector: sel });
		} catch (e) {
			results.push({ ok: false, ref, label, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { filled: results.filter(r => r.ok).length, total: fields.length, results };
}`;

/**
 * Export cookies + localStorage without using Playwright's storageState() which
 * internally calls CDP Storage.getCookies — blocked in Electron's sandboxed WebContentsView.
 * Returns an IBrowserStorageState-shaped object using only document APIs + page.context().cookies().
 */
export const EXPORT_STORAGE_STATE_FUNCTION = `async (page, args) => {
	// cookies via Playwright context (doesn't use CDP Storage domain)
	let cookies = [];
	try { cookies = await page.context().cookies(); } catch { /* ignore */ }
	// localStorage via page.evaluate — pure JS, no CDP
	const origin = await page.evaluate(() => {
		const items = [];
		for (let i = 0; i < localStorage.length; i++) {
			const name = localStorage.key(i);
			if (name !== null) items.push({ name, value: localStorage.getItem(name) ?? '' });
		}
		return { origin: window.location.origin, localStorage: items };
	});
	return { cookies, origins: origin.localStorage.length ? [origin] : [] };
}`;

export const APPLY_STORAGE_STATE_FUNCTION = `async (page, args) => {
	const state = Array.isArray(args) ? (args[0] ?? {}) : (args && typeof args === 'object' ? args : {});
	if (state.cookies?.length) {
		await page.context().addCookies(state.cookies);
	}
	for (const origin of state.origins ?? []) {
		await page.context().addInitScript(({ o, items }) => {
			if (window.location.origin === o) {
				for (const { name, value } of items) {
					try { window.localStorage.setItem(name, value); } catch {}
				}
			}
		}, { o: origin.origin, items: origin.localStorage });
	}
	return { cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 };
}`;

export const ENABLE_NETWORK_CAPTURE_FUNCTION = `async (page, args) => {
	${INVOKE_OPTS_UNWRAP}
	const urlPattern = opts.urlPattern;
	const includeBodies = !!opts.includeBodies;
	if (!urlPattern) {
		throw new Error('urlPattern is required');
	}
	if (!page.__v3codeNetCap) {
		page.__v3codeNetCap = { entries: [] };
	}
	const cap = page.__v3codeNetCap;
	if (cap.handlers) {
		page.off('request', cap.handlers.onRequest);
		page.off('response', cap.handlers.onResponse);
	}
	cap.entries.length = 0;
	const urlRe = new RegExp(urlPattern, 'i');
	const onRequest = (req) => {
		if (!urlRe.test(req.url())) {
			return;
		}
		cap.entries.push({
			time: Date.now(),
			method: req.method(),
			url: req.url(),
			resourceType: req.resourceType(),
			requestBody: includeBodies ? (req.postData() ?? undefined) : undefined,
		});
	};
	const onResponse = async (res) => {
		const req = res.request();
		if (!urlRe.test(req.url())) {
			return;
		}
		let entry = cap.entries.find(e => e.url === req.url() && e.method === req.method() && e.status === undefined);
		if (!entry) {
			entry = { time: Date.now(), method: req.method(), url: req.url(), resourceType: req.resourceType() };
			cap.entries.push(entry);
		}
		entry.status = res.status();
		if (includeBodies) {
			try {
				const text = await res.text();
				entry.responseBody = text.length > 32000 ? text.slice(0, 32000) + '…[truncated]' : text;
			} catch { /* ignore */ }
		}
	};
	page.on('request', onRequest);
	page.on('response', onResponse);
	cap.handlers = { onRequest, onResponse };
	return { enabled: true, pattern: urlPattern, bodies: includeBodies };
}`;

export const GET_NETWORK_LOG_FUNCTION = `async (page, args) => {
	${INVOKE_OPTS_UNWRAP}
	const clear = !!opts.clear;
	const cap = page.__v3codeNetCap || { entries: [] };
	const copy = cap.entries.slice();
	if (clear) {
		cap.entries.length = 0;
	}
	return copy;
}`;
