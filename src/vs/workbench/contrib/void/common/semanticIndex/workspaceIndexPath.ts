/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { URI } from '../../../../../base/common/uri.js';
import { isEqualOrParent, relativePath } from '../../../../../base/common/resources.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';

export const MULTI_ROOT_INDEX_PREFIX = '@roots';
export const SINGLE_ROOT_PATH_SCHEME = 'single-root-v1';
/** Position-based aliases (`1-app|2-api`). Retained only so persisted v1
 * snapshots are recognised and rejected — never generated. */
export const MULTI_ROOT_PATH_SCHEME_V1 = 'multi-root-alias-v1';
export const MULTI_ROOT_PATH_SCHEME = 'multi-root-alias-v2';

function folderSlug(folder: IWorkspaceFolder): string {
	const slug = folder.name.normalize('NFKC').toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug && slug !== '.' && slug !== '..' ? slug.slice(0, 48) : 'root';
}

/** Identity of a root for aliasing: the folder's own URI, trailing slash
 * stripped so `/work/app` and `/work/app/` are one root. Case is preserved —
 * two roots differing only in case are different URIs to VS Code. */
function folderIdentity(folder: IWorkspaceFolder): string {
	return folder.uri.toString().replace(/\/+$/, '');
}

function folderFingerprint(folder: IWorkspaceFolder): string {
	const sha = new StringSHA1();
	sha.update(folderIdentity(folder));
	return sha.digest().slice(0, 8);
}

/** Stable within a VS Code workspace definition and safe as one cloud path
 * segment. The suffix is derived from the folder's URI, not its position, so
 * reordering or removing another root never renames this one — that is what
 * lets a persisted snapshot survive a folder-set edit. The slug is only a
 * human-readable prefix; the fingerprint carries the identity, which keeps
 * two same-named folders in different locations distinct. */
export function workspaceFolderAlias(folder: IWorkspaceFolder): string {
	return `${folderSlug(folder)}-${folderFingerprint(folder)}`;
}

/** Cache identity for the folder SET. Sorted, so reordering the same roots
 * produces the same signature and reuses the snapshot. */
export function workspaceIndexPathScheme(folders: readonly IWorkspaceFolder[]): string {
	return folders.length > 1
		? `${MULTI_ROOT_PATH_SCHEME}:${folders.map(workspaceFolderAlias).sort().join('|')}`
		: SINGLE_ROOT_PATH_SCHEME;
}

/** Missing scheme metadata predates multi-root-safe keys. It remains valid for
 * a single root (whose keys did not change), but must rebuild for multiple.
 * A persisted v1 signature is never reinterpreted as v2: its keys embed
 * positional aliases, so it is rejected and re-walked once. That transition is
 * cheap — the content-addressed cache (casStore.ts) keys chunks and vectors by
 * content hash alone, so re-keying restores them without re-parsing or
 * re-embedding. */
export function isWorkspaceIndexPathSchemeCompatible(folders: readonly IWorkspaceFolder[], persisted: string | undefined): boolean {
	return folders.length <= 1
		? !persisted || persisted === SINGLE_ROOT_PATH_SCHEME
		: persisted === workspaceIndexPathScheme(folders);
}

/** Convert a workspace URI to the one canonical path used by chunks, recency,
 * local hydration, and cloud sync. Single-root paths stay backward compatible.
 * Multi-root paths are traversal-free (`@roots/api-1a2b3c4d/src/index.ts`) so the
 * cloud can safely accept them while same-named files remain distinct. */
export function workspaceIndexPath(folders: readonly IWorkspaceFolder[], resource: URI): string | undefined {
	let folder: IWorkspaceFolder | undefined;
	for (const candidate of folders) {
		if (!isEqualOrParent(resource, candidate.uri)) continue;
		if (!folder || candidate.uri.path.length > folder.uri.path.length) folder = candidate;
	}
	if (!folder) return undefined;
	const rel = relativePath(folder.uri, resource)?.replace(/\\/g, '/');
	if (rel === undefined || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return undefined;
	if (folders.length <= 1) return rel;
	const base = `${MULTI_ROOT_INDEX_PREFIX}/${workspaceFolderAlias(folder)}`;
	return rel ? `${base}/${rel}` : base;
}

function safeSegments(path: string): string[] | undefined {
	if (!path || path.startsWith('/') || path.includes('\0')) return undefined;
	const segments = path.replace(/\\/g, '/').split('/');
	return segments.some(segment => !segment || segment === '.' || segment === '..') ? undefined : segments;
}

/** Resolve an index path back to a concrete workspace URI. In a multi-root
 * workspace, unprefixed paths remain a compatibility shorthand for root 1;
 * every generated/retrieved path uses the explicit root alias. */
export function workspaceIndexUri(folders: readonly IWorkspaceFolder[], path: string): URI | undefined {
	if (folders.length === 0) return undefined;
	const segments = safeSegments(path);
	if (!segments) return undefined;
	if (folders.length <= 1 || segments[0] !== MULTI_ROOT_INDEX_PREFIX) {
		return URI.joinPath(folders[0].uri, ...segments);
	}
	if (segments.length < 3) return undefined;
	const folder = folders.find(candidate => workspaceFolderAlias(candidate) === segments[1]);
	return folder ? URI.joinPath(folder.uri, ...segments.slice(2)) : undefined;
}
