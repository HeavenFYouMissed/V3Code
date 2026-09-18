/*---------------------------------------------------------------------------------------------
 *  Copyright (c) V3Code. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V3CODE_MCP_TOKEN_PATTERN } from '../common/mcpExpose/mcpExposeTypes.js';

export { V3CODE_MCP_TOKEN_FILE } from '../common/mcpExpose/mcpExposeTypes.js';

function readValidToken(tokenFile: string): string {
	const token = fs.readFileSync(tokenFile, 'utf8').trim();
	if (!V3CODE_MCP_TOKEN_PATTERN.test(token)) {
		const error = new Error(`Invalid V3Code MCP token file: ${tokenFile}`) as NodeJS.ErrnoException;
		error.code = 'EINVAL';
		throw error;
	}
	try { fs.chmodSync(tokenFile, 0o600); } catch { /* Windows has no POSIX mode bits. */ }
	return token;
}

const TOKEN_LOCK_STALE_MS = 30_000;
const TOKEN_LOCK_WAIT_MS = 10;
const TOKEN_LOCK_TIMEOUT_MS = 5_000;
const tokenLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function withTokenFileLock<T>(tokenFile: string, callback: () => T): T {
	const lockFile = `${tokenFile}.lock`;
	const deadline = Date.now() + TOKEN_LOCK_TIMEOUT_MS;
	let lockFd: number | undefined;

	while (lockFd === undefined) {
		try {
			lockFd = fs.openSync(lockFile, 'wx', 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
			try {
				if (Date.now() - fs.statSync(lockFile).mtimeMs > TOKEN_LOCK_STALE_MS) {
					fs.unlinkSync(lockFile);
					continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
				throw statError;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for V3Code MCP token lock: ${lockFile}`);
			}
			Atomics.wait(tokenLockWaitArray, 0, 0, TOKEN_LOCK_WAIT_MS);
		}
	}

	try {
		return callback();
	} finally {
		fs.closeSync(lockFd);
		try { fs.unlinkSync(lockFile); } catch { /* another process can retire a stale lock */ }
	}
}

/**
 * Return the optional per-user local MCP bearer token, creating it once with
 * owner-only permissions. URL-only loopback clients do not need this token;
 * authenticated client configs can use it across editor restarts. Creation and
 * repair are serialized, while a private fsynced temporary file plus atomic
 * rename keeps the well-known path from ever exposing a partial credential.
 */
export function loadOrCreateV3codeMcpToken(tokenFile: string): string {
	try {
		return readValidToken(tokenFile);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT' && code !== 'EINVAL') { throw error; }
	}

	fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
	return withTokenFileLock(tokenFile, () => {
		// A different window may have completed creation or repair while this one
		// waited for the lock. Always re-read before modifying generated state.
		try {
			return readValidToken(tokenFile);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'EINVAL') { throw error; }
			if (code === 'EINVAL') { fs.unlinkSync(tokenFile); }
		}

		const candidate = crypto.randomBytes(24).toString('hex');
		const temporaryFile = `${tokenFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
		let fd: number | undefined;
		try {
			fd = fs.openSync(temporaryFile, 'wx', 0o600);
			fs.writeFileSync(fd, candidate, { encoding: 'utf8' });
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			fs.renameSync(temporaryFile, tokenFile);
		} finally {
			if (fd !== undefined) { fs.closeSync(fd); }
			try { fs.unlinkSync(temporaryFile); } catch { /* best-effort private temp cleanup */ }
		}
		try { fs.chmodSync(tokenFile, 0o600); } catch { /* Windows has no POSIX mode bits. */ }
		return candidate;
	});
}

/** Require the complete bearer token; missing credentials are never equivalent to valid ones. */
export function matchesV3codeMcpAuthorization(header: string | undefined, token: string): boolean {
	if (!header || !token) { return false; }
	if (!header.startsWith('Bearer ')) { return false; }
	const presented = header.slice(7).trim();
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(token, 'utf8');
	if (a.length !== b.length) { return false; }
	return crypto.timingSafeEqual(a, b);
}
