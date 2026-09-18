/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Catalog install identity: which installed server a catalog card actually owns.
 *
 * Installs are recorded as catalogEntryId -> { serverDefinitionId, installedName } at
 * install time, so connect/disconnect/reconnect always operate on exactly the server
 * this card installed — never on a label guess. Two identity spaces coexist (upstream
 * user/workspace mcp.json installs vs the legacy ~/.v3code/mcp.json adapter, whose ids
 * are prefixed `v3code.`), and labels can collide across them; definition ids cannot.
 *
 * Pure module: the facade owns persistence (IStorageService); everything here is data.
 */

export interface CatalogInstallRecord {
	readonly serverDefinitionId: string;
	readonly installedName: string;
	readonly collectionId?: string;
}

/** catalogEntryId -> the exact server that install produced. */
export type CatalogInstallMap = Record<string, CatalogInstallRecord>;

export const CATALOG_INSTALL_MAP_STORAGE_KEY = 'v3code.mcp.catalogInstallMap';

export function parseCatalogInstallMap(raw: string | undefined): CatalogInstallMap {
	if (raw === undefined || raw === '') { return {}; }
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return {}; }
		const out: CatalogInstallMap = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value !== null && typeof value === 'object'
				&& typeof (value as CatalogInstallRecord).serverDefinitionId === 'string'
				&& typeof (value as CatalogInstallRecord).installedName === 'string') {
				out[key] = value as CatalogInstallRecord;
			}
		}
		return out;
	} catch {
		return {};
	}
}

export function serializeCatalogInstallMap(map: CatalogInstallMap): string {
	return JSON.stringify(map);
}

export interface ServerDefinitionLike {
	readonly definition: { readonly id: string; readonly label: string };
}

export type ServerResolution<T> = {
	readonly server: T | undefined;
	readonly via: 'install-map' | 'definition-id' | 'label' | 'ambiguous-label' | 'none';
};

/** Definition ids of the legacy ~/.v3code/mcp.json discovery adapter are prefixed this way. */
export const LEGACY_DEFINITION_ID_PREFIX = 'v3code.';

/**
 * Resolve a catalog entry id or configured-server name to one live server.
 * Order: install map (exact definition id) -> exact definition id -> exact label.
 * When an upstream-installed server and a legacy-file server share a label, the
 * installed one wins (that is the identity catalog actions operate on); any other
 * label tie resolves to NOTHING rather than first-match-wins — a card acting on
 * the wrong same-labelled server is strictly worse than an error.
 */
export function resolveServerForName<T extends ServerDefinitionLike>(
	servers: readonly T[],
	nameOrCatalogId: string,
	map: CatalogInstallMap,
): ServerResolution<T> {
	const record = map[nameOrCatalogId];
	if (record !== undefined) {
		const mapped = servers.find(s => s.definition.id === record.serverDefinitionId);
		if (mapped !== undefined) {
			return { server: mapped, via: 'install-map' };
		}
	}

	const needle = nameOrCatalogId.toLowerCase();
	const byId = servers.find(s => s.definition.id.toLowerCase() === needle);
	if (byId !== undefined) {
		return { server: byId, via: 'definition-id' };
	}

	// Case-insensitive on purpose: the display surfaces match names case-insensitively,
	// and a toggle that displays a server its actions cannot find is a dead toggle.
	const byLabel = servers.filter(s => s.definition.label.toLowerCase() === needle);
	if (byLabel.length === 1) {
		return { server: byLabel[0], via: 'label' };
	}
	if (byLabel.length > 1) {
		const installed = byLabel.filter(s => !s.definition.id.startsWith(LEGACY_DEFINITION_ID_PREFIX));
		if (installed.length === 1) {
			return { server: installed[0], via: 'label' };
		}
		return { server: undefined, via: 'ambiguous-label' };
	}
	return { server: undefined, via: 'none' };
}

/** Structural config shape shared by install-name collision checks. */
export interface InstallConfigLike {
	readonly url?: string;
	readonly command?: string;
	readonly args?: readonly string[];
}

/** Same endpoint or same command line means "the same server" for adoption purposes. */
export function installConfigsEquivalent(a: InstallConfigLike, b: InstallConfigLike): boolean {
	if (a.url !== undefined || b.url !== undefined) {
		return a.url !== undefined && b.url !== undefined && a.url.replace(/\/$/, '') === b.url.replace(/\/$/, '');
	}
	return a.command === b.command
		&& (a.args ?? []).length === (b.args ?? []).length
		&& (a.args ?? []).every((arg, i) => arg === (b.args ?? [])[i]);
}

export type InstallNameDecision =
	| { readonly kind: 'fresh'; readonly name: string }
	| { readonly kind: 'adopt'; readonly name: string }
	| { readonly kind: 'suffixed'; readonly name: string };

/**
 * Collision policy for the desired install name:
 *  - free name        -> install under it
 *  - taken, same cfg  -> adopt the existing install (no duplicate)
 *  - taken, different -> install under `name-2`/`name-3`/... leaving the user's server alone
 */
export function decideInstallName(
	desiredName: string,
	existing: readonly { readonly name: string; readonly config: InstallConfigLike }[],
	newConfig: InstallConfigLike,
): InstallNameDecision {
	const taken = new Map(existing.map(e => [e.name, e.config]));
	const current = taken.get(desiredName);
	if (current === undefined) {
		return { kind: 'fresh', name: desiredName };
	}
	if (installConfigsEquivalent(current, newConfig)) {
		return { kind: 'adopt', name: desiredName };
	}
	for (let i = 2; ; i++) {
		const candidate = `${desiredName}-${i}`;
		const candidateCurrent = taken.get(candidate);
		if (candidateCurrent === undefined) {
			return { kind: 'suffixed', name: candidate };
		}
		if (installConfigsEquivalent(candidateCurrent, newConfig)) {
			return { kind: 'adopt', name: candidate };
		}
	}
}
