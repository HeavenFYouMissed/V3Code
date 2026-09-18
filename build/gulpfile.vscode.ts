/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { gulp, rename, replace, filter, jsonEditor } from './lib/gulp/facade.ts';
import * as fs from 'fs';
import * as path from 'path';
import es from 'event-stream';
import merge2 from 'merge2';
import vfs from 'vinyl-fs';
import electron from '@vscode/gulp-electron';
import * as util from './lib/util.ts';
import { getVersion } from './lib/getVersion.ts';
import { readISODate, writeISODate } from './lib/date.ts';
import * as task from './lib/gulp/task.ts';
import buildfile from './buildfile.ts';
import * as optimize from './lib/optimize.ts';
import { inlineMeta } from './lib/inlineMeta.ts';
import packageJson from '../package.json' with { type: 'json' };
import product from '../product.json' with { type: 'json' };
import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as i18n from './lib/i18n.ts';
import { getProductionDependencies } from './lib/dependencies.ts';
import { config } from './lib/electron.ts';
import { createAsar } from './lib/asar.ts';
import minimist from 'minimist';
import { compileBuildWithoutManglingTask, compileBuildWithManglingTask } from './gulpfile.compile.ts';
import { compileNonNativeExtensionsBuildTask, compileNativeExtensionsBuildTask, compileAllExtensionsBuildTask, compileExtensionMediaBuildTask, cleanExtensionsBuildTask, compileCopilotExtensionBuildTask } from './gulpfile.extensions.ts';
import { copyCodiconsTask } from './lib/compilation.ts';
import { getCopilotExcludeFilter, getRipgrepExcludeFilter, prepareBuiltInCopilotRipgrepShim } from './lib/copilot.ts';
import { getNodeLlamaCppExcludeFilter } from './lib/nodeLlamaCpp.ts';
import { useEsbuildTranspile } from './buildConfig.ts';
import { promisify } from 'util';
import globCallback from 'glob';
import rceditCallback from 'rcedit';
import { spawnTsgo } from './lib/tsgo.ts';
import { runEsbuildTranspile, runEsbuildBundle } from './lib/esbuild.ts';


const glob = promisify(globCallback);
const rcedit = promisify(rceditCallback);
const root = path.dirname(import.meta.dirname);
// Release worktrees used to all write to the parent checkout directory
// (`../VSCode-darwin-arm64` / `../VSCode-win32-x64`). One lane could therefore replace the app
// after another lane packaged or signed it, and a smoke test would silently exercise the wrong
// commit. Release scripts pin V3_BUILD_ROOT to a commit-scoped directory; ordinary upstream/dev
// tasks retain the historical parent-directory default.
const buildRoot = process.env['V3_BUILD_ROOT']
	? path.resolve(process.env['V3_BUILD_ROOT'])
	: path.dirname(root);
const commit = getVersion(root);

// event-stream@3.3.4's merge() calls pipe() before it registers each source's `end` listener.
// A fast or empty package source can therefore end in that gap, leaving Gulp waiting forever even
// though every byte reached the destination. merge2 registers first, handles already-ended streams,
// and propagates source errors. Keep the replacement scoped to packaging; other upstream build tasks
// retain their established stream behavior.
const mergePackageStreams = (...streams: NodeJS.ReadableStream[]): NodeJS.ReadWriteStream =>
	merge2(streams, { objectMode: true, pipeError: true });

// Build
const vscodeEntryPoints = [
	buildfile.workerEditor,
	buildfile.workerExtensionHost,
	buildfile.workerNotebook,
	buildfile.workerLanguageDetection,
	buildfile.workerLocalFileSearch,
	buildfile.workerProfileAnalysis,
	buildfile.workerOutputLinks,
	buildfile.workerBackgroundTokenization,
	buildfile.workbenchDesktop,
	buildfile.code
].flat();

const vscodeResourceIncludes = [

	// NLS
	'out-build/nls.messages.json',
	'out-build/nls.keys.json',

	// Workbench
	'out-build/vs/code/electron-browser/workbench/workbench.html',
	'out-build/vs/sessions/electron-browser/sessions.html',

	// Electron Preload
	'out-build/vs/base/parts/sandbox/electron-browser/preload.js',
	'out-build/vs/base/parts/sandbox/electron-browser/preload-aux.js',
	'out-build/vs/platform/browserView/electron-browser/preload-browserView.js',

	// Node Scripts
	'out-build/vs/base/node/{terminateProcess.sh,cpuUsage.sh,ps.sh}',

	// Touchbar
	'out-build/vs/workbench/browser/parts/editor/media/*.png',
	'out-build/vs/workbench/contrib/debug/browser/media/*.png',

	// External Terminal
	'out-build/vs/workbench/contrib/externalTerminal/**/*.scpt',

	// Terminal shell integration
	'out-build/vs/workbench/contrib/terminal/common/scripts/*.fish',
	'out-build/vs/workbench/contrib/terminal/common/scripts/*.ps1',
	'out-build/vs/workbench/contrib/terminal/common/scripts/*.psm1',
	'out-build/vs/workbench/contrib/terminal/common/scripts/*.sh',
	'out-build/vs/workbench/contrib/terminal/common/scripts/*.zsh',
	'out-build/vs/workbench/contrib/terminal/common/scripts/psreadline/**',

	// Accessibility Signals
	'out-build/vs/platform/accessibilitySignal/browser/media/*.mp3',

	// Welcome
	'out-build/vs/workbench/contrib/welcomeGettingStarted/common/media/**/*.{svg,png}',
	'out-build/vs/workbench/contrib/welcomeOnboarding/browser/media/*.svg',

	// Sessions
	'out-build/vs/sessions/contrib/chat/browser/media/*.svg',
	'out-build/vs/sessions/contrib/welcome/browser/media/*.svg',
	'out-build/vs/sessions/contrib/welcome/browser/media/themePreviews/*.svg',
	'out-build/vs/sessions/prompts/*.prompt.md',
	'out-build/vs/sessions/skills/**/SKILL.md',

	// V3Code brand art (agent welcome devil + optional hero media). This is an allowlist:
	// without an entry the packaged app silently ships without the images and the welcome
	// icon renders blank, while dev builds look fine because they read from source.
	'out-build/vs/workbench/contrib/void/browser/media/*.{png,gif,svg,jpg,webp}',

	// Extensions
	'out-build/vs/workbench/contrib/extensions/browser/media/{theme-icon.png,language-icon.svg}',
	'out-build/vs/workbench/services/extensionManagement/common/media/*.{svg,png}',

	// Webview
	'out-build/vs/workbench/contrib/webview/browser/pre/*.{js,html}',

	// Extension Host Worker
	'out-build/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html',

	// Tree Sitter highlights
	'out-build/vs/editor/common/languages/highlights/*.scm',

	// Tree Sitter injection queries
	'out-build/vs/editor/common/languages/injections/*.scm'
];

