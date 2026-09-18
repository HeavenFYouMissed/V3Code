/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { chromium } from 'playwright-core';

const cdp = process.argv[2] || 'http://127.0.0.1:58367';
const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
// Pick the workbench page (has .monaco-workbench)
let page = null;
for (const p of pages) {
	try {
		const has = await p.evaluate(() => !!document.querySelector('.monaco-workbench'));
		if (has) { page = p; break; }
	} catch { }
}
if (!page) { console.log(JSON.stringify({ error: 'no workbench page', pageCount: pages.length })); await browser.close(); process.exit(0); }

const result = await page.evaluate(() => {
	const r = (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const b = el.getBoundingClientRect();
		return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), top: Math.round(b.top) };
	};
	const aux = r('.part.auxiliarybar');
	const status = r('.part.statusbar');
	const inputPart = r('.part.auxiliarybar .interactive-input-part');
	const secToolbar = r('.part.auxiliarybar .chat-secondary-toolbar');
	const list = r('.part.auxiliarybar .interactive-list');
	const session = r('.part.auxiliarybar .interactive-session');
	const win = { w: window.innerWidth, h: window.innerHeight };
	let underlap = null;
	if (aux && status) underlap = aux.bottom - status.top; // >0 means aux extends under status bar
	return { win, aux, status, statusHeight: status?.h, inputPart, secToolbar, list, session, underlap };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
