/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { ILanguageModelsService } from '../common/languageModels.js';

const V3CODE_VENDOR = 'v3code';
// Tier ids (not raw provider/model ids): utility calls (tool risk assessment,
// thinking summaries) must ride the HOSTED lane for paid users — the raw ids
// now read as BYOK under tag-strict tier matching and would demand an own key.
export const V3CODE_FAST_MODEL_ID = 'v3code/tier/V3Fast';
export const V3CODE_PRO_MODEL_ID = 'v3code/tier/V3Pro';

export async function selectV3CodeUtilityModel(languageModelsService: ILanguageModelsService, preferredModelId?: string): Promise<string[]> {
	const preferred = preferredModelId?.trim();
	const preferredCandidates = preferred ? [preferred] : [];
	const defaultCandidates = [V3CODE_FAST_MODEL_ID, V3CODE_PRO_MODEL_ID];

	for (const candidate of [...preferredCandidates, ...defaultCandidates]) {
		if (!candidate || candidate === 'copilot-utility-small') {
			continue;
		}

		const models = await languageModelsService.selectLanguageModels({ vendor: V3CODE_VENDOR, id: candidate });
		if (models.length) {
			return models;
		}
	}

	const models = await languageModelsService.selectLanguageModels({ vendor: V3CODE_VENDOR });
	if (!preferred) {
		return models;
	}

	const exactOrSuffix = models.find(model => model === preferred || model.endsWith(`/${preferred}`));
	return exactOrSuffix ? [exactOrSuffix] : models;
}
