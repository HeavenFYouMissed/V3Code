/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { promisify } from 'util'
import { execFile as _execFile } from 'child_process'
import { IVoidSCMService } from '../common/voidSCMTypes.js'

interface NumStat {
	file: string
	added: number
	removed: number
}

const execFile = promisify(_execFile)

//8000 and 10 were chosen after some experimentation on small-to-moderately sized changes
const MAX_DIFF_LENGTH = 8000
const MAX_DIFF_FILES = 10

// SECURITY: run git with an ARGUMENT ARRAY via execFile (no shell). A repo we diff
// controls its own filenames, so a shell command string would let a file named
// `$(cmd).ts` inject `cmd` into the main process. Passing args as an array means git
// receives every value literally — filenames are never interpreted by a shell.
const git = async (args: string[], path: string): Promise<string> => {
	// Failure is a NON-ZERO EXIT CODE (execFile rejects on it) — never non-empty stderr.
	// Git routinely warns on stderr while succeeding, e.g. Git-for-Windows with
	// core.autocrlf=true emits "warning: LF will be replaced by CRLF" on every diff.
	const { stdout, stderr } = await execFile('git', args, { cwd: path })
	if (stderr) {
		console.warn(`[V3Code] git ${args[0]} wrote to stderr (exit 0, continuing):`, stderr.trim())
	}
	return stdout.trim()
}

const getNumStat = async (path: string, useStagedChanges: boolean): Promise<NumStat[]> => {
	const args = useStagedChanges ? ['diff', '--numstat', '--staged'] : ['diff', '--numstat']
	const output = await git(args, path)
	return output
		.split('\n')
		.map((line) => {
			const [added, removed, file] = line.split('\t')
			return {
				file,
				added: parseInt(added, 10) || 0,
				removed: parseInt(removed, 10) || 0,
			}
		})
}

const getSampledDiff = async (file: string, path: string, useStagedChanges: boolean): Promise<string> => {
	const args = ['diff', '--unified=0', '--no-color']
	if (useStagedChanges) {
		args.push('--staged')
	}
	// `--` then the literal filename: `file` is passed as its own argument, so even a
	// filename containing shell metacharacters is harmless (no shell involved).
	args.push('--', file)
	const diff = await git(args, path)
	return diff.slice(0, MAX_DIFF_LENGTH)
}

const hasStagedChanges = async (path: string): Promise<boolean> => {
	const output = await git(['diff', '--staged', '--name-only'], path)
	return output.length > 0
}

export class VoidSCMService implements IVoidSCMService {
	readonly _serviceBrand: undefined

	async gitStat(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const args = useStagedChanges ? ['diff', '--stat', '--staged'] : ['diff', '--stat']
		return git(args, path)
	}

	async gitSampledDiffs(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const numStatList = await getNumStat(path, useStagedChanges)
		const topFiles = numStatList
			.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
			.slice(0, MAX_DIFF_FILES)
		const diffs = await Promise.all(topFiles.map(async ({ file }) => ({ file, diff: await getSampledDiff(file, path, useStagedChanges) })))
		return diffs.map(({ file, diff }) => `==== ${file} ====\n${diff}`).join('\n\n')
	}

	gitBranch(path: string): Promise<string> {
		return git(['branch', '--show-current'], path)
	}

	gitLog(path: string): Promise<string> {
		return git(['log', '--pretty=format:%h|%s|%ad', '--date=short', '--no-merges', '-n', '5'], path)
	}
}
