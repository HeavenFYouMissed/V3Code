/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Built-in speech for V3Code chat via the Chromium Web Speech API.
 *
 * v1 uses the browser's speech recognition implementation (on some platforms this
 * may route audio to a cloud STT backend) and the operating system's installed
 * speech-synthesis voices for free read-aloud. For fully offline STT or a bundled
 * neural TTS voice, ship a lazy local ONNX provider later.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import {
	IKeywordRecognitionEvent,
	IKeywordRecognitionSession,
	ISpeechProvider,
	ISpeechService,
	ISpeechToTextEvent,
	ISpeechToTextSession,
	ISpeechToTextSessionOptions,
	ITextToSpeechSession,
	ITextToSpeechSessionOptions,
	KeywordRecognitionStatus,
	SpeechToTextStatus,
	TextToSpeechStatus,
} from '../../speech/common/speechService.js';

export const V3CODE_VOICE_ENABLED_KEY = 'v3code.voice.enabled';

const V3CODE_WEB_SPEECH_PROVIDER_ID = 'v3code.webSpeech';

type WebSpeechRecognition = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onstart: (() => void) | null;
	onresult: ((event: WebSpeechRecognitionEvent) => void) | null;
	onend: (() => void) | null;
	onerror: ((event: { error: string; message?: string }) => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
};

type WebSpeechRecognitionEvent = {
	resultIndex: number;
	results: {
		length: number;
		[index: number]: {
			isFinal: boolean;
			[index: number]: { transcript: string };
		};
	};
};

declare global {
	interface Window {
		webkitSpeechRecognition?: new () => WebSpeechRecognition;
		SpeechRecognition?: new () => WebSpeechRecognition;
	}
}

let micPermissionWarmupPromise: Promise<void> | undefined;
let recognitionGate: Promise<void> = Promise.resolve();

function humanizeSpeechError(error: string, message?: string): string {
	switch (error) {
		case 'not-allowed':
			return localize('v3code.voice.error.notAllowed', "Microphone access was denied. Allow microphone access for V3Code in System Settings.");
		case 'service-not-allowed':
			return localize('v3code.voice.error.serviceNotAllowed', "Speech recognition is not allowed in this context.");
		case 'network':
			return localize('v3code.voice.error.network', "Speech recognition needs a network connection (Chromium routes audio to a cloud STT service). Check your connection and try again.");
		case 'no-speech':
			return localize('v3code.voice.error.noSpeech', "No speech was detected. Hold the mic longer and speak clearly.");
		case 'aborted':
			return localize('v3code.voice.error.aborted', "Speech recognition was interrupted.");
		case 'audio-capture':
			return localize('v3code.voice.error.audioCapture', "No microphone was found or it is in use by another app.");
		default:
			return message?.trim() || error || localize('v3code.voice.error.unknown', "Speech recognition failed.");
	}
}

async function ensureMicrophonePermission(nativeHostService: INativeHostService, logService: ILogService): Promise<void> {
	if (!micPermissionWarmupPromise) {
		micPermissionWarmupPromise = (async () => {
			if (isMacintosh) {
				const status = await nativeHostService.getMediaAccessStatus('microphone');
				if (status === 'denied' || status === 'restricted') {
					throw new Error(humanizeSpeechError('not-allowed'));
				}
			}
			if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				for (const track of stream.getTracks()) {
					track.stop();
				}
			}
		})().catch(err => {
			micPermissionWarmupPromise = undefined;
			logService.warn('[v3code-voice] Microphone permission warmup failed', err);
			throw err;
		});
	}
	return micPermissionWarmupPromise;
}

async function waitForRecognitionSlot(): Promise<void> {
	await recognitionGate;
}

function chainRecognitionEnd(onEnd: () => void): void {
	const deferred = new DeferredPromise<void>();
	recognitionGate = deferred.p;
	onEnd();
	deferred.complete();
}

export function isWebSpeechRecognitionAvailable(): boolean {
	return typeof window !== 'undefined' && !!(window.webkitSpeechRecognition ?? window.SpeechRecognition);
}

export function isWebSpeechSynthesisAvailable(): boolean {
	return typeof window !== 'undefined'
		&& !!window.speechSynthesis
		&& typeof SpeechSynthesisUtterance !== 'undefined';
}

