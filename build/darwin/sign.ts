/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import fs from 'fs';
import path from 'path';
import { sign, type SignOptions } from '@electron/osx-sign';
import { spawn } from '@malept/cross-spawn-promise';

const root = path.dirname(path.dirname(import.meta.dirname));
const baseDir = path.dirname(import.meta.dirname);
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));

function getElectronVersion(): string {
	const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
	const target = /^target="(.*)"$/m.exec(npmrc)![1];
	return target;
}

/**
 * Path fragment identifying the bundled V3Code computer-use helper.
 *
 * The helper is a loose Mach-O at `Contents/Resources/computerUse/darwin/`, i.e. beside
 * `Resources/app` and outside every archive, because a binary inside an asar cannot be spawned.
 * `@electron/osx-sign` walks `Contents` and hands `optionsForFile` an absolute path, so this is
 * matched the same way the Electron helper bundles below are: as a plain substring.
 */
const computerUseHelperPathFragment = `${path.sep}Resources${path.sep}computerUse${path.sep}`;

/**
 * Bundle identifier the computer-use helper is signed with.
 *
 * MUST stay equal to `COMPUTER_USE_HELPER_BUNDLE_ID` in
 * `src/vs/workbench/contrib/computerUse/electron-main/computerUseHelperInstaller.ts`. That module
 * refuses to run the helper unless it satisfies the designated requirement
 * `identifier "<this>" and anchor apple generic and certificate leaf[subject.OU] = "<team>"`.
 *
 * It has to be passed explicitly: the helper has no bound Info.plist, so `codesign` would otherwise
 * derive the identifier from the file name (`v3code-computer-use-helper`) and the check above would
 * fail on every build. Signing it under its own identifier — rather than letting it inherit the
 * app's — is also what makes it an independently revocable TCC principal, so a user can grant or
 * withdraw Accessibility and Screen Recording for the helper without touching V3Code itself.
 */
const computerUseHelperIdentifier = 'dev.v3code.computerUseHelper';

function getEntitlementsForFile(filePath: string): string {
	if (filePath.includes(computerUseHelperPathFragment)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-computeruse-entitlements.plist');
	} else if (filePath.includes(' Helper (GPU).app')) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-gpu-entitlements.plist');
	} else if (filePath.includes(' Helper (Renderer).app')) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-renderer-entitlements.plist');
	} else if (filePath.includes(' Helper (Plugin).app')) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-plugin-entitlements.plist');
	} else if (filePath.includes(' Helper.app')) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-entitlements.plist');
	}
	return path.join(baseDir, 'azure-pipelines', 'darwin', 'app-entitlements.plist');
}

async function retrySignOnKeychainError<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;

			// Check if this is the specific keychain error we want to retry
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isKeychainError = errorMessage.includes('The specified item could not be found in the keychain.');

			if (!isKeychainError || attempt === maxRetries) {
				throw error;
			}

			console.log(`Signing attempt ${attempt} failed with keychain error, retrying...`);
			console.log(`Error: ${errorMessage}`);

			const delay = 1000 * Math.pow(2, attempt - 1);
			console.log(`Waiting ${Math.round(delay)}ms before retry ${attempt}/${maxRetries}...`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

async function main(buildDir?: string): Promise<void> {
	const tempDir = process.env['AGENT_TEMPDIRECTORY'];
	const arch = process.env['VSCODE_ARCH'];
	const identity = process.env['CODESIGN_IDENTITY'];

	if (!buildDir) {
		throw new Error('$AGENT_BUILDDIRECTORY not set');
	}

	if (!tempDir) {
		throw new Error('$AGENT_TEMPDIRECTORY not set');
	}

	const appRoot = path.join(buildDir, `VSCode-darwin-${arch}`);
	const appName = product.nameLong + '.app';
	const infoPlistPath = path.resolve(appRoot, appName, 'Contents', 'Info.plist');

	const appOpts: SignOptions = {
		app: path.join(appRoot, appName),
		platform: 'darwin',
		optionsForFile: (filePath) => ({
			entitlements: getEntitlementsForFile(filePath),
			hardenedRuntime: true,
			// See computerUseHelperIdentifier: without this the helper is signed under an identifier
			// derived from its file name and V3Code then refuses to run it.
			...(filePath.includes(computerUseHelperPathFragment)
				? { additionalArguments: ['--identifier', computerUseHelperIdentifier] }
				: {}),
		}),
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		keychain: path.join(tempDir, 'buildagent.keychain'),
		version: getElectronVersion(),
		identity,
	};

	// Only overwrite plist entries for x64 and arm64 builds,
	// universal will get its copy from the x64 build.
	if (arch !== 'universal') {
		await spawn('plutil', [
			'-insert',
			'NSAppleEventsUsageDescription',
			'-string',
			'An application in V3Code wants to use AppleScript.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSMicrophoneUsageDescription',
			'-string',
			'An application in V3Code wants to use the Microphone.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSCameraUsageDescription',
			'-string',
			'An application in V3Code wants to use the Camera.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSAudioCaptureUsageDescription',
			'-string',
			'An application in V3Code wants to use Audio Capture.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-insert',
			'NSLocalNetworkUsageDescription',
			'-string',
			'The app uses your local network for DNS resolution and to connect to locally running services.',
			`${infoPlistPath}`
		]);
	}

	await retrySignOnKeychainError(() => sign(appOpts));
}

if (import.meta.main) {
	main(process.argv[2]).catch(async err => {
		console.error(err);
		const tempDir = process.env['AGENT_TEMPDIRECTORY'];
		if (tempDir) {
			const keychain = path.join(tempDir, 'buildagent.keychain');
			const identities = await spawn('security', ['find-identity', '-p', 'codesigning', '-v', keychain]);
			console.error(`Available identities:\n${identities}`);
			const dump = await spawn('security', ['dump-keychain', keychain]);
			console.error(`Keychain dump:\n${dump}`);
		}
		process.exit(1);
	});
}
