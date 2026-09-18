/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createPublicKey, verify } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	canonicalV3CodeRouteJson,
	SignedV3CodeFreeRouteManifest,
	V3CodeFreeRoute,
	V3CodeFreeRouteProtocol,
	validateV3CodeFreeRouteManifest,
} from '../../common/v3codeFreeRouteManifest.js'

const V3CODE_MODEL_ROUTE_URL = 'https://backend-production-fc598.up.railway.app/api/editor/model-routes/v1'
const MANIFEST_REFRESH_MS = 15 * 60_000
const MANIFEST_FETCH_TIMEOUT_MS = 8_000
const MAX_STALE_MS = 7 * 24 * 60 * 60_000
const CACHE_PATH = join(homedir(), '.v3code', 'model-routes-v1.json')

/** Pin only PUBLIC Ed25519 keys. The matching private key lives outside every repository. */
export const V3CODE_FREE_ROUTE_PUBLIC_KEYS: Record<string, string> = {
	'v3code-free-routes-2026-08': 'MCowBQYDK2VwAyEA/pysyOjS66E329+kztQuJtDRx8oeE6+fh1jBnvHi8aI=',
}

/**
 * `protocol` selects the sender inside the free transport: 'openai-chat-completions' goes to
 * `POST {endpoint}/chat/completions`, 'openai-responses' to `POST {endpoint}/responses`. Zen splits
 * its catalogue across both, so a free id is only reachable if this matches what that model
 * actually serves — the Responses-only muse-spark pair 500s on the Chat Completions path.
 */
const builtinRoute = (
	upstreamModel: string,
	priority: number,
	vision = false,
	protocol: V3CodeFreeRouteProtocol = 'openai-chat-completions',
): V3CodeFreeRoute => ({
	id: `builtin-opencode-${upstreamModel}`,
	logicalModels: ['free-auto', upstreamModel],
	label: upstreamModel,
	enabled: true,
	mode: 'public-direct',
	endpoint: 'https://opencode.ai/zen/v1',
	protocol,
	upstreamModel,
	priority,
	capabilities: { tools: true, vision, reasoning: true },
	timeoutMs: 45_000,
	cooldownMs: 5 * 60_000,
	retryableStatuses: [401, 404, 408, 409, 425, 429, 500, 502, 503, 504],
	regions: ['*'],
	publicApiKey: 'public',
	headers: { 'x-opencode-client': 'v3code', 'User-Agent': 'v3code' },
})

/**
 * Offline safety net used only when the signed route sheet cannot be fetched OR read from cache.
 * Must stay in lockstep with V3CODE_FREE_ROTATION — a route sheet that advertises a model the
 * capability table doesn't know sends the prompt with fallback limits, and a rotation member with
 * no route is unreachable. `subagentFreeRosterMatchesRoutes` in the tests enforces that pairing.
 *
 * Order IS the failover order (priority ascending). Re-verified against the live gateway on
 * 2026-09-12; see V3CODE_FREE_ROTATION for the per-model probe results and removal reasons.
 *
 * The two muse-spark entries sit LAST because failover order is a reliability ranking: the four
 * Chat Completions ids ahead of them are the ones that have answered consistently across probes.
 * A user who wants the newest model simply picks it by name.
 */
export const BUILTIN_V3CODE_FREE_ROUTES: readonly V3CodeFreeRoute[] = [
	builtinRoute('nemotron-3.5-lightning-free', 10),
	builtinRoute('ling-3.0-flash-fin-free', 20),
	builtinRoute('big-pickle', 30),
	builtinRoute('mimo-v2.5-free', 40, true),
	builtinRoute('nemotron-3-ultra-free', 50),
	builtinRoute('muse-spark-1.3-contributor-free', 60, true, 'openai-responses'),
	builtinRoute('muse-spark-1.2-contributor-free', 70, true, 'openai-responses'),
]

type CachedEnvelope = { fetchedAt: string; manifest: SignedV3CodeFreeRouteManifest }
type RouteResolution = { routes: V3CodeFreeRoute[]; revision: string; source: 'live' | 'disk' | 'builtin' }

let memoryCache: { nextRefreshAt: number; resolution: RouteResolution } | undefined
let refreshInFlight: Promise<RouteResolution> | undefined