class UnavailableSpeechToTextSession implements ISpeechToTextSession {
	private readonly _onDidChange = new Emitter<ISpeechToTextEvent>();
	readonly onDidChange = this._onDidChange.event;
	private stopped = false;

	constructor(token: CancellationToken) {
		const stop = () => {
			if (this.stopped) { return; }
			this.stopped = true;
			this._onDidChange.fire({ status: SpeechToTextStatus.Stopped });
		};
		token.onCancellationRequested(stop);
		queueMicrotask(() => {
			if (this.stopped) { return; }
			this._onDidChange.fire({
				status: SpeechToTextStatus.Error,
				text: localize('v3code.voice.stt.unavailable', "System speech recognition is not available in this runtime. V Voice can still listen through its live voice session."),
			});
			stop();
		});
	}
}

class WebSpeechToTextSession implements ISpeechToTextSession {
	private readonly _onDidChange = new Emitter<ISpeechToTextEvent>();
	readonly onDidChange = this._onDidChange.event;

	private readonly recognition: WebSpeechRecognition;
	private readonly disposables = new DisposableStore();
	private readonly token: CancellationToken;
	private stopped = false;
	private started = false;
	private stopEventSent = false;

	constructor(
		token: CancellationToken,
		options: ISpeechToTextSessionOptions | undefined,
		nativeHostService: INativeHostService,
		logService: ILogService,
	) {
		this.token = token;
		const RecognitionCtor = window.webkitSpeechRecognition ?? window.SpeechRecognition;
		if (!RecognitionCtor) {
			throw new Error('Web Speech API is not available');
		}

		this.recognition = new RecognitionCtor();
		this.recognition.continuous = true;
		this.recognition.interimResults = true;
		if (options?.language) {
			this.recognition.lang = options.language;
		}

		this.recognition.onstart = () => {
			if (!this.stopped) {
				this.started = true;
				this._onDidChange.fire({ status: SpeechToTextStatus.Started });
			}
		};

		this.recognition.onresult = (event: WebSpeechRecognitionEvent) => {
			if (this.stopped) {
				return;
			}
			let interim = '';
			let finalText = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const transcript = result[0]?.transcript ?? '';
				if (result.isFinal) {
					finalText += transcript;
				} else {
					interim += transcript;
				}
			}
			if (interim) {
				this._onDidChange.fire({ status: SpeechToTextStatus.Recognizing, text: interim.trim() });
			}
			if (finalText) {
				this._onDidChange.fire({ status: SpeechToTextStatus.Recognized, text: finalText.trim() });
			}
		};

		this.recognition.onerror = (event) => {
			if (this.stopped) {
				return;
			}
			const text = humanizeSpeechError(event.error, event.message);
			logService.warn(`[v3code-voice] recognition error: ${event.error} ${event.message ?? ''}`);
			this._onDidChange.fire({
				status: SpeechToTextStatus.Error,
				text,
			});
		};

		this.recognition.onend = () => {
			chainRecognitionEnd(() => this.fireStopped());
		};

		this.disposables.add(token.onCancellationRequested(() => this.stop()));
		this.disposables.add(toDisposable(() => this.stop()));

		void this.startRecognition(nativeHostService, logService);
	}

	private async startRecognition(nativeHostService: INativeHostService, logService: ILogService): Promise<void> {
		try {
			await ensureMicrophonePermission(nativeHostService, logService);
			if (this.stopped || this.token.isCancellationRequested) {
				return;
			}
			await waitForRecognitionSlot();
			if (this.stopped) {
				return;
			}
			this.recognition.start();
		} catch (err) {
			if (this.stopped) {
				return;
			}
			const text = err instanceof Error ? err.message : String(err);
			logService.warn('[v3code-voice] Failed to start recognition', err);
			this._onDidChange.fire({
				status: SpeechToTextStatus.Error,
				text,
			});
			this.stop();
		}
	}

	private fireStopped(): void {
		if (this.stopEventSent) {
			return;
		}
		this.stopEventSent = true;
		this.stopped = true;
		this._onDidChange.fire({ status: SpeechToTextStatus.Stopped });
	}

	private stop(): void {
		if (this.stopped && this.stopEventSent) {
			return;
		}
		this.stopped = true;
		try {
			if (this.started) {
				this.recognition.stop();
			} else {
				this.recognition.abort();
				this.fireStopped();
			}
		} catch {
			try {
				this.recognition.abort();
			} catch {
				// ignore
			}
			this.fireStopped();
		}
	}

	dispose(): void {
		this.stop();
		this.disposables.dispose();
		this._onDidChange.dispose();
	}
}