const vscodeResources = [

	// Includes
	...vscodeResourceIncludes,

	// Excludes
	'!out-build/vs/code/browser/**',
	'!out-build/vs/editor/standalone/**',
	'!out-build/vs/code/**/*-dev.html',
	'!out-build/vs/workbench/contrib/issue/**/*-dev.html',
	'!**/test/**'
];

const bootstrapEntryPoints = [
	'out-build/main.js',
	'out-build/cli.js',
	'out-build/bootstrap-fork.js'
];

const bundleVSCodeTask = task.define('bundle-vscode', task.series(
	util.rimraf('out-vscode'),
	// Optimize: bundles source files automatically based on
	// import statements based on the passed in entry points.
	// In addition, concat window related bootstrap files into
	// a single file.
	optimize.bundleTask(
		{
			out: 'out-vscode',
			esm: {
				src: 'out-build',
				entryPoints: [
					...vscodeEntryPoints,
					...bootstrapEntryPoints
				],
				resources: vscodeResources,
				skipTSBoilerplateRemoval: entryPoint => entryPoint === 'vs/code/electron-browser/workbench/workbench' || entryPoint === 'vs/sessions/electron-browser/sessions'
			}
		}
	)
));
task.task(bundleVSCodeTask);

const sourceMappingURLBase = `https://main.vscode-cdn.net/sourcemaps/${commit}`;
const isCI = !!process.env['CI'] || !!process.env['BUILD_ARTIFACTSTAGINGDIRECTORY'] || !!process.env['GITHUB_WORKSPACE'];
const useCdnSourceMapsForPackagingTasks = isCI;
// Packaged builds must NEVER ship source maps: the bundle maps embed
// `sourcesContent` — the full original TypeScript source — and the shipped .js
// points its sourceMappingURL at the CDN base above, so on-disk maps are dead
// weight for debugging anyway. This was gated on isCI, which the local
// packaging scripts (scripts/v3-package-mac.sh) never set, so every locally
// packaged release shipped the entire source tree (~365MB raw, ~75MB of the
// zip). Dev builds are unaffected: they run from out/ and never enter the
// packaging tasks. Enforced by the no-core-sourcemaps entry in
// build/verify/artifact-manifest.json.
const stripSourceMapsInPackagingTasks = true;
const minifyVSCodeTask = task.define('minify-vscode', task.series(
	bundleVSCodeTask,
	util.rimraf('out-vscode-min'),
	optimize.minifyTask('out-vscode', `${sourceMappingURLBase}/core`)
));
task.task(minifyVSCodeTask);

task.task(task.define('core-ci-old', task.series(
	task.task('compile-build-with-mangling') as task.Task,
	task.parallel(
		task.task('minify-vscode') as task.Task,
		task.task('minify-vscode-reh') as task.Task,
		task.task('minify-vscode-reh-web') as task.Task,
	)
)));

task.task(task.define('core-ci', task.series(
	copyCodiconsTask,
	// compileNonNativeExtensionsBuildTask deliberately does not clean. Release packaging copies
	// `.build/extensions/**` wholesale, so a deleted/renamed extension otherwise survives forever
	// (a retired competitor theme previously survived and registered duplicate theme ids).
	cleanExtensionsBuildTask,
	compileNonNativeExtensionsBuildTask,
	compileExtensionMediaBuildTask,
	writeISODate('out-build'),
	// Type-check with tsgo (no emit)
	task.define('tsgo-typecheck', () => spawnTsgo(path.join(root, 'src', 'tsconfig.json'), { taskName: 'tsgo-typecheck', noEmit: true })),
	// Transpile individual files to out-build first (for unit tests)
	task.define('esbuild-out-build', () => runEsbuildTranspile('out-build', false)),
	// Then bundle for shipping (bundles also write NLS files to out-build)
	task.parallel(
		task.define('esbuild-vscode-min', () => runEsbuildBundle('out-vscode-min', true, true, 'desktop', `${sourceMappingURLBase}/core`)),
		task.define('esbuild-vscode-reh-min', () => runEsbuildBundle('out-vscode-reh-min', true, true, 'server', `${sourceMappingURLBase}/core`)),
		task.define('esbuild-vscode-reh-web-min', () => runEsbuildBundle('out-vscode-reh-web-min', true, true, 'server-web', `${sourceMappingURLBase}/core`)),
	)
)));

