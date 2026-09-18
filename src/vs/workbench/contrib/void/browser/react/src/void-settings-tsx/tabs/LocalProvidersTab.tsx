/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React from 'react';
import { localProviderNames } from '../settingsExternals.js';
import ErrorBoundary from '../../util/ErrorBoundary.js'
import {
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js'
import { OllamaSetupInstructions, VoidProviderSettings } from '../settingsShared.js'

export const LocalProvidersTab = () => (
	<ErrorBoundary>
		<p className="@@v3code-settings-row-desc mb-4 m-0">{`V3Code can access any model that you host locally. We automatically detect your local models by default.`}</p>
		<SettingsSection label="Setup">
			<SettingsCard>
				<div className="px-4 py-3 opacity-80">
					<OllamaSetupInstructions sayWeAutoDetect={true} />
				</div>
			</SettingsCard>
		</SettingsSection>
		<VoidProviderSettings providerNames={localProviderNames} />
	</ErrorBoundary>
)
