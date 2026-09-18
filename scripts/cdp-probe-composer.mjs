/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { chromium } from 'playwright-core';

const cdp = process.argv[2] || 'http://127.0.0.1:63819';
const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
let page = null;
for (const p of ctx.pages()) {
	try { if (await p.evaluate(() => !!document.querySelector('.monaco-workbench'))) { page = p; break; } } catch { }
}
if (!page) { console.log('NO WORKBENCH PAGE'); await browser.close(); process.exit(0); }

// Open the chat view if it isn't already present.
await page.evaluate(async () => {
	// Try to focus the chat input via command if not present.
	const has = () => document.querySelector('.part.auxiliarybar .interactive-session .chat-input-container');
	if (!has()) {
		// Attempt to run the focus-chat command through the keybinding service is hard; just report.
	}
});

const report = await page.evaluate(() => {
	const out = { found: false, focusBox: [], structure: [] };
	const container = document.querySelector('.part.auxiliarybar .interactive-session .chat-input-container')
		|| document.querySelector('.interactive-session .chat-input-container');
	if (!container) { out.note = 'no chat-input-container in DOM'; return out; }
	out.found = true;

	// Focus the inner textarea to reproduce the "square on focus".
	const ta = container.querySelector('textarea');
	if (ta) { ta.focus(); }

	const describe = (el) => {
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			cls: (el.className || '').toString().slice(0, 80),
			rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
			border: cs.borderWidth !== '0px' ? `${cs.borderWidth} ${cs.borderStyle} ${cs.borderColor}` : null,
			outline: (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` : null,
			boxShadow: cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 120) : null,
			bg: cs.backgroundColor,
		};
	};

	// Walk container subtree, collect anything drawing a visible box.
	const walk = (el, depth) => {
		const d = describe(el);
		if (d.border || d.outline || d.boxShadow) {
			out.focusBox.push({ depth, ...d });
		}
		out.structure.push({ depth, cls: d.cls, w: d.rect.w, h: d.rect.h, bg: d.bg, border: d.border, outline: d.outline });
		for (const c of el.children) walk(c, depth + 1);
	};
	walk(container, 0);
	// trim structure to first 40 for readability
	out.structure = out.structure.slice(0, 40);
	return out;
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
