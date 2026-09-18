/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, EventLLMMessageOnUsageParams, ServiceSendLLMMessageParams, MainSendLLMMessageParams, MainLLMMessageAbortParams, ServiceModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, MainModelListParams, OllamaModelResponse, OpenaiCompatibleModelResponse, FIM_CAPABLE_PROVIDERS, } from './sendLLMMessageTypes.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { IMCPService } from './mcpService.js';
import { ITokenUsageService } from './tokenUsageService.js';
import { OverridesOfModel, ProviderName } from './voidSettingsTypes.js';
import { IV3CodeAccountService } from './v3codeAccountService.js';
import { hostedWireModelForSelection } from './modelTiers.js';

// calls channel to implement features
export const ILLMMessageService = createDecorator<ILLMMessageService>('llmMessageService');

/** Grok (Plan) subscription sign-in status, read live from ~/.grok/auth.json in the main process. */
export type GrokPlanStatus = { signedIn: boolean; email?: string; expiresAt?: string };

/** Claude (Plan) status, read live from the Claude Code credential store in the main process.
 *  `expiresAt` is epoch ms here (Claude Code stores it that way), not an ISO string like Grok. */
export type ClaudePlanStatus = { signedIn: boolean; email?: string; subscriptionType?: string; expiresAt?: number };

/** GitHub Copilot sign-in status, read live from the Copilot credential stores. */
export type CopilotPlanStatus = { signedIn: boolean; login?: string };

/** Gemini (Plan) status, read live from ~/.gemini/oauth_creds.json. `projectResolved` is false
 *  when the user is signed in but the Code Assist project has not been discovered yet. */
export type GeminiPlanStatus = { signedIn: boolean; email?: string; expiresAt?: number; projectResolved?: boolean };

/** Cursor (Local): the "API for Cursor" app answers /v1/models when it is up and signed in.
 *  `signedIn` here means "the local server is reachable" — the app owns the key, not us. */
export type CursorLocalStatus = { signedIn: boolean; models?: string[] };
export type OpenaiPlanStatus = { signedIn: boolean; email?: string; expiresAt?: number };

export interface ILLMMessageService {
	readonly _serviceBrand: undefined;
	sendLLMMessage: (params: ServiceSendLLMMessageParams) => string | null;
	abort: (requestId: string) => void;
	ollamaList: (params: ServiceModelListParams<OllamaModelResponse>) => void;
	openAICompatibleList: (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => void;
	grokPlanStatus: () => Promise<GrokPlanStatus>;
	claudePlanStatus: () => Promise<ClaudePlanStatus>;
	copilotStatus: () => Promise<CopilotPlanStatus>;
	geminiPlanStatus: () => Promise<GeminiPlanStatus>;
	cursorLocalStatus: (endpoint?: string) => Promise<CursorLocalStatus>;
	openaiPlanStatus: () => Promise<OpenaiPlanStatus>;
}


// open this file side by side with llmMessageChannel
export class LLMMessageService extends Disposable implements ILLMMessageService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel // LLMMessageChannel

	// sendLLMMessage
	private readonly llmMessageHooks = {
		onText: {} as { [eventId: string]: ((params: EventLLMMessageOnTextParams) => void) },
		onFinalMessage: {} as { [eventId: string]: ((params: EventLLMMessageOnFinalMessageParams) => void) },
		onError: {} as { [eventId: string]: ((params: EventLLMMessageOnErrorParams) => void) },
		onAbort: {} as { [eventId: string]: (() => void) }, // NOT sent over the channel, result is instant when we call .abort()
	}

	// Usage metering context, kept per-request until the main process reports the request's
	// terminal usage (which it does exactly once — on final, error, OR abort, so aborted/errored
	// streams are still billed). Deliberately NOT cleared in _clearChannelHooks: on abort the
	// hooks are cleared synchronously, but the usage event arrives asynchronously after.
	private readonly _usageContextOfRequestId = new Map<string, {
		providerName: ProviderName;
		modelName: string;
		sessionId: string;
		overridesOfModel: OverridesOfModel | undefined;
	}>()

