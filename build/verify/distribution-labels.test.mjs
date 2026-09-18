import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform, label } from './distribution-labels.mjs';

for (const [name, path, text] of [
	['plain', 'src/example.ts', 'export const x = 1;\n'],
	['license', 'src/example.ts', '/* Copyright Microsoft. Licensed under MIT. */\nexport {};\n'],
	['shebang', 'scripts/example.mjs', '#!/usr/bin/env node\nconsole.log(1);\n'],
	['bom-crlf', 'src/example.ts', '\uFEFF/* Copyright A. */\r\nexport {};\r\n'],
	['jsdoc', 'src/example.ts', '/** Function documentation. */\nfunction x() {}\n'],
	['line-notice', 'src/example.rs', '// Copyright A\n// Licensed under MIT\nfn main() {}\n'],
]) test(name, () => {
	const result = transform(path, Buffer.from(text));
	assert.ok(result.output);
	assert.equal(result.output.toString().slice(0, result.offset) + result.output.toString().slice(result.offset + result.insertion.length), text);
	assert.equal(transform(path, result.output).reason, 'already-labelled');
	assert.ok(result.output.toString().includes(label));
	if (name === 'license') assert.ok(result.output.toString().startsWith(text.split('\n')[0]));
	if (name === 'shebang') assert.ok(result.output.toString().startsWith('#!/usr/bin/env node\n'));
	if (name === 'jsdoc') assert.ok(result.output.toString().endsWith(text));
});
test('skip sensitive formats and fixtures', () => {
	for (const path of ['package.json', 'src/test/a.ts', 'src/fixtures/a.js', 'lib/a.min.js', 'src/vs/platform/agentHost/common/state/protocol/a.ts']) assert.ok(transform(path, Buffer.from('x')).reason);
	assert.equal(transform('src/a.ts', Buffer.from('// DO NOT EDIT\nx')).reason, 'generated-banner');
	assert.equal(transform('src/a.ts', Buffer.from([255])).reason, 'non-utf8-or-binary');
});
