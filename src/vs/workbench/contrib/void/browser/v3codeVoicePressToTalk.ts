/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Global press-to-talk hold tracking. Survives chat-toolbar re-renders.
 * Captures the active pointer on document.body so focusInput() / toolbar rebuilds
 * do not emit pointercancel and abort the session.
 */

import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

let holdListeners: DisposableStore | undefined;
let activePointerId: number | undefined;

export function armV3VoicePressToTalkHold(pointerId: number, onRelease: () => void | Promise<void>): IDisposable {
	disarmV3VoicePressToTalkHold();

	const store = new DisposableStore();
	holdListeners = store;
	activePointerId = pointerId;

	let released = false;
	let acceptRelease = false;

	const release = () => {
		if (!acceptRelease || released) {
			return;
		}
		released = true;
		disarmV3VoicePressToTalkHold();
		void Promise.resolve(onRelease());
	};

	const targetWindow = getWindow(undefined);
	const body = targetWindow.document.body;

	const releaseCapture = () => {
		try {
			if (body.hasPointerCapture?.(pointerId)) {
				body.releasePointerCapture(pointerId);
			}
		} catch {
			// ignore
		}
	};

	const onPointerUp = (e: PointerEvent) => {
		if (e.pointerId === activePointerId && e.button === 0) {
			releaseCapture();
			release();
		}
	};

	try {
		body.setPointerCapture(pointerId);
	} catch {
		// Some platforms reject capture on body; pointerup-only still works.
	}

	store.add(toDisposable(releaseCapture));
	// pointerup only — pointercancel fires when focusInput() moves focus off the mic.
	store.add(addDisposableListener(targetWindow, 'pointerup', onPointerUp, true));

	targetWindow.requestAnimationFrame(() => {
		targetWindow.requestAnimationFrame(() => {
			acceptRelease = true;
		});
	});

	return {
		dispose: () => disarmV3VoicePressToTalkHold(),
	};
}

export function disarmV3VoicePressToTalkHold(): void {
	activePointerId = undefined;
	if (holdListeners) {
		holdListeners.dispose();
		holdListeners = undefined;
	}
}
