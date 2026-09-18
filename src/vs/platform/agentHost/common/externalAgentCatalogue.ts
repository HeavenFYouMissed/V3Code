/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * External agent catalogue — the user-owned list of Agent Client Protocol
 * (ACP) agents that may be launched by the agent host, plus which of them
 * are enabled. Agent identities and display names are **data** in this
 * file; nothing here names a specific agent product.
 *
 * The catalogue lives in a JSON file under the user's global storage
 * (see {@link EXTERNAL_AGENTS_CATALOGUE_FILENAME}). The renderer edits it
 * from the settings pane; the agent host watches it and registers one
 * provider per enabled entry. Remote registry metadata is merged into the
 * file only on an explicit refresh and never enables, installs or runs
 * anything by itself.
 */

/** File name of the catalogue inside `<appSettingsHome>/globalStorage`. */
export const EXTERNAL_AGENTS_CATALOGUE_FILENAME = 'external-agents.json';

/** Directory (inside `globalStorage`) holding per-agent session transcripts. */
export const EXTERNAL_AGENTS_SESSIONS_DIRNAME = 'external-agents-sessions';

/**
 * Prefix of every provider id created from a catalogue entry. Provider ids
 * double as session URI schemes, so entry ids are restricted to characters
 * that are valid in a URI scheme (see {@link isValidExternalAgentId}).
 */
export const EXTERNAL_AGENT_PROVIDER_PREFIX = 'acp-';

/** The current on-disk catalogue format version. */
export const EXTERNAL_AGENTS_CATALOGUE_VERSION = 1;

/** Optional environment overrides applied when launching an agent. */
export type ExternalAgentEnv = Readonly<Record<string, string>>;

/** Launch forms an entry may advertise. Only one is needed to run it. */
export interface IExternalAgentDistribution {
	/** Run through a package runner for Node packages (`npx`). */
	readonly npx?: { readonly package: string; readonly args?: readonly string[] };
	/** Run through a package runner for Python packages (`uvx`). */
	readonly uvx?: { readonly package: string; readonly args?: readonly string[] };
	/** Run an arbitrary local command (user-defined agents). */
	readonly command?: { readonly command: string; readonly args?: readonly string[]; readonly env?: ExternalAgentEnv };
	/**
	 * Registry entries may only ship platform binaries. Those are recorded so
	 * the UI can explain why the entry cannot be launched yet; downloading
	 * archives is not part of this catalogue.
	 */
	readonly binaryOnly?: boolean;
}

export type ExternalAgentSource = 'registry' | 'custom';

export interface IExternalAgentEntry {
	/** Stable id, valid as a URI scheme suffix. */
	readonly id: string;
	/** Display name shown to the user; data, never a hardcoded product name. */
	readonly name: string;
	readonly description?: string;
	readonly version?: string;
	readonly website?: string;
	readonly license?: string;
	readonly source: ExternalAgentSource;
	readonly distribution: IExternalAgentDistribution;
	/** Applied to the next session; disabling never kills an active conversation. */
	readonly memoryIndex?: boolean;
	readonly browserAccess?: boolean;
}

export interface IExternalAgentCatalogue {
	readonly version: typeof EXTERNAL_AGENTS_CATALOGUE_VERSION;
	/** Registry URL used by explicit refreshes. Empty means none configured. */
	readonly registryUrl: string;
	readonly agents: readonly IExternalAgentEntry[];
	/** Ids of agents the user enabled. Never changed by a registry refresh. */
	readonly enabledIds: readonly string[];
}

/** A concrete command line the host can spawn (no shell involved). */
export interface IExternalAgentLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: ExternalAgentEnv;
}

export function emptyExternalAgentCatalogue(): IExternalAgentCatalogue {
	return { version: EXTERNAL_AGENTS_CATALOGUE_VERSION, registryUrl: '', agents: [], enabledIds: [] };
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}$/;

export function isValidExternalAgentId(id: unknown): id is string {
	return typeof id === 'string' && AGENT_ID_PATTERN.test(id);
}

/**
 * Turns an arbitrary registry id or name into a valid catalogue id. Returns
 * `undefined` when nothing usable remains.
 */
export function normalizeExternalAgentId(raw: string): string | undefined {
	const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '');
	return isValidExternalAgentId(normalized) ? normalized : undefined;
}

export function providerIdForExternalAgent(agentId: string): string {
	return `${EXTERNAL_AGENT_PROVIDER_PREFIX}${agentId}`;
}

export function externalAgentIdFromProvider(provider: string): string | undefined {
	return provider.startsWith(EXTERNAL_AGENT_PROVIDER_PREFIX) ? provider.slice(EXTERNAL_AGENT_PROVIDER_PREFIX.length) : undefined;
}

export function isExternalAgentProvider(provider: string): boolean {
	return externalAgentIdFromProvider(provider) !== undefined;
}

