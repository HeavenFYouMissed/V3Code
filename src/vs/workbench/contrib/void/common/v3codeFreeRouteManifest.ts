/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export const V3CODE_FREE_ROUTE_SCHEMA_VERSION = 1 as const

export type V3CodeFreeRouteProtocol = 'openai-chat-completions' | 'openai-responses'

export type V3CodeFreeRoute = {
	id: string;
	logicalModels: string[];
	label: string;
	enabled: boolean;
	mode: 'public-direct' | 'hosted-proxy';
	endpoint: string;
	protocol: V3CodeFreeRouteProtocol;
	upstreamModel: string;
	priority: number;
	capabilities: {
		tools: boolean;
		vision: boolean;
		reasoning: boolean;
	};
	timeoutMs: number;
	cooldownMs: number;
	retryableStatuses: number[];
	regions: string[];
	publicApiKey?: string;
	headers?: Record<string, string>;
}

export type V3CodeFreeRouteManifestPayload = {
	schemaVersion: typeof V3CODE_FREE_ROUTE_SCHEMA_VERSION;
	revision: string;
	generatedAt: string;
	expiresAt: string;
	keyId: string;
	routes: V3CodeFreeRoute[];
}

export type SignedV3CodeFreeRouteManifest = {
	payload: V3CodeFreeRouteManifestPayload;
	signature: string;
}

const forbiddenHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value)

const safeIdentifier = (value: unknown, max = 160): value is string =>
	typeof value === 'string' && value.length >= 1 && value.length <= max && /^[a-zA-Z0-9._:/-]+$/.test(value)

const publicHttpsEndpoint = (value: unknown): value is string => {
	if (typeof value !== 'string' || value.length > 500) return false
	try {
		const url = new URL(value)
		if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false
		const host = url.hostname.toLowerCase()
		return !(
			host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local') ||
			/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) ||
			/^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
		)
	} catch {
		return false
	}
}

const validIdentifierArray = (value: unknown, max: number): value is string[] =>
	Array.isArray(value) && value.length >= 1 && value.length <= max && value.every(item => safeIdentifier(item, 120))

const validRegions = (value: unknown): value is string[] =>
	Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every(item => item === '*' || safeIdentifier(item, 120))

const validInteger = (value: unknown, min: number, max: number): value is number =>
	Number.isInteger(value) && Number(value) >= min && Number(value) <= max

export const validateV3CodeFreeRoute = (value: unknown): value is V3CodeFreeRoute => {
	if (!isRecord(value)) return false
	if (!safeIdentifier(value.id, 100) || !validIdentifierArray(value.logicalModels, 16)) return false
	if (typeof value.label !== 'string' || !value.label || value.label.length > 120) return false
	if (typeof value.enabled !== 'boolean' || (value.mode !== 'public-direct' && value.mode !== 'hosted-proxy')) return false
	if (!publicHttpsEndpoint(value.endpoint)) return false
	if (value.protocol !== 'openai-chat-completions' && value.protocol !== 'openai-responses') return false
	if (!safeIdentifier(value.upstreamModel) || !validInteger(value.priority, 0, 10_000)) return false
	if (!validInteger(value.timeoutMs, 2_000, 180_000) || !validInteger(value.cooldownMs, 1_000, 3_600_000)) return false
	if (!isRecord(value.capabilities) ||
		typeof value.capabilities.tools !== 'boolean' ||
		typeof value.capabilities.vision !== 'boolean' ||
		typeof value.capabilities.reasoning !== 'boolean') return false
	if (!Array.isArray(value.retryableStatuses) || value.retryableStatuses.length > 32 ||
		value.retryableStatuses.some(status => !validInteger(status, 400, 599))) return false
	if (!validRegions(value.regions)) return false
	if (value.publicApiKey !== undefined && (typeof value.publicApiKey !== 'string' || value.publicApiKey.length > 200 || /[\r\n]/.test(value.publicApiKey))) return false
	if (value.headers !== undefined) {
		if (!isRecord(value.headers) || Object.keys(value.headers).length > 20) return false
		for (const [name, headerValue] of Object.entries(value.headers)) {
			if (!name.trim() || forbiddenHeaders.has(name.toLowerCase())) return false
			if (typeof headerValue !== 'string' || headerValue.length > 500 || /[\r\n]/.test(headerValue)) return false
		}
	}
	return true
}

export const validateV3CodeFreeRouteManifest = (value: unknown): value is SignedV3CodeFreeRouteManifest => {
	if (!isRecord(value) || typeof value.signature !== 'string' || value.signature.length > 500) return false
	const payload = value.payload
	if (!isRecord(payload) || payload.schemaVersion !== V3CODE_FREE_ROUTE_SCHEMA_VERSION) return false
	if (!safeIdentifier(payload.revision, 100) || !safeIdentifier(payload.keyId, 100)) return false
	if (typeof payload.generatedAt !== 'string' || !Number.isFinite(Date.parse(payload.generatedAt))) return false
	if (typeof payload.expiresAt !== 'string' || !Number.isFinite(Date.parse(payload.expiresAt))) return false
	if (!Array.isArray(payload.routes) || payload.routes.length < 1 || payload.routes.length > 64) return false
	if (!payload.routes.every(validateV3CodeFreeRoute)) return false
	const ids = new Set(payload.routes.map(route => route.id))
	return ids.size === payload.routes.length && payload.routes.some(route => route.enabled && route.logicalModels.includes('free-auto'))
}

export const canonicalV3CodeRouteJson = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonicalV3CodeRouteJson).join(',')}]`
	const object = value as Record<string, unknown>
	return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalV3CodeRouteJson(object[key])}`).join(',')}}`
}
