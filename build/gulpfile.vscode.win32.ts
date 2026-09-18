/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import { gulp, rename } from './lib/gulp/facade.ts';
import * as path from 'path';
import rcedit from 'rcedit';
import vfs from 'vinyl-fs';
import pkg from '../package.json' with { type: 'json' };
import product from '../product.json' with { type: 'json' };
import { getVersion } from './lib/getVersion.ts';
import * as task from './lib/gulp/task.ts';
import * as util from './lib/util.ts';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const repoPath = path.dirname(import.meta.dirname);
const commit = getVersion(repoPath);
const buildPath = (arch: string) => path.join(path.dirname(repoPath), `VSCode-win32-${arch}`);
const setupDir = (arch: string, target: string) => path.join(repoPath, '.build', `win32-${arch}`, `${target}-setup`);
const innoSetupPath = path.join(path.dirname(path.dirname(require.resolve('innosetup'))), 'bin', 'ISCC.exe');
// Azure Artifact Signing (was: Microsoft-internal ESRP via sign-win32.ts, which
// only works inside Microsoft's tenant). Signs the setup exe + uninstaller when
// gulp runs with --sign; see scripts/v3-sign-win32.ps1 for auth/config.
const azureSignScriptPath = path.join(repoPath, 'scripts', 'v3-sign-win32.ps1');

function packageInnoSetup(iss: string, options: { definitions?: Record<string, unknown> }, cb: (err?: Error | null) => void) {
	const definitions = options.definitions || {};

	if (process.argv.some(arg => arg === '--debug-inno')) {
		definitions['Debug'] = 'true';
	}

	if (process.argv.some(arg => arg === '--sign')) {
		definitions['Sign'] = 'true';
	}

	const keys = Object.keys(definitions);

	keys.forEach(key => assert(typeof definitions[key] === 'string', `Missing value for '${key}' in Inno Setup package step`));

	const defs = keys.map(key => `/d${key}=${definitions[key]}`);
	const args = [
		iss,
		...defs,
		`/strustedsigning=pwsh -NoProfile -ExecutionPolicy Bypass -File ${azureSignScriptPath} -Files $f`
	];

	cp.spawn(innoSetupPath, args, { stdio: ['ignore', 'inherit', 'inherit'] })
		.on('error', cb)
		.on('exit', code => {
			if (code === 0) {
				cb(null);
			} else {
				cb(new Error(`InnoSetup returned exit code: ${code}`));
			}
		});
}

function buildWin32Setup(arch: string, target: string): task.CallbackTask {
	if (target !== 'system' && target !== 'user') {
		throw new Error('Invalid setup target');
	}

	return (cb) => {
		const x64AppId = target === 'system' ? product.win32x64AppId : product.win32x64UserAppId;
		const arm64AppId = target === 'system' ? product.win32arm64AppId : product.win32arm64UserAppId;

		const sourcePath = buildPath(arch);
		const outputPath = setupDir(arch, target);
		fs.mkdirSync(outputPath, { recursive: true });

		const quality = (product as typeof product & { quality?: string }).quality || 'dev';
		const useVersionedUpdate = (product as typeof product & { win32VersionedUpdate?: boolean })?.win32VersionedUpdate;
		const versionedResourcesFolder = useVersionedUpdate ? commit!.substring(0, 10) : '';
		const issPath = path.join(import.meta.dirname, 'win32', 'code.iss');
		const originalProductJsonPath = path.join(sourcePath, versionedResourcesFolder, 'resources/app/product.json');
		const productJsonPath = path.join(outputPath, 'product.json');
		const productJson = JSON.parse(fs.readFileSync(originalProductJsonPath, 'utf8'));
		productJson['target'] = target;

		const definitions: Record<string, unknown> = {
			NameLong: product.nameLong,
			NameShort: product.nameShort,
			DirName: product.win32DirName,
			Version: pkg.version,
			RawVersion: pkg.version.replace(/-\w+$/, ''),
			Commit: commit,
			NameVersion: product.win32NameVersion + (target === 'user' ? ' (User)' : ''),
			ExeBasename: product.nameShort,
			RegValueName: product.win32RegValueName,
			ShellNameShort: product.win32ShellNameShort,
			AppMutex: product.win32MutexName,
			TunnelMutex: product.win32TunnelMutex,
			TunnelServiceMutex: product.win32TunnelServiceMutex,
			TunnelApplicationName: product.tunnelApplicationName,
			ApplicationName: product.applicationName,
			Arch: arch,
			AppId: { 'x64': x64AppId, 'arm64': arm64AppId }[arch],
			IncompatibleTargetAppId: { 'x64': product.win32x64AppId, 'arm64': product.win32arm64AppId }[arch],
			AppUserId: product.win32AppUserModelId,
			ArchitecturesAllowed: { 'x64': 'x64', 'arm64': 'arm64' }[arch],
			ArchitecturesInstallIn64BitMode: { 'x64': 'x64', 'arm64': 'arm64' }[arch],
			SourceDir: sourcePath,
			RepoDir: repoPath,
			OutputDir: outputPath,
			InstallTarget: target,
			ProductJsonPath: productJsonPath,
			VersionedResourcesFolder: versionedResourcesFolder,
			Quality: quality
		};

		// VSCODE_SKIP_WIN32_APPX: build the installer WITHOUT the Explorer right-click
		// integration (the .appx + native explorer-command DLL). Those files aren't
		// produced by the min-ci client build, so referencing them fails ISCC. Skipping
		// them yields a normal double-click installer minus the "Open with" context menu —
		// acceptable for the V3Code beta until the native appx build is wired.
		if ((quality === 'stable' || quality === 'insider') && !process.env['VSCODE_SKIP_WIN32_APPX']) {
			definitions['AppxPackage'] = `${quality === 'stable' ? 'code' : 'code_insider'}_${arch}.appx`;
			definitions['AppxPackageDll'] = `${quality === 'stable' ? 'code' : 'code_insider'}_explorer_command_${arch}.dll`;
			definitions['AppxPackageName'] = `${product.win32AppUserModelId}`;
			const ctxMenu = (product as { win32ContextMenu?: Record<string, { clsid: string }> }).win32ContextMenu;
			if (ctxMenu && ctxMenu[arch]) {
				definitions['FileExplorerContextMenuCLSID'] = ctxMenu[arch].clsid;
			}
		}

		fs.writeFileSync(productJsonPath, JSON.stringify(productJson, undefined, '\t'));

		packageInnoSetup(issPath, { definitions }, cb as (err?: Error | null) => void);
	};
}

