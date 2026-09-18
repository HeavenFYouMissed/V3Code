/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, ImageDescribeMode, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';

const VISION_DESCRIBE_TIMEOUT_MS = 30_000;

export type VisionImageAttachment = {
	data: string;
	mimeType: string;
	description?: string;
	describeError?: string;
};

/** User messages that may carry image attachments for vision / describe. */
export type VisionDescribeUserMessage = {
	role: 'user';
	content: string;
	images?: VisionImageAttachment[];
};

const VISION_DESCRIBE_PROMPT = `Describe all image attachments in this message.

If there is one image, describe it directly.
If there are multiple images:
1. Describe each image separately, preserving their order.
2. Then provide a combined description explaining the overall context and relationships across the images.

Return one concise factual description suitable for inserting into a text-only chat prompt. Include visible text, objects, UI elements, people, and relevant context. Do not invent details.`;

const SCREENSHOT_DESCRIBE_PROMPT = `You are the eyes for a blind coding agent that just screenshotted a web page it is building. Describe the RENDERED page so the agent can judge and fix its own UI. Cover, in order:
1. Overall layout top-to-bottom (header / hero / sections / footer), alignment and spacing.
2. Visual hierarchy: what dominates, font sizes and weights, colors (name them), background, imagery.
3. All visible text, verbatim where prominent.
4. VISUAL BUGS — be blunt: clipped or overflowing text, overlapping elements, misalignment, poor contrast, unstyled or raw HTML, broken images, elements off-screen, awkward whitespace.
5. One-line aesthetic verdict (e.g. "polished dark landing page" or "looks broken and unstyled").
Only describe what is visible. Do not invent details.`;

export type ImageDescribeCallbacks = {
	onDescribeStart?: (info: { imageCount: number; visionModel: ModelSelection }) => void;
	onDescribeError?: (info: { message: string; visionModel: ModelSelection }) => void;
	promptManualDescribe?: (info: {
		imageCount: number;
		visionModel: ModelSelection | null;
		activeModel: ModelSelection;
	}) => Promise<'describe' | 'skip' | 'cancel'>;
};

export function modelSupportsVision(
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: IVoidSettingsService['state']['overridesOfModel'] | undefined,
): boolean {
	// An explicit per-model choice wins even when the model name is unknown or looks
	// like an older text-only family. False deliberately restores the describe path.
	const visionOverride = overridesOfModel?.[providerName]?.[modelName]?.supportsVision;
	if (typeof visionOverride === 'boolean') {
		return visionOverride;
	}
	try {
		const caps = getModelCapabilities(providerName, modelName, overridesOfModel);
		if (caps.isUnrecognizedModel) {
			return modelSupportsVisionHeuristic(providerName, modelName);
		}
		return caps.supportsVision === true;
	} catch {
		return modelSupportsVisionHeuristic(providerName, modelName);
	}
}

function modelSupportsVisionHeuristic(providerName: ProviderName, modelName: string): boolean {
	const m = modelName.toLowerCase();
	const p = providerName.toLowerCase();
	if (/deepseek|codestral|coder/.test(m)) { return false; }
	if (p === 'anthropic' || /claude[-_ ]?(?:3|4|opus|sonnet|haiku)/.test(m)) { return true; }
	if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|chatgpt-4o|\bo1\b|\bo3\b|\bo4\b/.test(m)) { return true; }
	if (p === 'gemini' || /gemini/.test(m)) { return true; }
	if (/grok-(?:1\.5)?v|grok-2-vision|grok-vision|llava|llama-3\.2-vision|pixtral|qwen[-_ ]?vl|qwen2[-.]?vl/.test(m)) { return true; }
	return false;
}

/**
 * Encode a model selection for the `visionDescribeModel` global setting. `'auto'` is stored as the
 * literal string; a specific pick is stored as JSON so provider + model survive round-tripping
 * regardless of characters in the model name (e.g. openrouter's `anthropic/claude-opus-4`).
 */
export function encodeVisionModelSetting(sel: ModelSelection): string {
	return JSON.stringify({ providerName: sel.providerName, modelName: sel.modelName });
}

/**
 * Decode the `visionDescribeModel` setting. Returns null for `'auto'`, empty, or any malformed
 * value — callers treat null as "auto (cheapest vision model)".
 */
