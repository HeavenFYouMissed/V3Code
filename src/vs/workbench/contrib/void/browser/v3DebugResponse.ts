/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { resolveV3BuiltinModeName } from '../common/v3DebugMode.js';

interface IResponseLike {
	readonly model?: { readonly request?: { readonly modeInfo?: { readonly modeName?: string } } };
}

const cache = new WeakMap<object, boolean>();

/**
 * True when the rendered element is a response to a request made in the built-in Debug mode.
 * The request's persisted `modeName` is the source of truth (it is what the native agent
 * resolves the mode from too), so a reopened Debug chat renders as Debug. Cached per element
 * because reconciliation runs on every tool state change.
 */
export function isV3DebugResponse(element: unknown): boolean {
	if (!element || typeof element !== 'object') {
		return false;
	}
	const cached = cache.get(element);
	if (cached !== undefined) {
		return cached;
	}
	const request = (element as IResponseLike).model?.request;
	if (!request) {
		return false; // not cacheable yet: the request may still be attaching
	}
	const result = resolveV3BuiltinModeName(request.modeInfo?.modeName) === 'debug';
	cache.set(element, result);
	return result;
}
