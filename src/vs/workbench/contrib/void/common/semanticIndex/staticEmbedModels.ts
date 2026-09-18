/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export const POTION_CODE_V1_REPO = 'minishlab/potion-code-16M';
export const POTION_CODE_V2_REPO = 'minishlab/potion-code-16M-v2';

/** Release default. V2 remains loadable for controlled evaluation, but the
 * full-corpus V3Code gate currently ranks V1 higher with our shipped hybrid
 * weights and contextual-header format. */
export const STATIC_CODE_REPO = POTION_CODE_V1_REPO;

/** Remove V3Code's chunk-text scheme suffix from a persisted embedder identity. */
export function rawEmbedModelId(modelId: string): string {
	return modelId.replace(/\+hdr\d+$/, '');
}

/** Resolve only the static spaces this build knows how to load. Fail closed for
 * transformer ids: comparing a query from the wrong vector space is worse than
 * omitting the previous-vector channel for that query. */
export function staticCodeRepoForIdentity(modelId: string): string | undefined {
	const raw = rawEmbedModelId(modelId);
	return raw === POTION_CODE_V1_REPO || raw === POTION_CODE_V2_REPO ? raw : undefined;
}

export function isStaticCodeModel(modelId: string): boolean {
	return staticCodeRepoForIdentity(modelId) !== undefined;
}
