/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export const MAX_IDLE_AGENT_TERMINALS = 8;

export interface TemporaryTerminalCacheEntry<T> {
	readonly key: string;
	readonly sessionId: string;
	readonly cwdKey: string;
	readonly value: T;
	busy: boolean;
	lastUsed: number;
}

export interface ReusableTemporaryTerminalState {
	readonly isDisposed: boolean;
	readonly hasExited: boolean;
	readonly expectedCwdKey: string;
	readonly actualCwdKey: string | undefined;
}

/**
 * A terminal is reusable only when its shell is live and its current directory can be proven to
 * match the directory requested by the next command. An unknown cwd is deliberately unsafe: a
 * previous command may have changed directories after the terminal was created.
 */
export function isReusableTemporaryTerminal(state: ReusableTemporaryTerminalState): boolean {
	return !state.isDisposed
		&& !state.hasExited
		&& state.actualCwdKey !== undefined
		&& state.actualCwdKey === state.expectedCwdKey;
}

/**
 * Pure ownership/LRU bookkeeping for service-created agent terminals. The caller owns terminal
 * creation and disposal; values returned from release/discard/clear must be disposed by it.
 */
export class TemporaryTerminalCache<T> {
	private readonly entries = new Map<string, TemporaryTerminalCacheEntry<T>>();
	private sequence = 0;

	constructor(private readonly maxIdleEntries = MAX_IDLE_AGENT_TERMINALS) {
		if (!Number.isInteger(maxIdleEntries) || maxIdleEntries < 0) {
			throw new Error('maxIdleEntries must be a non-negative integer');
		}
	}

	get size(): number { return this.entries.size; }

	get idleSize(): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (!entry.busy) { count++; }
		}
		return count;
	}

	get(key: string): TemporaryTerminalCacheEntry<T> | undefined {
		return this.entries.get(key);
	}

	/** Reserve an existing idle entry. Returns false if another invocation won the race. */
	tryAcquire(entry: TemporaryTerminalCacheEntry<T>): boolean {
		if (this.entries.get(entry.key) !== entry || entry.busy) {
			return false;
		}
		entry.busy = true;
		return true;
	}

	/** Add a newly-created terminal as busy. A concurrent owner may already have claimed the key. */
	addBusy(key: string, sessionId: string, cwdKey: string, value: T): TemporaryTerminalCacheEntry<T> | undefined {
		if (this.entries.has(key)) {
			return undefined;
		}
		const entry: TemporaryTerminalCacheEntry<T> = {
			key,
			sessionId,
			cwdKey,
			value,
			busy: true,
			lastUsed: ++this.sequence,
		};
		this.entries.set(key, entry);
		return entry;
	}

	/** Mark a clean command complete and return any idle values evicted by the global LRU cap. */
	release(entry: TemporaryTerminalCacheEntry<T>): T[] {
		if (this.entries.get(entry.key) !== entry) {
			return [];
		}
		entry.busy = false;
		entry.lastUsed = ++this.sequence;
		return this.trimIdleEntries();
	}

	discard(entry: TemporaryTerminalCacheEntry<T>): T | undefined {
		if (this.entries.get(entry.key) !== entry) {
			return undefined;
		}
		this.entries.delete(entry.key);
		return entry.value;
	}

	clear(): T[] {
		const values = [...this.entries.values()].map(entry => entry.value);
		this.entries.clear();
		return values;
	}

	private trimIdleEntries(): T[] {
		const idle = [...this.entries.values()]
			.filter(entry => !entry.busy)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		const evicted: T[] = [];
		while (idle.length > this.maxIdleEntries) {
			const oldest = idle.shift()!;
			if (this.entries.get(oldest.key) === oldest) {
				this.entries.delete(oldest.key);
				evicted.push(oldest.value);
			}
		}
		return evicted;
	}
}
