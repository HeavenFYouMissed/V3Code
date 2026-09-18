/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { renderMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { getBaseLayerHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegate2.js';
import { getDefaultHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction, toAction } from '../../../../../../base/common/actions.js';
import { IStringDictionary } from '../../../../../../base/common/collections.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import './media/chatModelPickerToggles.css';
import { ActionListItemKind, IActionListItem } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { TelemetryTrustedValue } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { IModelControlEntry, ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { ChatEntitlement, IChatEntitlementService, isProUser } from '../../../../../services/chat/common/chatEntitlementService.js';
import * as semver from '../../../../../../base/common/semver/semver.js';
import { IModelPickerDelegate } from './modelPickerActionItem.js';
import { IUriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { GitHubPaths, IDefaultAccountService } from '../../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IUpdateService, StateType } from '../../../../../../platform/update/common/update.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { clampRouterRung, V3_ROUTER_RUNG_LABELS, type V3RouterRung } from '../../../../../contrib/void/common/modelTiers.js';
import { IV3CodeAccountService } from '../../../../../contrib/void/common/v3codeAccountService.js';

function isVersionAtLeast(current: string, required: string): boolean {
	const currentSemver = semver.coerce(current);
	if (!currentSemver) {
		return false;
	}
	return semver.gte(currentSemver, required);
}

function getUpdateHoverContent(updateState: StateType): MarkdownString {
	const hoverContent = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
	switch (updateState) {
		case StateType.AvailableForDownload:
			hoverContent.appendMarkdown(localize('chat.modelPicker.downloadUpdateHover', "This model requires a newer version of VS Code. [Download Update](command:update.downloadUpdate) to access it."));
			break;
		case StateType.Downloaded:
		case StateType.Ready:
			hoverContent.appendMarkdown(localize('chat.modelPicker.restartUpdateHover', "This model requires a newer version of VS Code. [Restart to Update](command:update.restartToUpdate) to access it."));
			break;
		default:
			hoverContent.appendMarkdown(localize('chat.modelPicker.checkUpdateHover', "This model requires a newer version of VS Code. [Update VS Code](command:update.checkForUpdate) to access it."));
			break;
	}
	return hoverContent;
}

/**
 * Section identifiers for collapsible groups in the model picker.
 */
const ModelPickerSection = {
	Other: 'other',
} as const;

/**
 * Returns a human-readable display name for a model vendor.
 * Looks up the registered provider descriptor's displayName first,
 * then falls back to capitalizing the raw vendor id.
 */
function getVendorDisplayName(languageModelsService: ILanguageModelsService, vendor: string): string {
	const descriptor = languageModelsService.getVendors().find(v => v.vendor === vendor);
	if (descriptor?.displayName) {
		return descriptor.displayName;
	}
	return vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/**
 * Identifies a provider group bucket in the model picker. A bucket is
 * defined by `(vendor, groupName)` so that BYOK setups with multiple
 * user-configured groups under the same vendor (e.g. two `customoai`
 * entries named "Provider 1" and "Provider 2") are surfaced as
 * distinct sections — matching what the model configuration view shows.
 */
type ProviderGroupKey = string;

function getProviderGroupKey(vendor: string, groupName: string): ProviderGroupKey {
	return `${vendor}\u0000${groupName}`;
}

interface IProviderGroupInfo {
	readonly vendor: string;
	readonly groupName: string;
}

/**
 * Builds a `modelIdentifier -> { vendor, groupName }` lookup by walking
 * `getLanguageModelGroups()` for every registered vendor. Mirrors the
 * grouping used by `chatModelsViewModel.ts` so the picker and the model
 * configuration view stay aligned.
 */
function buildModelToProviderGroupMap(languageModelsService: ILanguageModelsService): Map<string, IProviderGroupInfo> {
	const map = new Map<string, IProviderGroupInfo>();
	for (const vendor of languageModelsService.getVendors()) {
		const groups = languageModelsService.getLanguageModelGroups(vendor.vendor);
		for (const group of groups) {
			// `group.group` is undefined for built-in vendors that have no
			// user configuration; fall back to the vendor display name so
			// the bucket key matches the single-section render path.
			const groupName = group.group?.name ?? vendor.displayName;
			for (const identifier of group.modelIdentifiers) {
				map.set(identifier, { vendor: vendor.vendor, groupName });
			}
		}
	}
	return map;
}

/**
 * Resolves the provider group for a model, falling back to the vendor
 * display name when no group entry is registered (e.g. legacy vendors or
 * tests that stub out `getLanguageModelGroups`).
 */
function getProviderGroupForModel(
	model: ILanguageModelChatMetadataAndIdentifier,
	modelToGroup: Map<string, IProviderGroupInfo>,
	languageModelsService: ILanguageModelsService,
): IProviderGroupInfo {
	const info = modelToGroup.get(model.identifier);
	if (info) {
		return info;
	}
	return {
		vendor: model.metadata.vendor,
		groupName: getVendorDisplayName(languageModelsService, model.metadata.vendor),
	};
}

type ChatModelChangeClassification = {
	owner: 'lramos15';
	comment: 'Reporting when the model picker is switched';
	fromModel?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The previous chat model' };
	toModel: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The new chat model' };
};

type ChatModelChangeEvent = {
	fromModel: string | TelemetryTrustedValue<string> | undefined;
	toModel: string | TelemetryTrustedValue<string>;
};

type ChatModelPickerInteraction = 'disabledModelContactAdminClicked' | 'premiumModelUpgradePlanClicked' | 'otherModelsExpanded' | 'otherModelsCollapsed';

type ChatModelPickerInteractionClassification = {
	owner: 'sandy081';
	comment: 'Reporting interactions in the chat model picker';
	interaction: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The model picker interaction that occurred' };
};

type ChatModelPickerInteractionEvent = {
	interaction: ChatModelPickerInteraction;
};

/**
 * Returns true if the model uses multiplier-based pricing (e.g. "2x").
 * The copilot extension always sets multiplierNumeric alongside multiplier pricing strings.
 */
function isMultiplierPricing(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	return model.metadata.multiplierNumeric !== undefined;
}

function createModelItem(
	action: IActionWidgetDropdownAction & { section?: string },
	model?: ILanguageModelChatMetadataAndIdentifier,
	openerService?: IOpenerService,
	vendorLabel?: string,
	isUBB?: boolean,
	ariaDescription?: string,
	pinAction?: IAction,
): IActionListItem<IActionWidgetDropdownAction> {
	const hover = model && openerService ? getModelHoverContent(model, openerService, isUBB) : undefined;
	return {
		item: action,
		kind: ActionListItemKind.Action,
		label: action.label,
		description: action.description,
		ariaDescription,
		group: { title: '', icon: action.icon ?? ThemeIcon.fromId(action.checked ? Codicon.check.id : Codicon.blank.id) },
		hideIcon: false,
		section: action.section,
		className: vendorLabel ? 'chat-model-picker-inline-source' : undefined,
		badge: vendorLabel,
		hover: hover ? { content: hover.element, disposable: hover.disposable } : undefined,
		tooltip: action.tooltip,
		toolbarActions: pinAction ? [pinAction] : undefined,
		submenuActions: action.toolbarActions?.length ? action.toolbarActions : undefined,
	};
}

/**
 * Creates a pin/unpin toolbar action for a model item in the picker.
 */
function createPinAction(
	modelIdentifier: string,
	isPinned: boolean,
	onTogglePin: (modelIdentifier: string, pinned: boolean) => void,
): IAction {
	return toAction({
		id: `pin.${modelIdentifier}`,
		label: isPinned
			? localize('chat.modelPicker.unpin', "Unpin Model")
			: localize('chat.modelPicker.pin', "Pin Model"),
		class: ThemeIcon.asClassName(isPinned ? Codicon.pinned : Codicon.pin),
		run: () => onTogglePin(modelIdentifier, !isPinned),
	});
}

/**
 * Resolves a configuration property from a model's configurationSchema by group.
 * Returns the key, current value (with default fallback), and schema metadata.
 */
function resolveConfigProperty(
	model: ILanguageModelChatMetadataAndIdentifier,
	group: string,
	languageModelsService: ILanguageModelsService,
): { key: string; value: unknown; schema: { enum?: unknown[]; enumItemLabels?: string[]; enumDescriptions?: string[]; default?: unknown } } | undefined {
	const schema = model.metadata.configurationSchema;
	if (!schema?.properties) {
		return undefined;
	}
	const currentConfig = languageModelsService.getModelConfiguration(model.identifier) ?? {};
	for (const [key, propSchema] of Object.entries(schema.properties)) {
		if (propSchema.group !== group) {
			continue;
		}
		if (!propSchema.enum || propSchema.enum.length < 2) {
			continue;
		}
		const value = currentConfig[key] ?? propSchema.default;
		return { key, value, schema: propSchema };
	}
	return undefined;
}

/**
 * Returns a screen-reader-friendly label for the price category.
 */
function getPriceCategoryLabel(priceCategory: string | undefined): string | undefined {
	switch (priceCategory) {
		case undefined:
		case '':
			return undefined;
		case 'low':
			return localize('chat.priceCategory.low', "Low cost");
		case 'medium':
			return localize('chat.priceCategory.medium', "Medium cost");
		case 'high':
			return localize('chat.priceCategory.high', "High cost");
		case 'very_high':
			return localize('chat.priceCategory.veryHigh', "Very high cost");
		default:
			return localize('chat.priceCategory.unknown', "{0} cost", priceCategory.charAt(0).toUpperCase() + priceCategory.slice(1));
	}
}

/**
 * Returns a short description summarizing the model's current configuration values
 * for properties marked with group 'navigation' (e.g., "High", "Medium").
 */
function getModelConfigurationDescription(model: ILanguageModelChatMetadataAndIdentifier, languageModelsService: ILanguageModelsService): string | undefined {
	const schema = model.metadata.configurationSchema;
	if (!schema?.properties) {
		return undefined;
	}

	const currentConfig = languageModelsService.getModelConfiguration(model.identifier) ?? {};
	const parts: string[] = [];

	for (const [key, propSchema] of Object.entries(schema.properties)) {
		if (propSchema.group !== 'navigation') {
			continue;
		}
		if (!propSchema.enum || propSchema.enum.length < 2) {
			continue;
		}
		const value = currentConfig[key] ?? propSchema.default;
		if (value === undefined) {
			continue;
		}
		const enumIndex = propSchema.enum?.indexOf(value) ?? -1;
		const label = propSchema.enumItemLabels?.[enumIndex] ?? String(value);
		parts.push(label);
	}

	return parts.length > 0 ? parts.join(', ') : undefined;
}

function createModelAction(
	model: ILanguageModelChatMetadataAndIdentifier,
	selectedModelId: string | undefined,
	onSelect: (model: ILanguageModelChatMetadataAndIdentifier) => void,
	languageModelsService: ILanguageModelsService,
	section?: string,
	suppressVendorInDetail?: boolean,
	isUBB?: boolean,
): { action: IActionWidgetDropdownAction & { section?: string }; ariaDescription?: string } {
	// Only show pricing in the description line if it's a multiplier (e.g. "2x").
	// Detailed AIC/token pricing is shown in the hover instead.
	const pricingForDescription = isMultiplierPricing(model) ? model.metadata.pricing : undefined;
	const priceCategoryLabel = isUBB ? getPriceCategoryLabel(model.metadata.priceCategory) : undefined;
	// In PRU mode, show the current configuration value (e.g. thinking effort "High") in the description
	const configDescription = !isUBB ? getModelConfigurationDescription(model, languageModelsService) : undefined;
	// Strip the detail when suppressVendorInDetail is set — the vendor is
	// shown either inline (promoted) or in a section header (Other Models).
	const detail = suppressVendorInDetail ? undefined : model.metadata.detail;
	const textParts = [configDescription, detail, pricingForDescription].filter(Boolean);
	const textDescription = textParts.length > 0 ? textParts.join(' · ') : undefined;

	// Richer hover so pointing at a model shows what it can do (name · context · reasoning/pricing).
	const ctxTokens = model.metadata.maxInputTokens;
	const ctxLabel = ctxTokens >= 1_000_000 ? `${(ctxTokens / 1_000_000).toFixed(ctxTokens % 1_000_000 === 0 ? 0 : 1)}M`
		: ctxTokens >= 1_000 ? `${Math.round(ctxTokens / 1_000)}k`
			: String(ctxTokens);
	const hoverTooltip = [
		model.metadata.name,
		ctxTokens ? localize('chat.modelPicker.ctxHover', "{0} context", ctxLabel) : undefined,
		textDescription,
	].filter(Boolean).join(' · ');

	// In PRU mode, restore per-model configuration toolbar actions (e.g. thinking effort gear)
	const toolbarActions = !isUBB ? languageModelsService.getModelConfigurationActions(model.identifier) : undefined;

	const action: IActionWidgetDropdownAction & { section?: string } = {
		id: model.identifier,
		enabled: true,
		icon: model.metadata.statusIcon,
		checked: model.identifier === selectedModelId,
		class: undefined,
		description: textDescription,
		tooltip: hoverTooltip,
		label: model.metadata.name,
		section,
		toolbarActions: toolbarActions && toolbarActions.length > 0 ? toolbarActions : undefined,
		run: () => onSelect(model),
	};
	const ariaDescription = priceCategoryLabel
		? (textDescription ? textDescription + ' · ' + priceCategoryLabel : priceCategoryLabel)
		: undefined;
	return { action, ariaDescription };
}

function shouldShowManageModelsAction(chatEntitlementService: IChatEntitlementService): boolean {
	return chatEntitlementService.clientByokEnabled ||
		chatEntitlementService.hasByokModels ||
		chatEntitlementService.entitlement === ChatEntitlement.Free ||
		chatEntitlementService.entitlement === ChatEntitlement.EDU ||
		chatEntitlementService.entitlement === ChatEntitlement.Pro ||
		chatEntitlementService.entitlement === ChatEntitlement.ProPlus ||
		chatEntitlementService.entitlement === ChatEntitlement.Max ||
		chatEntitlementService.entitlement === ChatEntitlement.Business ||
		chatEntitlementService.entitlement === ChatEntitlement.Enterprise ||
		chatEntitlementService.isInternal;
}

function createManageModelsAction(commandService: ICommandService): IActionWidgetDropdownAction {
	return {
		id: 'manageModels',
		enabled: true,
		checked: false,
		class: ThemeIcon.asClassName(Codicon.gear),
		tooltip: localize('chat.manageModels.tooltip', "Manage Language Models"),
		label: localize('chat.manageModels', "Manage Models..."),
		// V3Code: route the model-picker "Manage Models" gear to the V3Code settings pane
		// (providers / API keys / BYOK + model options) instead of the built-in Copilot
		// models editor (`MANAGE_CHAT_COMMAND_ID`). The command is registered by the void
		// contribution (voidSettingsPane.ts); referenced by string id to avoid a
		// chat → contrib/void layering import.
		run: () => { commandService.executeCommand('workbench.action.openVoidSettings'); }
	};
}

/**
 * Builds the grouped items for the model picker dropdown.
 *
 * Layout:
 * 1. Auto (always first)
 * 2. Promoted section (selected + recently used + featured models from control manifest)
 *    - Available models sorted alphabetically, followed by unavailable models
 *    - Unavailable models show upgrade/update/admin status
 *    - Promoted models show an inline source label (the provider group
 *      name) when more than one group is configured.
 * 3. Other Models (collapsible toggle) - models grouped by provider group
 *    (vendor + user-configured group name) with separator headers
 *    - Each provider group has a titled separator header. This matches
 *      the buckets shown in the model configuration view, so a BYOK setup
 *      with several groups under a single vendor (e.g. an "OpenAI
 *      Compatible" group and an "AWS Bedrock" group both registered to
 *      the `customoai` vendor) renders as distinct sections.
 * 4. Optional "Manage Models..." action shown in Other Models after a separator
 */
export function buildModelPickerItems(
	models: ILanguageModelChatMetadataAndIdentifier[],
	selectedModelId: string | undefined,
	recentModelIds: string[],
	pinnedModelIds: string[],
	controlModels: IStringDictionary<IModelControlEntry>,
	currentVSCodeVersion: string,
	updateStateType: StateType,
	onSelect: (model: ILanguageModelChatMetadataAndIdentifier) => void,
	onTogglePin: ((modelIdentifier: string, pinned: boolean) => void) | undefined,
	manageSettingsUrl: string | undefined,
	useGroupedModelPicker: boolean,
	manageModelsAction: IActionWidgetDropdownAction | undefined,
	chatEntitlementService: IChatEntitlementService,
	showUnavailableFeatured: boolean,
	showFeatured: boolean,
	languageModelsService?: ILanguageModelsService,
	openerService?: IOpenerService,
	isUBB?: boolean,
): IActionListItem<IActionWidgetDropdownAction>[] {
	const items: IActionListItem<IActionWidgetDropdownAction>[] = [];
	if (models.length === 0) {
		items.push(createModelItem({
			id: 'auto',
			enabled: true,
			checked: true,
			class: undefined,
			tooltip: localize('chat.modelPicker.auto', "Auto"),
			label: localize('chat.modelPicker.auto', "Auto"),
			run: () => { }
		}));
	}

	if (useGroupedModelPicker) {
		let otherModels: ILanguageModelChatMetadataAndIdentifier[] = [];
		// Build a lookup so each model can be assigned to its provider group
		// (vendor + user-configured group name). This must happen before both
		// the promoted-section badge logic and the Other Models grouping so
		// that both surfaces use the same notion of "distinct provider".
		const modelToGroup = languageModelsService
			? buildModelToProviderGroupMap(languageModelsService)
			: new Map<string, IProviderGroupInfo>();
		if (models.length) {
			// Collect all available models into lookup maps
			const allModelsMap = new Map<string, ILanguageModelChatMetadataAndIdentifier>();
			const modelsByMetadataId = new Map<string, ILanguageModelChatMetadataAndIdentifier>();
			for (const model of models) {
				allModelsMap.set(model.identifier, model);
				modelsByMetadataId.set(model.metadata.id, model);
			}

			const placed = new Set<string>();

			const markPlaced = (identifierOrId: string, metadataId?: string) => {
				placed.add(identifierOrId);
				if (metadataId) {
					placed.add(metadataId);
				}
			};

			const resolveModel = (id: string) => allModelsMap.get(id) ?? modelsByMetadataId.get(id);

			const getUnavailableReason = (entry: IModelControlEntry): 'upgrade' | 'update' | 'admin' => {
				const isBusinessOrEnterpriseUser = chatEntitlementService.entitlement === ChatEntitlement.Business || chatEntitlementService.entitlement === ChatEntitlement.Enterprise;
				if (!isBusinessOrEnterpriseUser) {
					return 'upgrade';
				}
				if (entry.minVSCodeVersion && !isVersionAtLeast(currentVSCodeVersion, entry.minVSCodeVersion)) {
					return 'update';
				}
				return 'admin';
			};

			// --- 1. Auto ---
			const autoModel = models.find(m => isAutoModel(m));
			if (autoModel) {
				markPlaced(autoModel.identifier, autoModel.metadata.id);
				const { action: autoAction, ariaDescription: autoAriaDesc } = createModelAction(autoModel, selectedModelId, onSelect, languageModelsService!, undefined, undefined, isUBB);
				items.push(createModelItem(autoAction, autoModel, openerService, undefined, isUBB, autoAriaDesc));
			}

			// Precompute group labels needed for inline badges
			const allGroupKeys = new Set(
				models.map(m => {
					const info = getProviderGroupForModel(m, modelToGroup, languageModelsService!);
					return getProviderGroupKey(info.vendor, info.groupName);
				})
			);
			const showGroupLabel = allGroupKeys.size > 1;

			// Helper to create a pin/unpin toolbar action for a model
			const makePinAction = (model: ILanguageModelChatMetadataAndIdentifier) =>
				onTogglePin ? createPinAction(model.identifier, pinnedModelIds.includes(model.identifier), onTogglePin) : undefined;

			// --- 2. Pinned models ---
			const pinnedSet = new Set(pinnedModelIds);
			const pinnedModels: ILanguageModelChatMetadataAndIdentifier[] = [];
			for (const id of pinnedModelIds) {
				if (placed.has(id)) {
					continue;
				}
				const model = resolveModel(id);
				if (model && !placed.has(model.identifier)) {
					markPlaced(model.identifier, model.metadata.id);
					pinnedModels.push(model);
				}
			}
			if (pinnedModels.length > 0) {
				items.push({ kind: ActionListItemKind.Separator, label: localize('chat.modelPicker.pinned', "Pinned") });
				for (const model of pinnedModels) {
					const groupLabel = showGroupLabel
						? getProviderGroupForModel(model, modelToGroup, languageModelsService!).groupName
						: undefined;
					const { action: pinnedAction, ariaDescription: pinnedAriaDesc } = createModelAction(model, selectedModelId, onSelect, languageModelsService!, undefined, showGroupLabel, isUBB);
					items.push(createModelItem(pinnedAction, model, openerService, groupLabel, isUBB, pinnedAriaDesc, makePinAction(model)));
				}
			}

			// --- 3. Promoted section (selected + recently used + featured) ---
			// MRU excludes pinned models and is limited to 3 entries
			const filteredRecentIds = recentModelIds.filter(id => !pinnedSet.has(id)).slice(0, 3);

			type PromotedItem =
				| { kind: 'available'; model: ILanguageModelChatMetadataAndIdentifier }
				| { kind: 'unavailable'; id: string; entry: IModelControlEntry; reason: 'upgrade' | 'update' | 'admin' };

			const promotedItems: PromotedItem[] = [];

			// Try to place a model by id. Returns true if handled.
			const tryPlaceModel = (id: string): boolean => {
				if (placed.has(id)) {
					return false;
				}
				const model = resolveModel(id);
				if (model && !placed.has(model.identifier)) {
					markPlaced(model.identifier, model.metadata.id);
					const entry = controlModels[model.metadata.id];
					if (entry?.minVSCodeVersion && !isVersionAtLeast(currentVSCodeVersion, entry.minVSCodeVersion)) {
						promotedItems.push({ kind: 'unavailable', id: model.metadata.id, entry, reason: 'update' });
					} else {
						promotedItems.push({ kind: 'available', model });
					}
					return true;
				}
				if (!model) {
					const entry = controlModels[id];
					if (entry && !entry.exists) {
						markPlaced(id);
						promotedItems.push({ kind: 'unavailable', id, entry, reason: getUnavailableReason(entry) });
						return true;
					}
				}
				return false;
			};

			// Selected model
			if (selectedModelId && selectedModelId !== autoModel?.identifier) {
				tryPlaceModel(selectedModelId);
			}

			// Recently used models (filtered to exclude pinned, limited to 3)
			for (const id of filteredRecentIds) {
				tryPlaceModel(id);
			}

			// Featured models from control manifest
			if (showFeatured) {
				for (const [entryId, entry] of Object.entries(controlModels)) {
					if (!entry.featured || placed.has(entryId)) {
						continue;
					}
					const model = resolveModel(entryId);
					if (model && !placed.has(model.identifier)) {
						if (entry.minVSCodeVersion && !isVersionAtLeast(currentVSCodeVersion, entry.minVSCodeVersion)) {
							if (showUnavailableFeatured) {
								markPlaced(model.identifier, model.metadata.id);
								promotedItems.push({ kind: 'unavailable', id: entryId, entry, reason: 'update' });
							}
						} else {
							markPlaced(model.identifier, model.metadata.id);
							promotedItems.push({ kind: 'available', model });
						}
					} else if (!model && !entry.exists) {
						if (showUnavailableFeatured) {
							markPlaced(entryId);
							promotedItems.push({ kind: 'unavailable', id: entryId, entry, reason: getUnavailableReason(entry) });
						}
					}
				}
			}

			// Render promoted section: available first, then sorted alphabetically by name.
			// Promoted models show their provider group name inline only when more
			// than one provider group is configured across all models.
			if (promotedItems.length > 0) {
				if (items.length > 0) {
					items.push({ kind: ActionListItemKind.Separator });
				}
				promotedItems.sort((a, b) => {
					const aAvail = a.kind === 'available' ? 0 : 1;
					const bAvail = b.kind === 'available' ? 0 : 1;
					if (aAvail !== bAvail) {
						return aAvail - bAvail;
					}
					const aName = a.kind === 'available' ? a.model.metadata.name : a.entry.label;
					const bName = b.kind === 'available' ? b.model.metadata.name : b.entry.label;
					return aName.localeCompare(bName);
				});

				for (const item of promotedItems) {
					if (item.kind === 'available') {
						const groupLabel = showGroupLabel
							? getProviderGroupForModel(item.model, modelToGroup, languageModelsService!).groupName
							: undefined;
						const { action: promotedAction, ariaDescription: promotedAriaDesc } = createModelAction(item.model, selectedModelId, onSelect, languageModelsService!, undefined, showGroupLabel, isUBB);
						items.push(createModelItem(promotedAction, item.model, openerService, groupLabel, isUBB, promotedAriaDesc, makePinAction(item.model)));
					} else {
						items.push(createUnavailableModelItem(item.id, item.entry, item.reason, manageSettingsUrl, updateStateType, chatEntitlementService));
					}
				}
			}

			// --- 3. Other Models (collapsible, grouped by provider group) ---
			otherModels = models.filter(m => !placed.has(m.identifier) && !placed.has(m.metadata.id));

			if (otherModels.length > 0) {
				if (items.length > 0) {
					items.push({ kind: ActionListItemKind.Separator });
				}
				const otherModelsToolbar = manageModelsAction
					? [toAction({ id: manageModelsAction.id, label: manageModelsAction.tooltip ?? manageModelsAction.label, class: ThemeIcon.asClassName(Codicon.gear), run: () => manageModelsAction.run() })]
					: undefined;
				items.push({
					item: {
						id: 'otherModels',
						enabled: true,
						checked: false,
						class: undefined,
						tooltip: localize('chat.modelPicker.otherModels', "Other Models"),
						label: localize('chat.modelPicker.otherModels', "Other Models"),
						run: () => { /* toggle handled by isSectionToggle */ }
					},
					kind: ActionListItemKind.Action,
					label: localize('chat.modelPicker.otherModels', "Other Models"),
					group: { title: '', icon: Codicon.chevronDown },
					hideIcon: false,
					section: ModelPickerSection.Other,
					isSectionToggle: true,
					toolbarActions: otherModelsToolbar,
					className: 'chat-model-picker-section-toggle',
				});

				// Group remaining models by provider group (vendor + user-configured
				// group name). This matches `chatModelsViewModel.getProviderGroupId`,
				// so that BYOK setups with several groups under a single vendor
				// (e.g. multiple `customoai` entries) render as distinct sections.
				interface IProviderGroupBucket {
					vendor: string;
					groupName: string;
					models: ILanguageModelChatMetadataAndIdentifier[];
				}
				const providerGroups = new Map<ProviderGroupKey, IProviderGroupBucket>();
				for (const model of otherModels) {
					const info = getProviderGroupForModel(model, modelToGroup, languageModelsService!);
					const key = getProviderGroupKey(info.vendor, info.groupName);
					let bucket = providerGroups.get(key);
					if (!bucket) {
						bucket = { vendor: info.vendor, groupName: info.groupName, models: [] };
						providerGroups.set(key, bucket);
					}
					bucket.models.push(model);
				}

				// Sort buckets: copilot vendor first, then alphabetically by group name
				const sortedBuckets = [...providerGroups.values()].sort((a, b) => {
					if (a.vendor === 'copilot' && b.vendor !== 'copilot') { return -1; }
					if (b.vendor === 'copilot' && a.vendor !== 'copilot') { return 1; }
					return a.groupName.localeCompare(b.groupName);
				});

				const showGroupHeaders = sortedBuckets.length > 1;

				for (const bucket of sortedBuckets) {
					if (showGroupHeaders) {
						items.push({
							kind: ActionListItemKind.Separator,
							label: bucket.groupName,
							section: ModelPickerSection.Other,
						});
					}

					// Models within a bucket sorted: available first, then alphabetically by name
					const sortedBucketModels = [...bucket.models].sort((a, b) => {
						const aEntry = controlModels[a.metadata.id] ?? controlModels[a.identifier];
						const bEntry = controlModels[b.metadata.id] ?? controlModels[b.identifier];
						const aAvail = aEntry?.minVSCodeVersion && !isVersionAtLeast(currentVSCodeVersion, aEntry.minVSCodeVersion) ? 1 : 0;
						const bAvail = bEntry?.minVSCodeVersion && !isVersionAtLeast(currentVSCodeVersion, bEntry.minVSCodeVersion) ? 1 : 0;
						if (aAvail !== bAvail) { return aAvail - bAvail; }
						return a.metadata.name.localeCompare(b.metadata.name);
					});

					for (const model of sortedBucketModels) {
						const entry = controlModels[model.metadata.id] ?? controlModels[model.identifier];
						if (entry?.minVSCodeVersion && !isVersionAtLeast(currentVSCodeVersion, entry.minVSCodeVersion)) {
							items.push(createUnavailableModelItem(model.metadata.id, entry, 'update', manageSettingsUrl, updateStateType, chatEntitlementService, ModelPickerSection.Other));
						} else {
							const { action: bucketAction, ariaDescription: bucketAriaDesc } = createModelAction(model, selectedModelId, onSelect, languageModelsService!, ModelPickerSection.Other, showGroupHeaders, isUBB);
							items.push(createModelItem(bucketAction, model, openerService, undefined, isUBB, bucketAriaDesc, makePinAction(model)));
						}
					}
				}
			}
		}

		if (manageModelsAction && !otherModels.length) {
			// No Other Models section: show manage models as standalone
			items.push({ kind: ActionListItemKind.Separator });
			items.push({
				item: manageModelsAction,
				kind: ActionListItemKind.Action,
				label: manageModelsAction.label,
				group: { title: '', icon: Codicon.blank },
				hideIcon: false,
				showAlways: true,
			});
		}
	} else {
		// Flat list: auto first, then all models sorted alphabetically
		const autoModel = models.find(m => isAutoModel(m));
		if (autoModel) {
			const { action: flatAutoAction, ariaDescription: flatAutoAriaDesc } = createModelAction(autoModel, selectedModelId, onSelect, languageModelsService!, undefined, undefined, isUBB);
			items.push(createModelItem(flatAutoAction, autoModel, openerService, undefined, isUBB, flatAutoAriaDesc));
		}
		const sortedModels = models
			.filter(m => m !== autoModel)
			.sort((a, b) => {
				const vendorCmp = a.metadata.vendor.localeCompare(b.metadata.vendor);
				return vendorCmp !== 0 ? vendorCmp : a.metadata.name.localeCompare(b.metadata.name);
			});
		for (const model of sortedModels) {
			const { action: flatAction, ariaDescription: flatAriaDesc } = createModelAction(model, selectedModelId, onSelect, languageModelsService!, undefined, undefined, isUBB);
			items.push(createModelItem(flatAction, model, openerService, undefined, isUBB, flatAriaDesc));
		}
	}

	return items;
}

export function getModelPickerAccessibilityProvider() {
	return {
		getAriaLabel(element: IActionListItem<IActionWidgetDropdownAction>) {
			if (element.kind !== ActionListItemKind.Action) {
				return null;
			}
			const description = element.ariaDescription ?? (typeof element.description === 'string' ? element.description : element.description?.value);
			return [element.label, element.badge, description].filter((part): part is string => !!part).join(', ');
		},
		isChecked(element: IActionListItem<IActionWidgetDropdownAction>) {
			if (element.isSectionToggle) {
				return undefined;
			}
			return element.kind === ActionListItemKind.Action ? !!element?.item?.checked : undefined;
		},
		getRole: (element: IActionListItem<IActionWidgetDropdownAction>) => {
			if (element.isSectionToggle) {
				return 'menuitem';
			}
			switch (element.kind) {
				case ActionListItemKind.Action: return 'menuitemradio';
				case ActionListItemKind.Separator: return 'separator';
				default: return 'separator';
			}
		},
		getWidgetRole: () => 'menu',
	} as const;
}

function createUnavailableModelItem(
	id: string,
	entry: IModelControlEntry,
	reason: 'upgrade' | 'update' | 'admin',
	manageSettingsUrl: string | undefined,
	updateStateType: StateType,
	chatEntitlementService: IChatEntitlementService,
	section?: string,
): IActionListItem<IActionWidgetDropdownAction> {
	let description: string | MarkdownString | undefined;

	if (reason === 'upgrade') {
		description = new MarkdownString(localize('chat.modelPicker.upgradeLink', "[Upgrade](command:workbench.action.chat.upgradePlan \" \")"), { isTrusted: true });
	} else if (reason === 'update') {
		description = localize('chat.modelPicker.updateDescription', "Update VS Code");
	} else {
		description = manageSettingsUrl
			? new MarkdownString(localize('chat.modelPicker.adminLink', "[Contact your admin]({0})", manageSettingsUrl), { isTrusted: true })
			: localize('chat.modelPicker.adminDescription', "Contact your admin");
	}

	let hoverContent: MarkdownString;
	if (reason === 'upgrade') {
		hoverContent = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (chatEntitlementService.entitlement === ChatEntitlement.Pro) {
			hoverContent.appendMarkdown(localize('chat.modelPicker.upgradeHoverProPlus', "[Upgrade to GitHub Copilot Pro+](command:workbench.action.chat.upgradePlan \" \") to use the best models."));
		} else {
			hoverContent.appendMarkdown(localize('chat.modelPicker.upgradeHover', "[Upgrade to GitHub Copilot Pro](command:workbench.action.chat.upgradePlan \" \") to use the best models."));
		}
	} else if (reason === 'update') {
		hoverContent = getUpdateHoverContent(updateStateType);
	} else {
		hoverContent = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		hoverContent.appendMarkdown(localize('chat.modelPicker.adminHover', "This model is not available. Contact your administrator to enable it."));
	}

	return {
		item: {
			id,
			enabled: false,
			checked: false,
			class: undefined,
			tooltip: entry.label,
			label: entry.label,
			description: typeof description === 'string' ? description : undefined,
			run: () => { }
		},
		kind: ActionListItemKind.Action,
		label: entry.label,
		description,
		group: { title: '', icon: ThemeIcon.fromId(Codicon.blank.id) },
		disabled: true,
		hideIcon: false,
		className: 'chat-model-picker-unavailable',
		section,
		hover: { content: hoverContent },
	};
}

type ModelPickerBadge = 'info' | 'warning';

/**
 * A model selection dropdown widget.
 *
 * Renders a button showing the currently selected model name.
 * On click, opens a grouped picker popup with:
 * Auto → Promoted (recently used + curated) → Other Models (collapsed with search).
 *
 * The widget owns its state - set models, selection, and curated IDs via setters.
 * Listen for selection changes via `onDidChangeSelection`.
 */
export class ModelPickerWidget extends Disposable {

	private readonly _onDidChangeSelection = this._register(new Emitter<ILanguageModelChatMetadataAndIdentifier>());
	readonly onDidChangeSelection: Event<ILanguageModelChatMetadataAndIdentifier> = this._onDidChangeSelection.event;

	private _selectedModel: ILanguageModelChatMetadataAndIdentifier | undefined;
	private _badge: ModelPickerBadge | undefined;
	private _compact: IObservable<boolean> | undefined;

	// V3Code: model controls pinned to the TOP of the model picker.
	// `Thinking` is WIRED: it reads/writes `v3code.agent.thinking`.
	// `Auto` + tier slider are WIRED: `v3code.agent.autoRouter` + `v3code.agent.routerRung`.
	private static readonly THINKING_SETTING_KEY = 'v3code.agent.thinking';
	private static readonly AUTO_ROUTER_SETTING_KEY = 'v3code.agent.autoRouter';
	private static readonly ROUTER_RUNG_SETTING_KEY = 'v3code.agent.routerRung';
	private static readonly DESIGN_MODE_SETTING_KEY = 'v3code.agent.designMode';
	private static readonly SECURITY_MODE_SETTING_KEY = 'v3code.agent.securityMode';
	/** Height of the V3Code control strip (Auto + budget ceiling + Design + Cyber Protection). */
	private static readonly PICKER_TOGGLE_STRIP_HEIGHT = 150;
	private _autoMode = false;
	private _routerRung: V3RouterRung = 0;
	private _designModeOn = false;
	private _securityModeOn = false;
	/** Optimistic UI — config read is async; keep local state so the switch doesn't snap off. */
	private _thinkingToggleOn = false;
	private get _thinkingEnabled(): boolean {
		return this._thinkingToggleOn;
	}
	private _syncThinkingToggleFromConfig(): void {
		const pref = this._configurationService.getValue<'default' | 'on' | 'off'>(ModelPickerWidget.THINKING_SETTING_KEY);
		// 'off' is the only state that disables reasoning; 'on' and legacy 'default' both mean on.
		this._thinkingToggleOn = pref !== 'off';
	}
	private _syncAutoRouterFromConfig(): void {
		this._autoMode = !!this._configurationService.getValue<boolean>(ModelPickerWidget.AUTO_ROUTER_SETTING_KEY);
		this._routerRung = clampRouterRung(Number(this._configurationService.getValue<number>(ModelPickerWidget.ROUTER_RUNG_SETTING_KEY) ?? 0));
		if (this._autoMode && this._routerRung === 0) {
			this._routerRung = 2;
		}
	}
	private _syncDesignModeFromConfig(): void {
		this._designModeOn = !!this._configurationService.getValue<boolean>(ModelPickerWidget.DESIGN_MODE_SETTING_KEY);
	}
	private _setDesignMode(on: boolean): void {
		this._designModeOn = on;
		void this._configurationService.updateValue(ModelPickerWidget.DESIGN_MODE_SETTING_KEY, on, ConfigurationTarget.USER);
		this._renderLabel();
	}
	private _syncSecurityModeFromConfig(): void {
		this._securityModeOn = !!this._configurationService.getValue<boolean>(ModelPickerWidget.SECURITY_MODE_SETTING_KEY);
	}
	private _setSecurityMode(on: boolean): void {
		this._securityModeOn = on;
		void this._configurationService.updateValue(ModelPickerWidget.SECURITY_MODE_SETTING_KEY, on, ConfigurationTarget.USER);
		this._renderLabel();
	}
	private _setAutoRouter(on: boolean): void {
		this._autoMode = on;
		void this._configurationService.updateValue(ModelPickerWidget.AUTO_ROUTER_SETTING_KEY, on, ConfigurationTarget.USER);
		if (on) {
			this._setRouterRung(2, { fromAutoToggle: true });
			this._notificationService.info(localize(
				'v3code.autoRouter.budgetHint',
				'Auto is set to Value. It will choose the cheapest capable model inside your current plan or API key.',
			));
		} else {
			this._setRouterRung(0, { fromAutoToggle: true });
		}
		this._renderLabel();
	}
	private _setRouterRung(rung: V3RouterRung, opts?: { fromAutoToggle?: boolean }): void {
		this._routerRung = rung;
		void this._configurationService.updateValue(ModelPickerWidget.ROUTER_RUNG_SETTING_KEY, rung, ConfigurationTarget.USER);
		const autoOn = rung > 0;
		if (this._autoMode !== autoOn) {
			this._autoMode = autoOn;
			void this._configurationService.updateValue(ModelPickerWidget.AUTO_ROUTER_SETTING_KEY, autoOn, ConfigurationTarget.USER);
			if (autoOn && !opts?.fromAutoToggle) {
				this._notificationService.info(localize(
					'v3code.autoRouter.budgetChanged',
					'Auto budget set to {0}. Routing stays inside your current plan or API key.',
					V3_ROUTER_RUNG_LABELS[rung],
				));
			}
		}
		this._renderLabel();
	}
	private _modelSupportsThinking(): boolean {
		const props = this._selectedModel?.metadata.configurationSchema?.properties;
		return !!props && props['v3codeReasoning'] !== undefined;
	}
	private _setThinkingEnabled(on: boolean): void {
		this._thinkingToggleOn = on;
		void this._configurationService.updateValue(
			ModelPickerWidget.THINKING_SETTING_KEY,
			on ? 'on' : 'off',
			ConfigurationTarget.USER,
		);
	}

	private _domNode: HTMLElement | undefined;
	private _badgeIcon: HTMLElement | undefined;
	private _nameButton: HTMLElement | undefined;
	private _effortButton: HTMLElement | undefined;
	private _tokensButton: HTMLElement | undefined;

	get selectedModel(): ILanguageModelChatMetadataAndIdentifier | undefined {
		return this._selectedModel;
	}

	get domNode(): HTMLElement | undefined {
		return this._domNode;
	}

	get nameButton(): HTMLElement | undefined {
		return this._nameButton;
	}

	constructor(
		private readonly _delegate: IModelPickerDelegate,
		@IActionWidgetService private readonly _actionWidgetService: IActionWidgetService,
		@ICommandService private readonly _commandService: ICommandService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IProductService private readonly _productService: IProductService,
		@IChatEntitlementService private readonly _entitlementService: IChatEntitlementService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IV3CodeAccountService private readonly _v3codeAccountService: IV3CodeAccountService,
	) {
		super();

		this._register(this._languageModelsService.onDidChangeLanguageModels(() => {
			if (this._selectedModel) {
				const metadata = this._languageModelsService.lookupLanguageModel(this._selectedModel.identifier);
				if (metadata) { this._selectedModel = { identifier: this._selectedModel.identifier, metadata }; }
			}
			this._renderLabel();
		}));

		// Re-render when the hub session/entitlement changes so the available model pool stays current.
		this._register(this._v3codeAccountService.onDidChangeState(() => {
			this._renderLabel();
		}));

		this._register(this._entitlementService.onDidChangeUsageBasedBilling(() => {
			this._renderLabel();
		}));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ModelPickerWidget.AUTO_ROUTER_SETTING_KEY)
				|| e.affectsConfiguration(ModelPickerWidget.ROUTER_RUNG_SETTING_KEY)) {
				this._syncAutoRouterFromConfig();
				this._renderLabel();
			}
			if (e.affectsConfiguration(ModelPickerWidget.DESIGN_MODE_SETTING_KEY)) {
				this._syncDesignModeFromConfig();
				this._renderLabel();
			}
			if (e.affectsConfiguration(ModelPickerWidget.SECURITY_MODE_SETTING_KEY)) {
				this._syncSecurityModeFromConfig();
				this._renderLabel();
			}
		}));

		this._syncAutoRouterFromConfig();
		this._syncDesignModeFromConfig();
		this._syncSecurityModeFromConfig();
	}

	setCompact(compact: IObservable<boolean>): void {
		this._compact = compact;
		this._register(autorun(reader => {
			const isCompact = compact.read(reader);
			if (this._domNode) {
				this._domNode.classList.toggle('compact', isCompact);
			}
			this._renderLabel();
		}));
	}

	setSelectedModel(model: ILanguageModelChatMetadataAndIdentifier | undefined): void {
		this._selectedModel = model;
		this._renderLabel();
	}

	setEnabled(enabled: boolean): void {
		if (this._domNode) {
			this._domNode.classList.toggle('disabled', !enabled);
			this._domNode.setAttribute('aria-disabled', String(!enabled));
		}
	}

	setBadge(badge: ModelPickerBadge | undefined): void {
		this._badge = badge;
		this._updateBadge();
	}

	render(container: HTMLElement): void {
		this._domNode = dom.append(container, dom.$('div.action-label.model-picker-split'));
		this._domNode.setAttribute('role', 'group');

		// Apply initial collapsed state now that _domNode exists
		if (this._compact?.get()) {
			this._domNode.classList.toggle('compact', true);
		}

		// Model name button
		this._nameButton = dom.append(this._domNode, dom.$('a.model-picker-section.model-picker-name'));
		this._nameButton.tabIndex = 0;
		this._nameButton.setAttribute('role', 'button');
		this._nameButton.setAttribute('aria-haspopup', 'true');
		this._nameButton.setAttribute('aria-expanded', 'false');

		// Thinking effort button (conditionally visible)
		this._effortButton = dom.append(this._domNode, dom.$('a.model-picker-section.model-picker-effort'));
		this._effortButton.tabIndex = 0;
		this._effortButton.setAttribute('role', 'button');
		this._effortButton.setAttribute('aria-haspopup', 'true');
		this._effortButton.setAttribute('aria-expanded', 'false');
		this._effortButton.style.display = 'none';

		// Context size button (conditionally visible)
		this._tokensButton = dom.append(this._domNode, dom.$('a.model-picker-section.model-picker-tokens'));
		this._tokensButton.tabIndex = 0;
		this._tokensButton.setAttribute('role', 'button');
		this._tokensButton.setAttribute('aria-haspopup', 'true');
		this._tokensButton.setAttribute('aria-expanded', 'false');
		this._tokensButton.style.display = 'none';

		this._badgeIcon = dom.$('span.model-picker-badge');
		this._updateBadge();

		this._renderLabel();

		this._registerButtonAction(this._nameButton, () => this.show());
		this._registerButtonAction(this._effortButton, () => this._showEffortPicker());
		this._registerButtonAction(this._tokensButton, () => this._showTokensPicker());

		// Managed hovers for effort and tokens buttons
		this._register(getBaseLayerHoverDelegate().setupManagedHover(
			getDefaultHoverDelegate('mouse'),
			this._effortButton,
			localize('chat.modelPicker.effortTooltip', "Set Thinking Effort")
		));
		this._register(getBaseLayerHoverDelegate().setupManagedHover(
			getDefaultHoverDelegate('mouse'),
			this._tokensButton,
			localize('chat.modelPicker.tokensTooltip', "Set Context Size")
		));
	}

	/**
	 * Registers mouse-down and Enter/Space key handlers on a button element.
	 */
	private _registerButtonAction(element: HTMLElement, action: () => void): void {
		this._register(dom.addDisposableGenericMouseDownListener(element, e => {
			if (e.button !== 0) {
				return;
			}
			dom.EventHelper.stop(e, true);
			action();
		}));
		this._register(dom.addDisposableListener(element, dom.EventType.KEY_DOWN, (e) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				action();
			}
		}));
	}

	show(anchor?: HTMLElement): void {
		const anchorElement = anchor ?? this._domNode;
		if (!anchorElement || this._domNode?.classList.contains('disabled')) {
			return;
		}

		this._syncThinkingToggleFromConfig();
		this._syncAutoRouterFromConfig();
		this._syncDesignModeFromConfig();
		this._syncSecurityModeFromConfig();

		const previousModel = this._selectedModel;

		const onSelect = (model: ILanguageModelChatMetadataAndIdentifier) => {
			this._telemetryService.publicLog2<ChatModelChangeEvent, ChatModelChangeClassification>('chat.modelChange', {
				fromModel: previousModel?.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(previousModel.identifier) : 'unknown',
				toModel: model.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(model.identifier) : 'unknown'
			});
			// Picking a concrete model means "use THIS model", not the auto-router. Turn Auto
			// off (rung -> 0) so the selection actually sticks instead of snapping back to Auto
			// on the next render/turn.
			if (this._autoMode) {
				this._setAutoRouter(false);
			}
			this._selectedModel = model;
			this._renderLabel();
			this._onDidChangeSelection.fire(model);
		};

		const models = this._delegate.getModels();
		const isPro = isProUser(this._entitlementService.entitlement);
		const isUBB = !!this._entitlementService.quotas.usageBasedBilling;
		const manifest = this._languageModelsService.getModelsControlManifest();
		const controlModelsForTier = isPro ? manifest.paid : manifest.free;
		const canShowManageModelsAction = this._delegate.showManageModelsAction() && shouldShowManageModelsAction(this._entitlementService);
		const manageModelsAction = canShowManageModelsAction ? createManageModelsAction(this._commandService) : undefined;
		const logModelPickerInteraction = (interaction: ChatModelPickerInteraction) => {
			this._telemetryService.publicLog2<ChatModelPickerInteractionEvent, ChatModelPickerInteractionClassification>('chat.modelPickerInteraction', { interaction });
		};
		const manageSettingsUrl = this._defaultAccountService.resolveGitHubUrl(GitHubPaths.copilotSettings);
		const onTogglePin = (modelIdentifier: string, pinned: boolean) => {
			if (pinned) {
				this._languageModelsService.pinModel(modelIdentifier);
			} else {
				this._languageModelsService.unpinModel(modelIdentifier);
			}
			// Re-show the picker to reflect the updated pin state
			this._actionWidgetService.hide();
			this.show(anchorElement);
		};

		const items = buildModelPickerItems(
			models,
			this._selectedModel?.identifier,
			this._languageModelsService.getRecentlyUsedModelIds().filter(id => !this._languageModelsService.isModelHidden(id)),
			this._languageModelsService.getPinnedModelIds().filter(id => !this._languageModelsService.isModelHidden(id)),
			controlModelsForTier,
			this._productService.version,
			this._updateService.state.type,
			onSelect,
			onTogglePin,
			manageSettingsUrl,
			this._delegate.useGroupedModelPicker(),
			isUBB ? manageModelsAction : undefined,
			this._entitlementService,
			this._delegate.showUnavailableFeatured(),
			this._delegate.showFeatured(),
			this._languageModelsService,
			this._openerService,
			isUBB,
		);

		// Collect all hover disposables so they are properly cleaned up when the
		// picker is hidden. The ActionListWidget only tracks the disposable for the
		// currently-shown hover; all other items' hover disposables would leak.
		const hoverDisposables = new DisposableStore();
		for (const item of items) {
			if (item.hover?.disposable) {
				hoverDisposables.add(item.hover.disposable);
			}
		}

		const listOptions = {
			// Always show the filter to allow for the secondary heading to show
			showFilter: true,
			filterPlaceholder: localize('chat.modelPicker.search', "Search models"),
			filterActions: !isUBB && manageModelsAction ? [manageModelsAction] : undefined,
			focusFilterOnOpen: true,
			collapsedByDefault: new Set([ModelPickerSection.Other]),
			// V3Code: the toggle strip mounts under the filter AFTER open; reserve its
			// height so the popup opens ABOVE the bottom-anchored composer and scrolls.
			filterChromeHeight: 36 + ModelPickerWidget.PICKER_TOGGLE_STRIP_HEIGHT,
			preferShowAbove: true,
			onDidToggleSection: (section: string, collapsed: boolean) => {
				if (section === ModelPickerSection.Other) {
					logModelPickerInteraction(collapsed ? 'otherModelsCollapsed' : 'otherModelsExpanded');
				}
			},
			linkHandler: (uri: URI) => {
				if (uri.scheme === 'command' && uri.path === 'workbench.action.chat.upgradePlan') {
					logModelPickerInteraction('premiumModelUpgradePlanClicked');
				} else if (manageSettingsUrl && this._uriIdentityService.extUri.isEqual(uri, URI.parse(manageSettingsUrl))) {
					logModelPickerInteraction('disabledModelContactAdminClicked');
				}
				void this._openerService.open(uri, { allowCommands: true });
			},
			minWidth: 200,
		};
		const previouslyFocusedElement = dom.getActiveElement();

		const delegate = {
			onSelect: (action: IActionWidgetDropdownAction) => {
				this._actionWidgetService.hide();
				action.run();
			},
			onHide: () => {
				hoverDisposables.dispose();
				this._nameButton?.setAttribute('aria-expanded', 'false');
				if (dom.isHTMLElement(previouslyFocusedElement)) {
					previouslyFocusedElement.focus();
				}
			}
		};

		this._nameButton?.setAttribute('aria-expanded', 'true');

		this._actionWidgetService.show(
			'ChatModelPicker',
			false,
			items,
			delegate,
			anchorElement,
			undefined,
			[],
			getModelPickerAccessibilityProvider(),
			listOptions
		);

		// Mount after the context-view widget paints — getActiveElement() right after
		// show() is often the list row, not the filter input, so a single sync check misses.
		const tryMountToggleStrip = (): void => {
			let filterInput: HTMLInputElement | undefined;
			const activeElement = dom.getActiveElement();
			if (dom.isHTMLInputElement(activeElement) && activeElement.classList.contains('action-list-filter-input')) {
				filterInput = activeElement;
			} else if (dom.isHTMLElement(anchorElement)) {
				const root = anchorElement.ownerDocument;
				// Filter input is rendered by the context-view/action-widget, not by us — query live DOM.
				// eslint-disable-next-line no-restricted-syntax
				const inPicker = root.querySelector('.context-view .action-widget .action-list-filter-input');
				if (dom.isHTMLInputElement(inPicker)) {
					filterInput = inPicker;
				}
			}
			if (!filterInput) {
				return;
			}
			filterInput.classList.add('chat-model-picker-filter-input');
			this._mountPickerToggleStrip(filterInput, hoverDisposables);
			this._contextViewService.layout();
		};
		tryMountToggleStrip();
		queueMicrotask(() => tryMountToggleStrip());
	}

	/**
	 * V3Code: mounts the Auto routing ceiling and Design controls into
	 * the model-picker popup as fixed DOM — appended INSIDE the popup's filter
	 * container so it sits directly under the "Search models" box and rides along
	 * with the filter row across the action widget's internal re-layouts.
	 *
	 * Why DOM and not action-list rows: injecting these as list items caused the
	 * 3rd toggle to render down among the model rows (clashing with the first
	 * pinned model) due to the model picker's list virtualization / section /
	 * row-recycling machinery. Fixed DOM keeps all three reliably grouped at the
	 * top, gives full control over the switch visuals, and is immune to the list.
	 *
	 * The toggles flip state in place (no picker re-open). Thinking is wired to
	 * `v3code.agent.thinking` (USER scope) which v3codeChatAgent reads for reasoning.
	 */
	private _mountPickerToggleStrip(filterInput: HTMLInputElement, store: DisposableStore): void {
		// The filter input lives at `.action-list-filter > .action-list-filter-row >
		// input`. Walk up to the filter container via parentElement (no selector
		// queries — those are banned by hygiene and fragile) so the toggle strip sits
		// directly under the "Search models" box and rides along with the filter row
		// across the action widget's internal re-layouts.
		const filterRow = filterInput.parentElement;
		const filterContainer = filterRow?.parentElement;
		if (!filterContainer || !dom.isHTMLElement(filterContainer)) {
			return;
		}
		// Guard against double-mounting on the same popup.
		if (filterContainer.dataset.v3codePickerToggles === 'mounted') {
			return;
		}
		filterContainer.dataset.v3codePickerToggles = 'mounted';

		const strip = dom.append(filterContainer, dom.$('.v3code-picker-toggles'));

		const makeRow = (label: string, isOn: () => boolean, flip: () => void, disabled?: () => boolean): void => {
			const row = dom.append(strip, dom.$('.v3code-picker-toggle'));
			row.setAttribute('role', 'switch');
			row.setAttribute('tabindex', '0');
			row.title = label;

			const labelEl = dom.append(row, dom.$('span.v3code-picker-toggle-label'));
			labelEl.textContent = label;
			dom.append(row, dom.$('span.v3code-picker-toggle-switch'));

			const sync = (): void => {
				const isDisabled = disabled?.() ?? false;
				const on = !isDisabled && isOn();
				row.classList.toggle('on', on);
				row.classList.toggle('disabled', isDisabled);
				row.setAttribute('aria-checked', on ? 'true' : 'false');
				row.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
			};
			sync();

			const activate = (): void => {
				if (disabled?.()) {
					return;
				}
				flip();
				sync();
			};

			// Keep focus on the filter input (prevents the widget's blur-close) and
			// stop the event from reaching the list/selection handlers.
			store.add(dom.addDisposableListener(row, dom.EventType.MOUSE_DOWN, (e) => {
				e.preventDefault();
				e.stopPropagation();
			}));
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, (e) => {
				e.preventDefault();
				e.stopPropagation();
				activate();
			}));
			store.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e) => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					event.preventDefault();
					event.stopPropagation();
					activate();
				}
			}));
		};

		makeRow(localize('v3code.picker.auto', "Auto"), () => this._autoMode, () => { this._setAutoRouter(!this._autoMode); });

		const autoCaption = dom.append(strip, dom.$('span.v3code-picker-auto-caption'));
		autoCaption.textContent = localize('v3code.picker.autoCaption', "Model budget · cheap to premium");
		autoCaption.style.cssText = 'display:block;font-size:10px;opacity:0.5;margin:-2px 0 2px 2px;';

		// Five budget positions under Auto. Manual keeps the picked model; API models
		// use real catalog price ordering, while plans/local models use capability.
		const sliderRow = dom.append(strip, dom.$('.v3code-picker-rung-row'));
		const sliderTrack = dom.append(sliderRow, dom.$('.v3code-picker-rung-track'));
		sliderTrack.setAttribute('role', 'slider');
		sliderTrack.setAttribute('aria-valuemin', '0');
		sliderTrack.setAttribute('aria-valuemax', '4');
		sliderTrack.tabIndex = 0;
		sliderTrack.title = localize('v3code.picker.routerSlider', "Auto model budget. Manual uses your picked model. Economy through Premium raise the price or model-power ceiling without crossing your current plan or API key.");

		// Inner lane is inset (CSS) so the 0% and 100% rungs don't touch the pill ends.
		const lane = dom.append(sliderTrack, dom.$('.v3code-picker-rung-lane'));
		const rungFill = dom.append(lane, dom.$('.v3code-picker-rung-fill'));
		const rungDots: HTMLElement[] = [];
		for (let i = 0; i < 5; i++) {
			const dot = dom.append(lane, dom.$('div.v3code-picker-rung-dot'));
			dot.setAttribute('role', 'button');
			dot.tabIndex = -1;
			dot.dataset.rung = String(i);
			dot.title = V3_ROUTER_RUNG_LABELS[i];
			dot.style.left = `${i / 4 * 100}%`;
			rungDots.push(dot);
		}
		const rungKnob = dom.append(lane, dom.$('.v3code-picker-rung-knob'));

		// Visible, live label so the slider isn't opaque — shows what the current rung means.
		const rungLabel = dom.append(sliderRow, dom.$('span.v3code-picker-rung-label'));
		rungLabel.style.cssText = 'display:block;margin-top:5px;font-size:11px;opacity:0.6;text-align:center;';

		const positionAt = (pct: number): void => {
			rungKnob.style.left = `${pct * 100}%`;
			rungFill.style.width = `${pct * 100}%`;
		};

		const syncSlider = (): void => {
			const rung = this._routerRung;
			sliderTrack.dataset.budget = String(rung);
			sliderTrack.setAttribute('aria-valuenow', String(rung));
			sliderTrack.setAttribute('aria-valuetext', V3_ROUTER_RUNG_LABELS[rung]);
			rungLabel.textContent = rung === 0
				? localize('v3code.picker.rung0', "Manual — use your picked model")
				: rung === 2
					? localize('v3code.picker.rungValue', "Value — recommended")
					: localize('v3code.picker.rungN', "{0} — automatic budget ceiling", V3_ROUTER_RUNG_LABELS[rung]);
			positionAt(rung / 4);
			for (let i = 0; i < rungDots.length; i++) {
				rungDots[i].classList.toggle('active', i <= rung);
				rungDots[i].classList.toggle('current', i === rung);
			}
		};
		syncSlider();

		const sliderWindow = dom.getWindow(sliderTrack);
		let glowTimer: number | undefined;
		const pulseSliderGlow = (): void => {
			sliderTrack.classList.remove('sliding-glow');
			void sliderTrack.offsetWidth;
			sliderTrack.classList.add('sliding-glow');
			if (glowTimer !== undefined) {
				sliderWindow.clearTimeout(glowTimer);
			}
			glowTimer = sliderWindow.setTimeout(() => sliderTrack.classList.remove('sliding-glow'), 520);
		};
		store.add({
			dispose: () => {
				if (glowTimer !== undefined) {
					sliderWindow.clearTimeout(glowTimer);
				}
			}
		});

		const activateRung = (rung: V3RouterRung): void => {
			this._setRouterRung(rung);
			syncSlider();
			pulseSliderGlow();
		};

		const rungFromClientX = (clientX: number): V3RouterRung => {
			const rect = lane.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
			return clampRouterRung(Math.round(pct * 4));
		};

		// Discrete snap only — click track or dot jumps straight to the nearest rung.
		store.add(dom.addDisposableListener(sliderTrack, dom.EventType.MOUSE_DOWN, (e) => {
			e.preventDefault();
			e.stopPropagation();
			activateRung(rungFromClientX(e.clientX));
		}));
		for (const dot of rungDots) {
			store.add(dom.addDisposableListener(dot, dom.EventType.MOUSE_DOWN, (e) => {
				e.preventDefault();
				e.stopPropagation();
				activateRung(clampRouterRung(Number(dot.dataset.rung ?? 0)));
			}));
		}
		store.add(dom.addDisposableListener(sliderTrack, dom.EventType.KEY_DOWN, (e) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.LeftArrow)) {
				event.preventDefault();
				event.stopPropagation();
				activateRung(clampRouterRung(this._routerRung - 1));
			} else if (event.equals(KeyCode.RightArrow)) {
				event.preventDefault();
				event.stopPropagation();
				activateRung(clampRouterRung(this._routerRung + 1));
			}
		}));

		makeRow(
			localize('v3code.picker.design', "Design"),
			() => this._designModeOn,
			() => { this._setDesignMode(!this._designModeOn); },
		);
		const designRow = strip.lastElementChild;
		if (dom.isHTMLElement(designRow)) {
			designRow.title = localize('v3code.picker.design.hint', "UI workflow: ask_user gallery pick + design-rag skill on every turn.");
		}

		makeRow(
			localize('v3code.picker.security', "Cyber Protection"),
			() => this._securityModeOn,
			() => { this._setSecurityMode(!this._securityModeOn); },
		);
		const securityRow = strip.lastElementChild;
		if (dom.isHTMLElement(securityRow)) {
			securityRow.title = localize('v3code.picker.security.hint', "Security workflow: taint-analysis scanning with the security_scan tool on code changes.");
		}
		// Global "Thinking" toggle retired in favour of per-model reasoning — each model's
		// own submenu carries its reasoning/effort (None/Low/Medium/High, Easy/Hard, Fast).
		// A single global override only fought those per-model choices. Kept behind a flag
		// so it's one line to bring back if needed.
		const showGlobalThinkingToggle: boolean = false;
		if (showGlobalThinkingToggle) {
			makeRow(
				localize('v3code.picker.thinking', "Thinking"),
				() => this._thinkingEnabled,
				() => { this._setThinkingEnabled(!this._thinkingEnabled); },
				() => !this._modelSupportsThinking(),
			);
			// Gray out + tooltip when the selected model cannot reason (e.g. Haiku).
			const thinkingRow = strip.lastElementChild;
			if (dom.isHTMLElement(thinkingRow) && !this._modelSupportsThinking()) {
				thinkingRow.title = localize('v3code.picker.thinking.unavailable', "Thinking is not available for this model — pick Opus, Sonnet, or Opus Hybrid.");
			}
		}
	}

	private _updateBadge(): void {
		if (this._badgeIcon) {
			if (this._badge) {
				const icon = this._badge === 'info' ? Codicon.info : Codicon.warning;
				dom.reset(this._badgeIcon, renderIcon(icon));
				this._badgeIcon.style.display = '';
				this._badgeIcon.classList.toggle('info', this._badge === 'info');
				this._badgeIcon.classList.toggle('warning', this._badge === 'warning');
			} else {
				this._badgeIcon.style.display = 'none';
			}
		}
	}

	private _renderLabel(): void {
		if (!this._domNode || !this._nameButton) {
			return;
		}

		const { name, statusIcon } = this._selectedModel?.metadata || {};

		const autoRouter = this._autoMode;

		// --- Name section ---
		const nameChildren: (HTMLElement | string)[] = [];
		if (statusIcon && !autoRouter) {
			nameChildren.push(renderIcon(statusIcon));
		}
		const modelLabel = autoRouter
			? localize('v3code.picker.autoLabel', "Auto")
			: (name ?? localize('chat.modelPicker.auto', "Auto"));
		// In PRU mode, append the config description (e.g. thinking effort) to the button label
		const isUBB = !!this._entitlementService.quotas.usageBasedBilling;
		const isV3CodeModel = this._selectedModel?.metadata.vendor === 'v3code';
		const showInlineReasoningControls = isUBB || isV3CodeModel;
		const isOpusHybrid = !autoRouter && (name?.toLowerCase() === 'opus hybrid');
		// Hide duplicate advisor/thinking pill on the bottom bar for Hybrid (Easy/Hard live in the picker list).
		const effortConfig = showInlineReasoningControls && !autoRouter && !isOpusHybrid
			? this._getConfigProperty('navigation')
			: undefined;
		const willShowEffortButton = !!(effortConfig && this._effortButton) && !autoRouter;
		const configDescription = !isUBB && !willShowEffortButton && !autoRouter && this._selectedModel
			? getModelConfigurationDescription(this._selectedModel, this._languageModelsService)
			: undefined;
		const autoSuffix = autoRouter ? V3_ROUTER_RUNG_LABELS[this._routerRung] : undefined;
		const designSuffix = this._designModeOn ? localize('v3code.picker.designOn', "Design") : undefined;
		const securitySuffix = this._securityModeOn ? localize('v3code.picker.securityOn', "Cyber Protection") : undefined;
		const suffixParts = [autoSuffix, designSuffix, securitySuffix].filter(Boolean);
		const fullLabel = suffixParts.length
			? `${modelLabel} · ${suffixParts.join(' · ')}`
			: configDescription
				? `${modelLabel} · ${configDescription}`
				: modelLabel;
		nameChildren.push(dom.$('span.chat-input-picker-label', undefined, fullLabel));
		if (this._badgeIcon) {
			nameChildren.push(this._badgeIcon);
		}
		dom.reset(this._nameButton, ...nameChildren);

		// Effort and tokens buttons are only shown in UBB mode.
		// In PRU mode, configuration is accessed via per-model toolbar actions in the picker dropdown.

		// Effort / thinking control — UBB mode, or V3Code BYOK models with configurationSchema.
		// (effortConfig is computed above so we can suppress the duplicate inline label.)
		if (effortConfig && this._effortButton) {
			// Use the localized enumItemLabel from the schema, falling back to the raw value
			const enumIndex = effortConfig.schema.enum?.indexOf(effortConfig.value) ?? -1;
			const effortLabel = enumIndex >= 0 && effortConfig.schema.enumItemLabels?.[enumIndex]
				? effortConfig.schema.enumItemLabels[enumIndex]
				: String(effortConfig.value);
			dom.reset(this._effortButton, dom.$('span.chat-input-picker-label', undefined, effortLabel));
			this._effortButton.style.display = '';
			this._effortButton.ariaLabel = localize('chat.modelPicker.effortAriaLabel', "Thinking Effort: {0}", effortLabel);
		} else if (this._effortButton) {
			this._effortButton.style.display = 'none';
		}

		// --- Tokens section (from configurationSchema group 'tokens') ---
		const tokensConfig = isUBB ? this._getConfigProperty('tokens') : undefined;
		if (tokensConfig && this._tokensButton) {
			const idx = tokensConfig.schema.enum?.indexOf(tokensConfig.value) ?? -1;
			const tokensLabel = idx >= 0 && tokensConfig.schema.enumItemLabels?.[idx]
				? tokensConfig.schema.enumItemLabels[idx]
				: formatTokenCount(Number(tokensConfig.value));
			dom.reset(this._tokensButton, dom.$('span.chat-input-picker-label', undefined, tokensLabel));
			this._tokensButton.style.display = '';
			this._tokensButton.ariaLabel = localize('chat.modelPicker.tokensAriaLabel', "Context Size: {0}", tokensLabel);
		} else if (this._tokensButton) {
			this._tokensButton.style.display = 'none';
		}

		// Aria
		this._domNode.ariaLabel = localize('chat.modelPicker.ariaLabel', "Pick Model, {0}", fullLabel);
	}

	private _getConfigProperty(group: string) {
		if (!this._selectedModel) {
			return undefined;
		}
		return resolveConfigProperty(this._selectedModel, group, this._languageModelsService);
	}

	private _showEffortPicker(): void {
		if (this._domNode?.classList.contains('disabled')) {
			return;
		}
		const config = this._getConfigProperty('navigation');
		if (!config || !this._effortButton || !this._selectedModel) {
			return;
		}

		const modelIdentifier = this._selectedModel.identifier;
		const enumValues = config.schema.enum ?? [];
		const enumItemLabels = config.schema.enumItemLabels;

		const items: IActionListItem<IActionWidgetDropdownAction>[] = [
			{
				kind: ActionListItemKind.Header,
				label: localize('chat.effort.header', "Thinking Effort"),
			}
		];

		for (let index = 0; index < enumValues.length; index++) {
			const value = enumValues[index];
			const label = enumItemLabels?.[index] ?? String(value);
			const isDefault = value === config.schema.default;
			const displayLabel = isDefault
				? localize('models.effortDefault', "{0} (default)", label)
				: label;
			items.push({
				item: {
					id: `effort.${value}`,
					enabled: true,
					checked: config.value === value,
					class: undefined,
					tooltip: config.schema.enumDescriptions?.[index] ?? '',
					label: displayLabel,
					run: () => {
						this._languageModelsService.setModelConfiguration(
							modelIdentifier,
							{ [config.key]: value }
						);
					}
				},
				kind: ActionListItemKind.Action,
				label: displayLabel,
				description: config.schema.enumDescriptions?.[index],
				group: { title: '', icon: ThemeIcon.fromId(config.value === value ? Codicon.check.id : Codicon.blank.id) },
				hideIcon: false,
			});
		}

		const previouslyFocusedElement = dom.getActiveElement();
		const delegate = {
			onSelect: (action: IActionWidgetDropdownAction) => {
				this._actionWidgetService.hide();
				action.run();
			},
			onHide: () => {
				this._effortButton?.setAttribute('aria-expanded', 'false');
				if (dom.isHTMLElement(previouslyFocusedElement)) {
					previouslyFocusedElement.focus();
				}
			}
		};

		this._effortButton.setAttribute('aria-expanded', 'true');

		this._actionWidgetService.show(
			'ChatModelEffortPicker',
			false,
			items,
			delegate,
			this._effortButton,
			undefined,
			[],
			{
				isChecked(element: IActionListItem<IActionWidgetDropdownAction>) {
					return element.kind === ActionListItemKind.Action ? !!element?.item?.checked : undefined;
				},
				getRole: () => 'menuitemradio' as const,
				getWidgetRole: () => 'menu' as const,
			},
			{
				footerText: localize('chat.effort.costHint', "Higher levels of thinking may increase costs"),
			}
		);
	}

	private _showTokensPicker(): void {
		if (this._domNode?.classList.contains('disabled')) {
			return;
		}
		const config = this._getConfigProperty('tokens');
		if (!config || !this._tokensButton || !this._selectedModel) {
			return;
		}

		const modelIdentifier = this._selectedModel.identifier;
		const enumValues = config.schema.enum ?? [];
		const enumItemLabels = config.schema.enumItemLabels;

		const items: IActionListItem<IActionWidgetDropdownAction>[] = [
			{
				kind: ActionListItemKind.Header,
				label: localize('chat.tokens.header', "Context Size"),
			}
		];

		for (let index = 0; index < enumValues.length; index++) {
			const value = enumValues[index];
			const label = enumItemLabels?.[index] ?? formatTokenCount(Number(value));
			const isDefault = value === config.schema.default;
			const displayLabel = isDefault
				? localize('models.tokensDefault', "{0} (default)", label)
				: label;
			const description = config.schema.enumDescriptions?.[index];
			items.push({
				item: {
					id: `tokens.${value}`,
					enabled: true,
					checked: config.value === value,
					class: undefined,
					tooltip: description ?? '',
					label: displayLabel,
					run: () => {
						this._languageModelsService.setModelConfiguration(
							modelIdentifier,
							{ [config.key]: value }
						);
					}
				},
				kind: ActionListItemKind.Action,
				label: displayLabel,
				description,
				group: { title: '', icon: ThemeIcon.fromId(config.value === value ? Codicon.check.id : Codicon.blank.id) },
				hideIcon: false,
			});
		}

		const previouslyFocusedElement = dom.getActiveElement();
		const delegate = {
			onSelect: (action: IActionWidgetDropdownAction) => {
				this._actionWidgetService.hide();
				action.run();
			},
			onHide: () => {
				this._tokensButton?.setAttribute('aria-expanded', 'false');
				if (dom.isHTMLElement(previouslyFocusedElement)) {
					previouslyFocusedElement.focus();
				}
			}
		};

		this._tokensButton.setAttribute('aria-expanded', 'true');

		this._actionWidgetService.show(
			'ChatModelTokensPicker',
			false,
			items,
			delegate,
			this._tokensButton,
			undefined,
			[],
			{
				isChecked(element: IActionListItem<IActionWidgetDropdownAction>) {
					return element.kind === ActionListItemKind.Action ? !!element?.item?.checked : undefined;
				},
				getRole: () => 'menuitemradio' as const,
				getWidgetRole: () => 'menu' as const,
			},
			{
				footerText: localize('chat.tokens.costHint', "Larger context may increase cost"),
			}
		);
	}
}