// Client-only 'core-ci' for the cross-platform CI runners (v3-build-linux /
// v3-build-windows): identical minus the two remote-server bundles — 16GB
// Actions runners OOM bundling desktop + reh + reh-web in parallel, and the
// client artifact only needs out-vscode-min.
task.task(task.define('core-ci-client', task.series(
	copyCodiconsTask,
	cleanExtensionsBuildTask,
	compileNonNativeExtensionsBuildTask,
	compileExtensionMediaBuildTask,
	writeISODate('out-build'),
	task.define('tsgo-typecheck-client', () => spawnTsgo(path.join(root, 'src', 'tsconfig.json'), { taskName: 'tsgo-typecheck-client', noEmit: true })),
	task.define('esbuild-out-build-client', () => runEsbuildTranspile('out-build', false)),
	task.define('esbuild-vscode-min-client', () => runEsbuildBundle('out-vscode-min', true, true, 'desktop', `${sourceMappingURLBase}/core`)),
)));

/**
 * Compute checksums for some files.
 *
 * @param out The out folder to read the file from.
 * @param filenames The paths to compute a checksum for.
 * @return A map of paths to checksums.
 */
function computeChecksums(out: string, filenames: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	filenames.forEach(function (filename) {
		const fullPath = path.join(process.cwd(), out, filename);
		result[filename] = computeChecksum(fullPath);
	});
	return result;
}

/**
 * Compute checksums for a file.
 *
 * @param filename The absolute path to a filename.
 * @return The checksum for `filename`.
 */
function computeChecksum(filename: string): string {
	const contents = fs.readFileSync(filename);

	const hash = crypto
		.createHash('sha256')
		.update(contents)
		.digest('base64')
		.replace(/=+$/, '');

	return hash;
}

/**
 * File name the native computer-use helper ships under.
 *
 * Must equal `HELPER_FILE_NAME` in
 * src/vs/workbench/contrib/computerUse/electron-main/computerUseHelperInstaller.ts — that is the
 * only name the app looks for.
 *
 * The two build scripts disagree on what they emit, so the copy below still renames: win32 emits
 * the bare SwiftPM/product name `v3code-computer-use.exe`, while darwin already emits the suffixed
 * `v3code-computer-use-helper` (it was changed to match the installer, precisely so a hand-built
 * helper would not be invisible to the app). Read getComputerUseHelperSourcePath with this in mind
 * — assuming both scripts emitted the bare name is what made darwin packaging look in the wrong
 * place and drop the helper silently.
 */
export function getComputerUseHelperFileName(platform: string): string {
	return platform === 'win32' ? 'v3code-computer-use-helper.exe' : 'v3code-computer-use-helper';
}

/**
 * Absolute path where the platform's helper build script leaves its output, or `undefined` on a
 * platform that has no helper.
 *
 * darwin: scripts/build-computer-use-helper-darwin.sh (universal arm64 + x86_64)
 * win32:  scripts/build-computer-use-helper-win32.ps1 (per-arch)
 */
export function getComputerUseHelperSourcePath(platform: string, arch: string): string | undefined {
	if (platform === 'darwin') {
		// scripts/build-computer-use-helper-darwin.sh finishes by MOVING the linked binary into a
		// signed `.app` — a dev helper's Accessibility and Screen Recording grants are keyed to a
		// bundle identity and would be lost on every rebuild otherwise — so the bare path it uses
		// mid-build does not exist once the script completes. Shipping the inner binary rather than
		// the bundle is correct: build/darwin/sign.ts matches this destination path to apply the
		// helper's own entitlements and identifier, so it is re-signed with the product identity as
		// part of signing the app, and the installer resolves a plain file.
		//
		// This previously pointed at the SwiftPM product name, which the script stopped writing long
		// ago, so even a correctly built helper failed the existsSync check and was dropped.
		const buildDir = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'computerUse', 'helper', 'darwin', '.build');
		const bundled = path.join(buildDir, 'V3Code Computer Use.app', 'Contents', 'MacOS', 'v3code-computer-use-helper');
		return fs.existsSync(bundled) ? bundled : path.join(buildDir, 'v3code-computer-use-helper');
	}
	if (platform === 'win32') {
		return path.join(root, '.build', 'computer-use', `win32-${arch}`, 'v3code-computer-use.exe');
	}
	return undefined;
}

/**
 * Stream placing the built computer-use helper into the packaged darwin bundle, or `undefined` when
 * no helper was built.
 *
 * The destination is `Contents/Resources/computerUse/darwin/`, deliberately a sibling of
 * `Resources/app` rather than inside it: the helper is spawned as a process, and a binary inside
 * `node_modules.asar` cannot be spawned. This must therefore be merged AFTER the `electron()` pipe,
 * because `@vscode/gulp-electron` rewrites every vinyl reaching it to live under `Resources/app`.
 * `build/darwin/sign.ts` matches this exact path fragment to pick the helper's entitlements and
 * bundle identifier, and `@electron/osx-sign` signs it inside-out before the app, so the helper's
 * signature is sealed into the bundle's CodeResources.
 *
 * A missing helper is not a packaging failure for a DEV build. Requiring a Swift toolchain for every
 * package run would break plain client builds; there the feature degrades dark — the installer finds
 * no bundled helper, reports `helperMissing`, and computer use stays unavailable.
 *
 * For a RELEASE build it is fatal. Degrading dark shipped every build to date without the helper:
 * nothing in the release path builds it (no ship script calls build-computer-use-helper-darwin.sh),
 * so `isAvailable` was permanently false and all sixteen `computer_*` tools silently failed to
 * register. The only symptom users and agents ever saw was `was not contributed`, which reads as
 * "this feature does not exist" — a whole shipped feature lost to a warning that scrolled past in
 * CI. A release that cannot do what it advertises should fail here rather than at the user.
 */
