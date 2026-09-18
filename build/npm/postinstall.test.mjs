/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readlinkSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import ts from 'typescript';

// Load only the helper: importing postinstall would start dependency installation.
const source = readFileSync(new URL('./postinstall.ts', import.meta.url), 'utf8');
const start = source.indexOf('function ensureAgentHarnessLink(');
const end = source.indexOf('\nasync function runWithConcurrency', start);
assert.ok(start >= 0 && end > start);
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
const helper = new Function('fs', 'path', 'process', js + '\nreturn ensureAgentHarnessLink;')(fs, path, process);

for (const kind of ['missing', 'file', 'directory', 'existing']) {
	test('optional agent harness: ' + kind, () => {
		const root = mkdtempSync(path.join(tmpdir(), 'v3-agent-link-test-'));
		try {
			mkdirSync(path.join(root, '.claude'));
			const target = path.join(root, 'instructions');
			const link = path.join(root, '.claude', 'instructions');
			if (kind === 'file') {
				writeFileSync(target, 'public instructions');
			}
			if (kind === 'directory') {
				mkdirSync(target);
			}
			if (kind === 'existing') {
				writeFileSync(link, 'keep this');
			}
			const result = helper('../instructions', link);
			if (kind === 'missing') {
				assert.equal(result, 'missing');
				assert.equal(existsSync(link), false);
			} else if (kind === 'existing') {
				assert.equal(result, 'existing');
				assert.equal(readFileSync(link, 'utf8'), 'keep this');
			} else {
				assert.ok(['symlink', 'junction', 'hard link'].includes(result));
				assert.equal(fs.statSync(link).isDirectory(), kind === 'directory');
				if (result === 'symlink') {
					assert.equal(readlinkSync(link), '../instructions');
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