export function decodeVisionModelSetting(raw: string | undefined | null): ModelSelection | null {
	if (!raw || raw === 'auto') { return null; }
	try {
		const parsed = JSON.parse(raw) as { providerName?: unknown; modelName?: unknown };
		if (parsed && typeof parsed.providerName === 'string' && typeof parsed.modelName === 'string') {
			return { providerName: parsed.providerName as ProviderName, modelName: parsed.modelName };
		}
	} catch { /* legacy / malformed → fall back to auto */ }
	return null;
}

/** Total per-Mtok cost (input + output) used to rank vision models for the "auto" pick. Missing
 *  cost (local / free models) sorts cheapest. */
function visionModelCost(
	providerName: ProviderName,
	modelName: string,
	overrides: IVoidSettingsService['state']['overridesOfModel'],
): number {
	try {
		const cost = getModelCapabilities(providerName, modelName, overrides).cost as { input?: number; output?: number } | undefined;
		return (cost?.input ?? 0) + (cost?.output ?? 0);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

export function getVisionDescribeModel(
	active: ModelSelection,
	settingsService: IVoidSettingsService,
): ModelSelection | null {
	const sop = settingsService.state.settingsOfProvider as Record<string, { models?: Array<{ modelName: string; isHidden: boolean }> }>;
	const overrides = settingsService.state.overridesOfModel;

	const isVisibleModel = (providerName: ProviderName, modelName: string): boolean => {
		const info = (sop[providerName]?.models ?? []).find(m => m.modelName === modelName);
		return !!info && !info.isHidden;
	};
	const isUsableVision = (providerName: ProviderName, modelName: string): boolean => {
		if (providerName === active.providerName && modelName === active.modelName) { return false; }
		return modelSupportsVision(providerName, modelName, overrides);
	};

	// 1) Explicit user pick (Settings → General → "Vision transcription model"). Honor it only while
	//    it is still visible and vision-capable; otherwise silently fall back to auto so a removed or
	//    hidden model never dead-ends image describe.
	const picked = decodeVisionModelSetting(settingsService.state.globalSettings.visionDescribeModel);
	if (picked && isVisibleModel(picked.providerName, picked.modelName) && isUsableVision(picked.providerName, picked.modelName)) {
		return picked;
	}

	// 2) Auto — cheapest available vision model. The old logic took the FIRST vision model in provider
	//    order, which landed on premium Anthropic models (Opus Hybrid / Fable 5) for most users. A
	//    transcription only needs a competent vision model, so prefer the cheapest to keep it minimal.
	let best: ModelSelection | null = null;
	let bestCost = Number.POSITIVE_INFINITY;
	for (const providerName of Object.keys(sop) as ProviderName[]) {
		for (const info of sop[providerName]?.models ?? []) {
			if (info.isHidden) { continue; }
			if (!isUsableVision(providerName, info.modelName)) { continue; }
			const cost = visionModelCost(providerName, info.modelName, overrides);
			if (cost < bestCost) {
				bestCost = cost;
				best = { providerName, modelName: info.modelName };
			}
		}
	}
	return best;
}

function describeImagesOneShot(
	images: Array<{ data: string; mimeType: string }>,
	visionModel: ModelSelection,
	settingsService: IVoidSettingsService,
	llmMessageService: ILLMMessageService,
	convertService: IConvertToLLMMessageService,
	token: CancellationToken,
	prompt: string = VISION_DESCRIBE_PROMPT,
): Promise<string> {
	return new Promise<string>(resolve => {
		if (token.isCancellationRequested) { resolve(''); return; }
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const finish = (text: string) => {
			if (settled) { return; }
			settled = true;
			if (timeoutId !== undefined) { clearTimeout(timeoutId); }
			resolve(text);
		};

		const { messages: llmMessages } = convertService.prepareLLMSimpleMessages({
			simpleMessages: [{
				role: 'user',
				content: prompt,
				images: images.map(img => ({ data: img.data, mimeType: img.mimeType })),
			}],
			systemMessage: '',
			modelSelection: visionModel,
			featureName: 'Chat',
		});

		let requestId: string | null = null;
		const cancelSub = token.onCancellationRequested(() => {
			if (requestId) { llmMessageService.abort(requestId); }
			finish('');
		});

		timeoutId = setTimeout(() => {
			console.warn('[V3Code Vision Describe] timed out after', VISION_DESCRIBE_TIMEOUT_MS, 'ms');
			if (requestId) { llmMessageService.abort(requestId); }
			finish('');
		}, VISION_DESCRIBE_TIMEOUT_MS);

		requestId = llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			messages: llmMessages,
			separateSystemMessage: undefined,
			chatMode: 'chat' as ChatMode,
			modelSelection: visionModel,
			modelSelectionOptions: undefined as never,
			overridesOfModel: settingsService.state.overridesOfModel,
			logging: { loggingName: 'V3Code Vision Describe' },
			onText: () => { /* ignore streaming deltas */ },
			onFinalMessage: ({ fullText }) => {
				cancelSub.dispose();
				finish((fullText ?? '').replace(/\u2060/g, '').trim());
			},
			onError: ({ message, fullError }) => {
				cancelSub.dispose();
				console.error('[V3Code Vision Describe] LLM error:', message, fullError);
				finish('');
			},
			onAbort: () => {
				cancelSub.dispose();
				finish('');
			},
		});

		if (!requestId) { cancelSub.dispose(); finish(''); }
	});
}

