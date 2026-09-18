/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { RawToolParamsObj } from '../sendLLMMessageTypes.js';

/**
 * Parses streamed function-call arguments without rejecting providers that represent an
 * all-optional/no-argument call as an empty string instead of the canonical `{}` JSON object.
 */
export function parseRawToolParamsString(value: string): RawToolParamsObj | null {
	const json = value.trim() || '{}';
	let input: unknown;
	try {
		input = JSON.parse(json);
	} catch {
		return null;
	}

	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return null;
	}

	return input as RawToolParamsObj;
}
