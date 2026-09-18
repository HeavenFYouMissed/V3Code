/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { generateKeyPairSync, sign } from 'node:crypto'
import { getModelCapabilities } from '../../common/modelCapabilities.js'
import { isV3CodeFreeModelId, V3CODE_FREE_AUTO_MODEL, V3CODE_FREE_ROTATION, V3CODE_FREE_VISION_MODEL } from '../../common/v3codeFreeModels.js'
import { canonicalV3CodeRouteJson, V3CodeFreeRouteManifestPayload } from '../../common/v3codeFreeRouteManifest.js'
import { BUILTIN_V3CODE_FREE_ROUTES, verifyV3CodeFreeRouteManifest } from '../../electron-main/llmMessage/v3codeFreeRouteManifest.js'

suite('V3Code free route manifest', () => {
	test('accepts a canonical Ed25519 signature and rejects mutation', () => {
		const pair = generateKeyPairSync('ed25519')
		const payload: V3CodeFreeRouteManifestPayload = {
			schemaVersion: 1,
			revision: 'test-revision',
			generatedAt: '2026-08-28T12:00:00.000Z',
			expiresAt: '2026-08-28T13:00:00.000Z',
			keyId: 'test-key',
			routes: [...BUILTIN_V3CODE_FREE_ROUTES],
		}
		const signature = sign(null, Buffer.from(canonicalV3CodeRouteJson(payload)), pair.privateKey).toString('base64')
		const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
		assert.ok(verifyV3CodeFreeRouteManifest({ payload, signature }, { 'test-key': publicKey }, Date.parse('2026-08-28T12:30:00.000Z')))
		assert.equal(verifyV3CodeFreeRouteManifest({ payload: { ...payload, revision: 'tampered' }, signature }, { 'test-key': publicKey }, Date.parse('2026-08-28T12:30:00.000Z')), undefined)
	})

	test('rejects private endpoints even when the envelope shape is otherwise valid', () => {
		const pair = generateKeyPairSync('ed25519')
		const payload: V3CodeFreeRouteManifestPayload = {
			schemaVersion: 1,
			revision: 'private-endpoint',
			generatedAt: '2026-08-28T12:00:00.000Z',
			expiresAt: '2026-08-28T13:00:00.000Z',
			keyId: 'test-key',
			routes: [{ ...BUILTIN_V3CODE_FREE_ROUTES[0], endpoint: 'https://127.0.0.1/v1' }],
		}
		const signature = sign(null, Buffer.from(canonicalV3CodeRouteJson(payload)), pair.privateKey).toString('base64')
		const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
		assert.equal(verifyV3CodeFreeRouteManifest({ payload, signature }, { 'test-key': publicKey }, Date.parse('2026-08-28T12:30:00.000Z')), undefined)
	})

	test('allows wildcard regions but rejects wildcard model ids', () => {
		const pair = generateKeyPairSync('ed25519')
		const route = { ...BUILTIN_V3CODE_FREE_ROUTES[0], logicalModels: ['*'], regions: ['*'] }
		const payload: V3CodeFreeRouteManifestPayload = {
			schemaVersion: 1,
			revision: 'wildcard-model',
			generatedAt: '2026-08-28T12:00:00.000Z',
			expiresAt: '2026-08-28T13:00:00.000Z',
			keyId: 'test-key',
			routes: [route],
		}
		const signature = sign(null, Buffer.from(canonicalV3CodeRouteJson(payload)), pair.privateKey).toString('base64')
		const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
		assert.equal(verifyV3CodeFreeRouteManifest({ payload, signature }, { 'test-key': publicKey }, Date.parse('2026-08-28T12:30:00.000Z')), undefined)
	})

	test('the offline route sheet and the picker roster are the same set', () => {
		// The bug this catches: `hy3-free` sat in the rotation with a matching built-in route, but
		// the gateway had never heard of it. Keeping the two lists paired means one edit updates
		// both, so a model can't be advertised in the picker with no route (unreachable) or given
		// a route with no capability record (sent with wrong limits).
		const routed = BUILTIN_V3CODE_FREE_ROUTES.map(route => route.upstreamModel).sort()
		assert.deepStrictEqual(routed, [...V3CODE_FREE_ROTATION].sort())
	})

	test('every built-in route is a free id, reaches the Zen gateway, and can call tools', () => {
		for (const route of BUILTIN_V3CODE_FREE_ROUTES) {
			// A paid id here would bill the gateway owner rather than the user.
			assert.ok(isV3CodeFreeModelId(route.upstreamModel), `${route.upstreamModel} is not a free id`)
			assert.strictEqual(getModelCapabilities('v3code-free', route.upstreamModel, undefined).cost.input, 0, route.upstreamModel)
			assert.strictEqual(route.endpoint, 'https://opencode.ai/zen/v1', route.upstreamModel)
			// The protocol must match what the model actually serves: Zen splits its catalogue across
			// the Chat Completions and Responses surfaces, and a Responses-only id (`muse-spark-*`)
			// 500s with "Internal server error" if it is sent down the Chat Completions path.
			const expectedProtocol = route.upstreamModel.startsWith('muse-spark-')
				? 'openai-responses'
				: 'openai-chat-completions'
			assert.strictEqual(route.protocol, expectedProtocol, route.upstreamModel)
			// free-auto failover only works if each route also answers to the synthetic id.
			assert.ok(route.logicalModels.includes(V3CODE_FREE_AUTO_MODEL), `${route.upstreamModel} is not in free-auto`)
			// A worker that cannot call tools is useless as an agent backend.
			assert.strictEqual(route.capabilities.tools, true, route.upstreamModel)
		}
	})

	test('free-auto can still serve an image turn', () => {
		// Image turns are ordered vision-first, so at least one route must accept images.
		const visionRoutes = BUILTIN_V3CODE_FREE_ROUTES.filter(route => route.capabilities.vision)
		assert.ok(visionRoutes.length > 0, 'no vision-capable free route remains')
		assert.ok(visionRoutes.some(route => route.upstreamModel === V3CODE_FREE_VISION_MODEL))
		assert.strictEqual(getModelCapabilities('v3code-free', V3CODE_FREE_VISION_MODEL, undefined).supportsVision, true)
	})

	test('failover priorities are unique so the rotation order is deterministic', () => {
		const priorities = BUILTIN_V3CODE_FREE_ROUTES.map(route => route.priority)
		assert.strictEqual(new Set(priorities).size, priorities.length)
		assert.deepStrictEqual([...priorities].sort((a, b) => a - b), priorities, 'routes must be listed in failover order')
	})
})
