// Verify a mechanical branding receipt against exact pre-pass Git bytes.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { transform } from './distribution-labels.mjs';
const [receipt, base, typescriptPath, destination] = process.argv.slice(2);
if (!destination) throw new Error('Usage: node verify-distribution-pass.mjs RECEIPT BASE TYPESCRIPT_MODULE OUTPUT');
const ts = (await import(typescriptPath)).default;
const report = JSON.parse(readFileSync(receipt));
const blobs = execFileSync('git', ['cat-file', '--batch'], {
	input: report.changed.map(p => `${base}:${p}\n`).join(''), maxBuffer: 512 * 1024 * 1024,
});
let offset = 0, parsed = 0;
for (const path of report.changed) {
	const end = blobs.indexOf(10, offset);
	const header = blobs.subarray(offset, end).toString().split(' ');
	if (header[1] !== 'blob') throw new Error(`Missing base blob: ${path}`);
	const size = Number(header[2]);
	const before = blobs.subarray(end + 1, end + 1 + size);
	offset = end + size + 2;
	const after = readFileSync(path);
	if (!transform(path, before).output?.equals(after)) throw new Error(`Not the exact additive transformation: ${path}`);
	if (transform(path, after).reason !== 'already-labelled') throw new Error(`Not idempotent: ${path}`);
	if (/\.[cm]?[jt]sx?$/.test(path)) {
		const diagnostics = data => ts.createSourceFile(path, data.toString(), ts.ScriptTarget.Latest, true).parseDiagnostics.map(d => [d.code, ts.flattenDiagnosticMessageText(d.messageText, ' ')]);
		if (JSON.stringify(diagnostics(before)) !== JSON.stringify(diagnostics(after))) throw new Error(`Parse regression: ${path}`);
		parsed++;
	}
}
report.verification = { exactAdditiveTransformations: report.changed.length, parseDiagnosticsUnchanged: parsed, idempotent: true, base };
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(report.verification);