/**
 * Give a text-only (non-vision) agent "sight" of a screenshot it captured via a browser tool.
 * Picks a configured vision model, describes the rendered page (layout, colors, visual bugs), and
 * returns the description text. The human still sees the real pixels in the chat tool card; only the
 * model reads this text. Returns an `error` string when no vision model is configured or the describe
 * call produced nothing, so the caller can fall back to the existing text-only note.
 */
export async function describeToolScreenshots(
	images: Array<{ data: string; mimeType: string }>,
	activeModel: ModelSelection,
	settingsService: IVoidSettingsService,
	llmMessageService: ILLMMessageService,
	convertService: IConvertToLLMMessageService,
	token: CancellationToken,
): Promise<{ description: string; visionModel: ModelSelection } | { error: 'no-vision-model' | 'describe-failed' }> {
	const visionModel = getVisionDescribeModel(activeModel, settingsService);
	if (!visionModel) { return { error: 'no-vision-model' }; }
	const description = await describeImagesOneShot(images, visionModel, settingsService, llmMessageService, convertService, token, SCREENSHOT_DESCRIBE_PROMPT);
	return description ? { description, visionModel } : { error: 'describe-failed' };
}

/** Describe one image attachment (for manual Describe button). */
export async function describeSingleImageAttachment(
	image: VisionImageAttachment,
	activeModel: ModelSelection,
	settingsService: IVoidSettingsService,
	llmMessageService: ILLMMessageService,
	convertService: IConvertToLLMMessageService,
	token: CancellationToken,
): Promise<{ description?: string; error?: string }> {
	if (modelSupportsVision(activeModel.providerName, activeModel.modelName, settingsService.state.overridesOfModel)) {
		return { error: 'Active model supports vision — no describe step needed.' };
	}
	const visionModel = getVisionDescribeModel(activeModel, settingsService);
	if (!visionModel) {
		return { error: 'No vision-capable model configured. Add Claude, GPT-4o, or Gemini in Settings.' };
	}
	const desc = await describeImagesOneShot(
		[{ data: image.data, mimeType: image.mimeType }],
		visionModel,
		settingsService,
		llmMessageService,
		convertService,
		token,
	);
	if (desc) {
		return { description: desc };
	}
	return { error: `Describe failed (${visionModel.modelName}). See DevTools console for details.` };
}

function getImageDescribeMode(settingsService: IVoidSettingsService): ImageDescribeMode {
	return settingsService.state.globalSettings.imageDescribeMode ?? 'manual';
}

function appendImageDescriptionBlock(content: string, descriptions: string[]): string {
	const joined = descriptions.map(d => d.trim()).filter(Boolean).join('\n\n');
	if (!joined) {
		return `${content}\n\n[Image Description unavailable]`;
	}
	return `${content}\n\n[Image Description: ${joined}]`;
}

/**
 * Describe image attachments for non-vision active models (DeepSeek-style workaround).
 * No-op when the active model supports vision. Mutates messages in place.
 */