export class WebTextToSpeechSession implements ITextToSpeechSession {
	private readonly _onDidChange = new Emitter<{ status: TextToSpeechStatus; text?: string }>();
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables = new DisposableStore();
	private activeUtterance: SpeechSynthesisUtterance | undefined;
	private finishActive: ((emitLifecycle?: boolean) => void) | undefined;
	private disposed = false;

	constructor(
		private readonly token: CancellationToken,
		private readonly language: string | undefined,
		private readonly logService: ILogService,
	) {
		// SpeechService owns the public session lifecycle on token cancellation, so
		// resolve the pending utterance without emitting a second Stopped event.
		this.disposables.add(token.onCancellationRequested(() => this.stop(false)));
	}

	async synthesize(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean || this.disposed || this.token.isCancellationRequested) {
			return;
		}
		if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
			this._onDidChange.fire({ status: TextToSpeechStatus.Error, text: localize('v3code.voice.tts.unavailable', "System text-to-speech is not available in this runtime.") });
			this._onDidChange.fire({ status: TextToSpeechStatus.Stopped });
			return;
		}

		// Chat currently awaits every chunk. Guarding the active utterance also makes
		// direct callers deterministic instead of interleaving two system voices.
		if (this.activeUtterance) {
			this.stopActive();
		}

		await new Promise<void>(resolve => {
			const utterance = new SpeechSynthesisUtterance(clean);
			this.activeUtterance = utterance;
			if (this.language) {
				utterance.lang = this.language;
			}
			const localVoice = this.pickLocalVoice(this.language);
			if (localVoice) {
				utterance.voice = localVoice;
			}

			let started = false;
			let finished = false;
			const finish = (emitLifecycle = true) => {
				if (finished) { return; }
				finished = true;
				utterance.onstart = null;
				utterance.onend = null;
				utterance.onerror = null;
				if (this.activeUtterance === utterance) {
					this.activeUtterance = undefined;
					this.finishActive = undefined;
				}
				// Some platform engines do not emit start before a very short utterance
				// ends. Balance the shared speech-service lifecycle in that case.
				if (emitLifecycle && !started) {
					started = true;
					this._onDidChange.fire({ status: TextToSpeechStatus.Started });
				}
				if (emitLifecycle) {
					this._onDidChange.fire({ status: TextToSpeechStatus.Stopped });
				}
				resolve();
			};
			this.finishActive = finish;
			utterance.onstart = () => {
				if (!started) {
					started = true;
					this._onDidChange.fire({ status: TextToSpeechStatus.Started });
				}
			};
			utterance.onend = () => finish();
			utterance.onerror = event => {
				const detail = event.error || localize('v3code.voice.tts.error.unknown', "unknown error");
				this.logService.warn(`[v3code-voice] system speech synthesis failed: ${detail}`);
				this._onDidChange.fire({
					status: TextToSpeechStatus.Error,
					text: localize('v3code.voice.tts.error', "System text-to-speech failed: {0}", detail),
				});
				finish();
			};

			try {
				window.speechSynthesis.speak(utterance);
			} catch (error) {
				this.logService.warn('[v3code-voice] could not start system speech synthesis', error);
				this._onDidChange.fire({
					status: TextToSpeechStatus.Error,
					text: error instanceof Error ? error.message : localize('v3code.voice.tts.error.start', "Could not start system text-to-speech."),
				});
				finish();
			}
		});
	}

	private pickLocalVoice(language: string | undefined): SpeechSynthesisVoice | undefined {
		const localVoices = window.speechSynthesis.getVoices().filter(voice => voice.localService);
		if (!localVoices.length) { return undefined; }
		if (!language) { return localVoices.find(voice => voice.default) ?? localVoices[0]; }
		const requested = language.toLowerCase();
		const base = requested.split('-')[0];
		return localVoices.find(voice => voice.lang.toLowerCase() === requested)
			?? localVoices.find(voice => voice.lang.toLowerCase().split('-')[0] === base)
			?? localVoices.find(voice => voice.default)
			?? localVoices[0];
	}

	private stopActive(emitLifecycle = true): void {
		if (!this.activeUtterance) { return; }
		window.speechSynthesis.cancel();
		// Chromium does not consistently deliver `end` after cancel(). Resolve the
		// pending chat chunk ourselves; `finish` is idempotent if an event follows.
		this.finishActive?.(emitLifecycle);
	}

	private stop(emitLifecycle = true): void {
		this.stopActive(emitLifecycle);
	}

	dispose(): void {
		this.disposed = true;
		this.stop(false);
		this.disposables.dispose();
		this._onDidChange.dispose();
	}
}

