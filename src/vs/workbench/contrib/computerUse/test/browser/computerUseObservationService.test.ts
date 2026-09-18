/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 * Gating tests for ambient observation.
 *
 * Every test here is about *not* capturing. The happy path is covered once, because it has to work;
 * everything else asserts that some individual thing being absent, stale, revoked, corrupt, or racing
 * results in nothing being read and nothing being kept. The fake host records every helper call it is
 * asked to make, so "did anything reach the machine" is a direct assertion rather than an inference.
 */

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	COMPUTER_USE_OBSERVATION_DEFAULT_INTERVAL_MS,
	COMPUTER_USE_OBSERVATION_MAX_INTERVAL_MS,
	COMPUTER_USE_OBSERVATION_MIN_INTERVAL_MS,
	ComputerUseObservationDependencies,
	ComputerUseObservationService,
	IComputerUseObservationClock,
	IComputerUseObservationConsentService,
	IComputerUseObservationHost,
	IComputerUseObservationMemorySink,
	summarizeObservation,
} from '../../browser/computerUseObservationService.js';
import {
	ComputerUseObservationSample,
	ComputerUseObservationStore,
	InMemoryComputerUseObservationStorage,
} from '../../browser/computerUseObservationStore.js';
import {
	COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS,
	COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
	ComputerUseObservableAppId,
	ComputerUseObservationPolicy,
} from '../../common/computerUseObservation.js';
import {
	ComputerUseApp,
	ComputerUseAxNode,
	ComputerUseAxTreeResult,
	ComputerUseCaptureResult,
	ComputerUseFrontmostApp,
	ComputerUseMethod,
	ComputerUseObserveSession,
	ComputerUseObserveStartParams,
	ComputerUseObserveStatusResult,
	ComputerUseObserveStopParams,
	ComputerUseParamsFor,
	ComputerUseResultFor,
} from '../../common/computerUseTypes.js';
import { MemoryFactTarget, UpsertFactInput } from '../../../void/browser/memoryService.js';

