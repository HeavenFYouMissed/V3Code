/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import type { VoidStaticModelInfo } from './modelCapabilities.js';
import type { VoidStatefulModelInfo } from './voidSettingsTypes.js';

/** Only documented, validated API metadata becomes discovered defaults. User overrides win. */
export function parseOpenRouterCatalogue(rows: readonly unknown[]): Map<string, Partial<VoidStaticModelInfo> & { supportsTools?: boolean }> {
	const result = new Map<string, Partial<VoidStaticModelInfo> & { supportsTools?: boolean }>();
	for (const row of rows) {
		if (!row || typeof row !== 'object') { continue; }
		const model = row as Record<string, unknown>;
		if (typeof model.id !== 'string' || !model.id.trim() || /[\x00-\x1f]/.test(model.id)) { continue; }
		const caps: Partial<VoidStaticModelInfo> & { supportsTools?: boolean } = {};
		if (Array.isArray(model.supported_parameters)) {
			caps.supportsTools = model.supported_parameters.includes('tools');
			caps.specialToolFormat = model.supported_parameters.includes('tools') ? 'openai-style' : undefined;
		}
		if (typeof model.context_length === 'number' && Number.isSafeInteger(model.context_length) && model.context_length > 0) {
			caps.contextWindow = model.context_length;
		}
		const architecture = model.architecture as { input_modalities?: unknown } | undefined;
		if (Array.isArray(architecture?.input_modalities)) {
			caps.supportsVision = architecture.input_modalities.includes('image');
		}
		result.set(model.id, caps);
	}
	return result;
}

export function mergeOpenRouterModels(existing: readonly VoidStatefulModelInfo[], ids: readonly string[]): VoidStatefulModelInfo[] {
	const previous = new Map(existing.map(model => [model.modelName, model]));
	const discovered = new Set(ids);
	return [
		...ids.map(modelName => ({ modelName, type: previous.get(modelName)?.type === 'custom' ? 'custom' as const : 'autodetected' as const, isHidden: previous.get(modelName)?.isHidden ?? true })),
		...existing.filter(model => model.type === 'custom' && !discovered.has(model.modelName)),
	];
}