class NoopKeywordRecognitionSession implements IKeywordRecognitionSession {
	private readonly _onDidChange = new Emitter<IKeywordRecognitionEvent>();
	readonly onDidChange = this._onDidChange.event;

	constructor(token: CancellationToken) {
		const fireStopped = () => {
			this._onDidChange.fire({ status: KeywordRecognitionStatus.Stopped });
		};
		token.onCancellationRequested(fireStopped);
		queueMicrotask(fireStopped);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

class V3WebSpeechProvider implements ISpeechProvider {
	readonly metadata = {
		extension: new ExtensionIdentifier(V3CODE_WEB_SPEECH_PROVIDER_ID),
		displayName: localize('v3code.webSpeech.displayName', "V3Code Web Speech"),
	};

	constructor(
		private readonly nativeHostService: INativeHostService,
		private readonly logService: ILogService,
	) { }

	createSpeechToTextSession(token: CancellationToken, options?: ISpeechToTextSessionOptions): ISpeechToTextSession {
		if (!isWebSpeechRecognitionAvailable()) {
			return new UnavailableSpeechToTextSession(token);
		}
		return new WebSpeechToTextSession(token, options, this.nativeHostService, this.logService);
	}

	createTextToSpeechSession(token: CancellationToken, options?: ITextToSpeechSessionOptions): ITextToSpeechSession {
		return new WebTextToSpeechSession(token, options?.language, this.logService);
	}

	createKeywordRecognitionSession(token: CancellationToken): IKeywordRecognitionSession {
		return new NoopKeywordRecognitionSession(token);
	}
}

class V3WebSpeechProviderContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeWebSpeechProvider';

	private providerDisposable: IDisposable | undefined;

	constructor(
		@ISpeechService private readonly speechService: ISpeechService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILogService private readonly logService: ILogService,
	) {
		this.syncProvider();
		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(V3CODE_VOICE_ENABLED_KEY)) {
				this.syncProvider();
			}
		});
	}

	private syncProvider(): void {
		const enabled = this.configurationService.getValue<boolean>(V3CODE_VOICE_ENABLED_KEY) !== false;
		const recognitionAvailable = isWebSpeechRecognitionAvailable();
		const synthesisAvailable = isWebSpeechSynthesisAvailable();

		if (!enabled || (!recognitionAvailable && !synthesisAvailable)) {
			this.providerDisposable?.dispose();
			this.providerDisposable = undefined;
			if (enabled) {
				this.logService.info('[v3code-voice] Web Speech APIs unavailable — chat speech disabled');
			}
			return;
		}

		if (this.providerDisposable) {
			return;
		}

		this.providerDisposable = this.speechService.registerSpeechProvider(
			V3CODE_WEB_SPEECH_PROVIDER_ID,
			new V3WebSpeechProvider(this.nativeHostService, this.logService),
		);
		this.logService.info(`[v3code-voice] Web Speech provider registered (input=${recognitionAvailable}, readAloud=${synthesisAvailable})`);
	}
}

registerWorkbenchContribution2(V3WebSpeechProviderContribution.ID, V3WebSpeechProviderContribution, WorkbenchPhase.AfterRestored);
