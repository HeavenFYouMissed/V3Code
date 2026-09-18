/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Installs the native computer-use helper out of the application bundle and into a user-writable
 * directory, verifying its code signature before it is ever allowed to run.
 *
 * The helper is **shipped inside V3Code**; there is no runtime download. Copying it out is only
 * necessary because the OS binds Accessibility and Screen Recording grants to a stable executable
 * path, and because a binary inside the app bundle must not be relaunched after an app update
 * replaced it underneath us.
 *
 * The order below is a security contract, not a suggestion:
 *   1. locate the bundled helper,
 *   2. verify its signature and designated requirement,
 *   3. install it atomically (temp file in the destination directory, then rename),
 *   4. clear the macOS quarantine flag,
 *   5. only then may it be executed.
 * A verification failure returns a typed error and never falls back to running the binary.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ComputerUseError, createComputerUseError } from '../common/computerUseTypes.js';

/** Log prefix shared with the channel so helper problems are greppable as one story. */
const LOG_PREFIX = '[v3code-computerUse]';

/** File name of the helper executable, per platform. */
const HELPER_FILE_NAME = process.platform === 'win32'
	? 'v3code-computer-use-helper.exe'
	: 'v3code-computer-use-helper';

/** Directory the helper is installed into. Deliberately outside every workspace. */
export const COMPUTER_USE_HELPER_DIR = join(homedir(), '.v3code', 'bin');

/**
 * The one path the helper is ever executed from.
 *
 * Stable across app updates so the OS keeps the Accessibility and Screen Recording grants the user
 * already gave, which are keyed on the executable's identity and path.
 */
export const COMPUTER_USE_HELPER_PATH = join(COMPUTER_USE_HELPER_DIR, HELPER_FILE_NAME);

/** Setting that points at a locally built helper. Development only — it skips verification. */
export const COMPUTER_USE_HELPER_PATH_SETTING = 'v3code.computerUse.helperBinaryPath';

/**
 * Bundle identifier the shipped helper is signed with.
 *
 * Pinned in the designated requirement so a same-named binary signed by anybody else — including a
 * binary an attacker dropped into the app's resources — fails verification.
 */
export const COMPUTER_USE_HELPER_BUNDLE_ID = 'dev.v3code.computerUseHelper';

/**
 * Apple Developer team OU pinned in the designated requirement alongside the bundle identifier.
 *
 * This is the 10-character Team ID from the signing certificate's subject OU, not a display name.
 * It previously read `'V3CODELABS'`, which is not a Team ID in any format, so the designated
 * requirement could never match and a packaged build would have rejected its own correctly-signed
 * helper. It never fired in development because the `helperBinaryPath` override skips verification.
 * `scripts/v3-sign-notarize-computer-use-helper.sh` compares the signed binary's TeamIdentifier
 * against this constant and refuses to proceed when they disagree — if signing moves to a different
 * Apple Developer account, that script fails loudly and this constant is what has to change.
 */
export const COMPUTER_USE_HELPER_TEAM_OU = '43CAXSDA3P';

/**
 * Authenticode certificate subjects accepted for the Windows helper — the win32 counterpart to the
 * Team OU pinned above. The helper is trusted when its subject contains ANY entry here.
 *
 * This was a single string reading `'V3Code'`: a product name that appears nowhere in the
 * certificate. The real Azure Artifact Signing subject is
 * `CN=Kimberly wilson, O=Kimberly wilson, L=Ledyard, S=ct, C=US` (measured from a signed CI
 * artifact, run 30714322565), so the publisher check could never match and every signed Windows
 * build rejected its own correctly-signed helper — leaving all sixteen computer_* tools
 * unregistered no matter how the binary was built or shipped. Like the mac constant above, it
 * never fired in development because the `helperBinaryPath` override skips verification entirely.
 *
 * It is a LIST rather than one value so that reissuing the certificate is a config change and not
 * a breakage. Signing under a company identity instead of an individual is a known future step
 * (the subject is what users see in the UAC prompt and SmartScreen), and it cannot be done
 * atomically: builds signed with the old and new certificates coexist across a rollout. Adding the
 * new subject here BEFORE the switch means both are accepted through the transition, and the old
 * entry is removed once no supported build carries it.
 *
 * These are the certificates' identities, not names we choose. The post-sign assert in
 * `scripts/v3-package-win32.sh` reads this list straight out of this file — single source of truth
 * — and aborts the build when the signed helper matches none of them, so a mismatch fails at
 * package time instead of silently on a user's machine.
 */
