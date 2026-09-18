/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/**
 * Ingest V3Code "Open Default Settings (JSON)" export into the repo.
 *
 *   node scripts/build-defaultSettings.mjs
 *   node scripts/build-defaultSettings.mjs --source "C:\path\to\export.txt"
 *
 * Default source: ../defaultsettingtoparse.txt (sibling of vselite/)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SOURCE = path.resolve(arg('--source', path.join(ROOT, '..', 'defaultsettingtoparse.txt')));
const OUT = path.join(ROOT, 'defaultSettings.jsonc');
const OUT_COPY = path.join(ROOT, '.cursor/v3code-defaultSettings.jsonc');

const HEADER = `{
	// V3Code defaultSettings.jsonc
	// Exported from running V3Code → Command Palette → "Open Default Settings (JSON)".
	// Regenerate: save export to mcp/defaultsettingtoparse.txt then run:
	//   node scripts/build-defaultSettings.mjs
	//
	// This is the full shipped-default catalog (~2300+ keys incl. extensions).
	// Product overrides also live in v3codeDefaultSettings.ts (desktop registry).
`;

function main() {
	if (!fs.existsSync(SOURCE)) {
		console.error('V3Code export not found:', SOURCE);
		console.error('Save Settings → Open Default Settings (JSON) to mcp/defaultsettingtoparse.txt');
		process.exit(1);
	}

	let text = fs.readFileSync(SOURCE, 'utf8').replace(/^\uFEFF/, '');
	text = text.trim();
	if (!text.startsWith('{')) {
		text = '{\n' + text;
	}

	// Replace or prepend header (keep body after first line `{`)
	const body = text.startsWith('{') ? text.slice(text.indexOf('{') + 1) : text;
	const out = HEADER + body;

	fs.mkdirSync(path.dirname(OUT_COPY), { recursive: true });
	fs.writeFileSync(OUT, out, 'utf8');
	fs.writeFileSync(OUT_COPY, out, 'utf8');

	const keys = (out.match(/^\s*"[^"]+"\s*:/gm) || []).length;
	const lines = out.split(/\n/).length;
	const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(0);

	console.log('Ingested V3Code defaultSettings');
	console.log('  Source:', SOURCE);
	console.log('  Wrote: ', OUT);
	console.log('  Copy:  ', OUT_COPY);
	console.log(`  ${kb} KB | ${lines} lines | ~${keys} keys`);
}

main();
