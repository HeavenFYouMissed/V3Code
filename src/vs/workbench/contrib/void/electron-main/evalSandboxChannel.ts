/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Registered in app.ts — mirrors semanticEmbedChannel.ts pattern.
// Runs a snippet of JS/TS in an ISOLATED node:vm context in the main (Node)
// process so the agent can verify the *behavior* of a pure function without a
// full transpile + relaunch. The sandbox has NO access to require/process/fs:
// it is purely for exercising logic against inputs.
//
// TypeScript: types are stripped via node:module's stripTypeScriptTypes when
// available (Node 22.13+/Electron with TS-strip support). If the runtime lacks
// it, the snippet runs as raw JS and `tsStripped:false` is reported — pure JS
// still works; TS-only syntax will surface a SyntaxError the agent can read.

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import * as vm from 'node:vm';
import * as nodeModule from 'node:module';
import { BundleReconstructChannel } from './bundleReconstructChannel.js';

export interface EvalSandboxParams {
	code: string;
	timeoutMs?: number;
}

export interface EvalSandboxResult {
	/** Captured console.log/info/warn/error lines, in order. */
	logs: string[];
	/** String form of the snippet's returned value (undefined if none). */
	result: string | undefined;
	/** Error name+message if the snippet threw or timed out; otherwise null. */
	error: string | null;
	/** Whether TS type-stripping was applied (false → ran as raw JS). */
	tsStripped: boolean;
	/** Wall-clock execution time in ms. */
	durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 10000;
const MAX_LOG_LINES = 200;
const MAX_VALUE_CHARS = 8000;

export class EvalSandboxChannel implements IServerChannel {

	private readonly _bundleReconstruct = new BundleReconstructChannel();

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`EvalSandboxChannel has no events. Requested: ${event}`);
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		if (command === 'run') {
			return this._run(params as EvalSandboxParams);
		}
		if (command === 'bundleReconstruct') {
			return this._bundleReconstruct.call(_, 'reconstruct', params);
		}
		if (command === 'bundleReconstructProbe') {
			return this._bundleReconstruct.call(_, 'probe');
		}
		throw new Error(`EvalSandboxChannel: command "${command}" not recognized.`);
	}

	private _stringify(x: unknown): string {
		if (typeof x === 'string') return x;
		if (x === undefined) return 'undefined';
		// JSON.stringify turns NaN/Infinity/-Infinity into `null` — actively misleading when the
		// agent is debugging numeric code. Preserve them: literal name at top level, a `<NaN>`
		// marker inside objects (distinct from a real "NaN" string).
		if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
		try {
			const s = JSON.stringify(x, (_k, v) => (typeof v === 'number' && !Number.isFinite(v)) ? `<${String(v)}>` : v);
			return s === undefined ? String(x) : s;
		} catch {
			return String(x);
		}
	}

	private async _run(params: EvalSandboxParams): Promise<EvalSandboxResult> {
		const code = typeof params?.code === 'string' ? params.code : '';
		const timeoutMs = Math.min(
			Math.max(1, Number(params?.timeoutMs) || DEFAULT_TIMEOUT_MS),
			MAX_TIMEOUT_MS,
		);
		const t0 = Date.now();

		if (!code.trim()) {
			return { logs: [], result: undefined, error: 'No code provided to run.', tsStripped: false, durationMs: 0 };
		}

		// Wrap FIRST so a top-level `return` in the snippet is legal, THEN strip
		// types — the stripper parses as a module where a bare `return` is illegal.
		let wrapped = `(async () => {\n${code}\n})()`;
		let tsStripped = false;
		try {
			const strip = (nodeModule as any).stripTypeScriptTypes;
			if (typeof strip === 'function') {
				wrapped = strip(wrapped, { mode: 'strip' });
				tsStripped = true;
			}
		} catch {
			// Stripping failed (e.g. genuine syntax error) — fall back to raw JS.
			wrapped = `(async () => {\n${code}\n})()`;
			tsStripped = false;
		}

		const logs: string[] = [];
		const push = (prefix: string, args: unknown[]) => {
			if (logs.length >= MAX_LOG_LINES) return;
			logs.push(prefix + args.map(a => this._stringify(a)).join(' '));
		};
		const sandboxConsole = {
			log: (...a: unknown[]) => push('', a),
			info: (...a: unknown[]) => push('', a),
			warn: (...a: unknown[]) => push('[warn] ', a),
			error: (...a: unknown[]) => push('[error] ', a),
			debug: (...a: unknown[]) => push('', a),
		};
		// Minimal, safe globals only. No require/process/fs/module/Buffer.
		const sandbox: Record<string, unknown> = {
			console: sandboxConsole,
			Math, JSON, Date, Array, Object, String, Number, Boolean,
			RegExp, Map, Set, Symbol, Promise, Error, isNaN, isFinite,
			parseInt, parseFloat,
		};

		let result: string | undefined;
		let error: string | null = null;
		try {
			const ctx = vm.createContext(sandbox);
			const value = await vm.runInContext(wrapped, ctx, { timeout: timeoutMs, displayErrors: true });
			if (value !== undefined) {
				let s = this._stringify(value);
				if (s.length > MAX_VALUE_CHARS) s = s.slice(0, MAX_VALUE_CHARS) + ' …(truncated)';
				result = s;
			}
		} catch (e) {
			error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		}

		if (logs.length >= MAX_LOG_LINES) {
			logs.push(`…(log truncated at ${MAX_LOG_LINES} lines)`);
		}

		return { logs, result, error, tsStripped, durationMs: Date.now() - t0 };
	}
}
