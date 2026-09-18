// Preserve existing attribution; this check does not determine ownership or license compatibility.
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const hash = value => createHash('sha256').update(value).digest('hex');
const marker = /copyright|licensed?\b|spdx-|all rights reserved/i;

export function notices(file, text) {
	if (/^(?:licen[cs]e|notice|copying|copyright|authors)(?:[.-].*)?$/i.test(file.split('/').at(-1))) {
		return [text];
	}
	let rest = text.replace(/^\uFEFF/, '').replace(/^#![^\n]*(?:\n|$)/, '');
	const result = [];
	while (true) {
		rest = rest.trimStart();
		const match = rest.match(/^(\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?:(?:\/\/|#)[^\n]*(?:\n|$))+)/);
		if (!match) break;
		if (marker.test(match[0])) result.push(match[0].trimEnd());
		rest = rest.slice(match[0].length);
	}
	return result;
}

export function changedNotice(file, before, after) {
	const next = notices(file, after);
	return notices(file, before).some(old => !next.some(value => value.includes(old)));
}

export function check(baseRef, headRef) {
	const base = git('rev-parse', '--verify', `${baseRef}^{commit}`).toString().trim();
	const head = git('rev-parse', '--verify', `${headRef}^{commit}`).toString().trim();
	const read = (ref, file) => git('show', `${ref}:${file}`);
	// Exceptions must already exist in the trusted base, never introduced by the checked PR.
	let exceptions = [];
	const exceptionPath = '.github/header-exceptions.json';
	const exists = git('ls-tree', '--name-only', base, '--', exceptionPath).length > 0;
	if (exists) exceptions = JSON.parse(read(base, exceptionPath)).exceptions;
	if (!Array.isArray(exceptions)) throw new Error('Invalid trusted exception file');
	const records = git('diff', '--name-status', '-z', '--no-renames', base, head).toString().split('\0');
	const failures = [];
	for (let i = 0; i < records.length - 1; i += 2) {
		const status = records[i], file = records[i + 1];
		if (status === 'A') continue;
		const before = read(base, file);
		const after = status === 'D' ? Buffer.alloc(0) : read(head, file);
		if (!changedNotice(file, before.toString(), after.toString())) continue;
		const approved = exceptions.some(e => e.path === file && e.beforeSha256 === hash(before)
			&& e.afterSha256 === hash(after) && typeof e.reason === 'string' && e.reason.trim()
			&& typeof e.evidence === 'string' && e.evidence.trim());
		if (!approved) failures.push(file);
	}
	return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv.length !== 4) throw new Error('Usage: node preserve-notices.mjs BASE HEAD');
		const failures = check(process.argv[2], process.argv[3]);
		if (failures.length) {
			console.error('Existing notices changed or removed; maintainer review required:\n' + failures.join('\n'));
			process.exitCode = 1;
		} else console.log('Existing notice preservation passed. New-file provenance is a separate review.');
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
