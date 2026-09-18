/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Renderer-side bundle reconstruction: source maps run locally (fetch + IFileService)
// so site teardown works without a fresh electron-main relaunch. webcrack stays on the
// main process (native isolated-vm) and is only used when source maps are unavailable.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { BundleReconstructMethod, BundleReconstructParams, BundleReconstructResult, BundleReconstructProbeResult } from '../common/bundleReconstructTypes.js';
import { WEBCRACK_UNAVAILABLE_HINT } from '../common/bundleReconstructTypes.js';
import {
	MAX_BUNDLE_BYTES,
	MAX_RECON_FILES,
	trySourceMapFiles,
	fetchText,
	type ISourceMapFile,
} from '../common/bundleReconstructSourceMap.js';

export const IBundleReconstructService = createDecorator<IBundleReconstructService>('bundleReconstructService');

export interface IBundleReconstructService {
	readonly _serviceBrand: undefined;
	reconstruct(params: {
		bundleUrl: string;
		workspaceRootAbs: string;
		outputDirRel: string;
		method?: BundleReconstructMethod;
	}): Promise<BundleReconstructResult>;
	probe(): Promise<BundleReconstructProbeResult>;
}

const STALE_MAIN_HINT = 'Quit V3Code completely (Cmd+Q — not Reload Window) and relaunch so electron-main picks up new code.';

function isIpcUnavailableError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /timed out after \d+ms/i.test(msg)
		|| /Unknown channel/i.test(msg)
		|| /void-channel-bundleReconstruct/i.test(msg)
		|| /not recognized/i.test(msg)
		|| /EvalSandboxChannel/i.test(msg);
}

function failResult(outputDirAbs: string, error: string, bundleBytes = 0, webcrackAvailable = false): BundleReconstructResult {
	return {
		ok: false,
		method: 'none',
		outputDirAbs,
		filesWritten: 0,
		bytesWritten: 0,
		bundleBytes,
		error,
		samplePaths: [],
		nodeVersion: typeof process !== 'undefined' ? process.versions?.node ?? 'renderer' : 'renderer',
		webcrackAvailable,
	};
}

export class BundleReconstructService extends Disposable implements IBundleReconstructService {

