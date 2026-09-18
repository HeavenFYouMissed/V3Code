/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React from 'react';
import { nonlocalProviderNames } from '../settingsExternals.js';
import ErrorBoundary from '../../util/ErrorBoundary.js'
import { VoidProviderSettings } from '../settingsShared.js'

export const MainProvidersTab = () => (
	<ErrorBoundary>
		<p className="@@v3code-settings-row-desc mb-4 m-0">{`V3Code can access models from Anthropic, OpenAI, OpenRouter, and more.`}</p>
		<VoidProviderSettings providerNames={nonlocalProviderNames} />
	</ErrorBoundary>
)