export const COMPUTER_USE_HELPER_WINDOWS_PUBLISHERS = ['Kimberly wilson'];

/** `codesign`/`signtool` answer in well under a second; the budget only guards a wedged process. */
const VERIFY_TIMEOUT_MS = 10_000;

/** Gatekeeper assessment can talk to the network, so it gets its own tighter budget. */
const SPCTL_TIMEOUT_MS = 5_000;

/**
 * Returns the signed application bundle that contains a packaged helper.
 *
 * Gatekeeper assesses distributable application bundles, not arbitrary loose Mach-O files. A
 * correctly Developer-ID-signed helper therefore produces the misleading result "the code is
 * valid but does not seem to be an app" when passed directly to `spctl --type execute`. The helper
 * still gets its own strict signature and designated-requirement checks; this target is only for
 * proving that the bytes came from the signed, notarized V3Code application that encloses them.
 */
export function findEnclosingDarwinAppBundle(filePath: string): string | undefined {
	let candidate = resolve(filePath);
	for (;;) {
		if (basename(candidate).endsWith('.app')) {
			return candidate;
		}
		const parent = dirname(candidate);
		if (parent === candidate) {
			return undefined;
		}
		candidate = parent;
	}
}

/** Where the helper was installed, and whether it got there unverified. */
export interface IComputerUseHelperInstallation {
	/** Absolute path the helper may now be executed from. */
	readonly path: string;
	/**
	 * True when the signature and designated-requirement checks were skipped because the
	 * {@link COMPUTER_USE_HELPER_PATH_SETTING} override named a locally built binary.
	 */
	readonly verificationSkipped: boolean;
}

/** Success or a typed failure. Never throws, so a broken install degrades instead of crashing. */
export type ComputerUseHelperInstallOutcome =
	| { readonly ok: true; readonly installation: IComputerUseHelperInstallation }
	| { readonly ok: false; readonly error: ComputerUseError };

/** Result of running a verification tool. */
interface ICommandOutcome {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/**
 * Locates, verifies and installs the bundled computer-use helper.
 *
 * One instance per application run. The successful outcome is cached, so repeated calls after the
 * first are free and the verification tools run once per session.
 */
export class ComputerUseHelperInstaller extends Disposable {

	/** Cached success. Failures are not cached — the channel's kill-switch handles repeat suppression. */
	private _installed: IComputerUseHelperInstallation | undefined;

	/** Coalesces concurrent callers onto one install run. */
	private _inFlight: Promise<ComputerUseHelperInstallOutcome> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();
	}

	/**
	 * Whether a helper is already present on disk, without verifying or installing anything.
	 *
	 * Used by the channel's `status` call, which must answer even when the helper cannot run.
	 */
	isInstalled(overridePath?: string): boolean {
		const path = overridePath?.trim() || COMPUTER_USE_HELPER_PATH;
		return existsSync(path);
	}

	/**
	 * Ensures a verified helper exists at an executable path, installing it if necessary.
	 *
	 * `overridePath` comes from {@link COMPUTER_USE_HELPER_PATH_SETTING}. When set, the binary is
	 * used as-is: signature verification is skipped and a prominent warning is logged, because the
	 * point of the override is to run a binary that was never signed.
	 */
	async ensureInstalled(overridePath?: string): Promise<ComputerUseHelperInstallOutcome> {
		const override = overridePath?.trim();
		if (override) {
			return this._useOverride(override);
		}
		if (this._installed && existsSync(this._installed.path)) {
			return { ok: true, installation: this._installed };
		}
		if (!this._inFlight) {
			this._inFlight = this._install().finally(() => { this._inFlight = undefined; });
		}
		return this._inFlight;
	}

	/** Accepts a developer-supplied binary, loudly. */
	private _useOverride(override: string): ComputerUseHelperInstallOutcome {
		if (!existsSync(override)) {
			return {
				ok: false,
				error: createComputerUseError('helperMissing', localize(
					'computerUse.override.missing',
					"The computer-use helper set in '{0}' does not exist: {1}",
					COMPUTER_USE_HELPER_PATH_SETTING,
					override,
				)),
			};
		}
		this.logService.warn(`${LOG_PREFIX} ${localize(
			'computerUse.override.unverified',
			"SIGNATURE VERIFICATION SKIPPED for the computer-use helper because '{0}' points at {1}. This binary can control the mouse, keyboard and screen — only keep this setting while developing the helper.",
			COMPUTER_USE_HELPER_PATH_SETTING,
			override,
		)}`);
		return { ok: true, installation: { path: override, verificationSkipped: true } };
	}