function computerUseHelperStream(platform: string, arch: string): NodeJS.ReadWriteStream | undefined {
	const source = getComputerUseHelperSourcePath(platform, arch);
	if (!source) {
		return undefined;
	}
	if (!fs.existsSync(source)) {
		const build = `Build it with scripts/build-computer-use-helper-${platform === 'win32' ? 'win32.ps1' : 'darwin.sh'}.`;
		// Opt-in rather than keyed off VSCODE_QUALITY: every packaging script sets that, including
		// v3-package-win32.sh, and no win32 path builds the helper yet — so a quality-based check
		// would have broken Windows packaging outright to enforce something Windows cannot satisfy.
		// The flag is set by whichever script has actually built the helper first.
		if (process.env['V3_REQUIRE_COMPUTER_USE_HELPER']) {
			throw new Error(`[computerUse] no helper at ${source}, but V3_REQUIRE_COMPUTER_USE_HELPER is set. Shipping without it disables every computer_* tool with no user-visible reason. ${build}`);
		}
		console.warn(`[computerUse] no helper at ${source} — packaging without it; computer use will be unavailable in this build. ${build}`);
		return undefined;
	}

	return gulp.src(source, { base: path.dirname(source) })
		.pipe(rename(f => {
			f.dirname = `${product.nameLong}.app/Contents/Resources/computerUse/${platform}`;
			f.basename = getComputerUseHelperFileName(platform);
			f.extname = '';
		}))
		// util.setExecutableBit is called with a pattern elsewhere in this file (['**/*.sh']), which
		// would not match a binary — so the helper gets its own unfiltered call.
		.pipe(util.setExecutableBit());
}

