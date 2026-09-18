/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { SendLLMMessageParams, OnText, OnFinalMessage, OnError, OnUsage, LLMUsage } from '../../common/sendLLMMessageTypes.js';
import { IMetricsService } from '../../common/metricsService.js';
import { displayInfoOfProviderName } from '../../common/voidSettingsTypes.js';
import { sendLLMMessageToProviderImplementation } from './sendLLMMessage.impl.js';


export const sendLLMMessage = async ({
	messagesType,
	messages: messages_,
	onText: onText_,
	onFinalMessage: onFinalMessage_,
	onError: onError_,
	onUsage: onUsage_,
	abortRef: abortRef_,
	logging: { loggingName, loggingExtras },
	settingsOfProvider,
	modelSelection,
	modelSelectionOptions,
	overridesOfModel,
	chatMode,
	coreToolsOnly,
	excludeTools,
	separateSystemMessage,
	mcpTools,
	hosted,
}: SendLLMMessageParams,

	metricsService: IMetricsService
) => {


	const { providerName, modelName } = modelSelection

	// only captures number of messages and message "shape", no actual code, instructions, prompts, etc
	const captureLLMEvent = (eventId: string, extras?: object) => {


		metricsService.capture(eventId, {
			providerName,
			modelName,
			customEndpointURL: settingsOfProvider[providerName]?.endpoint,
			numModelsAtEndpoint: settingsOfProvider[providerName]?.models?.length,
			...messagesType === 'chatMessages' ? {
				numMessages: messages_?.length,
			} : messagesType === 'FIMMessage' ? {
				prefixLength: messages_.prefix.length,
				suffixLength: messages_.suffix.length,
			} : {},
			...loggingExtras,
			...extras,
		})
	}
	const submit_time = new Date()

	let _fullTextSoFar = ''
	let _aborter: (() => void) | null = null
	let _setAborter = (fn: () => void) => { _aborter = fn }
	let _didAbort = false

	// --- usage metering ---------------------------------------------------------------
	// The transport is the ONE place every request passes through, so billed usage is
	// captured here for every feature, not just chat. Providers stream partial knowledge in
	// via onUsage (Anthropic message_start carries the full input-side bill before any output
	// streams; message_delta carries cumulative output tokens) — we keep the latest snapshot
	// and report it exactly once when the request terminates: final, error, OR abort. Without
	// this, a stream the user stopped (or that errored mid-way) was billed by the provider
	// but never counted by the meter.
	let _lastUsage: LLMUsage | undefined = undefined
	let _wireModelName: string | undefined = undefined
	let _usageReported = false
	const onUsageFromImpl: OnUsage = ({ usage, wireModelName }) => {
		_lastUsage = usage
		if (wireModelName) { _wireModelName = wireModelName }
	}
	const reportUsage = (finalUsage?: LLMUsage) => {
		if (_usageReported) return
		_usageReported = true
		// Always fire — even with no usage — so the browser side can release request state.
		onUsage_({ usage: finalUsage ?? _lastUsage, wireModelName: _wireModelName })
	}
	// ------------------------------------------------------------------------------------

	const onText: OnText = (params) => {
		const { fullText } = params
		if (_didAbort) return
		onText_(params)
		_fullTextSoFar = fullText
	}

	const onFinalMessage: OnFinalMessage = (params) => {
		const { fullText, fullReasoning, toolCall } = params
		if (_didAbort) return
		captureLLMEvent(`${loggingName} - Received Full Message`, { messageLength: fullText.length, reasoningLength: fullReasoning?.length, duration: new Date().getMilliseconds() - submit_time.getMilliseconds(), toolCallName: toolCall?.name })
		reportUsage(params.usage) // before the final message, so the meter is settled when the UI reads it
		onFinalMessage_(params)
	}

	const onError: OnError = (params) => {
		if (_didAbort) return
		let errorMessage = params.message
		console.error('sendLLMMessage onError:', errorMessage)

		// handle failed to fetch errors, which give 0 information by design
		if (errorMessage === 'TypeError: fetch failed')
			errorMessage = `Failed to fetch from ${displayInfoOfProviderName(providerName).title}. This likely means you specified the wrong endpoint in V3Code's Settings, or your local model provider like Ollama is powered off.`

		captureLLMEvent(`${loggingName} - Error`, { error: errorMessage })
		reportUsage() // errored streams were still billed for what ran — report last-known usage
		// Spread the WHOLE payload: the impls attach classification flags (`terminal`,
		// `hostedCreditExhausted`, `hostedAuthExpired`) that the renderer's retry/refresh
		// logic keys off — rebuilding the object here silently dropped all of them.
		onError_({ ...params, message: errorMessage })
	}

	// we should NEVER call onAbort internally, only from the outside
	const onAbort = () => {
		captureLLMEvent(`${loggingName} - Abort`, { messageLengthSoFar: _fullTextSoFar.length })
		_didAbort = true // set BEFORE aborting so a synchronous error from the aborter can't double-report
		try { _aborter?.() } // aborter sometimes automatically throws an error
		catch (e) { }
		reportUsage() // aborted streams were still billed for what ran — report last-known usage
	}
	abortRef_.current = onAbort


	if (messagesType === 'chatMessages')
		captureLLMEvent(`${loggingName} - Sending Message`, {})
	else if (messagesType === 'FIMMessage')
		captureLLMEvent(`${loggingName} - Sending FIM`, { prefixLen: messages_?.prefix?.length, suffixLen: messages_?.suffix?.length })


	try {
		const implementation = sendLLMMessageToProviderImplementation[providerName]
		if (!implementation) {
			onError({ message: `Error: Provider "${providerName}" not recognized.`, fullError: null })
			return
		}
		const { sendFIM, sendChat } = implementation
		if (messagesType === 'chatMessages') {
			await sendChat({ messages: messages_, onText, onFinalMessage, onError, onUsage: onUsageFromImpl, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, chatMode, coreToolsOnly, excludeTools, mcpTools, hosted })
			return
		}
		if (messagesType === 'FIMMessage') {
			if (sendFIM) {
				await sendFIM({ messages: messages_, onText, onFinalMessage, onError, onUsage: onUsageFromImpl, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage })
				return
			}
			onError({ message: `Error running Autocomplete with ${providerName} - ${modelName}.`, fullError: null })
			return
		}
		onError({ message: `Error: Message type "${messagesType}" not recognized.`, fullError: null })
		return
	}

	catch (error) {
		if (error instanceof Error) { onError({ message: error + '', fullError: error }) }
		else { onError({ message: `Unexpected Error in sendLLMMessage: ${error}`, fullError: error }); }
		// ; (_aborter as any)?.()
		// _didAbort = true
	}



}