	/** Steps 1 to 4 of the contract, in order, aborting on the first failure. */
	private async _install(): Promise<ComputerUseHelperInstallOutcome> {
		if (process.platform !== 'darwin' && process.platform !== 'win32') {
			return {
				ok: false,
				error: createComputerUseError('helperMissing', localize(
					'computerUse.platform.unsupported',
					"Computer use is not supported on this platform ({0}).",
					process.platform,
				)),
			};
		}

		// 1. Locate the bundled helper.
		const bundled = this._findBundledHelper();
		if (!bundled) {
			return {
				ok: false,
				error: createComputerUseError('helperMissing', localize(
					'computerUse.bundled.missing',
					"This build of V3Code does not contain the computer-use helper. Expected it at one of: {0}. To run a locally built helper, set '{1}'.",
					this._bundledCandidates().join(', '),
					COMPUTER_USE_HELPER_PATH_SETTING,
				)),
			};
		}

		// 2. Verify before trusting.
		const verificationError = await this._verify(bundled);
		if (verificationError) {
			this.logService.error(`${LOG_PREFIX} refusing to install ${bundled}: ${verificationError.message}`);
			return { ok: false, error: verificationError };
		}

		// 3. Install atomically, unless the identical bytes are already in place.
		try {
			await mkdir(COMPUTER_USE_HELPER_DIR, { recursive: true });
			const alreadyCurrent = await this._isSameFile(bundled, COMPUTER_USE_HELPER_PATH);
			if (!alreadyCurrent) {
				await this._atomicCopy(bundled, COMPUTER_USE_HELPER_PATH);
			}
			if (process.platform !== 'win32') {
				chmodSync(COMPUTER_USE_HELPER_PATH, 0o755);
			}
		} catch (error) {
			return {
				ok: false,
				error: createComputerUseError('helperMissing', localize(
					'computerUse.install.failed',
					"Could not install the computer-use helper to {0}: {1}",
					COMPUTER_USE_HELPER_PATH,
					this._messageOf(error),
				), true),
			};
		}

		// 4. Clear the quarantine flag, which would otherwise make the first launch fail with a
		//    Gatekeeper prompt no headless process can answer.
		if (process.platform === 'darwin') {
			await this._clearQuarantine(COMPUTER_USE_HELPER_PATH);
		}

		// 5. Executable from here on, and not one step earlier.
		const installation: IComputerUseHelperInstallation = { path: COMPUTER_USE_HELPER_PATH, verificationSkipped: false };
		this._installed = installation;
		this.logService.info(`${LOG_PREFIX} helper verified and installed at ${COMPUTER_USE_HELPER_PATH}`);
		return { ok: true, installation };
	}

