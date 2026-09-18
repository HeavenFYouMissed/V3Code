/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import type { Env } from '../env.js';

export type IndexProfile = 'standard' | 'advanced';
export type PrivacyMode = 'full' | 'vectors-only' | 'ephemeral';

export function isIndexProfile(value: unknown): value is IndexProfile {
	return value === 'standard' || value === 'advanced';
}

export function isPrivacyMode(value: unknown): value is PrivacyMode {
	return value === 'full' || value === 'vectors-only' || value === 'ephemeral';
}

export function privacyModeForProfile(profile: IndexProfile): 'vectors-only' | 'ephemeral' {
	return profile === 'advanced' ? 'ephemeral' : 'vectors-only';
}

/** Select the physical vector space. Never fall back from Advanced to Standard:
 * that would make a temporary binding error silently mix incompatible models. */
export function vectorIndexFor(env: Env, profile: IndexProfile): VectorizeIndex {
	if (profile === 'advanced') {
		if (!env.VECTORS_VOYAGE) throw new Error('Advanced index is not configured: VECTORS_VOYAGE is missing');
		return env.VECTORS_VOYAGE;
	}
	return env.VECTORS;
}
