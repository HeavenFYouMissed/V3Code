/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Main-process bundle reconstruction for site teardown / replication.
// Path 1: source maps (fetch bundle → sourceMappingURL → write sourcesContent tree).
// Path 2: webcrack (MIT) when no map — dynamic import; requires optional `webcrack` npm dep
// (uses isolated-vm; maintainer recommends Node 22/24 even majors).

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BundleReconstructParams, BundleReconstructResult, BundleReconstructProbeResult } from '../common/bundleReconstructTypes.js';
import { WEBCRACK_UNAVAILABLE_HINT } from '../common/bundleReconstructTypes.js';
import {
	MAX_BUNDLE_BYTES,
	MAX_RECON_FILES,
	fetchText,
	trySourceMapFiles,
} from '../common/bundleReconstructSourceMap.js';

export class BundleReconstructChannel implements IServerChannel {

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`BundleReconstructChannel has no events. Requested: ${event}`);
	}

	async call<T>(_: unknown, command: string, params?: unknown, _cancellationToken?: CancellationToken): Promise<T> {
		if (command === 'reconstruct') {
			return this._reconstruct(params as BundleReconstructParams) as T;
		}
		if (command === 'probe') {
			const webcrackAvailable = await this._isWebcrackAvailable();
			const probe: BundleReconstructProbeResult = {
				nodeVersion: process.versions.node,
				webcrackAvailable,
			};
			if (!webcrackAvailable) {
				probe.webcrackUnavailableReason = WEBCRACK_UNAVAILABLE_HINT;
			}
			return probe as T;
		}
		throw new Error(`BundleReconstructChannel: command "${command}" not recognized.`);
	}

	private async _reconstruct(params: BundleReconstructParams): Promise<BundleReconstructResult> {
		const method = params.method ?? 'auto';
		const workspaceRootAbs = path.resolve(params.workspaceRootAbs);
		const outputDirAbs = path.resolve(workspaceRootAbs, params.outputDirRel.replace(/^[/\\]+/, ''));

		if (!outputDirAbs.startsWith(workspaceRootAbs + path.sep) && outputDirAbs !== workspaceRootAbs) {
			return this._fail(outputDirAbs, 'output_dir must stay inside the workspace folder');
		}

		let bundleText: string;
		let bundleBytes: number;
		try {
			const fetched = await fetchText(params.bundleUrl, MAX_BUNDLE_BYTES);
			bundleText = fetched.text;
			bundleBytes = fetched.bytes;
		} catch (e) {
			return this._fail(outputDirAbs, `Failed to fetch bundle: ${this._errMsg(e)}`);
		}

		const webcrackAvailable = await this._isWebcrackAvailable();

		if (method === 'sourcemap' || method === 'auto') {
			const sm = await trySourceMapFiles(params.bundleUrl, bundleText);
			if (sm) {
				try {
					const written = await this._writeSourceMapTree(outputDirAbs, sm.sources);
					return {
						ok: true,
						method: 'sourcemap',
						outputDirAbs,
						filesWritten: written.count,
						bytesWritten: written.bytes,
						bundleBytes,
						sourceMapUrl: sm.mapUrl,
						samplePaths: written.samplePaths,
						nodeVersion: process.versions.node,
						webcrackAvailable,
					};
				} catch (e) {
					if (method === 'sourcemap') {
						return this._fail(outputDirAbs, `Source map extraction failed: ${this._errMsg(e)}`, bundleBytes, webcrackAvailable);
					}
				}
			} else if (method === 'sourcemap') {
				return this._fail(outputDirAbs, 'No source map found for this bundle (checked sourceMappingURL and .map sibling)', bundleBytes, webcrackAvailable);
			}
		}

		if (method === 'webcrack' || method === 'auto') {
			if (!webcrackAvailable) {
				if (method === 'webcrack') {
					return this._fail(outputDirAbs, WEBCRACK_UNAVAILABLE_HINT, bundleBytes, false);
				}
				return this._fail(outputDirAbs, `No usable source map (map missing or sourcesContent empty). ${WEBCRACK_UNAVAILABLE_HINT}`, bundleBytes, false);
			}
			try {
				const wc = await this._runWebcrack(bundleText, outputDirAbs);
				return {
					ok: true,
					method: 'webcrack',
					outputDirAbs,
					filesWritten: wc.filesWritten,
					bytesWritten: wc.bytesWritten,
					bundleBytes,
					bundleType: wc.bundleType,
					samplePaths: wc.samplePaths,
					nodeVersion: process.versions.node,
					webcrackAvailable: true,
				};
			} catch (e) {
				return this._fail(outputDirAbs, `webcrack failed: ${this._errMsg(e)}`, bundleBytes, true);
			}
		}

		return this._fail(outputDirAbs, 'Unknown method', bundleBytes, webcrackAvailable);
	}

	private _fail(outputDirAbs: string, error: string, bundleBytes = 0, webcrackAvailable = false): BundleReconstructResult {
		return {
			ok: false,
			method: 'none',
			outputDirAbs,
			filesWritten: 0,
			bytesWritten: 0,
			bundleBytes,
			error,
			samplePaths: [],
			nodeVersion: process.versions.node,
			webcrackAvailable,
		};
	}

	private async _writeSourceMapTree(outputDirAbs: string, sources: Array<{ relPath: string; content: string }>): Promise<{ count: number; bytes: number; samplePaths: string[] }> {
		await fs.mkdir(outputDirAbs, { recursive: true });
		let count = 0;
		let bytes = 0;
		const samplePaths: string[] = [];

		for (const { relPath, content } of sources) {
			if (count >= MAX_RECON_FILES) {
				break;
			}
			const dest = path.join(outputDirAbs, relPath);
			const destDir = path.dirname(dest);
			if (!dest.startsWith(outputDirAbs + path.sep) && dest !== outputDirAbs) {
				continue;
			}
			await fs.mkdir(destDir, { recursive: true });
			await fs.writeFile(dest, content, 'utf8');
			count++;
			bytes += Buffer.byteLength(content, 'utf8');
			if (samplePaths.length < 12) {
				samplePaths.push(relPath);
			}
		}

		return { count, bytes, samplePaths };
	}

	private async _isWebcrackAvailable(): Promise<boolean> {
		try {
			await import('webcrack');
			return true;
		} catch {
			return false;
		}
	}

	private async _runWebcrack(bundleText: string, outputDirAbs: string): Promise<{ filesWritten: number; bytesWritten: number; bundleType?: string; samplePaths: string[] }> {
		const { webcrack } = await import('webcrack');
		await fs.mkdir(outputDirAbs, { recursive: true });
		const result = await webcrack(bundleText, { jsx: true, unpack: true, unminify: true, deobfuscate: true });
		await result.save(outputDirAbs);

		let filesWritten = 0;
		let bytesWritten = 0;
		const samplePaths: string[] = [];
		const walk = async (dir: string, prefix = ''): Promise<void> => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const ent of entries) {
				const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					await walk(full, rel);
				} else if (ent.isFile()) {
					filesWritten++;
					const st = await fs.stat(full);
					bytesWritten += st.size;
					if (samplePaths.length < 12) {
						samplePaths.push(rel);
					}
				}
			}
		};
		await walk(outputDirAbs);

		let bundleType: string | undefined;
		if (result.bundle) {
			bundleType = result.bundle.type;
		}

		return { filesWritten, bytesWritten, bundleType, samplePaths };
	}

	private _errMsg(e: unknown): string {
		if (e instanceof Error) {
			return e.message;
		}
		return String(e);
	}
}
