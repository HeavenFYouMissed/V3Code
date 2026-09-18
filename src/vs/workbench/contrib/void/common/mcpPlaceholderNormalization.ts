/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Install-time placeholder normalization: published MCP configs arrive with bare
 * `${VAR}` placeholders that the editor's ConfigurationResolver will
 * never fill — the exact way `Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` once reached
 * the network verbatim. Before anything is persisted or connected, every bare
 * placeholder is rewritten into a form upstream resolves BEFORE network contact:
 *
 *   secret-shaped values   → `${input:VAR}` + a password-masked prompt definition
 *                            (resolved values live in the encrypted input storage)
 *   other values           → `${input:VAR}` with a plain prompt, or `${env:VAR}`
 *                            for stdio env passthrough
 *
 * Catalog/gallery metadata (CatalogInput.isSecret / isRequired) always wins over
 * the name-based heuristic. Detection itself lives in mcpCatalog.findUnresolvedVariables
 * — the single detector for the whole lane; never add another placeholder regex.
 */

import { IMcpServerVariable, McpServerVariableType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { CatalogInput, findUnresolvedVariables } from './mcpCatalog.js';
import { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

const SECRET_NAME_RE = /(TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH|PAT)/i;

export interface NormalizedMcpEntry {
	readonly entry: MCPConfigFileEntryJSON;
	/** Prompt definitions for upstream's `install({ inputs })`; empty when nothing to ask. */
	readonly inputs: readonly IMcpServerVariable[];
	/** Human-readable notes about every rewrite, for logging — never contains values. */
	readonly notices: readonly string[];
}

const enum PlaceholderContext { Header, Url, Env, CommandLine }

function classifyAsSecret(name: string, context: PlaceholderContext, meta: CatalogInput | undefined): boolean {
	if (meta?.isSecret !== undefined) {
		return meta.isSecret;
	}
	// Anything a header carries is credential-shaped until proven otherwise.
	return context === PlaceholderContext.Header || SECRET_NAME_RE.test(name);
}

export function normalizeMcpEntryPlaceholders(rawEntry: MCPConfigFileEntryJSON, requiredInputs?: readonly CatalogInput[]): NormalizedMcpEntry {
	const metaByName = new Map<string, CatalogInput>((requiredInputs ?? []).map(i => [i.name, i]));
	const inputsById = new Map<string, IMcpServerVariable>();
	const notices: string[] = [];

	const promptInput = (name: string, context: PlaceholderContext): string => {
		const meta = metaByName.get(name);
		const password = classifyAsSecret(name, context, meta);
		if (!inputsById.has(name)) {
			inputsById.set(name, {
				id: name,
				type: McpServerVariableType.PROMPT,
				description: meta?.description ?? (password ? `Value for the secret ${name}` : `Value for ${name}`),
				password,
				default: meta?.default,
			});
			notices.push(password
				? `"\${${name}}" will be requested securely and stored encrypted; it is never written into the config.`
				: `"\${${name}}" will be requested before the first connection.`);
		}
		return `\${input:${name}}`;
	};

	const rewriteValue = (value: string, context: PlaceholderContext): string => {
		const bare = findUnresolvedVariables([value]);
		let out = value;
		for (const name of bare) {
			const meta = metaByName.get(name);
			// stdio env passthrough keeps process-environment semantics unless the
			// catalog says the value must be asked for.
			const replacement = context === PlaceholderContext.Env && meta?.isRequired !== true && !classifyAsSecret(name, context, meta)
				? `\${env:${name}}`
				: promptInput(name, context);
			out = out.split(`\${${name}}`).join(replacement);
		}
		return out;
	};

	const rewriteRecord = (record: Record<string, string> | undefined, context: PlaceholderContext): Record<string, string> | undefined => {
		if (record === undefined) { return undefined; }
		// Keys go through the same pipeline: upstream's expression parser walks object
		// keys too, so a templated NAME left bare would be launch-refused forever.
		return Object.fromEntries(Object.entries(record).map(([k, v]) => [rewriteValue(k, context), rewriteValue(v, context)]));
	};

	const entry: MCPConfigFileEntryJSON = {
		...rawEntry,
		...(rawEntry.url !== undefined ? { url: rewriteValue(String(rawEntry.url), PlaceholderContext.Url) as unknown as MCPConfigFileEntryJSON['url'] } : {}),
		headers: rewriteRecord(rawEntry.headers, PlaceholderContext.Header),
		command: rawEntry.command !== undefined ? rewriteValue(rawEntry.command, PlaceholderContext.CommandLine) : undefined,
		args: rawEntry.args?.map(a => rewriteValue(a, PlaceholderContext.CommandLine)),
		env: rewriteRecord(rawEntry.env, PlaceholderContext.Env),
	};

	// A required env input the config never mentions still needs a value — docker-style
	// `-e NAME` passthrough reads it from the process environment, so inject a prompted
	// value there rather than silently spawning without it.
	for (const meta of requiredInputs ?? []) {
		if (meta.target === 'env' && meta.isRequired === true && entry.command !== undefined && entry.env?.[meta.name] === undefined) {
			entry.env = { ...(entry.env ?? {}), [meta.name]: promptInput(meta.name, PlaceholderContext.Env) };
		}
	}

	return { entry, inputs: [...inputsById.values()], notices };
}