function packageTask(platform: string, arch: string, sourceFolderName: string, destinationFolderName: string, _opts?: { stats?: boolean }) {
	const destination = path.join(buildRoot, destinationFolderName);
	platform = platform || process.platform;

	const task = () => {
		const out = sourceFolderName;
		const versionedResourcesFolder = util.getVersionedResourcesFolder(platform, commit!);

		const checksums = computeChecksums(out, [
			'vs/base/parts/sandbox/electron-browser/preload.js',
			'vs/workbench/workbench.desktop.main.js',
			'vs/workbench/workbench.desktop.main.css',
			'vs/workbench/api/node/extensionHostProcess.js',
			'vs/code/electron-browser/workbench/workbench.html',
			'vs/code/electron-browser/workbench/workbench.js',
			'vs/sessions/sessions.desktop.main.js',
			'vs/sessions/sessions.desktop.main.css',
			'vs/sessions/electron-browser/sessions.html',
			'vs/sessions/electron-browser/sessions.js'
		]);

		const src = gulp.src(out + '/**', { base: '.' })
			.pipe(rename(function (path) { path.dirname = path.dirname!.replace(new RegExp('^' + out), 'out'); }))
			.pipe(util.setExecutableBit(['**/*.sh']));

		// product.builtInExtensions is [] in product.json, which TS infers as
		// never[]; type the entries explicitly so .name/.platforms resolve.
		const builtInExtensionEntries: { name: string; platforms?: string[] }[] = product.builtInExtensions;
		const platformSpecificBuiltInExtensionsExclusions = builtInExtensionEntries.filter(ext => {
			if (!ext.platforms) {
				return false;
			}

			const set = new Set(ext.platforms);
			return !set.has(platform);
		}).map(ext => `!.build/extensions/${ext.name}/**`);

		const extensions = gulp.src(['.build/extensions/**', ...platformSpecificBuiltInExtensionsExclusions], { base: '.build', dot: true });

		const sourceFilterPattern = stripSourceMapsInPackagingTasks
			? ['**', '!**/*.{js,css}.map']
			: ['**'];
		const sources = mergePackageStreams(src, extensions)
			.pipe(filter(sourceFilterPattern, { dot: true }));

		let version = packageJson.version;
		const quality = (product as { quality?: string }).quality;

		if (quality && quality !== 'stable') {
			version += '-' + quality;
		}

		const name = product.nameShort;
		const packageJsonUpdates: Record<string, unknown> = { name, version };

		if (platform === 'linux') {
			packageJsonUpdates.desktopName = `${product.applicationName}.desktop`;
		}

		let packageJsonContents: string;
		const packageJsonStream = gulp.src(['package.json'], { base: '.' })
			.pipe(jsonEditor(packageJsonUpdates))
			.pipe(es.through(function (file) {
				packageJsonContents = file.contents.toString();
				this.emit('data', file);
			}));

		let productJsonContents: string;
		const productJsonStream = gulp.src(['product.json'], { base: '.' })
			.pipe(jsonEditor((json: Record<string, unknown>) => {
				json.commit = commit;
				json.date = readISODate(out);
				json.checksums = checksums;
				json.version = version;
				return json;
			}))
			.pipe(es.through(function (file) {
				productJsonContents = file.contents.toString();
				this.emit('data', file);
			}));

		const license = gulp.src([product.licenseFileName, 'ThirdPartyNotices.txt', 'licenses/**'], { base: '.', allowEmpty: true });

		// TODO the API should be copied to `out` during compile, not here
		const api = gulp.src('src/vscode-dts/vscode.d.ts').pipe(rename('out/vscode-dts/vscode.d.ts'));

		const telemetry = gulp.src('.build/telemetry/**', { base: '.build/telemetry', dot: true });

		const jsFilter = util.filter(data => !data.isDirectory() && /\.js$/.test(data.path));
		const root = path.resolve(path.join(import.meta.dirname, '..'));
		const productionDependencies = getProductionDependencies(root);
		const dependenciesSrc = productionDependencies.map(d => path.relative(root, d)).map(d => [`${d}/**`, `!${d}/**/{test,tests}/**`]).flat().concat('!**/*.mk');

		const depFilterPattern = ['**', `!**/${config.version}/**`, '!**/bin/darwin-arm64-87/**', '!**/package-lock.json', '!**/yarn.lock'];
		if (stripSourceMapsInPackagingTasks) {
			depFilterPattern.push('!**/*.{js,css}.map');
		}

		// V3Code ships without Copilot: do NOT re-add the @github/copilot
		// runtime prebuild that .moduleignore strips — it existed only for the
		// (removed) CopilotAgent agent-host provider.
		const deps = gulp.src(dependenciesSrc, { base: '.', dot: true })
			.pipe(filter(depFilterPattern))
			.pipe(util.cleanNodeModules(path.join(import.meta.dirname, '.moduleignore')))
			.pipe(util.cleanNodeModules(path.join(import.meta.dirname, `.moduleignore.${process.platform}`)))
			.pipe(filter(getCopilotExcludeFilter(platform, arch)))
			.pipe(filter(getRipgrepExcludeFilter(platform, arch)))
			.pipe(filter(getNodeLlamaCppExcludeFilter(platform, arch)))
			.pipe(jsFilter)
			.pipe(util.rewriteSourceMappingURL(sourceMappingURLBase))
			.pipe(jsFilter.restore)
			.pipe(createAsar(path.join(process.cwd(), 'node_modules'), [
				'**/*.node',
				'**/@node-llama-cpp/**', // .node + .dll — must not live inside ASAR (mirrors sqlite3 precedent)
				'**/@vscode/ripgrep-universal/bin/**',
				'**/@github/copilot-*/**',
				'**/node-pty/build/Release/*',
				'**/node-pty/build/Release/conpty/*',
				'**/node-pty/lib/worker/conoutSocketWorker.js',
				'**/node-pty/lib/shared/conout.js',
				'**/*.wasm',
				'**/@vscode/vsce-sign/bin/*',
			], [
				'**/*.mk',
				'!node_modules/vsda/**' // stay compatible with extensions that depend on us shipping `vsda` into ASAR
			], [
				'node_modules/vsda/**' // retain copy of `vsda` in node_modules for internal use
			], 'node_modules.asar'));

		// V3Code bundled product content — shipped with every install, independent of workspace.
		// `.v3code` also contains mutable repository/workspace state. Copying the directory wholesale
		// leaked PROJECT_STATUS.md into 0093 and made the package fail its own forbidden-state gate.
		// Keep this an allowlist so future local state cannot silently become product data.
		const v3codeBundled = gulp.src([
			'.v3code/mcp/**',
			'.v3code/rules/**',
			'.v3code/skills/**'
		], { base: '.', dot: true, allowEmpty: true });

		const mergeStreams = [
			packageJsonStream,
			productJsonStream,
			license,
			api,
			telemetry,
			sources,
			deps,
			v3codeBundled,
		];
		let all = mergePackageStreams(...mergeStreams);

		if (platform === 'win32') {
			all = mergePackageStreams(all, gulp.src([
				'resources/win32/bower.ico',
				'resources/win32/c.ico',
				'resources/win32/code.ico',
				'resources/win32/config.ico',
				'resources/win32/cpp.ico',
				'resources/win32/csharp.ico',
				'resources/win32/css.ico',
				'resources/win32/default.ico',
				'resources/win32/go.ico',
				'resources/win32/html.ico',
				'resources/win32/jade.ico',
				'resources/win32/java.ico',
				'resources/win32/javascript.ico',
				'resources/win32/json.ico',
				'resources/win32/less.ico',
				'resources/win32/markdown.ico',
				'resources/win32/php.ico',
				'resources/win32/powershell.ico',
				'resources/win32/python.ico',
				'resources/win32/react.ico',
				'resources/win32/ruby.ico',
				'resources/win32/sass.ico',
				'resources/win32/shell.ico',
				'resources/win32/sql.ico',
				'resources/win32/typescript.ico',
				'resources/win32/vue.ico',
				'resources/win32/xml.ico',
				'resources/win32/yaml.ico',
				'resources/win32/code_70x70.png',
				'resources/win32/code_150x150.png'
			], { base: '.' }));
		} else if (platform === 'linux') {
			const policyDest = gulp.src('.build/policies/linux/**', { base: '.build/policies/linux' })
				.pipe(rename(f => f.dirname = `policies/${f.dirname}`));
			all = mergePackageStreams(all, gulp.src('resources/linux/code.png', { base: '.' }), policyDest);
		} else if (platform === 'darwin') {
			const shortcut = gulp.src('resources/darwin/bin/code.sh')
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(replace('@@NAME@@', product.nameShort))
				.pipe(rename('bin/code'));
			const policyDest = gulp.src('.build/policies/darwin/**', { base: '.build/policies/darwin' })
				.pipe(rename(f => f.dirname = `policies/${f.dirname}`));
			all = mergePackageStreams(all, shortcut, policyDest);
		}

		const electronConfig = {
			...config,
			platform,
			arch: arch === 'armhf' ? 'arm' : arch,
			ffmpegChromium: false
		};

		let result: NodeJS.ReadWriteStream = all
			.pipe(util.skipDirectories())
			.pipe(util.fixWin32DirectoryPermissions())
			.pipe(filter(['**', '!**/.github/**'], { dot: true })) // https://github.com/microsoft/vscode/issues/116523
			.pipe(electron(electronConfig))
			.pipe(filter([
				'**',
				'!LICENSE',
				'!version',
				...(platform === 'darwin' ? ['!**/Contents/Applications', '!**/Contents/Applications/**'] : []),
				...(platform === 'win32' ? ['!**/electron_proxy.exe'] : []),
			], { dot: true }));

		if (platform === 'linux') {
			result = mergePackageStreams(result, gulp.src('resources/completions/bash/code', { base: '.' })
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(rename(function (f) { f.basename = product.applicationName; })));

			result = mergePackageStreams(result, gulp.src('resources/completions/zsh/_code', { base: '.' })
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(rename(function (f) { f.basename = '_' + product.applicationName; })));
		}

		if (platform === 'win32') {
			result = mergePackageStreams(result, gulp.src('resources/win32/bin/code.js', { base: 'resources/win32', allowEmpty: true }));

			if (versionedResourcesFolder) {
				result = mergePackageStreams(result, gulp.src('resources/win32/versioned/bin/code.cmd', { base: 'resources/win32/versioned' })
					.pipe(replace('@@NAME@@', product.nameShort))
					.pipe(replace('@@VERSIONFOLDER@@', versionedResourcesFolder))
					.pipe(rename(function (f) { f.basename = product.applicationName; })));

				result = mergePackageStreams(result, gulp.src('resources/win32/versioned/bin/code.sh', { base: 'resources/win32/versioned' })
					.pipe(replace('@@NAME@@', product.nameShort))
					.pipe(replace('@@PRODNAME@@', product.nameLong))
					.pipe(replace('@@VERSION@@', version))
					.pipe(replace('@@COMMIT@@', String(commit)))
					.pipe(replace('@@APPNAME@@', product.applicationName))
					.pipe(replace('@@VERSIONFOLDER@@', versionedResourcesFolder))
					.pipe(replace('@@SERVERDATAFOLDER@@', product.serverDataFolderName || '.vscode-remote'))
					.pipe(replace('@@QUALITY@@', quality!))
					.pipe(rename(function (f) { f.basename = product.applicationName; f.extname = ''; })));
			} else {
				result = mergePackageStreams(result, gulp.src('resources/win32/bin/code.cmd', { base: 'resources/win32' })
					.pipe(replace('@@NAME@@', product.nameShort))
					.pipe(rename(function (f) { f.basename = product.applicationName; })));

				result = mergePackageStreams(result, gulp.src('resources/win32/bin/code.sh', { base: 'resources/win32' })
					.pipe(replace('@@NAME@@', product.nameShort))
					.pipe(replace('@@PRODNAME@@', product.nameLong))
					.pipe(replace('@@VERSION@@', version))
					.pipe(replace('@@COMMIT@@', String(commit)))
					.pipe(replace('@@APPNAME@@', product.applicationName))
					.pipe(replace('@@SERVERDATAFOLDER@@', product.serverDataFolderName || '.vscode-remote'))
					.pipe(replace('@@QUALITY@@', String(quality)))
					.pipe(rename(function (f) { f.basename = product.applicationName; f.extname = ''; })));
			}

			result = mergePackageStreams(result, gulp.src('resources/win32/VisualElementsManifest.xml', { base: 'resources/win32' })
				.pipe(replace('@@VERSIONFOLDER@@', versionedResourcesFolder ? `${versionedResourcesFolder}\\` : ''))
				.pipe(rename(product.nameShort + '.VisualElementsManifest.xml')));

			result = mergePackageStreams(result, gulp.src('.build/policies/win32/**', { base: '.build/policies/win32' })
				.pipe(rename(f => f.dirname = `policies/${f.dirname}`)));

			if (quality === 'stable' || quality === 'insider') {
				result = mergePackageStreams(result, gulp.src('.build/win32/appx/**', { base: '.build/win32' }));
				const rawVersion = version.replace(/-\w+$/, '').split('.');
				const appxVersion = `${rawVersion[0]}.0.${rawVersion[1]}.${rawVersion[2]}`;
				result = mergePackageStreams(result, gulp.src('resources/win32/appx/AppxManifest.xml', { base: '.' })
					.pipe(replace('@@AppxPackageName@@', product.win32AppUserModelId))
					.pipe(replace('@@AppxPackageVersion@@', appxVersion))
					.pipe(replace('@@AppxPackageDisplayName@@', product.nameLong))
					.pipe(replace('@@AppxPackageDescription@@', product.win32NameVersion))
					.pipe(replace('@@ApplicationIdShort@@', product.win32RegValueName))
					.pipe(replace('@@ApplicationExe@@', product.nameShort + '.exe'))
					.pipe(replace('@@FileExplorerContextMenuID@@', quality === 'stable' ? 'OpenWithCode' : 'OpenWithCodeInsiders'))
					.pipe(replace('@@FileExplorerContextMenuCLSID@@', (product as { win32ContextMenu?: Record<string, { clsid: string }> }).win32ContextMenu![arch].clsid))
					.pipe(replace('@@FileExplorerContextMenuDLL@@', `${quality === 'stable' ? 'code' : 'code_insider'}_explorer_command_${arch}.dll`))
					.pipe(rename(f => f.dirname = `appx/manifest`)));
			}
		} else if (platform === 'linux') {
			result = mergePackageStreams(result, gulp.src('resources/linux/bin/code.sh', { base: '.' })
				.pipe(replace('@@PRODNAME@@', product.nameLong))
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(rename('bin/' + product.applicationName)));
		} else if (platform === 'darwin') {
			// The native computer-use helper, if one was built. Merged here (post-electron) so it
			// lands beside Resources/app instead of inside it. See computerUseHelperStream.
			// The win32 equivalent lives in gulpfile.vscode.win32.ts.
			const computerUseHelper = computerUseHelperStream(platform, arch);
			if (computerUseHelper) {
				result = mergePackageStreams(result, computerUseHelper);
			}
		}

		result = inlineMeta(result, {
			targetPaths: bootstrapEntryPoints,
			packageJsonFn: () => packageJsonContents,
			productJsonFn: () => productJsonContents
		});

		return result.pipe(vfs.dest(destination));
	};
	task.taskName = `package-${platform}-${arch}`;
	return task;
}

