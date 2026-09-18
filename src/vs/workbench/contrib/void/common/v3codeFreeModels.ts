/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Synthetic picker entry that opts into failover across the current Zen free roster. */
export const V3CODE_FREE_AUTO_MODEL = 'free-auto'

/**
 * OpenCode's free models are temporary and are retired or replaced without a stable deprecation
 * window. Keep only models that have passed a full V3Code native-tool smoke, and let the transport
 * skip any member that the gateway later reports as unavailable.
 *
 * Re-verified 2026-09-12 against the live gateway (key "public", one tool in the payload, and the
 * `x-opencode-session` header the free tier now demands). Every id below returned HTTP 200 AND a
 * real tool call — the Chat Completions ids via `POST /zen/v1/chat/completions`, the Responses ids
 * via `POST /zen/v1/responses`.
 *
 * This rotation deliberately mixes BOTH protocols. The free transport picks its sender from the
 * resolved route's `protocol`, so a Responses-only free model is usable on equal footing with the
 * Chat Completions ones rather than being a separate lane. Do not restore the old
 * "Chat Completions only" rule when editing this list.
 *
 * RESTORED 2026-09-12 — `nemotron-3-ultra-free` calls tools again after the 2026-09-04 upstream
 * NVIDIA capacity 502s. If it degrades once more the transport simply rotates past it, and its
 * capability record is kept either way, so a user who already selected it is never broken.
 *
 * REMOVED, with the observed reason — do not re-add without a fresh probe:
 *   - `hy3-free`              401 `Model hy3-free is not supported`, and absent from
 *                             `GET /zen/v1/models` entirely — a permanently dead rotation slot
 *                             that burned one failover attempt on every turn.
 *   - `deepseek-v4-flash-free` is still advertised by `GET /zen/v1/models`, but EVERY request
 *                             returns 400 `Model is unavailable`. The "free DeepSeek" is a
 *                             catalogue phantom, not a usable lane — never add it on the strength
 *                             of the model list alone. Re-confirmed 2026-09-12 with a live
 *                             tool-carrying turn (400 on /chat/completions, 500 on /responses).
 *                             The reason is structural, not a transient outage: Zen's free
 *                             DeepSeek promo ENDED 2026-08-20, and DeepSeek retired V4-Flash
 *                             upstream on 2026-09-10 when V4.1-Flash shipped — so this id can
 *                             never come back as a free lane. Zen's own docs list no DeepSeek
 *                             among its free models. Anyone reporting "the free DeepSeek is
 *                             back" is reading the catalogue, not calling the model.
 *                             The genuine V4.1-Flash is a PAID model and reaches V3Code only
 *                             through the BYOK `deepseek` provider (id `deepseek-flash`) or the
 *                             hosted tier — see deepseekFlashVisionOptions in modelCapabilities.
 *   - `laguna-s-2.1-free`     listed historically, now absent from the catalogue and rate limited
 *                             when it did appear.
 */
export const V3CODE_FREE_ROTATION = [
	'nemotron-3.5-lightning-free',
	'ling-3.0-flash-fin-free',
	'mimo-v2.5-free',
	'big-pickle',
	'nemotron-3-ultra-free',
	'muse-spark-1.3-contributor-free',
	'muse-spark-1.2-contributor-free',
] as const

/** The rotation member image turns prefer. The `muse-spark-*-contributor-free` pair also accept images. */
export const V3CODE_FREE_VISION_MODEL = 'mimo-v2.5-free'

/**
 * Is this a model id the zero-cost lane may route to?
 *
 * The free lane must never forward a request to Zen's PAID catalogue — those turns bill the
 * gateway owner, not the user, so an unrecognized id has to be refused rather than passed
 * through. This used to be a bare `endsWith('-free')` check, which silently excluded free models
 * whose ids carry no suffix (`big-pickle` is the current one) and would have quietly dropped them
 * from both the picker and the failover rotation.
 */
export const isV3CodeFreeModelId = (modelName: string): boolean =>
	modelName === V3CODE_FREE_AUTO_MODEL
	|| modelName.endsWith('-free')
	|| (V3CODE_FREE_ROTATION as readonly string[]).includes(modelName)

/**
 * A no-key lane cannot have a user-entered bad key. Zen uses 401 for retired/unsupported free
 * model ids as well as the expected 429/5xx capacity responses, so all of those are safe to retry
 * only while the request has emitted no output.
 */
export const isV3CodeFreeTransientError = (message: string): boolean =>
	/rate.?limit|quota|\b401\b|\b429\b|too many requests|overloaded|capacity|unavailable|not supported|unsupported|unknown model|invalid model|model.{0,40}(?:not found|missing|retired|expired)|timeout|timed out|5\d\d\b|internal server error|bad gateway|response from model was empty/i.test(message)
