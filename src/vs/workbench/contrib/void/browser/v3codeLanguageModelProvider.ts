/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import {
	ILanguageModelsService,
	ILanguageModelChatProvider,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	IChatResponsePart,
	IChatMessage,
	ChatMessageRole,
} from '../../chat/common/languageModels.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { getModelCapabilities, getReservedOutputTokenSpace, getIsReasoningEnabledState } from '../common/modelCapabilities.js';
import type { ChatMode, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { displayInfoOfProviderName, isProviderTemporarilyDisabled } from '../common/voidSettingsTypes.js';
import { V3_MODEL_TIERS, tierFromModelSelection, tierLanguageModelId, isHostedTierId } from '../common/modelTiers.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';
import { IRefreshModelService } from '../common/refreshModelService.js';
import { RefreshableProviderName, refreshableProviderNames } from '../common/voidSettingsTypes.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import type { LLMChatMessage } from '../common/sendLLMMessageTypes.js';
import { buildV3CodeConfigurationSchema } from './v3codeModelConfiguration.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { LlmStreamWatchdog, llmStreamStallMs } from './v3codeLlmStreamWatchdog.js';

const V3CODE_VENDOR = 'v3code';
const V3CODE_EXT_ID = new ExtensionIdentifier('v3code.v3code');

class V3CodeLanguageModelProvider extends Disposable implements IWorkbenchContribution, ILanguageModelChatProvider {

	static readonly ID = 'workbench.contrib.v3codeLanguageModelProvider';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Last catalog fingerprint — skip LM re-resolve when unrelated settings change. */
	private _lastCatalogFingerprint = '';

	/** Subscription lanes authenticate through a vendor CLI credential store, not an API key.
	 *  `as const` (not a plain annotation) so the tuple yields a literal union that
	 *  `_planStatusFetchers` can require a probe for — see the note there. */
	private static readonly PLAN_LANES = ['grokPlan', 'claudePlan', 'copilot', 'geminiPlan', 'cursorLocal', 'openaiPlan'] as const satisfies readonly ProviderName[];

	/** signed-in state per plan lane, refreshed on a slow poll — see _refreshPlanStatuses. */
	private _planSignedIn: Partial<Record<ProviderName, boolean>> | null = null;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
		@IRefreshModelService private readonly refreshModelService: IRefreshModelService,
	) {
		super();
		this._registerVendorAndProvider();

		// Sign-in/paid changes and provider-health changes both alter which models are usable —
		// re-resolve the catalog so the picker tracks reality (the fingerprint below includes both).
		this._register(this.accountService.onDidChangeState(() => {
			const fingerprint = this._catalogFingerprint(this.settingsService.state);
			if (fingerprint !== this._lastCatalogFingerprint) {
				this._lastCatalogFingerprint = fingerprint;
				this._onDidChange.fire();
			}
		}));
		this._register(this.refreshModelService.onDidChangeHealth(() => {
			const fingerprint = this._catalogFingerprint(this.settingsService.state);
			if (fingerprint !== this._lastCatalogFingerprint) {
				this._lastCatalogFingerprint = fingerprint;
				this._onDidChange.fire();
			}
		}));

		this._register(this.settingsService.onDidChangeState(() => {
			const fingerprint = this._catalogFingerprint(this.settingsService.state);
			if (fingerprint === this._lastCatalogFingerprint) {
				return;
			}
			this._lastCatalogFingerprint = fingerprint;
			this._onDidChange.fire();
		}));
		this._lastCatalogFingerprint = this._catalogFingerprint(this.settingsService.state);

		// Plan lanes have no API key to check, so their models used to sit in the picker even when
		// nobody had ever run the vendor's login — picking one 400'd at send time. Poll the (cheap,
		// local credential-store) status checks and re-resolve the catalog when sign-in state flips,
		// so a `claude /login` in the integrated terminal surfaces the models within a minute.
		const pollPlanStatuses = () => { this._refreshPlanStatuses().catch(() => { }); };
		pollPlanStatuses();
		const planPoll = this._register(new IntervalTimer());
		planPoll.cancelAndSet(pollPlanStatuses, 60_000, mainWindow);
	}

	/**
	 * One status probe per plan lane, keyed by lane.
	 *
	 * Typed as a TOTAL record over PLAN_LANES, so adding a lane there without adding its probe
	 * here is a compile error rather than a runtime surprise. The failure it prevents is silent
	 * and confusing: an unprobed lane reads as signed-OUT, and the `isSubscriptionLane` filter in
	 * provideLanguageModelChatInfo then keeps every model that lane serves out of the picker —
	 * the models just never appear, with nothing in the UI to explain why.
	 *
	 * These probes are cheap (local credential-store reads in the main process), which is why the
	 * constructor can poll them every minute. `cursorLocalStatus` takes an optional endpoint and
	 * defaults to the standard local address with no argument.
	 */
	private _planStatusFetchers(): Record<(typeof V3CodeLanguageModelProvider.PLAN_LANES)[number], () => Promise<{ signedIn: boolean }>> {
		return {
			grokPlan: () => this.llmMessageService.grokPlanStatus(),
			claudePlan: () => this.llmMessageService.claudePlanStatus(),
			copilot: () => this.llmMessageService.copilotStatus(),
			geminiPlan: () => this.llmMessageService.geminiPlanStatus(),
			cursorLocal: () => this.llmMessageService.cursorLocalStatus(),
			openaiPlan: () => this.llmMessageService.openaiPlanStatus(),
		};
	}

	private async _refreshPlanStatuses(): Promise<void> {
		const lanes = V3CodeLanguageModelProvider.PLAN_LANES;
		const fetchers = this._planStatusFetchers();
		// Drive the probes FROM the lane list, so the two cannot drift out of step.
		const results = await Promise.all(lanes.map(lane => isProviderTemporarilyDisabled(lane) ? Promise.resolve({ signedIn: false }) : fetchers[lane]()));
		const next: Partial<Record<ProviderName, boolean>> = {};
		lanes.forEach((lane, i) => { next[lane] = !!results[i]?.signedIn; });
		const prev = this._planSignedIn;
		const changed = !prev || lanes.some(p => prev[p] !== next[p]);
		this._planSignedIn = next;
		if (changed && prev) { this._onDidChange.fire(); }
	}

	private _catalogFingerprint(state: typeof this.settingsService.state): string {
		const parts: string[] = [];
		for (const tier of V3_MODEL_TIERS) {
			parts.push(tierLanguageModelId(tier));
		}
		for (const opt of state._modelOptions ?? []) {
			parts.push(this._modelId(opt.selection.providerName, opt.selection.modelName));
		}
		const chat = state.modelSelectionOfFeature?.['Chat'];
		if (chat) {
			parts.push(`sel:${chat.providerName}/${chat.modelName}/${chat.hostedTierId ?? ''}`);
		}
		// Account + provider-health inputs: these gate which entries are listed at all, so the
		// catalog must re-resolve when they flip (sign-in completes, a key check fails, etc.).
		const acct = this.accountService.state;
		parts.push(`acct:${acct.status}/${acct.isPaid ? 1 : 0}/${this.accountService.isPlanCreditExhausted() ? 1 : 0}`);
		for (const p of refreshableProviderNames) {
			const h = this.refreshModelService.healthOfProvider[p];
			if (h) { parts.push(`health:${p}=${h.status}`); }
		}
		return parts.join('|');
	}

	/** Does this provider have a usable BYOK credential entered in settings? */
	private _byokKeyPresent(providerName: string): boolean {
		const settings = this.settingsService.state.settingsOfProvider[providerName as ProviderName] as { apiKey?: string } | undefined;
		return !!settings?.apiKey?.trim();
	}

	private _providerHealth(providerName: string): 'unknown' | 'ok' | 'badKey' | 'unreachable' {
		return this.refreshModelService.healthOfProvider[providerName as RefreshableProviderName]?.status ?? 'unknown';
	}

	private _registerVendorAndProvider(): void {
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors(
			[{
				vendor: V3CODE_VENDOR,
				displayName: 'V3Code',
				configuration: undefined,
				managementCommand: undefined,
				when: undefined,
			}],
			[]
		);

		this._register(
			this.languageModelsService.registerLanguageModelProvider(V3CODE_VENDOR, this)
		);
	}

	private _modelId(providerName: string, modelName: string): string {
		return `${V3CODE_VENDOR}/${providerName}/${modelName}`;
	}

	private _selectionFromModelId(modelId: string): ModelSelection | null {
		const parts = modelId.split('/');
		if (parts.length === 3 && parts[0] === V3CODE_VENDOR && parts[1] === 'tier') {
			return V3_MODEL_TIERS.find(t => t.id === parts[2])?.selection ?? null;
		}
		if (parts.length >= 3 && parts[0] === V3CODE_VENDOR && parts[1] !== 'none' && parts[1] !== 'tier') {
			return {
				providerName: parts[1] as ProviderName,
				modelName: parts.slice(2).join('/'),
			};
		}

		return this.settingsService.state.modelSelectionOfFeature?.['Chat']
			?? V3_MODEL_TIERS[1]?.selection
			?? V3_MODEL_TIERS[0]?.selection
			?? null;
	}

	private _contentToText(message: IChatMessage): string {
		const parts: string[] = [];
		for (const part of message.content) {
			if (part.type === 'text') {
				parts.push(part.value);
			} else if (part.type === 'thinking') {
				parts.push(Array.isArray(part.value) ? part.value.join('') : part.value);
			} else if (part.type === 'tool_result') {
				parts.push(part.value.map(item => item.type === 'text' ? item.value : '').filter(Boolean).join('\n'));
			} else if (part.type === 'tool_use') {
				parts.push(`Tool call ${part.name}: ${JSON.stringify(part.parameters)}`);
			}
		}

		return parts.filter(Boolean).join('\n');
	}

	private _toLLMChatMessages(messages: IChatMessage[]): LLMChatMessage[] {
		return messages.map(message => {
			const content = this._contentToText(message);
			if (message.role === ChatMessageRole.Assistant) {
				return { role: 'assistant', content };
			}
			if (message.role === ChatMessageRole.System) {
				return { role: 'system', content };
			}
			return { role: 'user', content };
		});
	}

	async provideLanguageModelChatInfo(
		_options: ILanguageModelChatInfoOptions,
		_token: CancellationToken
	): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const state = this.settingsService.state;
		const chatModel = state.modelSelectionOfFeature?.['Chat'];
		const result: ILanguageModelChatMetadataAndIdentifier[] = [];
		const seenIdentifiers = new Set<string>();

		const acct = this.accountService.state;
		const hostedUsable = acct.status === 'signedIn' && acct.isPaid && !this.accountService.isPlanCreditExhausted();
		for (const tier of V3_MODEL_TIERS) {
			const id = tierLanguageModelId(tier);
			if (seenIdentifiers.has(id)) {
				continue;
			}
			// A tier the user cannot actually run stays out of the picker: hosted tiers need a
			// live paid plan (or a BYOK key for the tier's provider — the send path fails open
			// to BYOK); non-hosted tiers (Opus orchestration) need the provider's BYOK key.
			const tierByok = this._byokKeyPresent(tier.selection.providerName);
			const usable = isHostedTierId(tier.id) ? (hostedUsable || tierByok) : tierByok;
			if (!usable) {
				continue;
			}
			seenIdentifiers.add(id);
			const caps = getModelCapabilities(tier.selection.providerName as ProviderName, tier.selection.modelName, state.overridesOfModel);
			const storedTierOptions = state.optionsOfModelSelection['Chat']?.[tier.selection.providerName]?.[tier.selection.modelName];
			const tierOptions = { ...storedTierOptions, ...tier.options };
			const isCurrentDefault = tierFromModelSelection(chatModel, storedTierOptions)?.id === tier.id;
			// Resolve the reply reserve the SAME way the trimmer does (reasoning-aware), so the
			// context-usage meter's denominator matches the real input cap enforced in
			// convertToLLMMessageService. Using caps.reservedOutputTokenSpace directly read the
			// non-reasoning value (e.g. 128k for Opus) while the trimmer used the reasoning value
			// (e.g. 8k) — so the meter and the actual cap disagreed by the difference.
			const isReasoningEnabled = getIsReasoningEnabledState('Chat', tier.selection.providerName as ProviderName, tier.selection.modelName, tierOptions, state.overridesOfModel);
			const reservedOutputTokenSpace = getReservedOutputTokenSpace(tier.selection.providerName as ProviderName, tier.selection.modelName, { isReasoningEnabled, overridesOfModel: state.overridesOfModel }) ?? 4_096;
			result.push({
				identifier: id,
				metadata: {
					extension: V3CODE_EXT_ID,
					id,
					vendor: V3CODE_VENDOR,
					name: tier.label,
					family: 'tier',
					version: '1',
					configurationSchema: buildV3CodeConfigurationSchema(
						tier.selection.providerName as ProviderName,
						tier.selection.modelName,
						state.overridesOfModel,
						tierOptions,
					),
					// maxInputTokens is the usable PROMPT budget; the context-usage widget computes
					// the full window as maxInputTokens + maxOutputTokens. contextWindow is the FULL
					// window and reservedOutputTokenSpace (resolved reasoning-aware above) is the slice
					// reserved for the reply, so the prompt budget = contextWindow - reservedOutputTokenSpace.
					// (Setting maxInputTokens = contextWindow double-counted the reserve and made the
					// meter read ~1.38M.)
					maxInputTokens: Math.max(1, (caps.contextWindow ?? 1_000_000) - reservedOutputTokenSpace),
					maxOutputTokens: reservedOutputTokenSpace,
					isDefaultForLocation: isCurrentDefault ? {
						[ChatAgentLocation.Chat]: true,
						[ChatAgentLocation.EditorInline]: true,
						[ChatAgentLocation.Terminal]: true,
						[ChatAgentLocation.Notebook]: true,
					} : {},
					isUserSelectable: true,
					capabilities: {
						toolCalling: !!caps.specialToolFormat,
						agentMode: !!caps.specialToolFormat,
						// Always report vision=true so the image-attachment UI never drops images
						// before they reach the pipeline. The v3code pipeline routes non-vision
						// models through the vision describe-step (v3codeVisionDescribe.ts), so
						// every model can "see" — natively or via description.
						vision: true,
					},
				},
			});
		}

		// The SAME model id can be served by more than one provider lane, and the picker showed a
		// bare model name for each — so two identical "grok-4.5" rows appeared with no way to tell
		// which one you were choosing. They are not interchangeable: xAI is BYOK (your API key,
		// billed per token) while grokPlan runs on the Grok subscription from `grok login`. Tag the
		// lane ONLY when a name is genuinely ambiguous, so unique models keep their clean label.
		const lanesOfModelName = new Map<string, Set<string>>();
		for (const opt of state._modelOptions ?? []) {
			const lanes = lanesOfModelName.get(opt.selection.modelName) ?? new Set<string>();
			lanes.add(opt.selection.providerName);
			lanesOfModelName.set(opt.selection.modelName, lanes);
		}
		// Provider titles are already of the form "Grok (xAI)" / "Grok (Plan)", so prefer the
		// parenthesised qualifier — "grok-4.5 (Plan)" reads far better than "grok-4.5 (Grok (Plan))".
		const laneLabel = (providerName: ProviderName): string => {
			const title = displayInfoOfProviderName(providerName).title;
			return title.match(/\(([^)]+)\)/)?.[1] ?? title;
		};

		// Ensure the plan sign-in states are known before listing plan models. Normally the
		// constructor poll has already filled this in; awaiting here only matters on the very
		// first resolve after startup.
		if (this._planSignedIn === null) {
			try { await this._refreshPlanStatuses(); } catch { /* treated as signed-out below */ }
		}
		for (const opt of state._modelOptions ?? []) {
			const { providerName, modelName } = opt.selection;
			const id = this._modelId(providerName, modelName);
			if (seenIdentifiers.has(id)) {
				continue;
			}
			// Subscription lanes are ALWAYS tagged, even when nothing else shares the name: which
			// account pays is not inferable from "grok-4.5", and picking the wrong one either spends
			// an API key or the monthly plan. Everything else is tagged only on a real collision.
			// (Previously only grokPlan was tagged — claudePlan/copilot/geminiPlan showed bare names,
			// so a plan Opus and a BYOK Opus were two identical rows.)
			const isSubscriptionLane = (V3CodeLanguageModelProvider.PLAN_LANES as readonly string[]).includes(providerName);
			// A plan lane with no credential store is not usable — every send would 400 with
			// "Not signed in". Keep it out of the picker until the vendor login has been run.
			if (isSubscriptionLane && !this._planSignedIn?.[providerName as ProviderName]) {
				continue;
			}
			// A provider whose key/gateway PROBE came back rejected is not usable — every send
			// would fail the same way. Hard-filter only the definitive failure (badKey); a
			// transient outage ('unreachable') or a not-yet-probed provider stays listed with a
			// caveat below, so a blip never empties the picker.
			const health = this._providerHealth(providerName);
			if (health === 'badKey') {
				continue;
			}
			seenIdentifiers.add(id);
			const isAmbiguousAcrossLanes = (lanesOfModelName.get(modelName)?.size ?? 0) > 1;
			const displayName = providerName === 'openRouter' ? `${modelName} (OpenRouter)` : (isSubscriptionLane || isAmbiguousAcrossLanes)
				? `${modelName} (${laneLabel(providerName as ProviderName)})`
				: modelName;
			const caps = getModelCapabilities(providerName as ProviderName, modelName, state.overridesOfModel);
			const modelOptions = state.optionsOfModelSelection['Chat']?.[providerName]?.[modelName];
			// A hosted-tagged selection must not mark the same-named BYOK entry default.
			const isCurrentDefault = !chatModel?.hostedTierId && chatModel?.providerName === providerName && chatModel?.modelName === modelName;

			result.push({
				identifier: id,
				metadata: {
					extension: V3CODE_EXT_ID,
					id,
					vendor: V3CODE_VENDOR,
					name: displayName,
					family: providerName,
					version: '1',
					// Secondary line in the picker: which subscription pays for this lane. BYOK rows
					// stay clean — the absence of a badge means "your API key". A provider whose
					// last probe couldn't be reached keeps its row but says so.
					...(isSubscriptionLane
						? { detail: `${displayInfoOfProviderName(providerName as ProviderName).title} subscription` }
						: health === 'unreachable' ? { detail: 'provider unreachable — may fail' } : {}),
					configurationSchema: buildV3CodeConfigurationSchema(
						providerName as ProviderName,
						modelName,
						state.overridesOfModel,
						modelOptions,
					),
					maxInputTokens: Math.max(1, (caps.contextWindow ?? 128000) - (caps.reservedOutputTokenSpace ?? 32_000)),
					maxOutputTokens: caps.reservedOutputTokenSpace ?? 32_000,
					isDefaultForLocation: isCurrentDefault ? {
						[ChatAgentLocation.Chat]: true,
						[ChatAgentLocation.EditorInline]: true,
						[ChatAgentLocation.Terminal]: true,
						[ChatAgentLocation.Notebook]: true,
					} : {},
					isUserSelectable: true,
					capabilities: {
						toolCalling: !!caps.specialToolFormat,
						agentMode: !!caps.specialToolFormat,
						// Always report vision=true (see note above) — pipeline handles routing.
						vision: true,
					},
				},
			});
		}

		if (result.length === 0) {
			result.push({
				identifier: `${V3CODE_VENDOR}/none/unconfigured`,
				metadata: {
					extension: V3CODE_EXT_ID,
					id: `${V3CODE_VENDOR}/none/unconfigured`,
					vendor: V3CODE_VENDOR,
					name: 'No model configured',
					family: 'none',
					version: '0',
					maxInputTokens: 0,
					maxOutputTokens: 0,
					isDefaultForLocation: {},
					isUserSelectable: false,
				},
			});
		}

		return result;
	}

	async sendChatRequest(
		modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const modelSelection = this._selectionFromModelId(modelId);
		if (!modelSelection) {
			throw new Error('No V3Code model configured. Add a provider in V3Code Settings.');
		}
		const tier = modelId.startsWith(`${V3CODE_VENDOR}/tier/`)
			? V3_MODEL_TIERS.find(t => t.id === modelId.split('/').pop())
			: undefined;
		const storedOptions = this.settingsService.state.optionsOfModelSelection['Chat']?.[modelSelection.providerName]?.[modelSelection.modelName];
		const modelSelectionOptions = { ...storedOptions, ...tier?.options };

		// Pushable stream: the LLM callbacks (producer) enqueue parts; the async generator
		// (consumer) yields them live so the chat renders reasoning + text as they arrive
		// instead of waiting for the whole response. `onText` delivers CUMULATIVE fullText /
		// fullReasoning, so we slice by how much we've already emitted to get deltas.
		const queue: IChatResponsePart[] = [];
		let wake: (() => void) | undefined;
		let finished = false;
		let streamError: Error | undefined;
		let textSent = 0;
		let reasoningSent = 0;

		const signal = () => { wake?.(); wake = undefined; };

		const requestLifetime = new DisposableStore();
		let requestId: string | null = null;
		let finishFn: ((err?: Error) => void) | undefined;

		const streamStallMs = llmStreamStallMs(modelSelection.providerName, modelSelection.modelName);
		const stallWatchdog = requestLifetime.add(new LlmStreamWatchdog(() => {
			if (requestId) { this.llmMessageService.abort(requestId); }
			finishFn?.(new Error(`No response from V3Code language model for ${Math.round(streamStallMs / 1000)}s — request timed out and was aborted.`));
		}, streamStallMs));

		const enqueueDeltas = (fullText: string | undefined, fullReasoning: string | undefined) => {
			stallWatchdog.touch();
			// reasoning first so the thinking block renders before the answer
			if (fullReasoning && fullReasoning.length > reasoningSent) {
				queue.push({ type: 'thinking', value: fullReasoning.slice(reasoningSent) });
				reasoningSent = fullReasoning.length;
			}
			if (fullText && fullText.length > textSent) {
				queue.push({ type: 'text', value: fullText.slice(textSent) });
				textSent = fullText.length;
			}
			signal();
		};

		const done = new Promise<void>((resolve, reject) => {
			const finish = (err?: Error) => {
				if (finished) { return; }
				finished = true;
				streamError = err;
				requestLifetime.dispose();
				signal();
				if (err) { reject(err); } else { resolve(); }
			};
			finishFn = finish;
			requestLifetime.add(token.onCancellationRequested(() => {
				if (requestId) {
					this.llmMessageService.abort(requestId);
				}
				finish(new Error('V3Code language model request cancelled.'));
			}));

			requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: this._toLLMChatMessages(messages),
				separateSystemMessage: undefined,
				chatMode: 'chat' satisfies ChatMode,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel: this.settingsService.state.overridesOfModel,
				logging: { loggingName: 'V3Code Language Model API', loggingExtras: { modelId } },
				onText: ({ fullText, fullReasoning }) => enqueueDeltas(fullText, fullReasoning),
				onFinalMessage: ({ fullText, fullReasoning }) => {
					enqueueDeltas(fullText, fullReasoning);
					finish();
				},
				onError: ({ message, fullError }) => {
					finish(fullError instanceof Error ? fullError : new Error(message));
				},
				onAbort: () => finish(),
			});

			if (!requestId && !token.isCancellationRequested) {
				finish(new Error('V3Code language model request did not start.'));
			} else if (requestId) {
				stallWatchdog.arm();
			}
		});
		// the stream surfaces the error to the consumer; keep `done` from rejecting unhandled
		done.catch(() => undefined);

		const stream = (async function* () {
			while (true) {
				while (queue.length > 0) {
					yield queue.shift()!;
				}
				if (finished) {
					if (streamError) { throw streamError; }
					return;
				}
				await new Promise<void>(resolve => { wake = resolve; });
			}
		})();

		return {
			stream,
			result: done.then(() => ({})),
		};
	}

	async provideTokenCount(
		_modelId: string,
		_message: string | IChatMessage,
		_token: CancellationToken,
	): Promise<number> {
		if (typeof _message === 'string') {
			return Math.ceil(_message.length / 4);
		}
		return 100;
	}
}

registerWorkbenchContribution2(V3CodeLanguageModelProvider.ID, V3CodeLanguageModelProvider, WorkbenchPhase.BlockRestore);