	// Requests routed through the hub's hosted lane — when one terminates we nudge a fast meter
	// refresh so the % bars move near-live (the server already recorded the spend per request).
	private readonly _hostedRequestIds = new Set<string>()

	// One-shot retry per hosted request: re-dispatches the SAME request with a freshly-minted
	// account token after refreshForHostedSend() renews the session, so a stale-token 401 heals
	// silently instead of surfacing "Invalid API key" to a paying user.
	private readonly _hostedRetry = new Map<string, () => boolean>()

	// list hooks
	private readonly listHooks = {
		ollama: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OllamaModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OllamaModelResponse>) => void) },
		},
		openAICompat: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OpenaiCompatibleModelResponse>) => void) },
		}
	} satisfies {
		[providerName in 'ollama' | 'openAICompat']: {
			success: { [eventId: string]: ((params: EventModelListOnSuccessParams<any>) => void) },
			error: { [eventId: string]: ((params: EventModelListOnErrorParams<any>) => void) },
		}
	}

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService, // used as a renderer (only usable on client side)
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		// @INotificationService private readonly notificationService: INotificationService,
		@IMCPService private readonly mcpService: IMCPService,
		@ITokenUsageService private readonly tokenUsageService: ITokenUsageService,
		@IV3CodeAccountService private readonly v3codeAccountService: IV3CodeAccountService,
	) {
		super()

		// const service = ProxyChannel.toService<LLMMessageChannel>(mainProcessService.getChannel('void-channel-sendLLMMessage')); // lets you call it like a service
		// see llmMessageChannel.ts
		this.channel = this.mainProcessService.getChannel('void-channel-llmMessage')

		// .listen sets up an IPC channel and takes a few ms, so we set up listeners immediately and add hooks to them instead
		// llm
		this._register((this.channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this.llmMessageHooks.onText[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this.llmMessageHooks.onFinalMessage[e.requestId]?.(e);
			this._onHostedRequestSettled(e.requestId);
			this._clearChannelHooks(e.requestId)
		}))
		this._register((this.channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			// Hosted (paid) lane 401 = a stale/revoked ACCOUNT token, not a bad API key. Auto-heal
			// BEFORE surfacing anything: refresh the session and re-dispatch once. Only give up (with
			// an honest message) if the session is genuinely dead.
			if (e.hostedAuthExpired && this._hostedRetry.has(e.requestId)) {
				const retry = this._hostedRetry.get(e.requestId)!;
				this._hostedRetry.delete(e.requestId); // one shot only
				void (async () => {
					const result = await this.v3codeAccountService.refreshForHostedSend();
					if (result === 'renewed' && retry()) { return; } // silently re-sent with a fresh token
					const message = result === 'rejected'
						? `Your V3Code session expired. Sign in again from Settings > Account to restore your plan.`
						: `Could not reach your V3Code plan just now. Please try again in a moment.`;
					// A dead session cannot succeed on retry; a transient reach failure can.
					this.llmMessageHooks.onError[e.requestId]?.({ ...e, message, terminal: result === 'rejected' });
					this._onHostedRequestSettled(e.requestId);
					this._clearChannelHooks(e.requestId);
				})();
				return;
			}
			// Hosted 402 credit_exhausted — never treat as a bad API key and never fail-open to BYOK.
			// Terminal: retrying an exhausted meter can only 402 again (and re-bill the attempt).
			if (e.hostedCreditExhausted) {
				const message = this.v3codeAccountService.planCreditExhaustedMessage();
				this.llmMessageHooks.onError[e.requestId]?.({ ...e, message, terminal: true });
				this._onHostedRequestSettled(e.requestId);
				this._clearChannelHooks(e.requestId);
				return;
			}
			this.llmMessageHooks.onError[e.requestId]?.(e);
			this._onHostedRequestSettled(e.requestId);
			this._clearChannelHooks(e.requestId);
			console.error('Error in LLMMessageService:', JSON.stringify(e))
		}))
		// Usage metering — THE single capture point for every LLM request in the app (chat,
		// autocomplete, inline edit, commit messages, …). The main process fires this exactly
		// once per request when it terminates — final, error, OR abort — so partially-streamed
		// requests that the provider billed still land in the meter.
		this._register((this.channel.listen('onUsage_sendLLMMessage') satisfies Event<EventLLMMessageOnUsageParams>)(e => {
			const ctx = this._usageContextOfRequestId.get(e.requestId)
			this._usageContextOfRequestId.delete(e.requestId)
			if (!ctx || !e.usage) return
			this.tokenUsageService.recordUsage({
				sessionId: ctx.sessionId,
				providerName: ctx.providerName,
				modelName: ctx.modelName,
				wireModelName: e.wireModelName,
				overridesOfModel: ctx.overridesOfModel,
				promptTokens: e.usage.prompt_tokens ?? 0,
				completionTokens: e.usage.completion_tokens ?? 0,
				promptCacheHitTokens: e.usage.prompt_cache_hit_tokens,
				promptCacheWriteTokens: e.usage.prompt_cache_write_tokens,
				promptCacheWrite1hTokens: e.usage.prompt_cache_write_1h_tokens,
			})
		}))
		// .list()
		this._register((this.channel.listen('onSuccess_list_ollama') satisfies Event<EventModelListOnSuccessParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.success[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onError_list_ollama') satisfies Event<EventModelListOnErrorParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.error[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onSuccess_list_openAICompatible') satisfies Event<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.success[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onError_list_openAICompatible') satisfies Event<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.error[e.requestId]?.(e)
		}))

	}

	sendLLMMessage(params: ServiceSendLLMMessageParams) {
		const { onText, onFinalMessage, onError, onAbort, modelSelection, usageSessionId, ...proxyParams } = params;

		// throw an error if no model/provider selected (this should usually never be reached, the UI should check this first, but might happen in cases like Apply where we haven't built much UI/checks yet, good practice to have check logic on backend)
		if (modelSelection === null) {
			const message = `Please add a provider in V3Code's Settings.`
			onError({ message, fullError: null })
			return null
		}

		if (params.messagesType === 'chatMessages' && (params.messages?.length ?? 0) === 0) {
			const message = `No messages detected.`
			onError({ message, fullError: null })
			return null
		}

		const { settingsOfProvider, } = this.voidSettingsService.state

		const mcpTools = this.mcpService.getMCPTools()

		// Hosted plan lane: if the selected tier is one of the hub's hosted models AND the
		// user has an active paid plan, route this request through the hub on our platform
		// keys (fresh account token per request). Otherwise `hosted` is undefined and the
		// request runs BYOK exactly as before.
		const wireModel = hostedWireModelForSelection(modelSelection, params.modelSelectionOptions)
		const hostedNow = wireModel ? this.v3codeAccountService.getHostedInferenceOverride(wireModel) : undefined

		// add state for request id
		const requestId = generateUuid();
		this.llmMessageHooks.onText[requestId] = onText
		this.llmMessageHooks.onFinalMessage[requestId] = onFinalMessage
		this.llmMessageHooks.onError[requestId] = onError
		this.llmMessageHooks.onAbort[requestId] = onAbort // used internally only

		// Usage books to the caller's chat session when given; otherwise to a per-feature
		// bucket so autocomplete/edit/commit-message spend is still visible in the meter.
		this._usageContextOfRequestId.set(requestId, {
			providerName: modelSelection.providerName,
			modelName: modelSelection.modelName,
			sessionId: usageSessionId ?? `feature:${params.logging.loggingName}`,
			overridesOfModel: params.overridesOfModel,
		})

		// Plan lane soft-stop: paid + included usage gone + overage off → block BEFORE dispatch.
		// Hub CREDIT_ENFORCE may still be off, so the editor must own this UX. Never silent BYOK.
		// Delivered ASYNC under a real requestId: a null return made chatThreadService paint a
		// generic "unexpected error" over this exact message, burying the upgrade/overage CTA at
		// the single most monetizable moment in the product.
		if (wireModel && this.v3codeAccountService.isPlanCreditExhausted()) {
			queueMicrotask(() => {
				const errorHook = this.llmMessageHooks.onError[requestId]
				this._usageContextOfRequestId.delete(requestId)
				this._clearChannelHooks(requestId)
				errorHook?.({
					requestId,
					message: this.v3codeAccountService.planCreditExhaustedMessage(),
					fullError: null,
					hostedCreditExhausted: true,
					terminal: true,
				})
			})
			return requestId
		}

		const providerApiKey = (settingsOfProvider[modelSelection.providerName] as { apiKey?: string } | undefined)?.apiKey

		// Autocomplete (FIM) on a hosted tier: the hub's hosted lane carries chat only — main
		// drops the hosted tag on FIM sends, which used to silently run every keystroke on the
		// user's own provider key while the UI said "plan" (or 400 "Invalid API key" with no key).
		// Route it explicitly: a real BYOK request when a key exists (tier tag dropped, metered
		// honestly under the provider), a clear terminal error when it doesn't.
		if (params.messagesType === 'FIMMessage' && wireModel) {
			// A key alone isn't enough — the provider's BYOK path must actually implement FIM
			// (openAI/xAI don't), or the fallback dispatch can only die in main with a generic
			// "Error running Autocomplete with openAI - <model>": the exact error this replaces.
			const byokCanFIM = FIM_CAPABLE_PROVIDERS.has(modelSelection.providerName)
			if (!providerApiKey || !byokCanFIM) {
				queueMicrotask(() => {
					const errorHook = this.llmMessageHooks.onError[requestId]
					this._usageContextOfRequestId.delete(requestId)
					this._clearChannelHooks(requestId)
					errorHook?.({
						requestId,
						message: !byokCanFIM
							? `Autocomplete doesn't run on the hosted plan lane yet, and ${modelSelection.providerName} has no autocomplete (FIM) API to fall back to. Pick a FIM-capable model for Autocomplete in the model picker (DeepSeek, Mistral, or a local model).`
							: `Autocomplete doesn't run on the hosted plan lane yet. Add a ${modelSelection.providerName} API key in Settings, or pick a BYOK model for Autocomplete in the model picker.`,
						fullError: null,
						terminal: true,
					})
				})
				return requestId
			}
			this.channel.call('sendLLMMessage', {
				...proxyParams,
				requestId,
				settingsOfProvider,
				modelSelection: { providerName: modelSelection.providerName, modelName: modelSelection.modelName },
				mcpTools,
				hosted: undefined,
			} satisfies MainSendLLMMessageParams)
			return requestId
		}

		// params will be stripped of all its functions over the IPC channel
		const dispatch = (hosted: typeof hostedNow, selection = modelSelection) => {
			if (hosted) {
				// Same key on the 401-retry redelivery below, so the hub can dedupe the
				// logical request (main's SDK client runs with maxRetries: 0).
				hosted = { ...hosted, idempotencyKey: requestId };
				this._hostedRequestIds.add(requestId);
				// Enable a one-shot silent retry if this send 401s on a stale account token: it
				// re-dispatches the SAME request with a freshly-minted hosted override.
				this._hostedRetry.set(requestId, () => {
					const fresh = wireModel ? this.v3codeAccountService.getHostedInferenceOverride(wireModel) : undefined;
					if (!fresh) { return false; }
					// Re-seed the usage context: the first attempt's onUsage event already consumed
					// and deleted it, so without this the retry's (billed) tokens never reach the meter.
					this._usageContextOfRequestId.set(requestId, {
						providerName: modelSelection.providerName,
						modelName: modelSelection.modelName,
						sessionId: usageSessionId ?? `feature:${params.logging.loggingName}`,
						overridesOfModel: params.overridesOfModel,
					});
					this.channel.call('sendLLMMessage', {
						...proxyParams, requestId, settingsOfProvider, modelSelection: selection, mcpTools,
						hosted: { ...fresh, idempotencyKey: requestId },
					} satisfies MainSendLLMMessageParams);
					return true;
				});
			}
			this.channel.call('sendLLMMessage', {
				...proxyParams,
				requestId,
				settingsOfProvider,
				modelSelection: selection,
				mcpTools,
				hosted,
			} satisfies MainSendLLMMessageParams);
		}

		/** Run on the user's own key — drop hostedTierId so the wire name isn't re-routed. */
		const dispatchByok = () => {
			dispatch(undefined, {
				providerName: modelSelection.providerName,
				modelName: modelSelection.modelName,
			})
		}

		// Hosted tiers prefer the hub when the user has an active paid plan. If they don't
		// (not signed in / free) but HAVE a BYOK key for that provider, fail-open to BYOK —
		// otherwise Autocomplete/Chat with a stuck V3Fast/V3Pro tag spam "Sign in for plan"
		// and stall every request on ensureHostedAccess.
		// Paid-but-exhausted never reaches here (soft-stop above); do not fail-open in that case.
		if (wireModel && !hostedNow) {
			void (async () => {
				const acct0 = this.v3codeAccountService.state
				if (acct0.status !== 'signedIn' && providerApiKey) {
					if (!this.llmMessageHooks.onAbort[requestId]) { return }
					dispatchByok()
					return
				}

				await this.v3codeAccountService.ensureHostedAccess()
				if (!this.llmMessageHooks.onAbort[requestId]) { return } // aborted while validating

				// Re-check after refresh — meter may have just reported 100%.
				if (this.v3codeAccountService.isPlanCreditExhausted()) {
					const errorHook = this.llmMessageHooks.onError[requestId]
					this._usageContextOfRequestId.delete(requestId)
					this._clearChannelHooks(requestId)
					errorHook?.({
						requestId,
						message: this.v3codeAccountService.planCreditExhaustedMessage(),
						fullError: null,
						hostedCreditExhausted: true,
						terminal: true, // same soft-stop as the pre-dispatch gate — retrying can't succeed without user action
					})
					return
				}

				const hosted = this.v3codeAccountService.getHostedInferenceOverride(wireModel)
				if (hosted) {
					dispatch(hosted)
					return
				}
				// Free / unsigned with a key: fail-open BYOK. Paid users without a live
				// hosted override get an honest plan message — never silent key spend.
				if (providerApiKey && !this.v3codeAccountService.state.isPaid) {
					dispatchByok()
					return
				}
				const acct = this.v3codeAccountService.state
				const message = acct.status !== 'signedIn'
					? `This model runs on your V3Code plan. Sign in from Settings > Account to use it, or pick one of your own provider models (BYOK) in Settings.`
					: acct.isPaid
						? `Couldn't verify your V3Code plan just now (connection or sign-in hiccup) — your plan is fine. Try again in a moment; if this keeps happening, sign in again from Settings > Account.`
						: `This is a V3Code hosted plan model. Upgrade to a paid plan from Settings > Account to use it, or pick one of your own provider models (BYOK) in Settings.`
				// Sign-in / upgrade asks are terminal — retrying without user action can't succeed.
				// The paid-but-unverified case is a transient and stays retryable.
				const terminal = !(acct.status === 'signedIn' && acct.isPaid)
				const errorHook = this.llmMessageHooks.onError[requestId]
				this._usageContextOfRequestId.delete(requestId)
				this._clearChannelHooks(requestId)
				errorHook?.({ requestId, message, fullError: null, terminal })
			})()
			return requestId
		}

		dispatch(hostedNow)
		return requestId
	}

	abort(requestId: string) {
		const abortHook = this.llmMessageHooks.onAbort[requestId];
		if (!abortHook) return; // already cleared / unknown id — avoid spamming the channel
		abortHook(); // calling the abort hook here is instant (doesn't go over a channel)
		this.channel.call('abort', { requestId } satisfies MainLLMMessageAbortParams);
		// Settle hosted bookkeeping: aborts fire neither onFinalMessage nor onError, so without
		// this the _hostedRequestIds/_hostedRetry entries leaked forever AND the plan meter never
		// refreshed after a cancelled hosted stream the hub already billed. (The usage context is
		// NOT cleared here — main still fires onUsage on abort for partially-streamed requests.)
		this._onHostedRequestSettled(requestId)
		this._hostedRetry.delete(requestId)
		this._clearChannelHooks(requestId)
	}


	ollamaList = (params: ServiceModelListParams<OllamaModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voidSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.ollama.success[requestId_] = onSuccess
		this.listHooks.ollama.error[requestId_] = onError

		this.channel.call('ollamaList', {
			...proxyParams,
			settingsOfProvider,
			providerName: 'ollama',
			requestId: requestId_,
		} satisfies MainModelListParams<OllamaModelResponse>)
	}


	openAICompatibleList = (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voidSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.openAICompat.success[requestId_] = onSuccess
		this.listHooks.openAICompat.error[requestId_] = onError

		this.channel.call('openAICompatibleList', {
			...proxyParams,
			settingsOfProvider,
			requestId: requestId_,
		} satisfies MainModelListParams<OpenaiCompatibleModelResponse>)
	}

	grokPlanStatus = async (): Promise<GrokPlanStatus> => {
		try {
			const status = await this.channel.call('grokPlanStatus') as GrokPlanStatus | undefined;
			return status ?? { signedIn: false };
		} catch {
			return { signedIn: false };
		}
	}

	claudePlanStatus = async (): Promise<ClaudePlanStatus> => {
		try {
			const status = await this.channel.call('claudePlanStatus') as ClaudePlanStatus | undefined;
			return status ?? { signedIn: false };
		} catch {
			return { signedIn: false };
		}
	}

	copilotStatus = async (): Promise<CopilotPlanStatus> => {
		try {
			const status = await this.channel.call('copilotStatus') as CopilotPlanStatus | undefined;
			return status ?? { signedIn: false };
		} catch {
			return { signedIn: false };
		}
	}

	geminiPlanStatus = async (): Promise<GeminiPlanStatus> => {
		try {
			const status = await this.channel.call('geminiPlanStatus') as GeminiPlanStatus | undefined;
			return status ?? { signedIn: false };
		} catch {
			return { signedIn: false };
		}
	}

	cursorLocalStatus = async (endpoint?: string): Promise<CursorLocalStatus> => {
		try {
			const status = await this.channel.call('cursorLocalStatus', { endpoint }) as CursorLocalStatus | undefined;
			return status ?? { signedIn: false };
		} catch {
			return { signedIn: false };
		}
	}

	openaiPlanStatus = async (): Promise<OpenaiPlanStatus> => {
		try {
			const status = await this.channel.call('openaiPlanStatus') as OpenaiPlanStatus | undefined;
			return status ?? { signedIn: false };
		} catch {
			return { signedIn: false };
		}
	}

	/** When a hosted request terminates, nudge a fast (debounced) meter refresh so the plan %
	 *  bars catch up to the spend the server just recorded — no waiting for the 10-min reconcile. */
	private _onHostedRequestSettled(requestId: string) {
		this._hostedRetry.delete(requestId);
		if (this._hostedRequestIds.delete(requestId)) {
			this.v3codeAccountService.refreshUsageSoon();
		}
	}

	private _clearChannelHooks(requestId: string) {
		delete this.llmMessageHooks.onText[requestId]
		delete this.llmMessageHooks.onFinalMessage[requestId]
		delete this.llmMessageHooks.onError[requestId]
		delete this.llmMessageHooks.onAbort[requestId]

		delete this.listHooks.ollama.success[requestId]
		delete this.listHooks.ollama.error[requestId]

		delete this.listHooks.openAICompat.success[requestId]
		delete this.listHooks.openAICompat.error[requestId]
	}
}

registerSingleton(ILLMMessageService, LLMMessageService, InstantiationType.Eager);