/**
 * Resolves the launch form for an entry. User-defined commands win, then
 * `npx`, then `uvx`. Returns `undefined` when the entry has no supported
 * launch form (for example a binary-only registry entry).
 */
export function resolveExternalAgentLaunch(entry: IExternalAgentEntry): IExternalAgentLaunch | undefined {
	const d = entry.distribution;
	if (d.command?.command) {
		return d.command.env ? { command: d.command.command, args: [...(d.command.args ?? [])], env: d.command.env } : { command: d.command.command, args: [...(d.command.args ?? [])] };
	}
	if (d.npx?.package) {
		return { command: 'npx', args: ['--yes', d.npx.package, ...(d.npx.args ?? [])] };
	}
	if (d.uvx?.package) {
		return { command: 'uvx', args: [d.uvx.package, ...(d.uvx.args ?? [])] };
	}
	return undefined;
}

/** Short human-readable description of how an entry launches. */
export function describeExternalAgentLaunch(entry: IExternalAgentEntry): string {
	const d = entry.distribution;
	if (d.command?.command) {
		return [d.command.command, ...(d.command.args ?? [])].join(' ');
	}
	if (d.npx?.package) {
		return `npx ${d.npx.package}`;
	}
	if (d.uvx?.package) {
		return `uvx ${d.uvx.package}`;
	}
	return '';
}

// ---- Parsing ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') {
			return undefined;
		}
		out.push(item);
	}
	return out;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== 'string') {
			return undefined;
		}
		out[k] = v;
	}
	return out;
}

function parseDistribution(value: unknown): IExternalAgentDistribution | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const out: { npx?: IExternalAgentDistribution['npx']; uvx?: IExternalAgentDistribution['uvx']; command?: IExternalAgentDistribution['command']; binaryOnly?: boolean } = {};
	if (isRecord(value.npx) && typeof value.npx.package === 'string' && value.npx.package.length > 0) {
		out.npx = { package: value.npx.package, args: stringArray(value.npx.args) };
	}
	if (isRecord(value.uvx) && typeof value.uvx.package === 'string' && value.uvx.package.length > 0) {
		out.uvx = { package: value.uvx.package, args: stringArray(value.uvx.args) };
	}
	if (isRecord(value.command) && typeof value.command.command === 'string' && value.command.command.trim().length > 0) {
		const env = stringRecord(value.command.env);
		out.command = { command: value.command.command.trim(), args: stringArray(value.command.args), ...(env ? { env } : {}) };
	}
	if (value.binaryOnly === true) {
		out.binaryOnly = true;
	}
	return out;
}

/**
 * Parses one catalogue entry. Invalid entries yield `undefined` so a single
 * bad row never discards the whole file.
 */
export function parseExternalAgentEntry(value: unknown): IExternalAgentEntry | undefined {
	if (!isRecord(value) || !isValidExternalAgentId(value.id)) {
		return undefined;
	}
	const name = optionalString(value.name);
	const distribution = parseDistribution(value.distribution);
	if (!name || !distribution) {
		return undefined;
	}
	return {
		id: value.id,
		name,
		description: optionalString(value.description),
		version: optionalString(value.version),
		website: optionalString(value.website),
		license: optionalString(value.license),
		source: value.source === 'registry' ? 'registry' : 'custom',
		distribution,
		...(typeof value.memoryIndex === 'boolean' ? { memoryIndex: value.memoryIndex } : {}),
		...(typeof value.browserAccess === 'boolean' ? { browserAccess: value.browserAccess } : {}),
	};
}

/**
 * Parses the catalogue file text. Missing or malformed files produce an
 * empty catalogue rather than throwing, so a corrupt file can be repaired
 * from the UI. Duplicate ids keep the first occurrence.
 */
export function parseExternalAgentCatalogue(text: string | undefined): IExternalAgentCatalogue {
	if (!text || !text.trim()) {
		return emptyExternalAgentCatalogue();
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return emptyExternalAgentCatalogue();
	}
	if (!isRecord(json)) {
		return emptyExternalAgentCatalogue();
	}
	const seen = new Set<string>();
	const agents: IExternalAgentEntry[] = [];
	if (Array.isArray(json.agents)) {
		for (const raw of json.agents) {
			const entry = parseExternalAgentEntry(raw);
			if (entry && !seen.has(entry.id)) {
				seen.add(entry.id);
				agents.push(entry);
			}
		}
	}
	const enabledIds = (stringArray(json.enabledIds) ?? []).filter(id => seen.has(id));
	const registryUrl = optionalString(json.registryUrl) ?? '';
	return { version: EXTERNAL_AGENTS_CATALOGUE_VERSION, registryUrl, agents, enabledIds: [...new Set(enabledIds)] };
}

export function serializeExternalAgentCatalogue(catalogue: IExternalAgentCatalogue): string {
	return JSON.stringify(catalogue, undefined, '\t') + '\n';
}

