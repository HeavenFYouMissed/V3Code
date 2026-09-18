// Mechanical distribution branding only; never adds copyright or changes licensing.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedNotice } from './preserve-notices.mjs';

export const label = 'Part of V3Code, distributed by KandD Labs LLC.';
export function transform(path, input) {
	if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.rs'].includes(extname(path))) return { reason: 'unsupported-format' };
	if (/(^|\/)(node_modules|vendor|third_party|thirdParty|dist|out|generated|fixtures?|__fixtures__|__snapshots__|test|tests|testData|testdata|test-data|samples?|designSystems)(\/|$)/i.test(path)
		|| /(?:\.min\.|\.test\.|\.spec\.|\.generated\.)/.test(path)
		|| path.startsWith('src/vs/platform/agentHost/common/state/protocol/')) return { reason: 'dependency-generated-or-test-data' };
	const text = input.toString('utf8');
	if (!Buffer.from(text).equals(input) || text.includes('\0')) return { reason: 'non-utf8-or-binary' };
	if (/[^\r\n]{4000}/.test(text) || /[#@] sourceMappingURL=/.test(text) || /^\uFEFF?@charset/i.test(text)) return { reason: 'bundled-or-position-sensitive' };
	if (/do not edit|auto[- ]?generated|automatically generated/i.test(text.slice(0, 2000))) return { reason: 'generated-banner' };
	if (text.slice(0, 3000).includes(label)) return { reason: 'already-labelled' };
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	let offset = text.startsWith('\uFEFF') ? 1 : 0;
	const shebang = text.slice(offset).match(/^#![^\n]*\n/);
	if (shebang) offset += shebang[0].length;
	else if (text.slice(offset).startsWith('#!') && !text.includes('\n')) return { reason: 'unterminated-shebang' };
	// Keep the upstream header in its exact original position (hygiene requires it).
	// Do not move documentation comments away from their declarations.
	while (true) {
		const match = text.slice(offset).match(/^(\s*)(\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*(?:\n|$))+)/);
		if (!match || !/copyright|licensed?\b|spdx-|all rights reserved/i.test(match[2])) break;
		offset += match[0].length;
		if (text.slice(offset).startsWith(eol)) offset += eol.length;
	}
	const block = `/* ${label}${eol} * Existing copyright and license notices remain applicable.${eol} */${eol}`;
	const insertion = (offset && !text.slice(0, offset).endsWith('\n') && text[offset - 1] !== '\uFEFF' ? eol : '') + block;
	const output = text.slice(0, offset) + insertion + text.slice(offset);
	if (changedNotice(path, text, output)) throw new Error(`Notice changed: ${path}`);
	if (output.slice(0, offset) + output.slice(offset + insertion.length) !== text) throw new Error(`Non-additive edit: ${path}`);
	return { output: Buffer.from(output), offset, insertion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const apply = process.argv.includes('--apply');
	if (process.argv.slice(2).some(a => a !== '--apply')) throw new Error('Usage: node build/verify/distribution-labels.mjs [--apply]');
	const records = execFileSync('git', ['ls-files', '-s', '-z'], { maxBuffer: 32 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
	const report = { mode: apply ? 'apply' : 'dry-run', changed: [], skipped: [], counts: {} };
	const planned = [];
	for (const record of records) {
		const [metadata, path] = record.split('\t');
		const result = metadata.startsWith('100') ? transform(path, readFileSync(path)) : { reason: 'non-regular-file' };
		if (result.output) { planned.push([path, result.output]); report.changed.push(path); }
		else { report.skipped.push({ path, reason: result.reason }); report.counts[result.reason] = (report.counts[result.reason] || 0) + 1; }
	}
	// Complete validation before the first write. Existing bytes and file modes stay intact.
	if (apply) for (const [path, output] of planned) writeFileSync(path, output);
	console.log(JSON.stringify(report, null, 2));
}
