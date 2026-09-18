/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Immutable release metadata writer. Existing records may be re-read, but never replaced with
// different content. This prevents a later package/sign run from silently retargeting an artifact.

import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function value(name, required = true) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) {
		if (required) {
			throw new Error(`missing --${name}`);
		}
		return undefined;
	}
	return process.argv[index + 1];
}

function boolean(name) {
	const raw = value(name);
	if (raw !== 'true' && raw !== 'false') {
		throw new Error(`--${name} must be true or false`);
	}
	return raw === 'true';
}

export function writeImmutableMetadata(output, payload) {
	const body = `${JSON.stringify(payload, null, 2)}\n`;
	if (existsSync(output)) {
		const current = readFileSync(output, 'utf8');
		if (current === body) {
			return 'unchanged';
		}
		throw new Error(`refusing to replace immutable metadata with different content: ${output}`);
	}
	const descriptor = openSync(output, 'wx');
	try {
		writeFileSync(descriptor, body, 'utf8');
	} finally {
		closeSync(descriptor);
	}
	return 'created';
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const output = resolve(value('output'));
	const size = Number(value('size'));
	if (!Number.isSafeInteger(size) || size < 1) {
		throw new Error('--size must be a positive integer');
	}
	const payload = {
		appVersion: value('app-version'),
		v3codeVersion: value('v3code-version'),
		commit: value('commit'),
		arch: value('arch'),
		platform: value('platform'),
		state: value('state'),
		artifact: resolve(value('artifact')),
		size,
		sha256: value('sha256'),
		signed: boolean('signed'),
		notarized: boolean('notarized')
	};
	if (!/^[0-9a-f]{40}$/.test(payload.commit)) {
		throw new Error('--commit must be a 40-hex SHA');
	}
	if (!/^[0-9a-f]{64}$/.test(payload.sha256)) {
		throw new Error('--sha256 must be a 64-hex digest');
	}
	const result = writeImmutableMetadata(output, payload);
	console.log(`${result}: ${output}`);
}