function hasAuthenticodeSignature(filePath: string): Promise<boolean> {
	return new Promise(resolve => {
		const proc = cp.spawn('signtool.exe', ['verify', '/pa', filePath]);
		// Absence of signtool means "not signed", NOT "cannot continue". This
		// rejected on ENOENT, and stripAuthenticodeSignature() calls it
		// UNCONDITIONALLY — that function exists to hand rcedit an unsigned PE,
		// and --sign never gated it. signtool.exe ships only with the Windows SDK
		// and is on PATH only inside a Developer Command Prompt, so packaging
		// V3Code for Windows was impossible on any machine without the SDK. Every
		// Windows packaging defect was therefore discoverable only at CI latency
		// (~50 min) instead of locally (~10 min) — which is why several shipped.
		// A machine that cannot RUN signtool cannot have PRODUCED an Authenticode
		// signature here either, and the only consumer of this answer is "must I
		// strip one before rcedit". CI is unaffected: the runner has the SDK, so
		// the real verify still runs where it matters, and the signing paths
		// (v3-sign-win32.ps1, the post-sign Authenticode assert) are untouched.
		proc.on('error', () => resolve(false));
		proc.on('exit', code => resolve(code === 0));
	});
}

async function stripAuthenticodeSignature(filePath: string): Promise<void> {
	// ESRP's `signtool /as` (append) fails with 0x800700C1 on PEs whose existing
	// Authenticode signature was invalidated by rcedit. Strip cleanly first so
	// rcedit operates on an unsigned PE.
	if (!await hasAuthenticodeSignature(filePath)) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const proc = cp.spawn('signtool.exe', ['remove', '/s', filePath]);
		let out = '';
		proc.stdout?.on('data', chunk => out += chunk.toString());
		proc.stderr?.on('data', chunk => out += chunk.toString());
		proc.on('error', reject);
		proc.on('exit', code => {
			if (code === 0) {
				resolve();
			} else {
				process.stderr.write(out);
				reject(new Error(`signtool remove /s failed for ${filePath} (exit ${code})`));
			}
		});
	});
}

