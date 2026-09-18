/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspace } from '../../../../../platform/workspace/common/workspace.js';

export interface CloudIndexRepositoryIdentity {
	repositoryLocator: string;
	displayName: string;
	provider: 'github' | 'gitlab' | 'bitbucket' | 'git';
	/** Current symbolic Git branch. Undefined for detached/non-Git workspaces. */
	branchName?: string;
	/** False for multi-root/non-Git fallbacks. They stay in the personal space. */
	shareable: boolean;
}

function normalizeLocator(host: string, path: string): string | undefined {
	const cleanHost = host.trim().toLowerCase();
	const cleanPath = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
	const parts = cleanPath.split('/').filter(Boolean);
	if (!/^[a-z0-9.-]+$/.test(cleanHost) || parts.length < 2) return undefined;
	if (parts.some(part => !/^[a-z0-9._-]+$/.test(part))) return undefined;
	return `${cleanHost}/${parts.join('/')}`;
}

/** Convert a normal HTTPS/SSH/SCP git remote to host/owner/repo without ever
 *  retaining credentials, query strings, fragments, or a local path. */
export function repositoryLocatorFromRemoteUrl(raw: string): string | undefined {
	const value = raw.trim();
	if (!value || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^[a-z]:[\\/]/i.test(value)) {
		return undefined;
	}

	const scp = value.includes('://') ? null : value.match(/^(?:[^@/:]+@)?([a-z0-9.-]+):(.+)$/i);
	if (scp) return normalizeLocator(scp[1]!, scp[2]!);

	try {
		const parsed = new URL(value);
		if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined;
		return normalizeLocator(parsed.hostname, parsed.pathname);
	} catch {
		const direct = value.match(/^([a-z0-9.-]+)\/(.+)$/i);
		return direct ? normalizeLocator(direct[1]!, direct[2]!) : undefined;
	}
}

export function repositoryLocatorFromGitConfig(config: string): string | undefined {
	const remotes: Array<{ name: string; url: string }> = [];
	let remoteName: string | undefined;
	for (const line of config.split(/\r?\n/)) {
		const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
		if (section) {
			remoteName = section[1]!.toLowerCase();
			continue;
		}
		if (/^\s*\[/.test(line)) {
			remoteName = undefined;
			continue;
		}
		const url = remoteName ? line.match(/^\s*url\s*=\s*(.+?)\s*$/i) : undefined;
		if (url) remotes.push({ name: remoteName!, url: url[1]! });
	}

	remotes.sort((left, right) => {
		const rank = (name: string) => name === 'origin' ? 0 : name === 'upstream' ? 1 : 2;
		return rank(left.name) - rank(right.name);
	});
	for (const remote of remotes) {
		const locator = repositoryLocatorFromRemoteUrl(remote.url);
		if (locator) return locator;
	}
	return undefined;
}

function providerFor(locator: string): CloudIndexRepositoryIdentity['provider'] {
	const host = locator.split('/')[0];
	if (host === 'github.com') return 'github';
	if (host === 'gitlab.com') return 'gitlab';
	if (host === 'bitbucket.org') return 'bitbucket';
	return 'git';
}

async function readText(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		return (await fileService.readFile(uri)).value.toString();
	} catch {
		return undefined;
	}
}

function resolvePath(base: URI, raw: string): URI | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	if (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value)) return URI.file(value);
	return URI.joinPath(base, ...value.replace(/\\/g, '/').split('/'));
}

async function readGitConfig(fileService: IFileService, root: URI): Promise<string | undefined> {
	const direct = await readText(fileService, URI.joinPath(root, '.git', 'config'));
	if (direct) return direct;

	const dotGit = await readText(fileService, URI.joinPath(root, '.git'));
	const gitDirRaw = dotGit?.match(/^gitdir:\s*(.+)\s*$/im)?.[1];
	const gitDir = gitDirRaw ? resolvePath(root, gitDirRaw) : undefined;
	if (!gitDir) return undefined;

	const worktreeConfig = await readText(fileService, URI.joinPath(gitDir, 'config'));
	if (worktreeConfig && repositoryLocatorFromGitConfig(worktreeConfig)) return worktreeConfig;

	const commonDirRaw = (await readText(fileService, URI.joinPath(gitDir, 'commondir')))?.trim();
	const commonDir = (commonDirRaw ? resolvePath(gitDir, commonDirRaw) : undefined) ?? URI.joinPath(gitDir, '..', '..');
	return readText(fileService, URI.joinPath(commonDir, 'config'));
}

async function readGitBranch(fileService: IFileService, root: URI): Promise<string | undefined> {
	let head = await readText(fileService, URI.joinPath(root, '.git', 'HEAD'));
	if (!head) {
		const dotGit = await readText(fileService, URI.joinPath(root, '.git'));
		const gitDirRaw = dotGit?.match(/^gitdir:\s*(.+)\s*$/im)?.[1];
		const gitDir = gitDirRaw ? resolvePath(root, gitDirRaw) : undefined;
		head = gitDir ? await readText(fileService, URI.joinPath(gitDir, 'HEAD')) : undefined;
	}
	return branchNameFromHead(head ?? '');
}

export function branchNameFromHead(head: string): string | undefined {
	const branch = head.trim().match(/^ref:\s+refs\/heads\/(.+)$/)?.[1]?.trim();
	if (!branch || branch.length > 255 || branch.includes('..') || /[\x00-\x1f\x7f]/.test(branch)) return undefined;
	return branch;
}

/** Resolve once per workspace activation. Multi-root/non-Git workspaces get an
 *  opaque personal locator, so no absolute path ever crosses the network. */
export async function resolveCloudIndexRepositoryIdentity(
	workspace: IWorkspace,
	fileService: IFileService,
): Promise<CloudIndexRepositoryIdentity> {
	const displayName = workspace.name || workspace.folders[0]?.name || 'Workspace';
	if (workspace.folders.length === 1) {
		const config = await readGitConfig(fileService, workspace.folders[0]!.uri);
		const repositoryLocator = config ? repositoryLocatorFromGitConfig(config) : undefined;
		if (repositoryLocator) {
			const branchName = await readGitBranch(fileService, workspace.folders[0]!.uri);
			return { repositoryLocator, displayName, provider: providerFor(repositoryLocator), branchName, shareable: true };
		}
	}

	const fingerprint = workspace.id.toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 48) || 'anonymous';
	return {
		repositoryLocator: `local.v3code.invalid/workspaces/${fingerprint}`,
		displayName,
		provider: 'git',
		shareable: false,
	};
}
