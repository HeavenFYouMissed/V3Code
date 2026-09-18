/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V's native-chat orb system.
 *
 * Ordinary chat keeps its existing message identities. The voice surface owns exactly
 * one animated canvas and only schedules frames while it is visible, so the galaxy
 * treatment never multiplies with chat history.
 */

import * as dom from '../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { V3GalaxyOrbRenderer } from './v3codeGalaxyOrbRenderer.js';
import { registerV3VoiceAgentEventSink, type V3VoiceAgentEvent, type V3VoicePlanTodo } from './v3codeVoiceAgentEvents.js';
import type { V3VoiceRealtimeState } from './v3codeVoiceRealtimeClient.js';

export type V3VoiceOrbState = 'idle' | 'listening' | 'muted' | 'thinking' | 'speaking';

export type V3VoiceByokSetupStep = 'api-key' | 'ready';

/** BYOK Voice is an explicit provider choice, so its only setup gate is a usable key. */
export function getV3VoiceByokSetupStep(apiKey: string): V3VoiceByokSetupStep {
	return apiKey.trim() ? 'ready' : 'api-key';
}

export interface IV3VoiceSurfaceActions {
	connect(): Promise<void>;
	disconnect(): void;
	restoreFocus(): void;
	setMuted(muted: boolean): void;
	cancelResponse(): boolean;
	requestAgentStatus(): void;
	syncAgentContext?(text: string, working: boolean): void;
	relayAgentEvent(event: V3VoiceAgentEvent): void;
	answerAgentQuestion(choice: string): { accepted: boolean; message: string };
	speakCheckpoint(text: string): void;
	saveByokApiKey(apiKey: string): Promise<void>;
	readClipboardText(): Promise<string>;
	openOpenAIApiKeys(): void;
}

const controllers = new WeakMap<HTMLElement, V3VoiceSurfaceController>();

export function getOrCreateV3VoiceSurface(session: HTMLElement, actions: IV3VoiceSurfaceActions): V3VoiceSurfaceController {
	let controller = controllers.get(session);
	if (!controller) {
		controller = new V3VoiceSurfaceController(session, actions);
		controllers.set(session, controller);
	} else {
		controller.updateActions(actions);
	}
	return controller;
}

/** Update an already-open voice surface without allocating one for ordinary chat. */
export function updateV3VoiceSurfaceForResponse(row: HTMLElement, responseId: string, working: boolean, getCaption?: () => string): void {
	const session = row.closest<HTMLElement>('.interactive-session');
	if (!session) {
		return;
	}
	const controller = controllers.get(session);
	if (!controller) {
		return;
	}
	controller.setAgentResponse(responseId, working, getCaption);
}

/** Manual composer submission returns the selected session to ordinary chat. */
export function deactivateV3VoiceSurfaceForSession(sessionResource: string): void {
	for (const controller of controllersBySessionResource.get(sessionResource) ?? []) {
		controller.park();
	}
}

const controllersBySessionResource = new Map<string, Set<V3VoiceSurfaceController>>();

type Star = Readonly<{ x: number; y: number; radius: number; alpha: number; phase: number }>;