function patchWin32DependenciesTask(destinationFolderName: string) {
	const cwd = path.join(buildRoot, destinationFolderName);

	return async () => {
		const versionedResourcesFolder = util.getVersionedResourcesFolder('win32', commit!);
		const deps = (await Promise.all([
			// Skip foreign-platform binaries: onnxruntime-node (and friends) ship
			// linux/darwin natives inside one npm package; rcedit can only patch PEs.
			glob('**/*.node', {
				cwd, ignore: [
					'extensions/node_modules/@parcel/watcher/**',
					'**/napi-v3/linux/**',
					'**/napi-v3/darwin/**',
					'**/prebuilds/linux*/**',
					'**/prebuilds/darwin*/**',
					'**/prebuilds/android*/**',
				]
			}),
			glob('**/rg.exe', { cwd }),
			glob('**/*explorer_command*.dll', { cwd }),
		])).flatMap(o => o);
		const packageJson = JSON.parse(await fs.promises.readFile(path.join(cwd, versionedResourcesFolder, 'resources', 'app', 'package.json'), 'utf8'));
		const product = JSON.parse(await fs.promises.readFile(path.join(cwd, versionedResourcesFolder, 'resources', 'app', 'product.json'), 'utf8'));
		const baseVersion = packageJson.version.replace(/-.*$/, '');

		const patchPromises = deps.map<Promise<unknown>>(async dep => {
			const basename = path.basename(dep);
			const fullPath = path.join(cwd, dep);

			await stripAuthenticodeSignature(fullPath);
			await rcedit(fullPath, {
				'file-version': baseVersion,
				'version-string': {
					'CompanyName': 'Microsoft Corporation',
					'FileDescription': product.nameLong,
					'FileVersion': packageJson.version,
					'InternalName': basename,
					'LegalCopyright': 'Copyright (C) 2026 Microsoft. All rights reserved',
					'OriginalFilename': basename,
					'ProductName': product.nameLong,
					'ProductVersion': packageJson.version,
				}
			});
		});

		await Promise.all(patchPromises);
	};
}