	/**
	 * Candidate locations of the bundled helper, dev build first.
	 *
	 * `node_modules.asar` is rewritten to `node_modules.asar.unpacked` the same way `rgDiskPath`
	 * does it: a native executable inside an asar archive cannot be spawned, so packaged builds
	 * unpack it and the on-disk path differs from the require path.
	 */
	private _bundledCandidates(): string[] {
		const appRoot = this.environmentMainService.appRoot;
		const resourcesPath = process.resourcesPath || dirname(appRoot);
		const candidates = [
			// Dev: checked in / built into the repo's resources.
			join(appRoot, 'resources', 'computerUse', process.platform, HELPER_FILE_NAME),
			join(appRoot, 'resources', 'computerUse', HELPER_FILE_NAME),
			// Packaged: alongside the app inside Resources/, outside any archive.
			join(resourcesPath, 'computerUse', process.platform, HELPER_FILE_NAME),
			join(resourcesPath, 'computerUse', HELPER_FILE_NAME),
			// Shipped as a dependency's binary, which lands in the unpacked archive.
			join(appRoot, 'node_modules', '@v3code', 'computer-use-helper', 'bin', HELPER_FILE_NAME),
		];
		return candidates.map(candidate => candidate.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked'));
	}

	/** First candidate that exists, or `undefined`. */
	private _findBundledHelper(): string | undefined {
		return this._bundledCandidates().find(candidate => existsSync(candidate));
	}

	/** Platform signature verification. Returns `undefined` when the binary is trustworthy. */
	private async _verify(path: string): Promise<ComputerUseError | undefined> {
		if (process.platform === 'darwin') {
			return this._verifyDarwin(path);
		}
		return this._verifyWindows(path);
	}

	/**
	 * macOS: a valid helper signature, a designated requirement pinning who signed it, and a
	 * Gatekeeper assessment of the enclosing application. All three are needed — `--verify` alone
	 * only proves the binary is signed by *someone*, which an attacker with an ad-hoc certificate
	 * also satisfies. Gatekeeper cannot assess the loose helper directly: even a correctly signed
	 * and notarized Mach-O is rejected as "valid code, but not an app".
	 */
	private async _verifyDarwin(path: string): Promise<ComputerUseError | undefined> {
		const signature = await this._run('codesign', ['--verify', '--deep', '--strict', path], VERIFY_TIMEOUT_MS);
		if (signature.code !== 0) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.codesign',
				"The computer-use helper at {0} failed code-signature verification and will not be run: {1}",
				path,
				this._detailOf(signature),
			));
		}

		const requirement = `identifier "${COMPUTER_USE_HELPER_BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${COMPUTER_USE_HELPER_TEAM_OU}"`;
		const designated = await this._run('codesign', ['--verify', '--strict', `-R=${requirement}`, path], VERIFY_TIMEOUT_MS);
		if (designated.code !== 0) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.requirement',
				"The computer-use helper at {0} is signed, but not by V3Code (expected bundle identifier {1} and team {2}). It will not be run: {3}",
				path,
				COMPUTER_USE_HELPER_BUNDLE_ID,
				COMPUTER_USE_HELPER_TEAM_OU,
				this._detailOf(designated),
			));
		}

		const appBundle = findEnclosingDarwinAppBundle(path);
		if (!appBundle) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.noAppBundle',
				"The computer-use helper at {0} is signed, but it is not inside a V3Code application bundle whose notarization can be verified. It will not be run.",
				path,
			));
		}

		// Verify the container as well as the leaf. This seals the helper into the exact app bundle
		// Gatekeeper assesses, rather than accepting a correctly signed helper copied into a modified
		// or ad-hoc application.
		const appSignature = await this._run('codesign', ['--verify', '--deep', '--strict', appBundle], VERIFY_TIMEOUT_MS);
		if (appSignature.code !== 0) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.appCodesign',
				"The V3Code application containing the computer-use helper failed code-signature verification and will not be trusted: {0}",
				this._detailOf(appSignature),
			));
		}

		const assessment = await this._run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appBundle], SPCTL_TIMEOUT_MS);
		if (assessment.code !== 0) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.gatekeeper',
				"Gatekeeper rejected the V3Code application containing the computer-use helper at {0}, so the helper will not be run: {1}",
				appBundle,
				this._detailOf(assessment),
			), assessment.timedOut);
		}
		return undefined;
	}

	/**
	 * Windows: Authenticode verification against any installed root, plus a publisher check.
	 *
	 * Both come from ONE `Get-AuthenticodeSignature` call: `.Status` proves the chain,
	 * `.SignerCertificate.Subject` proves it is *our* chain.
	 *
	 * This deliberately does NOT shell out to `signtool verify /pa`. signtool.exe ships only
	 * with the Windows SDK and is on PATH only inside a Developer Command Prompt, so on an
	 * end-user machine the spawn fails with ENOENT, `_run` settles `{ code: null }`, and the
	 * helper was rejected as `helperMissing` — even when a correctly signed binary was sitting
	 * right there. Install then aborted before the copy, so computer-use was permanently dead
	 * on Windows and the message blamed the binary ("failed Authenticode verification") when
	 * the real problem was that the VERIFIER was absent. An inverted error message like that
	 * costs days. powershell.exe is guaranteed present in System32.
	 */
	private async _verifyWindows(path: string): Promise<ComputerUseError | undefined> {
		const literal = path.replace(/'/g, "''");
		const signature = await this._run('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			// Status on the first line, subject on the second. Guarded because an unsigned file
			// has a null SignerCertificate, and dereferencing it would emit an error instead of
			// the Status we still want to report.
			`$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; Write-Output $s.Status; if ($s.SignerCertificate) { Write-Output $s.SignerCertificate.Subject }`,
		], VERIFY_TIMEOUT_MS);

		if (signature.code !== 0) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.failed',
				"The computer-use helper at {0} could not be checked for a valid signature and will not be run: {1}",
				path,
				this._detailOf(signature),
			));
		}

		const [status = '', ...subjectLines] = signature.stdout.trim().split('\n').map(line => line.trim());
		if (status !== 'Valid') {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.status',
				"The computer-use helper at {0} failed Authenticode verification ({1}) and will not be run.",
				path,
				status || 'no signature status reported',
			));
		}

		const subject = subjectLines.join(' ').trim();
		const subjectLower = subject.toLowerCase();
		if (!COMPUTER_USE_HELPER_WINDOWS_PUBLISHERS.some(publisher => subjectLower.includes(publisher.toLowerCase()))) {
			return createComputerUseError('helperMissing', localize(
				'computerUse.verify.publisher',
				"The computer-use helper at {0} is signed by an unexpected publisher (expected one of {1}, found {2}). It will not be run.",
				path,
				COMPUTER_USE_HELPER_WINDOWS_PUBLISHERS.join(', '),
				subject || 'nothing',
			));
		}
		return undefined;
	}

	/**
	 * Copies through a temporary name in the destination's own directory, then renames.
	 *
	 * Same directory so the rename is a same-filesystem atomic operation: a half-written binary
	 * must never exist at the path the helper is launched from.
	 */
	private async _atomicCopy(source: string, destination: string): Promise<void> {
		const temporary = join(dirname(destination), `.${HELPER_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
		try {
			await copyFile(source, temporary);
			if (process.platform !== 'win32') {
				chmodSync(temporary, 0o755);
			}
			await rename(temporary, destination);
		} catch (error) {
			await unlink(temporary).catch(() => { /* nothing to clean up */ });
			throw error;
		}
	}

	/** True when both files exist with identical bytes, so the copy can be skipped. */
	private async _isSameFile(left: string, right: string): Promise<boolean> {
		if (!existsSync(right)) {
			return false;
		}
		const [leftHash, rightHash] = await Promise.all([this._sha256(left), this._sha256(right)]);
		return leftHash !== undefined && leftHash === rightHash;
	}

	/** SHA-256 of a file, or `undefined` when it cannot be read. */
	private async _sha256(path: string): Promise<string | undefined> {
		try {
			return createHash('sha256').update(await readFile(path)).digest('hex');
		} catch {
			return undefined;
		}
	}

	/** Removes `com.apple.quarantine`. A missing attribute is the common case, not an error. */
	private async _clearQuarantine(path: string): Promise<void> {
		const outcome = await this._run('xattr', ['-d', 'com.apple.quarantine', path], VERIFY_TIMEOUT_MS);
		if (outcome.code !== 0) {
			this.logService.trace(`${LOG_PREFIX} no quarantine flag to clear on ${path}: ${this._detailOf(outcome)}`);
		}
	}

	/** Runs a verification tool with a hard timeout, capturing both streams. */
	private _run(command: string, args: readonly string[], timeoutMs: number): Promise<ICommandOutcome> {
		return new Promise<ICommandOutcome>(resolve => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
			const settle = (outcome: ICommandOutcome): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(outcome);
			};
			const timer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					/* already gone */
				}
				settle({ code: null, stdout, stderr, timedOut: true });
			}, timeoutMs);
			child.stdout.on('data', chunk => { stdout += String(chunk); });
			child.stderr.on('data', chunk => { stderr += String(chunk); });
			child.on('error', error => settle({ code: null, stdout, stderr: `${stderr}${this._messageOf(error)}`, timedOut: false }));
			child.on('close', code => settle({ code, stdout, stderr, timedOut: false }));
		});
	}

	/** Short human-readable tail of a tool's output, for log and error messages. */
	private _detailOf(outcome: ICommandOutcome): string {
		if (outcome.timedOut) {
			return 'the check timed out';
		}
		const detail = (outcome.stderr || outcome.stdout).trim().split('\n').slice(-3).join('; ');
		return detail || `exit code ${outcome.code}`;
	}

	/** Message of an unknown thrown value. */
	private _messageOf(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