export function formatV3VoiceCheckpoint(raw: string, maxLength = 180): string {
	const clean = raw
		.replace(/```[\s\S]*?```/g, ' code sample omitted ')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_~`#>]+/g, '')
		.replace(/(?:^|\s)[-•]\s+/g, ' · ')
		.replace(/\s+/g, ' ')
		.trim();
	return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : clean;
}

export function formatV3VoiceCaptionLines(raw: string, maxLines = 5, maxLineLength = 112): string[] {
	const clean = raw
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[`*_>#~-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!clean) {
		return [];
	}

	const lines: string[] = [];
	const sentences = clean.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [clean];
	for (const sentence of sentences) {
		const words = sentence.trim().split(/\s+/);
		let line = '';
		for (const word of words) {
			const candidate = line ? `${line} ${word}` : word;
			if (line && candidate.length > maxLineLength) {
				lines.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		if (line) {
			lines.push(line);
		}
	}
	return lines.slice(-Math.max(1, maxLines));
}

export function splitV3VoiceActiveCaptionWord(line: string): { before: string; active: string } {
	const match = /\S+$/.exec(line);
	return match
		? { before: line.slice(0, match.index), active: match[0] }
		: { before: line, active: '' };
}

export class V3VoiceSurfaceController {
	private actions: IV3VoiceSurfaceActions;
	private readonly window: Window;
	private readonly root: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly galaxyRenderer: V3GalaxyOrbRenderer;
	private readonly context: CanvasRenderingContext2D | undefined;
	private readonly status: HTMLElement;
	private readonly hint: HTMLElement;
	private readonly caption: HTMLElement;
	private readonly checkpointStack: HTMLElement;
	private readonly checkpoint: HTMLButtonElement;
	private readonly checkpointIcon: HTMLElement;
	private readonly checkpointLabel: HTMLElement;
	private readonly checkpointChoices: HTMLElement;
	private readonly talkButton: HTMLButtonElement;
	private readonly talkButtonLabel: HTMLElement;
	private readonly stopButton: HTMLButtonElement;
	private readonly micMeter: HTMLElement;
	private readonly micMeterFill: HTMLElement;
	private readonly micMeterHeard: HTMLElement;
	private readonly onboarding: HTMLElement;
	private readonly onboardingInput: HTMLInputElement;
	private readonly onboardingSubmit: HTMLButtonElement;
	private readonly onboardingError: HTMLElement;
	private readonly stars: readonly Star[];
	private frame: number | undefined;
	private lastFrameTime = 0;
	private muted = false;
	private readonly workingResponseIds = new Set<string>();
	private readonly planTodos = new Map<string, V3VoicePlanTodo>();
	private agentEventBinding: IDisposable | undefined;
	private boundSessionResource: string | undefined;
	private checkpointText = '';
	private readonly captionTurns: string[] = [];
	private captionSource = '';
	private captionActive = false;
	private previousCaptionLines: readonly string[] = [];
	private state: V3VoiceOrbState = 'idle';
	private smoothedEnergy = 0;
	private visible = false;

	constructor(private readonly session: HTMLElement, actions: IV3VoiceSurfaceActions) {
		this.actions = actions;
		this.window = session.ownerDocument.defaultView ?? window;

		this.root = dom.append(session, dom.$('.v3-voice-surface'));
		this.root.setAttribute('aria-hidden', 'true');
		this.root.dataset.state = this.state;

		const veil = dom.append(this.root, dom.$('.v3-voice-glass-veil'));
		const topbar = dom.append(veil, dom.$('.v3-voice-topbar'));
		const identity = dom.append(topbar, dom.$('.v3-voice-identity'));
		dom.append(identity, dom.$('span.v3-voice-title', undefined, 'V'));
		dom.append(identity, dom.$('span.v3-voice-label', undefined, localize('v3VoiceSurfaceLabel', "Voice")));

		const closeButton = dom.append(topbar, dom.$('button.v3-voice-icon-button.codicon.codicon-close')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.setAttribute('aria-label', localize('v3VoiceSurfaceClose', "End V Voice"));

		const stage = dom.append(veil, dom.$('.v3-voice-stage'));
		const presence = dom.append(stage, dom.$('.v3-voice-presence'));
		const presenceDot = dom.append(presence, dom.$('span.v3-voice-presence-dot'));
		presenceDot.setAttribute('aria-hidden', 'true');
		const presenceCopy = dom.append(presence, dom.$('.v3-voice-presence-copy'));
		this.status = dom.append(presenceCopy, dom.$('.v3-voice-status', undefined, localize('v3VoiceReady', "Ready when you are")));
		this.status.setAttribute('aria-live', 'polite');
		this.hint = dom.append(presenceCopy, dom.$('.v3-voice-hint', undefined, localize('v3VoiceReadyHint', "Hold the orb or microphone to talk")));

		this.checkpointStack = dom.append(stage, dom.$('.v3-voice-checkpoint-stack'));
		this.checkpointStack.hidden = true;
		this.checkpoint = dom.append(this.checkpointStack, dom.$('button.v3-voice-checkpoint')) as HTMLButtonElement;
		this.checkpoint.type = 'button';
		this.checkpoint.hidden = true;
		this.checkpointIcon = dom.append(this.checkpoint, dom.$('span.codicon.codicon-check.v3-voice-checkpoint-icon'));
		this.checkpointLabel = dom.append(this.checkpoint, dom.$('span.v3-voice-checkpoint-label'));
		dom.append(this.checkpoint, dom.$('span.codicon.codicon-volume-up.v3-voice-checkpoint-speak'));
		this.checkpointChoices = dom.append(this.checkpointStack, dom.$('.v3-voice-checkpoint-choices'));
		this.checkpointChoices.hidden = true;
		this.checkpoint.addEventListener('click', () => {
			if (this.checkpointText) {
				this.actions.speakCheckpoint(this.checkpointText);
			}
		});

		const orbButton = dom.append(stage, dom.$('button.v3-voice-hero-orb')) as HTMLButtonElement;
		orbButton.type = 'button';
		orbButton.setAttribute('aria-label', localize('v3VoiceSurfaceToggleOrb', "Mute or resume V Voice"));
		const aura = dom.append(orbButton, dom.$('.v3-voice-orb-aura'));
		aura.setAttribute('aria-hidden', 'true');
		this.canvas = dom.append(orbButton, dom.$('canvas.v3-voice-orb-canvas')) as HTMLCanvasElement;
		const orbGlass = dom.append(orbButton, dom.$('.v3-voice-orb-glass'));
		orbGlass.setAttribute('aria-hidden', 'true');

		this.galaxyRenderer = new V3GalaxyOrbRenderer(this.canvas);
		// A canvas cannot switch context types after one has been created. Only take a
		// 2D context when WebGL was unavailable from the start; the CSS glass remains a
		// visible fallback if a live WebGL context is later lost.
		this.context = this.galaxyRenderer.hasContext ? undefined : (this.canvas.getContext('2d', { alpha: true }) ?? undefined);
		this.stars = this.createStars(104);

		this.onboarding = dom.append(stage, dom.$('.v3-voice-onboarding'));
		this.onboarding.hidden = true;
		const onboardingCopy = dom.append(this.onboarding, dom.$('.v3-voice-onboarding-copy'));
		dom.append(onboardingCopy, dom.$('.v3-voice-onboarding-eyebrow', undefined, localize('v3VoiceByokPreview', "BYOK early access")));
		dom.append(onboardingCopy, dom.$('h2.v3-voice-onboarding-title', undefined, localize('v3VoiceMeetV', "Meet V")));
		dom.append(onboardingCopy, dom.$('p.v3-voice-onboarding-description', undefined, localize(
			'v3VoiceByokDescription',
			"Talk through an idea, ask V to search current information or project memory, send real work to your selected agent, and hear only the progress that matters.",
		)));
		const capabilities = dom.append(onboardingCopy, dom.$('.v3-voice-onboarding-capabilities'));
		for (const capability of [
			localize('v3VoiceCapabilityTalk', "Think out loud"),
			localize('v3VoiceCapabilityMemory', "Recall project memory"),
			localize('v3VoiceCapabilityDelegate', "Drive the coding agent"),
			localize('v3VoiceCapabilityStatus', "Relay decisions and results"),
		]) {
			const item = dom.append(capabilities, dom.$('span.v3-voice-onboarding-capability'));
			dom.append(item, dom.$('span.codicon.codicon-sparkle'));
			dom.append(item, dom.$('span', undefined, capability));
		}

		const keyPanel = dom.append(this.onboarding, dom.$('.v3-voice-onboarding-key-panel'));
		dom.append(keyPanel, dom.$('.v3-voice-onboarding-key-title', undefined, localize('v3VoiceBringKey', "Bring your OpenAI API key")));
		dom.append(keyPanel, dom.$('.v3-voice-onboarding-key-note', undefined, localize(
			'v3VoiceByokPrivacy',
			"Your key is encrypted in your local V3Code settings and never passes through V3Code's servers. OpenAI bills your API account.",
		)));
		dom.append(keyPanel, dom.$('.v3-voice-onboarding-key-note', undefined, localize(
			'v3VoiceByokPlan',
			"V Voice is free with your OpenAI key during a two-month early-access trial. It is scheduled to become a V3Code plan feature afterward, and we will give notice in the app before trial access changes.",
		)));
		const keyForm = dom.append(keyPanel, dom.$('form.v3-voice-onboarding-key-form')) as HTMLFormElement;
		const keyInputWrap = dom.append(keyForm, dom.$('.v3-voice-onboarding-key-input-wrap'));
		this.onboardingInput = dom.append(keyInputWrap, dom.$('input.v3-voice-onboarding-key-input')) as HTMLInputElement;
		this.onboardingInput.type = 'password';
		this.onboardingInput.placeholder = 'sk-proj-…';
		this.onboardingInput.autocomplete = 'off';
		this.onboardingInput.spellcheck = false;
		this.onboardingInput.setAttribute('aria-label', localize('v3VoiceOpenAIKey', "OpenAI API key"));
		const pasteKey = dom.append(keyInputWrap, dom.$('button.v3-voice-onboarding-paste')) as HTMLButtonElement;
		pasteKey.type = 'button';
		pasteKey.textContent = localize('v3VoicePasteKey', "Paste");
		pasteKey.setAttribute('aria-label', localize('v3VoicePasteOpenAIKey', "Paste OpenAI API key from clipboard"));
		this.onboardingSubmit = dom.append(keyForm, dom.$('button.v3-voice-onboarding-submit')) as HTMLButtonElement;
		this.onboardingSubmit.type = 'submit';
		dom.append(this.onboardingSubmit, dom.$('span', undefined, localize('v3VoiceStartV', "Start V")));
		dom.append(this.onboardingSubmit, dom.$('span.codicon.codicon-arrow-right'));
		const keyLinks = dom.append(keyPanel, dom.$('.v3-voice-onboarding-key-links'));
		const createKey = dom.append(keyLinks, dom.$('button.v3-voice-onboarding-link')) as HTMLButtonElement;
		createKey.type = 'button';
		dom.append(createKey, dom.$('span.codicon.codicon-link-external'));
		dom.append(createKey, dom.$('span', undefined, localize('v3VoiceCreateOpenAIKey', "Create a key at OpenAI")));
		dom.append(keyLinks, dom.$('span.v3-voice-onboarding-feedback', undefined, localize(
			'v3VoiceByokFeedback',
			"Want BYOK Voice to remain available outside paid plans? Share feedback and V3Code during the trial. Final availability will depend on demand and sustainable costs.",
		)));
		this.onboardingError = dom.append(keyPanel, dom.$('.v3-voice-onboarding-error'));
		this.onboardingError.hidden = true;
		createKey.addEventListener('click', () => this.actions.openOpenAIApiKeys());
		pasteKey.addEventListener('click', () => {
			void this.pasteByokApiKey(pasteKey);
		});
		keyForm.addEventListener('submit', event => {
			event.preventDefault();
			void this.submitByokApiKey();
		});

		this.caption = dom.append(stage, dom.$('.v3-voice-caption'));
		this.caption.setAttribute('aria-label', localize('v3VoiceTranscript', "Recent V Voice transcript"));

		this.micMeter = dom.append(stage, dom.$('.v3-voice-mic-meter'));
		this.micMeter.setAttribute('role', 'meter');
		this.micMeter.setAttribute('aria-label', localize('v3VoiceInputLevel', "Microphone input level"));
		this.micMeter.setAttribute('aria-valuemin', '0');
		this.micMeter.setAttribute('aria-valuemax', '100');
		this.micMeter.setAttribute('aria-valuenow', '0');
		this.micMeterHeard = dom.append(this.micMeter, dom.$('.v3-voice-mic-heard', undefined, localize('v3VoiceInput', "Input")));
		const micTrack = dom.append(this.micMeter, dom.$('.v3-voice-mic-track'));
		this.micMeterFill = dom.append(micTrack, dom.$('.v3-voice-mic-fill'));
		dom.append(this.micMeter, dom.$('.v3-voice-mic-label', undefined, localize('v3VoiceLevel', "level")));

		const dock = dom.append(veil, dom.$('.v3-voice-dock'));
		const backButton = dom.append(dock, dom.$('button.v3-voice-dock-button.v3-voice-back')) as HTMLButtonElement;
		backButton.type = 'button';
		dom.append(backButton, dom.$('span.codicon.codicon-arrow-left'));
		dom.append(backButton, dom.$('span', undefined, localize('v3VoiceBack', "Chat")));

		this.talkButton = dom.append(dock, dom.$('button.v3-voice-dock-button.v3-voice-talk')) as HTMLButtonElement;
		this.talkButton.type = 'button';
		dom.append(this.talkButton, dom.$('span.codicon.codicon-mic'));
		this.talkButtonLabel = dom.append(this.talkButton, dom.$('span', undefined, localize('v3VoiceMute', "Mute")));

		this.stopButton = dom.append(dock, dom.$('button.v3-voice-dock-button.v3-voice-stop.codicon.codicon-debug-stop')) as HTMLButtonElement;
		this.stopButton.type = 'button';
		this.stopButton.disabled = true;
		this.stopButton.setAttribute('aria-label', localize('v3VoiceStopResponse', "Stop V speaking"));
		this.stopButton.setAttribute('title', localize('v3VoiceStopResponse', "Stop V speaking"));

		const agentButton = dom.append(dock, dom.$('button.v3-voice-dock-button.v3-voice-send')) as HTMLButtonElement;
		agentButton.type = 'button';
		dom.append(agentButton, dom.$('span', undefined, localize('v3VoiceAgentStatus', "Agent status")));
		dom.append(agentButton, dom.$('span.codicon.codicon-pulse'));

		closeButton.addEventListener('click', () => this.hide());
		backButton.addEventListener('click', () => this.park());
		this.root.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				this.park();
			}
		});

		const toggleMuted = () => {
			this.setMuted(!this.muted);
			this.actions.setMuted(this.muted);
		};
		orbButton.addEventListener('click', toggleMuted);
		this.talkButton.addEventListener('click', toggleMuted);
		this.stopButton.addEventListener('click', () => {
			if (this.actions.cancelResponse()) {
				this.stopButton.disabled = true;
				this.stopButton.classList.remove('v3-voice-stop-live');
				this.status.textContent = localize('v3VoiceStopped', "V stopped");
			}
		});

		agentButton.addEventListener('click', () => {
			this.setState('thinking');
			this.hint.textContent = localize('v3VoiceStatusHint', "V is checking the main agent");
			this.actions.requestAgentStatus();
		});
	}

	private async pasteByokApiKey(button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			const apiKey = (await this.actions.readClipboardText()).trim();
			if (!apiKey) {
				throw new Error(localize('v3VoiceClipboardEmpty', "The clipboard does not contain an API key."));
			}
			this.onboardingInput.value = apiKey;
			this.onboardingError.hidden = true;
			this.onboardingInput.focus();
		} catch (error) {
			this.onboardingError.textContent = error instanceof Error ? error.message : localize('v3VoicePasteFailed', "V3Code could not read the clipboard.");
			this.onboardingError.hidden = false;
		} finally {
			button.disabled = false;
		}
	}

	updateActions(actions: IV3VoiceSurfaceActions): void {
		this.actions = actions;
		this.ensureMounted();
	}

	showByokOnboarding(detail?: string): void {
		this.root.dataset.onboarding = 'true';
		this.onboarding.hidden = false;
		this.onboardingError.hidden = !detail;
		this.onboardingError.textContent = detail ?? '';
		this.setState('idle');
		this.status.textContent = localize('v3VoiceByokReady', "V is ready to meet you");
		this.hint.textContent = localize('v3VoiceByokHint', "Use your own OpenAI key for this private preview");
		this.window.requestAnimationFrame(() => this.onboardingInput.focus());
	}

	private hideByokOnboarding(): void {
		delete this.root.dataset.onboarding;
		this.onboarding.hidden = true;
		this.onboardingError.hidden = true;
		this.onboardingError.textContent = '';
		this.onboardingInput.value = '';
	}

	private async submitByokApiKey(): Promise<void> {
		const apiKey = this.onboardingInput.value.trim();
		this.onboardingSubmit.disabled = true;
		this.onboardingError.hidden = true;
		try {
			await this.actions.saveByokApiKey(apiKey);
			this.hideByokOnboarding();
			this.setConnectionState('connecting');
			await this.actions.connect();
		} catch (error) {
			this.showByokOnboarding(error instanceof Error ? error.message : localize('v3VoiceByokFailed', "V could not start with that key."));
		} finally {
			this.onboardingSubmit.disabled = false;
		}
	}

	bindAgentSession(sessionResource: string): void {
		if (this.boundSessionResource === sessionResource && this.agentEventBinding) {
			return;
		}
		// A single chat surface can be projected between the IDE and Agents panel.
		// Never let a newly selected session inherit the prior session's task card.
		this.planTodos.clear();
		this.captionTurns.length = 0;
		this.captionSource = '';
		this.previousCaptionLines = [];
		this.renderCaptionLines();
		this.checkpointText = '';
		this.checkpoint.hidden = true;
		this.checkpointStack.hidden = true;
		this.checkpointChoices.hidden = true;
		this.checkpointChoices.replaceChildren();
		this.unbindAgentSession();
		this.boundSessionResource = sessionResource;
		let controllers = controllersBySessionResource.get(sessionResource);
		if (!controllers) {
			controllers = new Set();
			controllersBySessionResource.set(sessionResource, controllers);
		}
		controllers.add(this);
		this.agentEventBinding = registerV3VoiceAgentEventSink(sessionResource, event => this.handleAgentEvent(event));
	}

	async open(): Promise<void> {
		// Chat input rows are rebuilt as sessions move between the IDE and Agents
		// surfaces. That rebuild can detach extension-owned children while leaving
		// the session element (and this controller's WeakMap entry) alive. Reattach
		// immediately before opening so a rendered V Voice pill can never become a
		// visible no-op after a layout/session projection.
		this.ensureMounted();
		this.show('thinking');
		this.setConnectionState('connecting');
		try {
			await this.actions.connect();
		} catch {
			// The realtime client reports the concrete failure through setConnectionState.
		}
	}

	show(state: V3VoiceOrbState = 'idle'): void {
		this.ensureMounted();
		this.visible = true;
		this.root.classList.add('v3-voice-surface-visible');
		this.root.setAttribute('aria-hidden', 'false');
		this.setState(state);
		this.resizeCanvas();
		this.scheduleFrame();
		this.window.requestAnimationFrame(() => this.root.querySelector<HTMLElement>('.v3-voice-hero-orb')?.focus());
	}

	private ensureMounted(): void {
		if (this.root.parentElement !== this.session) {
			this.session.appendChild(this.root);
		}
	}

	hide(): void {
		const restoreFocus = this.root.contains(this.root.ownerDocument.activeElement);
		this.visible = false;
		this.muted = false;
		this.talkButton.classList.remove('v3-voice-control-muted');
		this.root.classList.remove('v3-voice-surface-visible');
		// Move focus back to the V Voice pill before aria-hiding the overlay. Leaving
		// focus in a hidden descendant makes the close action inaccessible and causes
		// Chromium to reject the aria-hidden transition.
		if (restoreFocus) {
			this.actions.restoreFocus();
		}
		this.root.setAttribute('aria-hidden', 'true');
		this.cancelFrame();
		this.unbindAgentSession();
		this.actions.disconnect();
	}

	park(): void {
		const restoreFocus = this.root.contains(this.root.ownerDocument.activeElement);
		this.visible = false;
		this.setMuted(true);
		this.actions.setMuted(true);
		this.root.classList.remove('v3-voice-surface-visible');
		if (restoreFocus) {
			this.actions.restoreFocus();
		}
		this.root.setAttribute('aria-hidden', 'true');
		this.cancelFrame();
	}

	private unbindAgentSession(): void {
		this.agentEventBinding?.dispose();
		this.agentEventBinding = undefined;
		if (this.boundSessionResource) {
			const controllers = controllersBySessionResource.get(this.boundSessionResource);
			controllers?.delete(this);
			if (controllers?.size === 0) {
				controllersBySessionResource.delete(this.boundSessionResource);
			}
		}
		this.boundSessionResource = undefined;
	}

	private handleAgentEvent(event: V3VoiceAgentEvent): void {
		if (event.kind === 'plan') {
			const previouslyCompleted = new Set([...this.planTodos.values()].filter(todo => todo.status === 'completed').map(todo => todo.id));
			if (!event.merge) {
				this.planTodos.clear();
			}
			for (const todo of event.todos) {
				this.planTodos.set(todo.id, todo);
			}
			const todos = [...this.planTodos.values()];
			const completed = todos.filter(todo => todo.status === 'completed');
			const newlyCompleted = [...completed].reverse().find(todo => !previouslyCompleted.has(todo.id));
			const active = todos.find(todo => todo.status === 'in_progress');
			if (newlyCompleted) {
				this.showCheckpoint(`Task ${completed.length} of ${todos.length} complete — ${newlyCompleted.content}`, 'complete');
			} else if (active) {
				this.showCheckpoint(`Working on task ${Math.max(1, todos.indexOf(active) + 1)} of ${todos.length} — ${active.content}`, 'working');
			}
		} else if (event.kind === 'question') {
			this.showCheckpoint(`Agent needs your decision — ${event.question}`, 'question');
			this.showQuestionChoices(event.options);
		} else {
			const label = event.outcome === 'completed' ? 'Build complete' : event.outcome === 'blocked' ? 'Agent blocked' : 'Agent needs your answer';
			this.showCheckpoint(`${label} — ${event.text}`, event.outcome);
		}
		this.actions.relayAgentEvent(event);
	}

	private showCheckpoint(text: string, tone: string): void {
		const clean = formatV3VoiceCheckpoint(text, 900);
		if (tone !== 'question') {
			this.checkpointChoices.hidden = true;
			this.checkpointChoices.replaceChildren();
		}
		if (!this.checkpoint.hidden && this.checkpointLabel.textContent) {
			const echo = dom.append(this.checkpointStack, dom.$('.v3-voice-checkpoint-echo'));
			echo.dataset.tone = this.checkpoint.dataset.tone ?? 'working';
			echo.textContent = this.checkpointLabel.textContent;
			this.window.setTimeout(() => echo.remove(), 900);
		}
		this.checkpointText = clean;
		this.checkpointLabel.textContent = formatV3VoiceCheckpoint(clean);
		this.checkpoint.dataset.tone = tone;
		this.checkpointIcon.classList.toggle('codicon-check', tone === 'complete' || tone === 'completed');
		this.checkpointIcon.classList.toggle('codicon-loading', tone === 'working');
		this.checkpointIcon.classList.toggle('codicon-question', tone === 'question');
		this.checkpointIcon.classList.toggle('codicon-warning', tone === 'blocked');
		this.checkpointStack.hidden = false;
		this.checkpoint.hidden = false;
		this.checkpoint.classList.remove('v3-voice-checkpoint-enter');
		void this.checkpoint.offsetWidth;
		this.checkpoint.classList.add('v3-voice-checkpoint-enter');
		this.checkpoint.setAttribute('aria-label', `${this.checkpointLabel.textContent}. ${localize('v3VoiceSpeakCheckpoint', "Read aloud")}`);
	}

	private showQuestionChoices(options: readonly string[]): void {
		this.checkpointChoices.replaceChildren();
		for (const [index, option] of options.slice(0, 2).entries()) {
			const button = dom.append(this.checkpointChoices, dom.$('button.v3-voice-question-choice')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = `${index === 0 ? 'A' : 'B'} · ${formatV3VoiceCheckpoint(option, 80)}`;
			button.addEventListener('click', event => {
				event.stopPropagation();
				const result = this.actions.answerAgentQuestion(option);
				if (result.accepted) {
					this.checkpointChoices.hidden = true;
					this.showCheckpoint(`Decision sent — ${option}`, 'complete');
				} else {
					this.showCheckpoint(result.message, 'blocked');
				}
			});
		}
		this.checkpointChoices.hidden = this.checkpointChoices.childElementCount === 0;
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.root.dataset.mic = muted ? 'off' : 'live';
		this.talkButton.classList.toggle('v3-voice-control-muted', muted);
		this.talkButton.setAttribute('aria-pressed', String(muted));
		this.talkButtonLabel.textContent = muted ? localize('v3VoiceMicOff', "Mic off") : localize('v3VoiceMicOn', "Mic on");
		this.micMeter.classList.toggle('v3-voice-mic-muted', muted);
		this.hint.textContent = muted
			? localize('v3VoiceMutedHint', "Microphone paused — the main agent can keep working")
			: localize('v3VoiceLiveHint', "Keep talking naturally — V will relay only what matters");
	}

	setInputLevel(level: number, speechDetected: boolean): void {
		const normalized = Math.max(0, Math.min(1, level));
		this.micMeterFill.style.setProperty('--v3-voice-input-level', normalized.toFixed(3));
		this.micMeter.classList.toggle('v3-voice-mic-detected', speechDetected);
		this.micMeterHeard.textContent = speechDetected ? localize('v3VoiceHeard', "Heard") : localize('v3VoiceInput', "Input");
		this.micMeter.setAttribute('aria-valuenow', String(Math.round(normalized * 100)));
	}

	setAgentResponse(responseId: string, working: boolean, getCaption?: () => string): void {
		if (working) {
			this.workingResponseIds.add(responseId);
		} else {
			this.workingResponseIds.delete(responseId);
		}
		// Keep a quiet snapshot for the explicit Agent status tool. Never stream
		// the coding agent's response into V's ghost caption or Realtime context:
		// V speaks for itself and checks the agent only when the user asks.
		const rawCaption = getCaption?.() ?? '';
		if (rawCaption) {
			this.actions.syncAgentContext?.(rawCaption, this.workingResponseIds.size > 0);
		}
	}

	setCaption(rawText: string, active = false): void {
		const text = this.cleanCaption(rawText);
		if (!text) {
			if (this.captionSource) {
				this.captionTurns.push(this.captionSource);
				this.captionTurns.splice(0, Math.max(0, this.captionTurns.length - 2));
				this.captionSource = '';
			}
		} else {
			this.captionSource = text;
		}
		this.captionActive = active && !!text;
		this.renderCaptionLines();
	}

	setState(state: V3VoiceOrbState): void {
		this.state = state;
		this.root.dataset.state = state;
		const canStop = state === 'speaking';
		this.stopButton.disabled = !canStop;
		this.stopButton.classList.toggle('v3-voice-stop-live', canStop);
		if (state === 'listening') {
			this.status.textContent = localize('v3VoiceListening', "Listening…");
			this.hint.textContent = localize('v3VoiceListeningHint', "Talk naturally — interrupt V whenever you want");
		} else if (state === 'muted') {
			this.status.textContent = localize('v3VoiceMicOffStatus', "Microphone off");
			this.hint.textContent = localize('v3VoiceMutedHint', "V stays connected and the main agent can keep working");
		} else if (state === 'thinking') {
			this.status.textContent = localize('v3VoiceThinking', "V is thinking");
		} else if (state === 'speaking') {
			this.status.textContent = localize('v3VoiceSpeaking', "V is working with the agent");
			this.hint.textContent = localize('v3VoiceSpeakingHint', "Keep talking — V will relay what matters");
		} else {
			this.status.textContent = localize('v3VoiceReady', "Ready when you are");
		}
		if (this.visible) {
			this.scheduleFrame();
		}
	}

	setConnectionState(state: V3VoiceRealtimeState, detail?: string): void {
		if (state === 'connecting') {
			this.setState('thinking');
			this.status.textContent = localize('v3VoiceConnecting', "Connecting to V…");
			this.hint.textContent = localize('v3VoiceConnectingHint', "Normal chat stays available if voice cannot connect");
		} else if (state === 'listening') {
			this.setMuted(false);
			this.setState('listening');
		} else if (state === 'muted') {
			this.setMuted(true);
			this.setState('muted');
		} else if (state === 'thinking') {
			this.setState('thinking');
		} else if (state === 'speaking') {
			this.setState('speaking');
		} else if (state === 'error') {
			this.setState('idle');
			this.status.textContent = localize('v3VoiceUnavailable', "V Voice is unavailable");
			this.hint.textContent = detail || localize('v3VoiceUnavailableHint', "Normal chat still works");
		} else {
			this.setState('idle');
			this.status.textContent = localize('v3VoiceEnded', "Voice session ended");
			this.hint.textContent = detail || localize('v3VoiceEndedHint', "Open V Voice again whenever you are ready");
		}
	}

	private scheduleFrame(): void {
		if (this.frame !== undefined || !this.visible || !this.session.isConnected) {
			return;
		}
		this.frame = this.window.requestAnimationFrame(time => this.render(time));
	}

	private cancelFrame(): void {
		if (this.frame !== undefined) {
			this.window.cancelAnimationFrame(this.frame);
			this.frame = undefined;
		}
	}

	private render(timeMs: number): void {
		this.frame = undefined;
		if (!this.visible || !this.session.isConnected) {
			return;
		}
		const reducedMotion = this.window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const minimumFrameMs = 1000 / 30;
		if (timeMs - this.lastFrameTime >= minimumFrameMs) {
			this.lastFrameTime = timeMs;
			this.draw(timeMs / 1000);
		}
		// State/caption updates schedule another single frame. Everyone else gets the
		// live 30fps surface; reduced-motion users do not pay for an idle render loop.
		if (!reducedMotion) {
			this.scheduleFrame();
		}
	}

	private resizeCanvas(): void {
		const rect = this.canvas.getBoundingClientRect();
		const cssSize = Math.max(220, Math.round(rect.width || 280));
		const dpr = Math.min(this.window.devicePixelRatio || 1, 1.75);
		const size = Math.round(cssSize * dpr);
		if (this.canvas.width !== size || this.canvas.height !== size) {
			this.canvas.width = size;
			this.canvas.height = size;
		}
	}

	private draw(time: number): void {
		this.resizeCanvas();
		const targetEnergy = this.state === 'listening'
			? 0.46 + Math.max(0, Math.sin(time * 4.3)) * 0.22
			: this.state === 'speaking'
				? 0.58 + Math.max(0, Math.sin(time * 3.1)) * 0.28
				: this.state === 'thinking' ? 0.26 : 0.08;
		this.smoothedEnergy += (targetEnergy - this.smoothedEnergy) * 0.1;
		const energy = this.smoothedEnergy;
		const reducedMotion = this.window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const motionTime = reducedMotion ? 1.8 : time;
		if (this.galaxyRenderer.render(motionTime, energy)) {
			return;
		}

		const context = this.context;
		if (!context) {
			return;
		}
		const size = this.canvas.width;
		const center = size / 2;
		const radius = size * 0.465;
		const pulse = 1 + energy * 0.025;

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, size, size);
		context.save();
		context.translate(center, center);
		context.scale(pulse, pulse);

		const outerGlow = context.createRadialGradient(0, 0, radius * 0.72, 0, 0, radius * 1.15);
		outerGlow.addColorStop(0, `rgba(104, 111, 255, ${0.07 + energy * 0.1})`);
		outerGlow.addColorStop(0.72, `rgba(70, 214, 226, ${0.05 + energy * 0.08})`);
		outerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
		context.fillStyle = outerGlow;
		context.beginPath();
		context.arc(0, 0, radius * 1.15, 0, Math.PI * 2);
		context.fill();

		context.save();
		context.beginPath();
		context.arc(0, 0, radius, 0, Math.PI * 2);
		context.clip();

		const base = context.createRadialGradient(-radius * 0.28, -radius * 0.34, radius * 0.05, 0, 0, radius * 1.1);
		base.addColorStop(0, '#15192b');
		base.addColorStop(0.42, '#060812');
		base.addColorStop(0.82, '#020307');
		base.addColorStop(1, '#000104');
		context.fillStyle = base;
		context.fillRect(-radius, -radius, radius * 2, radius * 2);

		context.save();
		context.rotate(-0.48 + Math.sin(motionTime * 0.09) * 0.08);
		context.globalCompositeOperation = 'screen';
		for (let band = 0; band < 5; band++) {
			const y = (band - 2) * radius * 0.12 + Math.sin(motionTime * 0.22 + band) * radius * 0.025;
			const gradient = context.createLinearGradient(-radius, y, radius, y + radius * 0.25);
			gradient.addColorStop(0, 'rgba(75, 42, 150, 0)');
			gradient.addColorStop(0.28, `rgba(94, 67, 192, ${0.045 + energy * 0.035})`);
			gradient.addColorStop(0.53, `rgba(79, 184, 210, ${0.08 + energy * 0.05})`);
			gradient.addColorStop(0.72, `rgba(186, 91, 194, ${0.04 + energy * 0.025})`);
			gradient.addColorStop(1, 'rgba(32, 76, 155, 0)');
			context.fillStyle = gradient;
			context.fillRect(-radius, y - radius * 0.12, radius * 2, radius * 0.24);
		}
		context.restore();

		const clouds = [
			{ x: -0.42, y: -0.18, r: 0.56, color: '112, 78, 219', phase: 0.2 },
			{ x: 0.38, y: -0.28, r: 0.48, color: '53, 189, 218', phase: 1.9 },
			{ x: 0.2, y: 0.45, r: 0.62, color: '102, 51, 177', phase: 3.2 },
			{ x: -0.35, y: 0.4, r: 0.42, color: '40, 117, 180', phase: 4.4 },
		];
		context.globalCompositeOperation = 'screen';
		for (const cloud of clouds) {
			const x = radius * (cloud.x + Math.sin(motionTime * 0.18 + cloud.phase) * 0.08);
			const y = radius * (cloud.y + Math.cos(motionTime * 0.16 + cloud.phase) * 0.07);
			const cloudRadius = radius * cloud.r * (1 + energy * 0.09);
			const nebula = context.createRadialGradient(x, y, 0, x, y, cloudRadius);
			nebula.addColorStop(0, `rgba(${cloud.color}, ${0.14 + energy * 0.08})`);
			nebula.addColorStop(0.45, `rgba(${cloud.color}, ${0.07 + energy * 0.035})`);
			nebula.addColorStop(1, `rgba(${cloud.color}, 0)`);
			context.fillStyle = nebula;
			context.fillRect(-radius, -radius, radius * 2, radius * 2);
		}

		context.globalCompositeOperation = 'screen';
		for (const star of this.stars) {
			const twinkle = reducedMotion ? 0.72 : 0.5 + Math.sin(motionTime * (0.7 + star.phase * 0.08) + star.phase) * 0.35;
			const alpha = star.alpha * (0.72 + twinkle * 0.28) * (1 + energy * 0.35);
			context.fillStyle = `rgba(235, 244, 255, ${Math.min(1, alpha)})`;
			context.beginPath();
			context.arc(star.x * radius, star.y * radius, star.radius * size, 0, Math.PI * 2);
			context.fill();
		}

		context.globalCompositeOperation = 'multiply';
		const edge = context.createRadialGradient(-radius * 0.25, -radius * 0.32, radius * 0.08, 0, 0, radius * 1.05);
		edge.addColorStop(0, 'rgba(255,255,255,0)');
		edge.addColorStop(0.68, 'rgba(0,0,0,0.05)');
		edge.addColorStop(0.9, 'rgba(0,0,0,0.42)');
		edge.addColorStop(1, 'rgba(0,0,0,0.86)');
		context.fillStyle = edge;
		context.fillRect(-radius, -radius, radius * 2, radius * 2);

		context.globalCompositeOperation = 'screen';
		const highlight = context.createRadialGradient(-radius * 0.38, -radius * 0.48, 0, -radius * 0.34, -radius * 0.43, radius * 0.64);
		highlight.addColorStop(0, `rgba(255,255,255,${0.22 + energy * 0.08})`);
		highlight.addColorStop(0.2, 'rgba(220,232,255,0.08)');
		highlight.addColorStop(1, 'rgba(255,255,255,0)');
		context.fillStyle = highlight;
		context.fillRect(-radius, -radius, radius * 2, radius * 2);
		context.restore();

		context.globalCompositeOperation = 'source-over';
		context.lineWidth = Math.max(1, size * 0.003);
		context.strokeStyle = `rgba(225, 235, 255, ${0.2 + energy * 0.08})`;
		context.beginPath();
		context.arc(0, 0, radius - context.lineWidth / 2, 0, Math.PI * 2);
		context.stroke();
		context.restore();
	}

	private createStars(count: number): readonly Star[] {
		const stars: Star[] = [];
		let seed = 0x51f15e;
		for (let index = 0; index < count; index++) {
			seed = (1664525 * seed + 1013904223) >>> 0;
			const angle = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
			seed = (1664525 * seed + 1013904223) >>> 0;
			const distance = Math.sqrt((seed & 0xffff) / 0xffff) * 0.91;
			seed = (1664525 * seed + 1013904223) >>> 0;
			stars.push({
				x: Math.cos(angle) * distance,
				y: Math.sin(angle) * distance,
				radius: 0.0018 + ((seed >>> 12) & 0xff) / 0xff * 0.004,
				alpha: 0.3 + ((seed >>> 20) & 0xff) / 0xff * 0.7,
				phase: index * 0.73,
			});
		}
		return stars;
	}

	private cleanCaption(rawText: string): string {
		return rawText
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/[`*_>#~-]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	private renderCaptionLines(): void {
		const transcript = [...this.captionTurns, this.captionSource].filter(Boolean).join(' ');
		const lines = formatV3VoiceCaptionLines(transcript);
		const advanced = lines.length > 0 && (
			lines.length > this.previousCaptionLines.length
			|| (this.previousCaptionLines.length > 0 && lines[0] !== this.previousCaptionLines[0])
		);
		while (this.caption.childElementCount > lines.length) {
			this.caption.lastElementChild?.remove();
		}
		for (let index = 0; index < lines.length; index++) {
			let line = this.caption.children.item(index) as HTMLElement | null;
			if (!line) {
				line = dom.append(this.caption, dom.$('.v3-voice-caption-line'));
			}
			const isActiveLine = this.captionActive && index === lines.length - 1;
			if (isActiveLine) {
				const parts = splitV3VoiceActiveCaptionWord(lines[index]);
				line.replaceChildren(parts.before);
				if (parts.active) {
					dom.append(line, dom.$('span.v3-voice-caption-active-word', undefined, parts.active));
				}
			} else {
				line.textContent = lines[index];
			}
		}
		this.caption.classList.toggle('v3-voice-caption-visible', lines.length > 0);
		if (advanced) {
			this.caption.classList.remove('v3-voice-caption-advance');
			void this.caption.offsetWidth;
			this.caption.classList.add('v3-voice-caption-advance');
		}
		this.previousCaptionLines = lines;
	}
}
