/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * A later call supersedes any earlier pending one. Use one instance per document.
 */
export class AutocompleteDebouncer {
	private debounceTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
	private resolvePending: ((shouldDebounce: boolean) => void) | undefined = undefined;

	async delayAndShouldDebounce(debounceDelayMs: number): Promise<boolean> {
		// Supersede the in-flight call by RESOLVING it, not just by clearing its timer.
		// Its `resolve` only ever ran inside the timer we cancel here, so cancelling
		// alone left the caller awaiting a promise that could never settle: every fast
		// keystroke stranded an autocomplete request, and because the provider batch
		// waits on all of them, ghost text stopped appearing until a new editor built a
		// fresh debouncer. Resolving true means "superseded - skip this one".
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = undefined;
		}
		this.resolvePending?.(true);
		this.resolvePending = undefined;

		return new Promise<boolean>(resolve => {
			this.resolvePending = resolve;
			this.debounceTimeout = setTimeout(() => {
				this.debounceTimeout = undefined;
				this.resolvePending = undefined;
				resolve(false);
			}, debounceDelayMs);
		});
	}
}