function prepareCopilotRipgrepShimTask(platform: string, arch: string, destinationFolderName: string) {
	const outputDir = path.join(buildRoot, destinationFolderName);

	return async () => {
		// On Windows with win32VersionedUpdate, app resources live under a
		// commit-hash prefix: {output}/{commitHash}/resources/app/
		const versionedResourcesFolder = util.getVersionedResourcesFolder(platform, commit!);
		const appBase = platform === 'darwin'
			? path.join(outputDir, `${product.nameLong}.app`, 'Contents', 'Resources', 'app')
			: path.join(outputDir, versionedResourcesFolder, 'resources', 'app');
		const appNodeModulesDir = path.join(appBase, 'node_modules');

		const builtInCopilotExtensionDir = path.join(appBase, 'extensions', 'copilot');
		if (!fs.existsSync(builtInCopilotExtensionDir)) {
			// V3Code ships without the built-in Copilot extension; nothing to shim.
			return;
		}
		prepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);
	};
}

const BUILD_TARGETS = [
	{ platform: 'win32', arch: 'x64' },
	{ platform: 'win32', arch: 'arm64' },
	{ platform: 'darwin', arch: 'x64', opts: { stats: true } },
	{ platform: 'darwin', arch: 'arm64', opts: { stats: true } },
	{ platform: 'linux', arch: 'x64' },
	{ platform: 'linux', arch: 'armhf' },
	{ platform: 'linux', arch: 'arm64' },
];
BUILD_TARGETS.forEach(buildTarget => {
	const dashed = (str: string) => (str ? `-${str}` : ``);
	const platform = buildTarget.platform;
	const arch = buildTarget.arch;
	const opts = buildTarget.opts;

	const [vscode, vscodeMin] = ['', 'min'].map(minified => {
		const sourceFolderName = `out-vscode${dashed(minified)}`;
		const destinationFolderName = `VSCode${dashed(platform)}${dashed(arch)}`;

		const packageTasks: task.Task[] = [
			compileNativeExtensionsBuildTask,
			util.rimraf(path.join(buildRoot, destinationFolderName)),
			packageTask(platform, arch, sourceFolderName, destinationFolderName, opts),
			prepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)
		];

		if (platform === 'win32') {
			packageTasks.push(patchWin32DependenciesTask(destinationFolderName));
		}

		const vscodeTaskCI = task.define(`vscode${dashed(platform)}${dashed(arch)}${dashed(minified)}-ci`, task.series(...packageTasks));
		task.task(vscodeTaskCI);

		let vscodeTask: task.Task;
		if (useEsbuildTranspile) {
			const esbuildBundleTask = task.define(
				`esbuild-bundle${dashed(platform)}${dashed(arch)}${dashed(minified)}`,
				() => runEsbuildBundle(
					sourceFolderName,
					!!minified,
					true,
					'desktop',
					minified && useCdnSourceMapsForPackagingTasks ? `${sourceMappingURLBase}/core` : undefined
				)
			);
			vscodeTask = task.define(`vscode${dashed(platform)}${dashed(arch)}${dashed(minified)}`, task.series(
				copyCodiconsTask,
				cleanExtensionsBuildTask,
				compileNonNativeExtensionsBuildTask,
				compileCopilotExtensionBuildTask,
				compileExtensionMediaBuildTask,
				writeISODate('out-build'),
				esbuildBundleTask,
				vscodeTaskCI
			));
		} else {
			vscodeTask = task.define(`vscode${dashed(platform)}${dashed(arch)}${dashed(minified)}`, task.series(
				minified ? compileBuildWithManglingTask : compileBuildWithoutManglingTask,
				cleanExtensionsBuildTask,
				compileNonNativeExtensionsBuildTask,
				compileCopilotExtensionBuildTask,
				compileExtensionMediaBuildTask,
				minified ? minifyVSCodeTask : bundleVSCodeTask,
				vscodeTaskCI
			));
		}
		task.task(vscodeTask);

		return vscodeTask;
	});

	if (process.platform === platform && process.arch === arch) {
		task.task(task.define('vscode', task.series(vscode)));
		task.task(task.define('vscode-min', task.series(vscodeMin)));
	}
});

// #region nls

task.task(task.define(
	'vscode-translations-export',
	task.series(
		task.task('core-ci') as task.Task,
		compileAllExtensionsBuildTask,
		function () {
			const pathToMetadata = './out-build/nls.metadata.json';
			const pathToExtensions = '.build/extensions/*';
			const pathToSetup = 'build/win32/i18n/messages.en.isl';

			return es.merge(
				gulp.src(pathToMetadata).pipe(i18n.createXlfFilesForCoreBundle()),
				gulp.src(pathToSetup).pipe(i18n.createXlfFilesForIsl()),
				gulp.src(pathToExtensions).pipe(i18n.createXlfFilesForExtensions())
			).pipe(vfs.dest('../vscode-translations-export'));
		}
	)
));

task.task('vscode-translations-import', function () {
	const options = minimist(process.argv.slice(2), {
		string: 'location',
		default: {
			location: '../vscode-translations-import'
		}
	});
	return es.merge([...i18n.defaultLanguages, ...i18n.extraLanguages].map(language => {
		const id = language.id;
		return gulp.src(`${options.location}/${id}/vscode-setup/messages.xlf`)
			.pipe(i18n.prepareIslFiles(language))
			.pipe(vfs.dest(`./build/win32/i18n`));
	}));
});

// #endregion