function getModelHoverContent(model: ILanguageModelChatMetadataAndIdentifier, openerService: IOpenerService, isUBB?: boolean): { element: HTMLElement; disposable: DisposableStore } | undefined {
	const isAuto = isAutoModel(model);
	const container = dom.$('.chat-model-hover');
	const disposables = new DisposableStore();

	// --- Model name header ---
	container.appendChild(dom.$('.chat-model-hover-name', undefined, model.metadata.name));

	// --- Description (tooltip as markdown) ---
	if (model.metadata.tooltip) {
		container.appendChild(dom.$('.chat-model-hover-separator'));
		const descriptionContainer = dom.$('.chat-model-hover-description');
		const md = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (model.metadata.statusIcon) {
			md.appendMarkdown(`$(${model.metadata.statusIcon.id})&nbsp;`);
		}
		md.appendMarkdown(model.metadata.tooltip);
		const rendered = renderMarkdown(md, {
			actionHandler: (url: string) => {
				openerService.open(URI.parse(url), { allowCommands: true });
			},
		});
		disposables.add(rendered);
		descriptionContainer.appendChild(rendered.element);
		container.appendChild(descriptionContainer);
	}

	// --- Cost info (UBB only) ---
	if (!isAuto && isUBB) {
		const formatCostValue = (cost: number): string => {
			return cost === 1
				? localize('models.costValueSingular', "{0} credit", cost)
				: localize('models.costValuePlural', "{0} credits", cost);
		};
		const buildCostLines = (input: number | undefined, cache: number | undefined, output: number | undefined): { label: string; value: string }[] => {
			const lines: { label: string; value: string }[] = [];
			if (input !== undefined) {
				lines.push({ label: localize('models.inputCostLabel', "Input"), value: formatCostValue(input) });
			}
			if (cache !== undefined) {
				lines.push({ label: localize('models.cacheCostLabel', "Cached input"), value: formatCostValue(cache) });
			}
			if (output !== undefined) {
				lines.push({ label: localize('models.outputCostLabel', "Output"), value: formatCostValue(output) });
			}
			return lines;
		};
		const appendCostSection = (parent: HTMLElement, title: string, lines: { label: string; value: string }[], categoryLabel?: string): void => {
			const section = dom.$('.chat-model-hover-cost');
			const titleRow = dom.$('.chat-model-hover-cost-title-row');
			titleRow.appendChild(dom.$('.chat-model-hover-cost-title', undefined, title));
			if (categoryLabel) {
				titleRow.appendChild(dom.$('span.chat-model-hover-cost-tag', undefined, categoryLabel));
			}
			section.appendChild(titleRow);
			for (const line of lines) {
				section.appendChild(dom.$('.chat-model-hover-cost-line', undefined,
					dom.$('span.chat-model-hover-cost-line-label', undefined, `${line.label}: `),
					dom.$('span', undefined, line.value),
				));
			}
			parent.appendChild(section);
		};

		const costLines = buildCostLines(model.metadata.inputCost, model.metadata.cacheCost, model.metadata.outputCost);
		const priceCategoryLabel = getPriceCategoryLabel(model.metadata.priceCategory);
		if (costLines.length > 0) {
			appendCostSection(container, localize('models.priceTitle', "Cost (per 1M tokens)"), costLines, priceCategoryLabel);

			// Long-context pricing — only when it differs from default
			const longContextCostLines = buildCostLines(model.metadata.longContextInputCost, model.metadata.longContextCacheCost, model.metadata.longContextOutputCost);
			if (longContextCostLines.length > 0) {
				appendCostSection(container, localize('models.longContextPriceTitle', "Long context cost (per 1M tokens)"), longContextCostLines);
			}
		} else if (priceCategoryLabel) {
			const costSection = dom.$('.chat-model-hover-cost');
			const titleRow = dom.$('.chat-model-hover-cost-title-row');
			titleRow.appendChild(dom.$('.chat-model-hover-cost-title', undefined, localize('models.priceCategoryTitle', "Cost")));
			titleRow.appendChild(dom.$('span.chat-model-hover-cost-tag', undefined, priceCategoryLabel));
			costSection.appendChild(titleRow);
			container.appendChild(costSection);
		} else if (model.metadata.pricing && !isMultiplierPricing(model)) {
			const costSection = dom.$('.chat-model-hover-cost');
			costSection.appendChild(dom.$('span', undefined, localize('models.cost', 'Cost: {0}', model.metadata.pricing)));
			container.appendChild(costSection);
		}
	}

	// --- Context size ---
	if (!isAuto && (model.metadata.maxInputTokens || model.metadata.maxOutputTokens)) {
		const totalTokens = (model.metadata.maxInputTokens ?? 0) + (model.metadata.maxOutputTokens ?? 0);
		const contextSection = dom.$('.chat-model-hover-context');
		contextSection.appendChild(dom.$('.chat-model-hover-context-label', undefined, localize('models.contextSize', "Max context")));
		contextSection.appendChild(dom.$('.chat-model-hover-context-value', undefined, formatTokenCount(totalTokens)));
		container.appendChild(contextSection);
	}

	// --- Configurable properties (UBB only — PRU uses inline toolbar actions) ---
	if (!isAuto && isUBB && model.metadata.configurationSchema?.properties) {
		const configurableLabels: string[] = [];
		for (const [, propSchema] of Object.entries(model.metadata.configurationSchema.properties)) {
			if (propSchema.enum && propSchema.enum.length >= 2) {
				const label = propSchema.title ?? propSchema.description;
				if (label) {
					configurableLabels.push(label);
				}
			}
		}
		if (configurableLabels.length > 0) {
			container.appendChild(dom.$('.chat-model-hover-separator'));
			const configRow = dom.$('.chat-model-hover-configurable');
			configRow.appendChild(dom.$('span.chat-model-hover-configurable-label', undefined, localize('models.configurable', "Configurable:")));
			for (const label of configurableLabels) {
				configRow.appendChild(dom.$('span.chat-model-hover-configurable-tag', undefined, label));
			}
			container.appendChild(configRow);
		}
	}

	return container.children.length > 0 ? { element: container, disposable: disposables } : undefined;
}


export function formatTokenCount(count: number): string {
	if (count > 900_000) {
		const value = Math.ceil(count / 1_000_000);
		return `${value}M`;
	} else if (count >= 1000) {
		return `${Math.round(count / 1000)}K`;
	}
	return count.toString();
}

function isAutoModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	return model.metadata.id === 'auto' && (model.metadata.vendor === 'copilot' || model.metadata.vendor === 'copilotcli');
}
