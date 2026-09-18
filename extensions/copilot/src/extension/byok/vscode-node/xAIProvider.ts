/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

// https://docs.x.ai/docs/api-reference#list-language-models
interface XAIModelData {
	id: string;
	fingerprint: string;
	created: number;
	object: string;
	owned_by: string;
	input_modalities: string[];
	output_modalities: string[];
	prompt_text_token_price: number;
	cached_prompt_text_token_price: number;
	prompt_image_token_price: number;
	completion_text_token_price: number;
	search_price?: number;
	version: string;
	aliases: string[];
}

class XAIEndpoint extends OpenAIEndpoint {

	private get _promptCacheKey(): string {
		return `xai:${this.model.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-')}`;
	}

	override getExtraHeaders(): Record<string, string> {
		return {
			...super.getExtraHeaders(),
			// xAI recommends a stable conversation/cache id for best-effort sticky
			// routing and prompt-cache hits. BYOK does not currently thread the real
			// chat session id into this endpoint, so use a provider/model key that
			// still keeps repeated system/tool prefixes on the same cache route.
			'x-grok-conv-id': this._promptCacheKey,
		};
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const body = super.createRequestBody(options);
		body.prompt_cache_key ??= this._promptCacheKey;
		this.logService.info(`[xai-cache-request] prompt_cache_key=${body.prompt_cache_key} x-grok-conv-id=${this._promptCacheKey}`);
		return body;
	}
}

export class XAIBYOKLMProvider extends AbstractOpenAICompatibleLMProvider {

	public static readonly providerName = 'xAI';
	public static readonly providerId = this.providerName.toLowerCase();

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			XAIBYOKLMProvider.providerId,
			XAIBYOKLMProvider.providerName,
			knownModels,
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService
		);
	}

	protected getModelsBaseUrl(): string | undefined {
		return 'https://api.x.ai/v1';
	}

	protected override getModelsDiscoveryUrl(modelsBaseUrl: string): string {
		return `${modelsBaseUrl}/language-models`;
	}

	protected override async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model.id, model.url);
		return this._instantiationService.createInstance(XAIEndpoint, modelInfo, model.configuration?.apiKey ?? '', `${model.url}/chat/completions`);
	}

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		const xaiModelData = modelData as XAIModelData;
		// Add new model with reasonable defaults
		let maxInputTokens;
		let maxOutputTokens;

		// Coding models and Grok 4+ models have larger context windows
		const parsedVersion = this.parseXAIModelVersion(xaiModelData.id) ?? 0;
		if (xaiModelData.id.startsWith('grok-code') || parsedVersion >= 4) {
			maxInputTokens = 120000;
			maxOutputTokens = 120000;
		} else {
			maxInputTokens = 80000;
			maxOutputTokens = 30000;
		}

		return {
			name: this.humanizeXAIModelId(xaiModelData.id),
			toolCalling: true,
			vision: xaiModelData.input_modalities.includes('image'),
			maxInputTokens,
			maxOutputTokens,
		};
	}

	private parseXAIModelVersion(modelId: string): number | undefined {
		const match = modelId.match(/^grok-(\d+)/);
		return match ? parseInt(match[1], 10) : undefined;
	}

	private humanizeXAIModelId(modelId: string): string {
		const parts = modelId.split('-').filter(p => p.length > 0);
		return parts.map(p => {
			if (/^\d+$/.test(p)) {
				return p; // keep pure numbers as-is
			}
			return p.charAt(0).toUpperCase() + p.slice(1);
		}).join(' ');
	}
}
