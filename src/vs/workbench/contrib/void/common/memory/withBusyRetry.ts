/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Busy/locked retry for SQLite writes (WAL = one writer at a time). PRAGMA busy_timeout
 * covers short contention inside SQLite; this wrapper covers the longer ones. Errors are
 * rethrown naming the exact failing stage so callers can surface them — a failed durable
 * write must never vanish silently.
 *
 * Pure and headlessly testable: the sleep is injected.
 */
export async function withBusyRetry<T>(
	stage: string,
	op: () => Promise<T>,
	sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
	const delaysMs = [0, 75, 250, 500];
	let lastError: unknown;
	for (let attempt = 0; attempt < delaysMs.length; attempt++) {
		if (delaysMs[attempt] > 0) await sleep(delaysMs[attempt]);
		try {
			return await op();
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			if (!/busy|locked/i.test(message)) break;
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`memory write failed at stage "${stage}": ${message}`);
}