suite('ComputerUse - ambient observation service', () => {

	const leaks = ensureNoDisposablesAreLeakedInTestSuite();

	/** A fixed "now", so retention and expiry boundaries are exact rather than nearly. */
	const NOW = 1_800_000_000_000;

	const FIGMA: ComputerUseApp = { id: 'com.figma.Desktop', name: 'Figma', pid: 4242 };
	const NOTES: ComputerUseApp = { id: 'com.apple.Notes', name: 'Notes', pid: 4343 };
	const SELF: ComputerUseApp = { id: 'dev.v3code.code', name: 'V3Code', pid: 1 };

	// -------------------------------------------------------------------------------------------
	// Fakes
	// -------------------------------------------------------------------------------------------

	/** A clock whose every timer is fired by hand, so nothing in these tests waits on wall time. */
	class FakeClock implements IComputerUseObservationClock {

		private _now: number;
		private readonly _pending: { at: number; callback: () => void; cancelled: boolean }[] = [];

		constructor(now: number) {
			this._now = now;
		}

		now(): number {
			return this._now;
		}

		schedule(callback: () => void, delayMs: number): IDisposable {
			const entry = { at: this._now + delayMs, callback, cancelled: false };
			this._pending.push(entry);
			return toDisposable(() => { entry.cancelled = true; });
		}

		set(now: number): void {
			this._now = now;
		}

		/** Advances the clock and fires everything that came due, oldest first. */
		async advance(ms: number): Promise<void> {
			this._now += ms;
			const due = this._pending
				.filter(entry => !entry.cancelled && entry.at <= this._now)
				.sort((a, b) => a.at - b.at);
			for (const entry of due) {
				const index = this._pending.indexOf(entry);
				if (index >= 0) {
					this._pending.splice(index, 1);
				}
				if (!entry.cancelled) {
					entry.callback();
				}
				await flush();
			}
		}

		get pendingCount(): number {
			return this._pending.filter(entry => !entry.cancelled).length;
		}
	}

	/** Lets every queued promise settle, so an `await`-heavy sampling path completes inside one test. */
	async function flush(): Promise<void> {
		for (let i = 0; i < 32; i++) {
			await Promise.resolve();
		}
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		for (let i = 0; i < 32; i++) {
			await Promise.resolve();
		}
	}

	/** Records every helper call, so "nothing reached the machine" is directly assertable. */
	class FakeHost implements IComputerUseObservationHost {

		isAvailable = true;
		readonly calls: { method: ComputerUseMethod; params: unknown }[] = [];
		frontmost: ComputerUseFrontmostApp = { ...FIGMA, title: 'Untitled — Figma' };
		tree: ComputerUseAxTreeResult = {
			app: FIGMA,
			generation: 7,
			nodes: [{ ref: 'r1', role: 'button', label: 'Export', enabled: true, focused: true }],
		};
		sessions: ComputerUseObserveSession[] = [];
		readonly failing = new Set<ComputerUseMethod>();
		/** When set, `capture` waits on this before resolving, so a stop can be raced against a frame. */
		captureGate: Promise<void> | undefined;
		/** Set true by a capture that actually handed a frame back. */
		captureDelivered = false;
		/** False models a helper that answers `observeStart` but lists no session. */
		reportStartedSessions = true;

		countOf(method: ComputerUseMethod): number {
			return this.calls.filter(call => call.method === method).length;
		}

		async invoke<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUseResultFor<M>> {
			this.calls.push({ method, params });
			if (this.failing.has(method)) {
				throw new Error(`fake helper failure for '${method}'`);
			}
			switch (method) {
				case 'frontmostApp':
					return this.frontmost as unknown as ComputerUseResultFor<M>;
				case 'axTree':
					return this.tree as unknown as ComputerUseResultFor<M>;
				case 'capture': {
					if (this.captureGate) {
						await this.captureGate;
					}
					this.captureDelivered = true;
					const capture: ComputerUseCaptureResult = {
						width: 640,
						height: 400,
						scale: 0.5,
						format: 'png',
						dataBase64: 'ZmFrZS1mcmFtZQ==',
						excludedPids: [1],
						display: { displayId: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } },
					};
					return capture as unknown as ComputerUseResultFor<M>;
				}
				case 'observeStart': {
					const start = params as ComputerUseObserveStartParams;
					if (!this.reportStartedSessions) {
						return this._status() as unknown as ComputerUseResultFor<M>;
					}
					this.sessions = [
						...this.sessions.filter(session => session.pid !== start.pid),
						{
							pid: start.pid,
							appId: start.appId,
							startedAt: NOW,
							stopAtMs: start.stopAtMs,
							intervalMs: start.intervalMs,
							content: start.content,
							samples: 0,
						},
					];
					return this._status() as unknown as ComputerUseResultFor<M>;
				}
				case 'observeStop': {
					const stop = params as ComputerUseObserveStopParams;
					this.sessions = stop.pid === undefined
						? []
						: this.sessions.filter(session => session.pid !== stop.pid);
					return this._status() as unknown as ComputerUseResultFor<M>;
				}
				case 'observeStatus':
					return this._status() as unknown as ComputerUseResultFor<M>;
				default:
					throw new Error(`the observation service must not call '${method}'`);
			}
		}

		private _status(): ComputerUseObserveStatusResult {
			return { observing: this.sessions.length > 0, sessions: [...this.sessions] };
		}
	}

	/** The second consent gate, as a flag. */
	class FakeConsent implements IComputerUseObservationConsentService {

		declare readonly _serviceBrand: undefined;

		private readonly _emitter = new Emitter<boolean>();
		readonly onDidChangeConsent: Event<boolean> = this._emitter.event;

		accepted = false;
		/** What the dialog would answer. False models the user declining. */
		wouldAccept = true;
		prompts = 0;

		hasAccepted(): boolean {
			return this.accepted;
		}

		async ensureAccepted(): Promise<boolean> {
			if (this.accepted) {
				return true;
			}
			this.prompts++;
			if (!this.wouldAccept) {
				return false;
			}
			this.accepted = true;
			this._emitter.fire(true);
			return true;
		}

		revoke(): void {
			if (!this.accepted) {
				return;
			}
			this.accepted = false;
			this._emitter.fire(false);
		}

		dispose(): void {
			this._emitter.dispose();
		}
	}

	/** Collects the facts the service would have written. */
	class FakeMemory implements IComputerUseObservationMemorySink {

		isAvailable = true;
		readonly facts: { fact: UpsertFactInput; target: MemoryFactTarget | undefined }[] = [];
		private _next = 0;

		async upsertFact(fact: UpsertFactInput, target?: MemoryFactTarget): Promise<{ readonly id: string } | null> {
			this.facts.push({ fact, target });
			return { id: `fact-${++this._next}` };
		}
	}

	// -------------------------------------------------------------------------------------------
	// Harness
	// -------------------------------------------------------------------------------------------

	interface Harness {
		readonly service: ComputerUseObservationService;
		readonly policyStore: ComputerUseObservationStore;
		readonly host: FakeHost;
		readonly consent: FakeConsent;
		readonly memory: FakeMemory;
		readonly clock: FakeClock;
		readonly confirmations: ComputerUseApp[];
		setting: { enabled: boolean };
		confirmAnswer: { value: boolean };
		fireSettingChange(): void;
	}

	function createHarness(options?: {
		readonly settingEnabled?: boolean;
		readonly consentAccepted?: boolean;
		readonly seedPolicy?: ComputerUseObservationPolicy;
		readonly memoryAvailable?: boolean;
	}): Harness {
		const disposables = new DisposableStore();
		leaks.add(disposables);

		const storage = new InMemoryComputerUseObservationStorage();
		if (options?.seedPolicy) {
			storage.writePolicy(options.seedPolicy);
		}
		const policyStore = disposables.add(new ComputerUseObservationStore(storage));
		const host = new FakeHost();
		const consent = disposables.add(new FakeConsent());
		consent.accepted = options?.consentAccepted ?? false;
		const memory = new FakeMemory();
		memory.isAvailable = options?.memoryAvailable ?? true;
		const clock = new FakeClock(NOW);
		const setting = { enabled: options?.settingEnabled ?? false };
		const confirmAnswer = { value: true };
		const confirmations: ComputerUseApp[] = [];
		const settingEmitter = disposables.add(new Emitter<void>());

		const dependencies: ComputerUseObservationDependencies = {
			store: policyStore,
			host,
			consent,
			memory,
			isSettingEnabled: () => setting.enabled,
			onDidChangeSetting: settingEmitter.event,
			clock,
			log: { info: () => { }, warn: () => { }, error: () => { } },
			confirmApplication: async app => {
				confirmations.push(app);
				return confirmAnswer.value;
			},
			// No indicator: these tests are about the gate, and mounting DOM would only add a way for
			// them to fail for reasons that have nothing to do with the gate.
			createIndicator: undefined,
		};

		const service = disposables.add(new ComputerUseObservationService(dependencies));
		return {
			service,
			policyStore,
			host,
			consent,
			memory,
			clock,
			confirmations,
			setting,
			confirmAnswer,
			fireSettingChange: () => settingEmitter.fire(),
		};
	}

	/** A harness that is fully armed for `app`: setting on, consent given, opted in, rule granted. */
	async function createArmedHarness(
		app: ComputerUseApp = FIGMA,
		mode: 'axTree' | 'axTreeAndScreenshots' = 'axTree',
	): Promise<Harness> {
		const harness = createHarness({ settingEnabled: true, consentAccepted: true });
		assert.strictEqual(await harness.service.requestOptIn(), true);
		assert.strictEqual(await harness.service.requestApplication(app, mode, 60 * 60 * 1000), true);
		return harness;
	}

	// -------------------------------------------------------------------------------------------
	// 1. Off by default
	// -------------------------------------------------------------------------------------------

	test('is off with no configuration at all, and reaches nothing', async () => {
		const harness = createHarness();

		assert.strictEqual(harness.service.isSettingEnabled, false);
		assert.strictEqual(harness.service.isOptedIn, false);
		assert.strictEqual(harness.service.isAvailable, false);
		assert.strictEqual(harness.service.isObserving, false);

		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started, false);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'settingDisabled');
		assert.deepStrictEqual(harness.host.calls, [], 'nothing may reach the helper while the setting is off');
	});

	test('an absent setting reads as off rather than as unset', () => {
		// The integration phase adds `enableComputerUseObservation` to GlobalSettings; until then the
		// read is `undefined`, and this is the assertion that `undefined` denies.
		const harness = createHarness();
		harness.setting.enabled = undefined as unknown as boolean;
		assert.strictEqual(harness.service.isSettingEnabled, false);
		assert.strictEqual(harness.service.isAvailable, false);
	});

	test('the setting alone arms nothing: consent is still required', async () => {
		const harness = createHarness({ settingEnabled: true });
		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'consentMissing');
		assert.strictEqual(harness.host.calls.length, 0);
	});

	test('consent alone arms nothing: the opt-in must be recorded too', async () => {
		const harness = createHarness({ settingEnabled: true, consentAccepted: true });
		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'notOptedIn');
		assert.strictEqual(harness.host.calls.length, 0);
	});

	test('the opt-in alone arms nothing: a per-application rule is still required', async () => {
		const harness = createHarness({ settingEnabled: true, consentAccepted: true });
		assert.strictEqual(await harness.service.requestOptIn(), true);
		assert.strictEqual(harness.service.isAvailable, true, 'the capability is available…');

		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'noRuleForApplication', '…but no application is');
		assert.strictEqual(harness.host.calls.length, 0);
	});

	test('opting in is refused outright while the setting is off, and prompts nobody', async () => {
		const harness = createHarness({ settingEnabled: false });
		assert.strictEqual(await harness.service.requestOptIn(), false);
		assert.strictEqual(harness.consent.prompts, 0, 'a dialog would imply the setting could be bypassed');
		assert.strictEqual(harness.policyStore.isOptedIn(), false);
	});

	test('declining the consent dialog records no opt-in', async () => {
		const harness = createHarness({ settingEnabled: true });
		harness.consent.wouldAccept = false;
		assert.strictEqual(await harness.service.requestOptIn(), false);
		assert.strictEqual(harness.consent.prompts, 1);
		assert.strictEqual(harness.policyStore.isOptedIn(), false);
		assert.strictEqual(harness.service.isAvailable, false);
	});

	test('an opt-in from an older version does not carry forward', async () => {
		const harness = createHarness({
			settingEnabled: true,
			consentAccepted: true,
			seedPolicy: {
				optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION - 1,
				enabled: true,
				retentionMs: 60 * 60 * 1000,
			},
		});
		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'optInVersionStale');
		assert.strictEqual(harness.host.calls.length, 0);
	});

	// -------------------------------------------------------------------------------------------
	// 2. Self is never observable
	// -------------------------------------------------------------------------------------------

	test('V3Code cannot be granted observation, and is not even asked about', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual(await harness.service.requestApplication(SELF, 'axTree'), false);
		assert.deepStrictEqual(harness.confirmations.map(app => app.id), [FIGMA.id], 'no dialog for self');
		assert.strictEqual(harness.policyStore.listRules().some(rule => rule.appId.includes('v3code')), false);
	});

	test('V3Code cannot be observed even with a rule smuggled past the type system', async () => {
		// The shape a hand-edited settings file or a forward-compatible write could produce: a rule that
		// only exists because a cast bypassed the branded id.
		const forged: ComputerUseObservationPolicy = {
			optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
			enabled: true,
			retentionMs: 60 * 60 * 1000,
			rules: [{
				appId: SELF.id.toLowerCase() as unknown as ComputerUseObservableAppId,
				mode: 'axTreeAndScreenshots',
				grantedAt: NOW - 1000,
				expiresAt: NOW + 60 * 60 * 1000,
			}],
		};
		const harness = createHarness({ settingEnabled: true, consentAccepted: true, seedPolicy: forged });

		const outcome = await harness.service.start(SELF);
		assert.strictEqual(outcome.started, false);
		assert.strictEqual(harness.host.calls.length, 0, 'not one helper call for a self observation');
		// Sanitization dropped the rule on read, so the engine never even sees it as a self grant.
		assert.strictEqual(harness.policyStore.listRules().length, 0);
	});

	// -------------------------------------------------------------------------------------------
	// 3. Starting, and what a start actually asks the helper for
	// -------------------------------------------------------------------------------------------

	test('a fully armed application starts, and the helper is given a self-expiring session', async () => {
		const harness = await createArmedHarness();

		const outcome = await harness.service.start(FIGMA, { intervalMs: 5_000 });
		assert.strictEqual(outcome.started, true);
		assert.strictEqual(harness.service.isObserving, true);

		const start = harness.host.calls.find(call => call.method === 'observeStart');
		assert.ok(start, 'observeStart must have been called');
		const params = start.params as ComputerUseObserveStartParams;
		assert.strictEqual(params.pid, FIGMA.pid);
		assert.strictEqual(params.intervalMs, 5_000);
		assert.strictEqual(params.content, 'axTree');
		assert.ok(params.stopAtMs > NOW, 'stopAtMs is the whole safety story and must be in the future');
		const decision = harness.policyStore.decide(FIGMA, NOW);
		assert.strictEqual(decision.permitted, true);
		assert.strictEqual(
			params.stopAtMs,
			decision.permitted === true ? decision.permittedUntil : -1,
			'stopAtMs must come from the authorizing decision, not from a local guess',
		);
	});

	test('a rejected sampling interval never reaches the helper', async () => {
		const harness = await createArmedHarness();
		for (const intervalMs of [1, COMPUTER_USE_OBSERVATION_MIN_INTERVAL_MS - 1, COMPUTER_USE_OBSERVATION_MAX_INTERVAL_MS + 1, Number.NaN]) {
			const outcome = await harness.service.start(FIGMA, { intervalMs });
			assert.strictEqual(outcome.started === false && outcome.blocked, 'intervalOutOfRange', `interval ${intervalMs}`);
		}
		assert.strictEqual(harness.host.countOf('observeStart'), 0);
	});

	test('a helper that does not report the session back is treated as having refused', async () => {
		const harness = await createArmedHarness();
		// A helper that answers but lists nothing: believing it started would leave us supervising
		// something that is not there.
		harness.host.reportStartedSessions = false;

		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'helperRefused');
		assert.strictEqual(harness.service.isObserving, false);
	});

	test('a second start for the same application is refused', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA)).started, true);
		const second = await harness.service.start(FIGMA);
		assert.strictEqual(second.started === false && second.blocked, 'alreadyObserving');
	});

	// -------------------------------------------------------------------------------------------
	// 4. Sampling
	// -------------------------------------------------------------------------------------------

	test('a sample is taken and retained while the granted application is in front', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		await harness.clock.advance(2_000);

		const history = harness.service.listHistory();
		assert.strictEqual(history.length, 1);
		assert.strictEqual(history[0].appId, 'com.figma.desktop');
		assert.strictEqual(history[0].mode, 'axTree');
		assert.strictEqual(history[0].usedScreenshot, false, 'no frame is taken in axTree mode');
		assert.ok(history[0].summary.includes('Untitled'), 'the window title makes it into the summary');
		assert.strictEqual(harness.host.countOf('capture'), 0, 'axTree mode must never call capture');
		assert.strictEqual(harness.service.sessions[0].samples, 1);
	});

	test('nothing is read while some other application is in front', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);
		harness.host.frontmost = { ...NOTES, title: 'Groceries' };

		await harness.clock.advance(2_000);

		assert.strictEqual(harness.service.listHistory().length, 0);
		assert.strictEqual(harness.host.countOf('axTree'), 0, 'a background application must not be walked');
		assert.strictEqual(harness.service.sessions[0].skipped, 1);
	});

	test('screenshot mode takes a frame, and keeps no trace of it', async () => {
		const harness = await createArmedHarness(FIGMA, 'axTreeAndScreenshots');
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		await harness.clock.advance(2_000);

		assert.strictEqual(harness.host.countOf('capture'), 1);
		const [sample] = harness.service.listHistory();
		assert.ok(sample, 'a sample was retained');
		assert.strictEqual(sample.usedScreenshot, true);
		// The only defensible assertion about a frame that must not be retained: nothing anywhere in the
		// persisted record resembles the image payload the helper handed over.
		assert.strictEqual(JSON.stringify(sample).includes('ZmFrZS1mcmFtZQ'), false);
	});

	test('a revocation mid-flight loses: the in-flight sample is not retained', async () => {
		const harness = await createArmedHarness(FIGMA, 'axTreeAndScreenshots');
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		// Hold the frame inside the helper call, so a hard stop lands while it is in flight.
		let releaseFrame: () => void = () => { };
		harness.host.captureGate = new Promise<void>(resolve => { releaseFrame = resolve; });

		await harness.clock.advance(2_000);
		assert.strictEqual(harness.service.listHistory().length, 0, 'the sample has not completed yet');

		await harness.service.hardStop('test');
		releaseFrame();
		await flush();

		assert.strictEqual(harness.host.captureDelivered, true, 'the frame really did come back over the pipe');
		assert.strictEqual(harness.service.listHistory().length, 0, 'and it was thrown away rather than summarized');
		assert.strictEqual(harness.service.isObserving, false);
	});

	test('a hard stop cancels the next sample rather than merely skipping it', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		await harness.service.hardStop('test');
		await harness.clock.advance(10_000);

		assert.strictEqual(harness.host.countOf('axTree'), 0);
		assert.strictEqual(harness.service.listHistory().length, 0);
		assert.strictEqual(harness.clock.pendingCount, 0, 'no timer survives a hard stop');
	});

	test('the grant expiring stops the session by itself', async () => {
		const harness = createHarness({ settingEnabled: true, consentAccepted: true });
		assert.strictEqual(await harness.service.requestOptIn(), true);
		assert.strictEqual(await harness.service.requestApplication(FIGMA, 'axTree', 4_000), true);
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		await harness.clock.advance(2_000);
		assert.strictEqual(harness.service.listHistory().length, 1);

		// Past `expiresAt` now: the next tick must stop rather than sample.
		await harness.clock.advance(4_000);
		assert.strictEqual(harness.service.isObserving, false);
		assert.strictEqual(harness.host.countOf('axTree'), 1, 'no read happened after the grant lapsed');
	});

	test('switching the setting off stops everything that is running', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		harness.setting.enabled = false;
		harness.fireSettingChange();
		await flush();

		assert.strictEqual(harness.service.isObserving, false);
		await harness.clock.advance(10_000);
		assert.strictEqual(harness.host.countOf('axTree'), 0);
	});

	test('withdrawing consent stops observation and deletes the history', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);
		await harness.clock.advance(2_000);
		assert.strictEqual(harness.service.listHistory().length, 1);

		harness.consent.revoke();
		await flush();

		assert.strictEqual(harness.service.isObserving, false);
		assert.strictEqual(harness.service.isOptedIn, false);
		assert.strictEqual(harness.service.listHistory().length, 0, 'the notes go with the permission that made them');
	});

	test('pausing stops every session, and resuming does not restart them', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		await harness.service.pause(60_000);
		assert.strictEqual(harness.service.isObserving, false);
		assert.strictEqual(harness.service.isPaused, true);

		const blockedWhilePaused = await harness.service.start(FIGMA, { intervalMs: 2_000 });
		assert.strictEqual(blockedWhilePaused.started === false && blockedWhilePaused.blocked, 'paused');

		await harness.service.resume();
		assert.strictEqual(harness.service.isPaused, false);
		assert.strictEqual(harness.service.isObserving, false, 'resuming is not a request to be watched again');
	});

	// -------------------------------------------------------------------------------------------
	// 5. A policy denial cannot be bypassed
	// -------------------------------------------------------------------------------------------

	test('a sample cannot be stored once the rule is gone, even by calling the store directly', async () => {
		const harness = await createArmedHarness();
		const sample: ComputerUseObservationSample = {
			appId: 'com.figma.desktop',
			appName: 'Figma',
			capturedAt: NOW,
			mode: 'axTree',
			summary: 'window "Untitled", 1 elements',
			nodeCount: 1,
			usedScreenshot: false,
		};
		assert.strictEqual(harness.policyStore.appendSample(sample, NOW).kept, true);

		harness.policyStore.revokeRule(FIGMA.id);
		const afterRevoke = harness.policyStore.appendSample({ ...sample, capturedAt: NOW + 1 }, NOW + 1);
		assert.strictEqual(afterRevoke.kept, false);
		assert.strictEqual(afterRevoke.kept === false && afterRevoke.refusal, 'policyDenies');
		assert.strictEqual(harness.policyStore.listSamples(NOW + 1).length, 1, 'and nothing was added');
	});

	test('an explicit deny rule beats a grant and cannot be talked past', async () => {
		const harness = await createArmedHarness();
		harness.policyStore.setRule(FIGMA, 'denied', NOW, 60 * 60 * 1000);

		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'ruleDenies');
		assert.strictEqual(harness.host.countOf('observeStart'), 0);
	});

	test('a sample cannot claim a mode broader than the grant', async () => {
		const harness = await createArmedHarness(FIGMA, 'axTree');
		const escalated = harness.policyStore.appendSample({
			appId: 'com.figma.desktop',
			appName: 'Figma',
			capturedAt: NOW,
			mode: 'axTreeAndScreenshots',
			summary: 'anything',
			nodeCount: 1,
			usedScreenshot: true,
		}, NOW);
		assert.strictEqual(escalated.kept === false && escalated.refusal, 'modeExceedsGrant');
	});

	test('the master switch being off denies every application at once', async () => {
		const harness = await createArmedHarness();
		harness.policyStore.setEnabled(false);
		const outcome = await harness.service.start(FIGMA);
		assert.strictEqual(outcome.started === false && outcome.blocked, 'masterSwitchOff');
		assert.strictEqual(harness.service.isAvailable, false);
	});

	test('a policy with no usable retention window records nothing', async () => {
		const harness = await createArmedHarness();
		// Mirrors a truncated or hand-edited write: everything else intact, retention unreadable.
		assert.strictEqual(harness.policyStore.setRetentionMs(COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS + 1), false);

		const injected = new InMemoryComputerUseObservationStorage();
		injected.writePolicy({
			optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
			enabled: true,
			retentionMs: undefined,
			rules: harness.policyStore.listRules(),
		});
		const bare = leaks.add(new ComputerUseObservationStore(injected));
		const decision = bare.decide(FIGMA, NOW);
		assert.strictEqual(decision.permitted, false);
		assert.strictEqual(decision.permitted === false && decision.reason, 'retentionWindowInvalid');
	});

	// -------------------------------------------------------------------------------------------
	// 6. Retention boundaries and clear-history scopes
	// -------------------------------------------------------------------------------------------

	test('retention is exclusive at the cutoff: a sample exactly on it is dropped', async () => {
		const harness = await createArmedHarness();
		const retentionMs = harness.policyStore.getRetentionMs();
		assert.ok(retentionMs !== undefined);

		const onTheBoundary = NOW - retentionMs;
		assert.strictEqual(harness.policyStore.appendSample(sampleAt(onTheBoundary), NOW).kept, false);
		assert.strictEqual(harness.policyStore.appendSample(sampleAt(onTheBoundary + 1), NOW).kept, true);
		assert.strictEqual(harness.policyStore.listSamples(NOW).length, 1);

		// One millisecond later the surviving sample is itself on the boundary, and goes.
		assert.strictEqual(harness.policyStore.prune(NOW + 1), 1);
		assert.strictEqual(harness.policyStore.listSamples(NOW + 1).length, 0);
	});

	test('an unreadable retention window prunes everything rather than keeping it', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual(harness.policyStore.appendSample(sampleAt(NOW), NOW).kept, true);
		// Withdrawing the opt-in is the only supported route to an unusable window, and it must take the
		// history with it.
		harness.policyStore.revokeOptIn();
		assert.strictEqual(harness.policyStore.listSamples(NOW).length, 0);
	});

	test('clear history by application leaves the other application alone', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual(await harness.service.requestApplication(NOTES, 'axTree', 60 * 60 * 1000), true);
		harness.policyStore.appendSample(sampleAt(NOW, 'com.figma.desktop', 'Figma'), NOW);
		harness.policyStore.appendSample(sampleAt(NOW, 'com.apple.notes', 'Notes'), NOW);
		assert.strictEqual(harness.service.listHistory().length, 2);

		assert.strictEqual(await harness.service.clearHistory({ kind: 'app', appId: 'COM.FIGMA.DESKTOP' }), 1);
		assert.deepStrictEqual(harness.service.listHistory().map(record => record.appId), ['com.apple.notes']);
	});

	test('clear history by time range is inclusive at both ends', async () => {
		const harness = await createArmedHarness();
		for (const offset of [-3_000, -2_000, -1_000]) {
			harness.policyStore.appendSample(sampleAt(NOW + offset), NOW);
		}
		assert.strictEqual(harness.service.listHistory().length, 3);

		assert.strictEqual(await harness.service.clearHistory({ kind: 'timeRange', fromMs: NOW - 3_000, toMs: NOW - 2_000 }), 2);
		assert.deepStrictEqual(harness.service.listHistory().map(record => record.capturedAt), [NOW - 1_000]);
	});

	test('clear history for everything leaves nothing', async () => {
		const harness = await createArmedHarness();
		harness.policyStore.appendSample(sampleAt(NOW), NOW);
		harness.policyStore.appendSample(sampleAt(NOW - 1), NOW);
		assert.strictEqual(await harness.service.clearHistory({ kind: 'all' }), 2);
		assert.strictEqual(harness.service.listHistory().length, 0);
	});

	test('a clear request with an inverted range deletes rather than keeps', async () => {
		const harness = await createArmedHarness();
		harness.policyStore.appendSample(sampleAt(NOW), NOW);
		assert.strictEqual(await harness.service.clearHistory({ kind: 'timeRange', fromMs: NOW, toMs: NOW - 5_000 }), 1);
	});

	// -------------------------------------------------------------------------------------------
	// 7. Reconciliation
	// -------------------------------------------------------------------------------------------

	test('reconciliation stops a helper session the policy does not permit', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		// A session the renderer never asked for — a lost `observeStop`, or a helper that outlived a
		// reload.
		harness.host.sessions = [
			...harness.host.sessions,
			{
				pid: NOTES.pid,
				appId: NOTES.id,
				startedAt: NOW,
				stopAtMs: NOW + 60_000,
				intervalMs: 5_000,
				content: 'axTreeAndScreenshots',
				samples: 3,
			},
		];

		await harness.service.reconcile();

		assert.deepStrictEqual(harness.host.sessions.map(session => session.pid), [FIGMA.pid]);
		assert.strictEqual(harness.service.isObserving, true, 'the sanctioned session survives');
	});

	test('a helper that cannot report its sessions causes a hard stop', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);
		harness.host.failing.add('observeStatus');

		await harness.service.reconcile();

		assert.strictEqual(harness.service.isObserving, false, 'supervision we cannot perform is capture we must not allow');
	});

	test('revoking an application stops its session and clears its rule', async () => {
		const harness = await createArmedHarness();
		assert.strictEqual((await harness.service.start(FIGMA, { intervalMs: 2_000 })).started, true);

		await harness.service.revokeApplication(FIGMA.id);

		assert.strictEqual(harness.service.isObserving, false);
		assert.strictEqual(harness.policyStore.listRules().length, 0);
		assert.strictEqual(harness.host.sessions.length, 0);
	});

	// -------------------------------------------------------------------------------------------
	// 8. Summarization into the existing memory system
	// -------------------------------------------------------------------------------------------

	test('samples are folded into one memory fact per application, once', async () => {
		const harness = await createArmedHarness();
		harness.policyStore.appendSample(sampleAt(NOW - 2_000), NOW);
		harness.policyStore.appendSample(sampleAt(NOW - 1_000), NOW);

		assert.strictEqual(await harness.service.summarizeIntoMemory(), 1);
		assert.strictEqual(harness.memory.facts.length, 1);
		const [written] = harness.memory.facts;
		assert.strictEqual(written.target, 'workspace');
		assert.strictEqual(written.fact.kind, 'pattern');
		assert.strictEqual((written.fact.meta as { origin?: string }).origin, 'computerUse.observation');
		assert.ok((written.fact.confidence ?? 1) < 0.5, 'a screen-derived fact must not outrank an asserted one');

		// Idempotent: the samples are marked, so a second pass writes nothing.
		assert.strictEqual(await harness.service.summarizeIntoMemory(), 0);
		assert.strictEqual(harness.memory.facts.length, 1);
	});

	test('no memory store means no summaries, not buffered ones', async () => {
		const harness = await createArmedHarness();
		harness.memory.isAvailable = false;
		harness.policyStore.appendSample(sampleAt(NOW), NOW);
		assert.strictEqual(await harness.service.summarizeIntoMemory(), 0);
		assert.strictEqual(harness.memory.facts.length, 0);
	});

	// -------------------------------------------------------------------------------------------
	// 9. Summaries are bounded, single-line, untrusted text
	// -------------------------------------------------------------------------------------------

	test('a summary is one line however hostile the window title is', () => {
		const nodes: readonly ComputerUseAxNode[] = [{
			ref: 'r1',
			role: 'textField',
			label: 'Body',
			enabled: true,
			focused: true,
		}];
		const summary = summarizeObservation('line one\nline two\r\n- fake: bullet', nodes, 12);
		assert.strictEqual(summary.includes('\n'), false);
		assert.strictEqual(summary.includes('\r'), false);
		assert.ok(summary.includes('12'));
		assert.ok(summary.includes('Body'));
	});

	test('a summary field is length-bounded', () => {
		const summary = summarizeObservation('x'.repeat(4_000), [], 0);
		assert.ok(summary.length < 200, `unexpectedly long summary: ${summary.length}`);
	});

	test('the default sampling interval is inside the permitted band', () => {
		assert.ok(COMPUTER_USE_OBSERVATION_DEFAULT_INTERVAL_MS >= COMPUTER_USE_OBSERVATION_MIN_INTERVAL_MS);
		assert.ok(COMPUTER_USE_OBSERVATION_DEFAULT_INTERVAL_MS <= COMPUTER_USE_OBSERVATION_MAX_INTERVAL_MS);
	});

	// -------------------------------------------------------------------------------------------
	// Fixtures
	// -------------------------------------------------------------------------------------------

	function sampleAt(
		capturedAt: number,
		appId: string = 'com.figma.desktop',
		appName: string = 'Figma',
	): ComputerUseObservationSample {
		return {
			appId,
			appName,
			capturedAt,
			mode: 'axTree',
			summary: `window "Untitled", ${capturedAt} elements`,
			nodeCount: 1,
			usedScreenshot: false,
		};
	}
});