// ---- Registry --------------------------------------------------------------

/**
 * Maps a registry document (`{ agents: [...] }`) to catalogue entries.
 * Unknown fields are ignored; entries without a usable id or name are
 * skipped; binary-only entries are kept with `binaryOnly: true` so the UI
 * can explain they cannot be launched from this catalogue.
 */
export function mapRegistryToExternalAgentEntries(registry: unknown): IExternalAgentEntry[] {
	if (!isRecord(registry) || !Array.isArray(registry.agents)) {
		return [];
	}
	const out: IExternalAgentEntry[] = [];
	const seen = new Set<string>();
	for (const raw of registry.agents) {
		if (!isRecord(raw)) {
			continue;
		}
		const id = typeof raw.id === 'string' ? normalizeExternalAgentId(raw.id) : undefined;
		const name = optionalString(raw.name);
		if (!id || !name || seen.has(id)) {
			continue;
		}
		const dist = isRecord(raw.distribution) ? raw.distribution : {};
		const distribution: { npx?: IExternalAgentDistribution['npx']; uvx?: IExternalAgentDistribution['uvx']; binaryOnly?: boolean } = {};
		if (isRecord(dist.npx) && typeof dist.npx.package === 'string') {
			distribution.npx = { package: dist.npx.package, args: stringArray(dist.npx.args) };
		}
		if (isRecord(dist.uvx) && typeof dist.uvx.package === 'string') {
			distribution.uvx = { package: dist.uvx.package, args: stringArray(dist.uvx.args) };
		}
		if (!distribution.npx && !distribution.uvx) {
			if (!isRecord(dist.binary)) {
				continue;
			}
			distribution.binaryOnly = true;
		}
		seen.add(id);
		out.push({
			id,
			name,
			description: optionalString(raw.description),
			version: optionalString(raw.version),
			website: optionalString(raw.website) ?? optionalString(raw.repository),
			license: optionalString(raw.license),
			source: 'registry',
			distribution,
		});
	}
	return out;
}

/**
 * Merges freshly fetched registry entries into a catalogue. Registry-sourced
 * rows are replaced by id, custom rows are untouched, and `enabledIds` is
 * preserved exactly (minus ids that no longer exist).
 */
export function mergeRegistryEntries(catalogue: IExternalAgentCatalogue, fetched: readonly IExternalAgentEntry[]): IExternalAgentCatalogue {
	const custom = catalogue.agents.filter(a => a.source === 'custom');
	const customIds = new Set(custom.map(a => a.id));
	const registry = fetched.filter(a => !customIds.has(a.id)).map(entry => {
		const previous = catalogue.agents.find(a => a.id === entry.id);
		return { ...entry, ...(previous?.memoryIndex !== undefined ? { memoryIndex: previous.memoryIndex } : {}), ...(previous?.browserAccess !== undefined ? { browserAccess: previous.browserAccess } : {}) };
	});
	const agents = [...custom, ...registry];
	const ids = new Set(agents.map(a => a.id));
	return {
		...catalogue,
		agents,
		enabledIds: catalogue.enabledIds.filter(id => ids.has(id)),
	};
}

export function setExternalAgentEnabled(catalogue: IExternalAgentCatalogue, id: string, enabled: boolean): IExternalAgentCatalogue {
	if (!catalogue.agents.some(a => a.id === id)) {
		return catalogue;
	}
	const set = new Set(catalogue.enabledIds);
	if (enabled) {
		set.add(id);
	} else {
		set.delete(id);
	}
	return { ...catalogue, enabledIds: [...set] };
}

export function upsertExternalAgent(catalogue: IExternalAgentCatalogue, entry: IExternalAgentEntry): IExternalAgentCatalogue {
	const agents = catalogue.agents.some(a => a.id === entry.id)
		? catalogue.agents.map(a => a.id === entry.id ? entry : a)
		: [...catalogue.agents, entry];
	return { ...catalogue, agents };
}

export function removeExternalAgent(catalogue: IExternalAgentCatalogue, id: string): IExternalAgentCatalogue {
	return {
		...catalogue,
		agents: catalogue.agents.filter(a => a.id !== id),
		enabledIds: catalogue.enabledIds.filter(e => e !== id),
	};
}

/** Structural equality of the parts that affect how an agent is launched. */
export function externalAgentLaunchEquals(a: IExternalAgentEntry, b: IExternalAgentEntry): boolean {
	const la = resolveExternalAgentLaunch(a);
	const lb = resolveExternalAgentLaunch(b);
	if (!la || !lb) {
		return la === lb;
	}
	return la.command === lb.command
		&& la.args.length === lb.args.length
		&& la.args.every((v, i) => v === lb.args[i])
		&& JSON.stringify(la.env ?? {}) === JSON.stringify(lb.env ?? {});
}