export async function describeImagesForNonVisionModel(
	messages: VisionDescribeUserMessage[],
	activeModel: ModelSelection,
	settingsService: IVoidSettingsService,
	llmMessageService: ILLMMessageService,
	convertService: IConvertToLLMMessageService,
	token: CancellationToken,
	callbacks?: ImageDescribeCallbacks,
): Promise<'ok' | 'cancelled'> {
	try {
		const overrides = settingsService.state.overridesOfModel;
		if (modelSupportsVision(activeModel.providerName, activeModel.modelName, overrides)) {
			return 'ok';
		}
		const targets = messages.filter(
			(m): m is VisionDescribeUserMessage & { images: NonNullable<VisionDescribeUserMessage['images']> } =>
				!!m.images && m.images.length > 0,
		);
		if (targets.length === 0) {
			return 'ok';
		}

		const mode = getImageDescribeMode(settingsService);
		const visionModel = getVisionDescribeModel(activeModel, settingsService);

		if (mode !== 'off' && !visionModel) {
			for (const m of targets) {
				m.content = `${m.content}\n\n[Image attached, but no vision-capable model is configured to read it. Add a Claude / GPT-4o / Gemini key to enable image understanding.]`;
				m.images = [];
			}
			return 'ok';
		}

		for (const m of targets) {
			if (!m.images || m.images.length === 0) { continue; }

			const preDescribed = m.images.map(img => img.description?.trim()).filter((d): d is string => !!d);
			const undescribed = m.images.filter(img => !img.description?.trim());

			if (mode === 'off') {
				m.content = `${m.content}\n\n[${m.images.length} image(s) attached — image describe is disabled in Settings.]`;
				m.images = [];
				continue;
			}

			let apiDescriptions: string[] = [];
			let shouldCallApi = false;

			if (undescribed.length > 0) {
				if (mode === 'on_send') {
					shouldCallApi = true;
				} else if (mode === 'manual') {
					if (callbacks?.promptManualDescribe) {
						const choice = await callbacks.promptManualDescribe({
							imageCount: undescribed.length,
							visionModel,
							activeModel,
						});
						if (choice === 'cancel') {
							return 'cancelled';
						}
						shouldCallApi = choice === 'describe';
					}
				}
			}

			if (shouldCallApi && visionModel && undescribed.length > 0) {
				callbacks?.onDescribeStart?.({ imageCount: undescribed.length, visionModel });
				const desc = await describeImagesOneShot(
					undescribed.map(img => ({ data: img.data, mimeType: img.mimeType })),
					visionModel,
					settingsService,
					llmMessageService,
					convertService,
					token,
				);
				if (token.isCancellationRequested) {
					return 'cancelled';
				}
				if (desc) {
					apiDescriptions = [desc];
				} else {
					callbacks?.onDescribeError?.({
						message: 'Vision model returned no description.',
						visionModel,
					});
				}
			}

			const allDescriptions = [...preDescribed, ...apiDescriptions];

			if (allDescriptions.length > 0) {
				m.content = appendImageDescriptionBlock(m.content, allDescriptions);
			} else if (shouldCallApi) {
				m.content = appendImageDescriptionBlock(m.content, []);
			} else if (undescribed.length > 0) {
				m.content = `${m.content}\n\n[${undescribed.length} image(s) not described — use Describe on attachments before send, or set "Describe on send" in Settings.]`;
			}

			m.images = [];
		}
		return 'ok';
	} catch {
		for (const m of messages) {
			if (m.images && m.images.length > 0) {
				m.images = undefined;
			}
		}
		return 'ok';
	}
}

/** Apply vision describe to sidebar chat thread messages (mutates user messages in place). */
export async function describeImagesInChatMessages(
	chatMessages: ChatMessage[],
	activeModel: ModelSelection,
	settingsService: IVoidSettingsService,
	llmMessageService: ILLMMessageService,
	convertService: IConvertToLLMMessageService,
	token: CancellationToken,
	callbacks?: ImageDescribeCallbacks,
): Promise<'none' | 'ok' | 'cancelled'> {
	const userMessages: VisionDescribeUserMessage[] = [];
	for (const m of chatMessages) {
		if (m.role === 'user' && m.images && m.images.length > 0) {
			userMessages.push(m);
		}
	}
	if (userMessages.length === 0) {
		return 'none';
	}
	const result = await describeImagesForNonVisionModel(
		userMessages,
		activeModel,
		settingsService,
		llmMessageService,
		convertService,
		token,
		callbacks,
	);
	return result === 'cancelled' ? 'cancelled' : 'ok';
}
