/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Packaging helpers for the bundled `node-llama-cpp` local inference runtime.
 * Platform packages live under `@node-llama-cpp/{platform}` (e.g. `win-x64-vulkan`);
 * only the current build target's variants are kept in the ASAR bundle.
 */

/** Optional dependency packages shipped by node-llama-cpp. */
export const nodeLlamaCppPlatforms = [
	'linux-arm64', 'linux-armv7l', 'linux-x64',
	'linux-x64-cuda', 'linux-x64-cuda-ext', 'linux-x64-vulkan',
	'mac-arm64-metal', 'mac-x64',
	'win-arm64', 'win-x64', 'win-x64-cuda', 'win-x64-cuda-ext', 'win-x64-vulkan',
] as const;

function toNodePlatformArch(platform: string, arch: string): { nodePlatform: string; nodeArch: string } {
	let nodePlatform = platform === 'alpine' ? 'linux' : platform;
	let nodeArch = arch;

	if (arch === 'armhf') {
		nodeArch = 'arm';
	} else if (arch === 'alpine') {
		nodePlatform = 'linux';
		nodeArch = 'x64';
	}

	return { nodePlatform, nodeArch };
}

/** Maps VS Code build target to the `@node-llama-cpp/*` package name prefix. */
function toLlamaPackagePrefix(nodePlatform: string, nodeArch: string): string {
	const os = nodePlatform === 'darwin' ? 'mac' : nodePlatform === 'win32' ? 'win' : nodePlatform;
	return `${os}-${nodeArch}`;
}

function isLlamaPackageForTarget(packageName: string, prefix: string): boolean {
	return packageName === prefix || packageName.startsWith(`${prefix}-`);
}

/**
 * Strips `@node-llama-cpp` packages for platforms other than the build target.
 * Keeps acceleration variants for the same OS/arch (e.g. `win-x64-vulkan` on win-x64).
 */
export function getNodeLlamaCppExcludeFilter(platform: string, arch: string): string[] {
	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	const prefix = toLlamaPackagePrefix(nodePlatform, nodeArch);
	const nonTarget = nodeLlamaCppPlatforms.filter(p => !isLlamaPackageForTarget(p, prefix));
	const excludes = nonTarget.map(p => `!**/node_modules/@node-llama-cpp/${p}/**`);
	return ['**', ...excludes];
}