	readonly _serviceBrand: undefined;
	private readonly _primaryChannel: IChannel;
	private readonly _fallbackChannel: IChannel;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._primaryChannel = this.mainProcessService.getChannel('void-channel-bundleReconstruct');
		this._fallbackChannel = this.mainProcessService.getChannel('void-channel-evalSandbox');
	}

	async reconstruct(params: {
		bundleUrl: string;
		workspaceRootAbs: string;
		outputDirRel: string;
		method?: BundleReconstructMethod;
	}): Promise<BundleReconstructResult> {
		const method = params.method ?? 'auto';
		const workspaceRootAbs = params.workspaceRootAbs.replace(/\\/g, '/').replace(/\/$/, '');
		const outputDirRel = params.outputDirRel.replace(/^[/\\]+/, '');
		const outputDirAbs = `${workspaceRootAbs}/${outputDirRel}`.replace(/\/+/g, '/');

		if (!outputDirAbs.startsWith(workspaceRootAbs + '/') && outputDirAbs !== workspaceRootAbs) {
			return failResult(outputDirAbs, 'output_dir must stay inside the workspace folder');
		}

		let bundleText: string;
		let bundleBytes: number;
		try {
			const fetched = await fetchText(params.bundleUrl, MAX_BUNDLE_BYTES);
			bundleText = fetched.text;
			bundleBytes = fetched.bytes;
		} catch (e) {
			return failResult(outputDirAbs, `Failed to fetch bundle: ${e instanceof Error ? e.message : String(e)}`);
		}

		if (method === 'sourcemap' || method === 'auto') {
			const sm = await trySourceMapFiles(params.bundleUrl, bundleText);
			if (sm) {
				try {
					const written = await this._writeSourceMapTree(URI.file(workspaceRootAbs), outputDirRel, sm.sources);
					return {
						ok: true,
						method: 'sourcemap',
						outputDirAbs,
						filesWritten: written.count,
						bytesWritten: written.bytes,
						bundleBytes,
						sourceMapUrl: sm.mapUrl,
						samplePaths: written.samplePaths,
						nodeVersion: typeof process !== 'undefined' ? process.versions?.node ?? 'renderer' : 'renderer',
						webcrackAvailable: false,
					};
				} catch (e) {
					if (method === 'sourcemap') {
						return failResult(outputDirAbs, `Source map extraction failed: ${e instanceof Error ? e.message : String(e)}`, bundleBytes);
					}
				}
			} else if (method === 'sourcemap') {
				return failResult(outputDirAbs, 'No source map found for this bundle (checked sourceMappingURL and .map sibling)', bundleBytes);
			}
			// auto: source map path exhausted — fall through to webcrack via main only if probe says it's loadable
			const probe = await this.probe();
			if (!probe.webcrackAvailable) {
				return failResult(
					outputDirAbs,
					`No usable source map (map missing or sourcesContent empty). ${probe.webcrackUnavailableReason ?? WEBCRACK_UNAVAILABLE_HINT}`,
					bundleBytes,
				);
			}
		}

		if (method === 'webcrack' || method === 'auto') {
			return this._reconstructViaMain({ ...params, method }, bundleBytes, outputDirAbs);
		}

		return failResult(outputDirAbs, 'Unknown method', bundleBytes);
	}

	private async _writeSourceMapTree(
		workspaceRoot: URI,
		outputDirRel: string,
		sources: ISourceMapFile[],
	): Promise<{ count: number; bytes: number; samplePaths: string[] }> {
		const outputRoot = URI.joinPath(workspaceRoot, outputDirRel);
		let count = 0;
		let bytes = 0;
		const samplePaths: string[] = [];

		for (const { relPath, content } of sources) {
			if (count >= MAX_RECON_FILES) {
				break;
			}
			const dest = URI.joinPath(outputRoot, ...relPath.split('/'));
			if (!dest.fsPath.startsWith(outputRoot.fsPath)) {
				continue;
			}
			await this.fileService.createFile(dest, VSBuffer.fromString(content), { overwrite: true });
			count++;
			bytes += content.length;
			if (samplePaths.length < 12) {
				samplePaths.push(relPath);
			}
		}

		return { count, bytes, samplePaths };
	}

	private async _reconstructViaMain(
		params: BundleReconstructParams,
		bundleBytes: number,
		outputDirAbs: string,
	): Promise<BundleReconstructResult> {
		const ipcParams: BundleReconstructParams = { ...params, method: params.method ?? 'webcrack' };
		try {
			return await this._callMain('reconstruct', ipcParams);
		} catch (primaryErr) {
			if (!isIpcUnavailableError(primaryErr)) {
				throw primaryErr;
			}
			try {
				return await this._fallbackChannel.call<BundleReconstructResult>('bundleReconstruct', ipcParams);
			} catch (fallbackErr) {
				const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
				const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
				return failResult(
					outputDirAbs,
					`webcrack requires main process (source map path not available). IPC failed: ${primaryMsg}. Fallback: ${fallbackMsg}. ${STALE_MAIN_HINT}`,
					bundleBytes,
				);
			}
		}
	}

	private _callMain(command: string, params?: unknown): Promise<BundleReconstructResult> {
		return this._primaryChannel.call<BundleReconstructResult>(command, params);
	}

	async probe(): Promise<BundleReconstructProbeResult> {
		try {
			return await this._primaryChannel.call<BundleReconstructProbeResult>('probe');
		} catch (primaryErr) {
			if (!isIpcUnavailableError(primaryErr)) {
				throw primaryErr;
			}
			try {
				return await this._fallbackChannel.call<BundleReconstructProbeResult>('bundleReconstructProbe');
			} catch {
				return {
					nodeVersion: 'unknown (main process stale)',
					webcrackAvailable: false,
					webcrackUnavailableReason: `${WEBCRACK_UNAVAILABLE_HINT} ${STALE_MAIN_HINT}`,
				};
			}
		}
	}
}

registerSingleton(IBundleReconstructService, BundleReconstructService, InstantiationType.Delayed);