export const verifyV3CodeFreeRouteManifest = (
	value: unknown,
	publicKeys: Record<string, string> = V3CODE_FREE_ROUTE_PUBLIC_KEYS,
	now = Date.now(),
	maxStaleMs = 0,
): SignedV3CodeFreeRouteManifest | undefined => {
	if (!validateV3CodeFreeRouteManifest(value)) return undefined
	const publicKeyBase64 = publicKeys[value.payload.keyId]
	if (!publicKeyBase64) return undefined
	const expiresAt = Date.parse(value.payload.expiresAt)
	const generatedAt = Date.parse(value.payload.generatedAt)
	if (generatedAt > now + 5 * 60_000 || expiresAt <= generatedAt || expiresAt + maxStaleMs < now) return undefined
	try {
		const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
		return verify(
			null,
			Buffer.from(canonicalV3CodeRouteJson(value.payload), 'utf8'),
			publicKey,
			Buffer.from(value.signature, 'base64'),
		) ? value : undefined
	} catch {
		return undefined
	}
}

const routeResolution = (manifest: SignedV3CodeFreeRouteManifest, source: 'live' | 'disk'): RouteResolution => ({
	routes: manifest.payload.routes
		.filter(route => route.enabled && route.mode === 'public-direct')
		.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
	revision: manifest.payload.revision,
	source,
})

const readDiskManifest = async (): Promise<RouteResolution | undefined> => {
	try {
		const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as CachedEnvelope
		const verified = verifyV3CodeFreeRouteManifest(parsed?.manifest, V3CODE_FREE_ROUTE_PUBLIC_KEYS, Date.now(), MAX_STALE_MS)
		return verified ? routeResolution(verified, 'disk') : undefined
	} catch {
		return undefined
	}
}

const writeDiskManifest = async (manifest: SignedV3CodeFreeRouteManifest): Promise<void> => {
	const tempPath = `${CACHE_PATH}.${process.pid}.tmp`
	await mkdir(dirname(CACHE_PATH), { recursive: true, mode: 0o700 })
	await writeFile(tempPath, `${JSON.stringify({ fetchedAt: new Date().toISOString(), manifest })}\n`, { mode: 0o600 })
	await chmod(tempPath, 0o600)
	await rename(tempPath, CACHE_PATH)
}

const fetchLiveManifest = async (): Promise<RouteResolution> => {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS)
	try {
		const response = await fetch(V3CODE_MODEL_ROUTE_URL, {
			method: 'GET',
			headers: { accept: 'application/json', 'User-Agent': 'V3Code/model-router-v1' },
			redirect: 'error',
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`route manifest returned HTTP ${response.status}`)
		const value = await response.json()
		const manifest = verifyV3CodeFreeRouteManifest(value)
		if (!manifest) throw new Error('route manifest signature or schema is invalid')
		await writeDiskManifest(manifest).catch(error => console.error('[free-router] could not cache verified route sheet', error))
		return routeResolution(manifest, 'live')
	} finally {
		clearTimeout(timeout)
	}
}

const builtinResolution = (): RouteResolution => ({
	routes: [...BUILTIN_V3CODE_FREE_ROUTES],
	revision: 'builtin-2026-08-28',
	source: 'builtin',
})

const refreshResolution = async (): Promise<RouteResolution> => {
	try {
		const resolution = await fetchLiveManifest()
		console.log(`[free-router] live route sheet ${resolution.revision} loaded (${resolution.routes.length} direct routes)`)
		return resolution
	} catch (error) {
		console.error('[free-router] live route refresh failed; trying last verified cache', error)
		const disk = await readDiskManifest()
		if (disk) {
			console.log(`[free-router] using cached signed route sheet ${disk.revision}`)
			return disk
		}
		console.log('[free-router] no verified cache; using the built-in safe route sheet')
		return builtinResolution()
	}
}

export const getV3CodeFreeRouteResolution = async (): Promise<RouteResolution> => {
	if (memoryCache && memoryCache.nextRefreshAt > Date.now()) return memoryCache.resolution
	if (!refreshInFlight) {
		refreshInFlight = refreshResolution()
			.then(resolution => {
				memoryCache = { nextRefreshAt: Date.now() + MANIFEST_REFRESH_MS, resolution }
				return resolution
			})
			.finally(() => { refreshInFlight = undefined })
	}
	return refreshInFlight
}

