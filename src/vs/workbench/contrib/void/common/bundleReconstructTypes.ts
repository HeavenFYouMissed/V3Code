/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export type BundleReconstructMethod = 'auto' | 'sourcemap' | 'webcrack';

/** Shown when webcrack probe/import fails — stops agents from retrying `npm install`. */
export const WEBCRACK_UNAVAILABLE_HINT =
	'webcrack unavailable: listed in optionalDependencies but npm skips it when native module isolated-vm fails to compile against Electron 39 V8 (v8::Object::GetIsolate removed). Do NOT run npm install webcrack - it reports up to date and stays missing. Use method=sourcemap (renderer path, no webcrack). webcrack fallback resumes when isolated-vm ships Electron 39-compatible builds.';

export interface BundleReconstructProbeResult {
	nodeVersion: string;
	webcrackAvailable: boolean;
	webcrackUnavailableReason?: string;
}

export interface BundleReconstructParams {
	bundleUrl: string;
	workspaceRootAbs: string;
	outputDirRel: string;
	method?: BundleReconstructMethod;
}

export interface BundleReconstructResult {
	ok: boolean;
	method: 'sourcemap' | 'webcrack' | 'none';
	outputDirAbs: string;
	filesWritten: number;
	bytesWritten: number;
	bundleBytes: number;
	sourceMapUrl?: string;
	bundleType?: string;
	error?: string;
	samplePaths: string[];
	nodeVersion: string;
	webcrackAvailable: boolean;
}
