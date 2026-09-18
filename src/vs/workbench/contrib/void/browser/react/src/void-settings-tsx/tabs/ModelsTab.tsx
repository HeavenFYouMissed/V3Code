/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React from 'react';
import { refreshableProviderNames, displayInfoOfProviderName } from '../settingsExternals.js';
import ErrorBoundary from '../../util/ErrorBoundary.js'
import {
	SettingRow,
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js'
import {
	AutoDetectLocalModelsToggleControl,
	ModelDump,
	RefreshableModelsRows,
} from '../settingsShared.js'

export const ModelsTab = () => (
	<ErrorBoundary>
		<ModelDump />
		<SettingsSection label="Detection">
			<SettingsCard>
				<SettingRow
					settingId="models.autodetect"
					title="Auto-detect local models"
					description={`Automatically detect local providers and models (${refreshableProviderNames.map(providerName => displayInfoOfProviderName(providerName).title).join(', ')}).`}
					control={<AutoDetectLocalModelsToggleControl />}
				/>
				<RefreshableModelsRows />
			</SettingsCard>
		</SettingsSection>
	</ErrorBoundary>
)