function defineWin32SetupTasks(arch: string, target: string) {
	const cleanTask = util.rimraf(setupDir(arch, target));
	task.task(task.define(`vscode-win32-${arch}-${target}-setup`, task.series(cleanTask, buildWin32Setup(arch, target))));
}

defineWin32SetupTasks('x64', 'system');
defineWin32SetupTasks('arm64', 'system');
defineWin32SetupTasks('x64', 'user');
defineWin32SetupTasks('arm64', 'user');

function copyInnoUpdater(arch: string) {
	return () => {
		return gulp.src('build/win32/{inno_updater.exe,vcruntime140.dll}', { base: 'build/win32' })
			.pipe(vfs.dest(path.join(buildPath(arch), 'tools')));
	};
}

/**
 * Copies the built native computer-use helper into the packaged win32 tree.
 *
 * Modelled on {@link copyInnoUpdater}, with three deliberate differences:
 *
 * 1. The destination is `resources/computerUse/win32/`, NOT `tools/`. `build/win32/code.iss`
 *    excludes `\tools` from its recursive copy and installs it separately, whereas anything under
 *    `resources/` is picked up by the installer's `Source: "*"` wildcard with no `.iss` change.
 * 2. The file is renamed to `v3code-computer-use-helper.exe` — the build script emits
 *    `v3code-computer-use.exe`, but `HELPER_FILE_NAME` in
 *    src/vs/workbench/contrib/computerUse/electron-main/computerUseHelperInstaller.ts is the only
 *    name the app looks for.
 * 3. A missing helper is a no-op, not a failure. `gulp.src` is given `allowEmpty` so a package run
 *    on a machine without MSVC still succeeds; the feature degrades dark (the installer reports
 *    `helperMissing` and computer use stays unavailable).
 *
 * Ordering: this must run before scripts/v3-sign-win32.ps1, which signs `-Folder` recursively and
 * therefore picks the helper up automatically. It must not run after — Authenticode over a tree does
 * not retroactively cover a file added later.
 */
function copyComputerUseHelper(arch: string) {
	return () => {
		const source = path.join(repoPath, '.build', 'computer-use', `win32-${arch}`, 'v3code-computer-use.exe');
		if (!fs.existsSync(source)) {
			console.warn(`[computerUse] no helper at ${source} — packaging without it; computer use will be unavailable in this build. Build it with scripts/build-computer-use-helper-win32.ps1 -Arch ${arch}.`);
		}
		const versionedResourcesFolder = util.getVersionedResourcesFolder('win32', commit!);
		return gulp.src(source, { base: path.dirname(source), allowEmpty: true })
			.pipe(rename(f => { f.basename = 'v3code-computer-use-helper'; f.extname = '.exe'; }))
			.pipe(vfs.dest(path.join(buildPath(arch), versionedResourcesFolder, 'resources', 'computerUse', 'win32')));
	};
}

function updateIcon(executablePath: string): task.CallbackTask {
	return cb => {
		const icon = path.join(repoPath, 'resources', 'win32', 'code.ico');
		rcedit(executablePath, { icon }, cb);
	};
}

// copyComputerUseHelper is appended to the inno-updater series, not given a step of its own in the
// packaging script, because `vscode-win32-<arch>-inno-updater` is the only post-package /
// pre-signing win32 gulp task scripts/v3-package-win32.sh invokes. Wiring it here puts the helper in
// the tree before v3-sign-win32.ps1 -Folder sweeps it up, with no edit to the packaging script. It is
// also exposed standalone below; if the packaging script ever calls that task directly, remove it
// from these two series so the copy is not done twice.
task.task(task.define('vscode-win32-x64-inno-updater', task.series(copyInnoUpdater('x64'), updateIcon(path.join(buildPath('x64'), 'tools', 'inno_updater.exe')), copyComputerUseHelper('x64'))));
task.task(task.define('vscode-win32-arm64-inno-updater', task.series(copyInnoUpdater('arm64'), updateIcon(path.join(buildPath('arm64'), 'tools', 'inno_updater.exe')), copyComputerUseHelper('arm64'))));

task.task(task.define('vscode-win32-x64-computer-use-helper', copyComputerUseHelper('x64')));
task.task(task.define('vscode-win32-arm64-computer-use-helper', copyComputerUseHelper('arm64')));
