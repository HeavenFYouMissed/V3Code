/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useEffect, useState } from 'react';
import * as ReactDOM from 'react-dom/client'
import { markAsSingleton } from '../../../../../../../base/common/lifecycle.js';
import { _registerServices } from './services.js';


import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';

let _servicesRegistered = false
let _globalDisposables: Array<{ dispose(): void }> = []

export const mountFnGenerator = (Component: (params: any) => React.ReactNode) => (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => {
	if (typeof document === 'undefined') {
		console.error('index.tsx error: document was undefined')
		return
	}

	// Only register shared services once. The agent panel (VoidChatEditorPane)
	// creates a second mount point which would otherwise call _registerServices
	// again, adding duplicate event listeners that fire on stale/unmounted
	// React components.
	if (!_servicesRegistered) {
		_servicesRegistered = true
		_globalDisposables = _registerServices(accessor)
		for (const d of _globalDisposables) {
			markAsSingleton(d)
		}
	}

	const root = ReactDOM.createRoot(rootElement)

	const rerender = (props?: any) => {
		root.render(<Component {...props} />); // tailwind dark theme indicator
	}
	const dispose = () => {
		root.unmount()
		// Do NOT dispose global service listeners — they're shared across
		// all mount points. Only the React root is scoped to this mount.
	}

	rerender(props)

	const returnVal = {
		rerender,
		dispose,
	}
	return returnVal
}
