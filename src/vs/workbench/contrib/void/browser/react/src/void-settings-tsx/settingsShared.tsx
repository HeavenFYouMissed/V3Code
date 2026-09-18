/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { ProviderName, SettingName, displayInfoOfSettingName, providerNames, VoidStatefulModelInfo, customSettingNamesOfProvider, RefreshableProviderName, refreshableProviderNames, displayInfoOfProviderName, nonlocalProviderNames, localProviderNames, GlobalSettingName, isProviderNameDisabled, subTextMdOfProviderName, isProviderTemporarilyDisabled } from '../../../../common/voidSettingsTypes.js'
import ErrorBoundary from '../util/ErrorBoundary.js'
import { VoidButtonBgDarken, VoidCustomDropdownBox, VoidInputBox2, VoidSimpleInputBox, VoidSwitch } from '../util/inputs.js'
import { useAccessor, useProviderHealth, useRefreshModelListener, useRefreshModelState, useSettingsState } from '../util/services.js'
import { X, RefreshCw, Loader2, Check, Asterisk, Plus } from 'lucide-react'
import {
	CardDivider,
	SettingRow,
	SettingsCard,
	SettingsSection,
	ProviderHeader,
} from './SettingsLayout.js'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { WarningBox } from './WarningBox.js'
import { os } from '../../../../common/helpers/systemInfo.js'
import { IconLoading } from '../shared-tsx/chatShared.js'
import { ToolApprovalType } from '../../../../common/toolsServiceTypes.js'
import { getModelCapabilities, modelOverrideKeys, ModelOverrides } from '../../../../common/modelCapabilities.js'
import { V3_MODEL_TIERS, tierFromModelSelection, TIER_POWER, TIER_BURN, TierBurn, tierGlyph, isHostedTierId } from '../../../../common/modelTiers.js'
import { TransferEditorType } from '../../../extensionTransferTypes.js'

// Brand accent, theme-following (no hardcoded hex — follows the active theme's --v3-accent).
export const ACCENT = 'var(--v3-accent, #9587ff)';
export const accentMix = (pct: number) => `color-mix(in srgb, ${ACCENT} ${pct}%, transparent)`;

// Power rating as 6 monochrome bubbles (N filled): the model-strength ladder in the picker.
const PowerBubbles = ({ n }: { n: number }) => (
	<span className='inline-flex items-center gap-[2px] shrink-0' title={`Power ${n}/6`} aria-label={`Power ${n} of 6`}>
		{Array.from({ length: 6 }, (_, i) => (
			<span key={i} style={{
				width: 5, height: 5, borderRadius: 9999,
				background: i < n ? 'var(--vscode-foreground)' : 'var(--vscode-foreground)',
				opacity: i < n ? 0.85 : 0.22,
			}} />
		))}
	</span>
);

const BURN_LABEL: Record<TierBurn, string> = { cheap: 'Cheap', mid: 'Mid', heavy: 'Heavy' };
// Relative "how fast it drains the plan" hint. NO price, ever. Monochrome, opacity scales with burn.
const BurnBadge = ({ burn }: { burn: TierBurn }) => (
	<span title={`Burn: ${BURN_LABEL[burn]}`} className='shrink-0' style={{
		fontSize: '9px', letterSpacing: '0.4px', textTransform: 'uppercase', fontWeight: 600,
		padding: '1px 5px', borderRadius: 9999,
		border: '1px solid var(--vscode-foreground)', color: 'var(--vscode-foreground)',
		opacity: burn === 'heavy' ? 0.8 : burn === 'mid' ? 0.6 : 0.42,
	}}>{BURN_LABEL[burn]}</span>
);

const ButtonLeftTextRightOption = ({ text, leftButton }: { text: string, leftButton?: React.ReactNode }) => {

	return <div className='flex items-center text-void-fg-3 px-3 py-0.5 rounded-sm overflow-hidden gap-2'>
		{leftButton ? leftButton : null}
		<span>
			{text}
		</span>
	</div>
}

// models
const RefreshModelButton = ({ providerName }: { providerName: RefreshableProviderName }) => {

	const refreshModelState = useRefreshModelState()

	const accessor = useAccessor()
	const refreshModelService = accessor.get('IRefreshModelService')
	const metricsService = accessor.get('IMetricsService')

	const [justFinished, setJustFinished] = useState<null | 'finished' | 'error'>(null)

	useRefreshModelListener(
		useCallback((providerName2, refreshModelState) => {
			if (providerName2 !== providerName) return
			const { state } = refreshModelState[providerName]
			if (!(state === 'finished' || state === 'error')) return
			// now we know we just entered 'finished' state for this providerName
			setJustFinished(state)
			const tid = setTimeout(() => { setJustFinished(null) }, 2000)
			return () => clearTimeout(tid)
		}, [providerName])
	)

	const { state } = refreshModelState[providerName]

	const { title: providerTitle } = displayInfoOfProviderName(providerName)

	return <ButtonLeftTextRightOption

		leftButton={
			<button
				className='flex items-center'
				disabled={state === 'refreshing' || justFinished !== null}
				onClick={() => {
					refreshModelService.startRefreshingModels(providerName, { enableProviderOnSuccess: false, doNotFire: false })
					metricsService.capture('Click', { providerName, action: 'Refresh Models' })
				}}
			>
				{justFinished === 'finished' ? <Check className='stroke-green-500 size-3' />
					: justFinished === 'error' ? <X className='stroke-red-500 size-3' />
						: state === 'refreshing' ? <Loader2 className='size-3 animate-spin' />
							: <RefreshCw className='size-3' />}
			</button>
		}

		text={justFinished === 'finished' ? `${providerTitle} Models are up-to-date!`
			: justFinished === 'error' ? `${providerTitle} refresh failed — check API key.`
				: `Refresh ${providerTitle} models from API.`}
	/>
}

const RefreshableModels = () => {
	const settingsState = useSettingsState()


	const buttons = refreshableProviderNames.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) return null
		return <RefreshModelButton key={providerName} providerName={providerName} />
	})

	return <>
		{buttons}
	</>

}



export const AnimatedCheckmarkButton = ({ text, className }: { text?: string, className?: string }) => {
	const [dashOffset, setDashOffset] = useState(40);

	useEffect(() => {
		const startTime = performance.now();
		const duration = 500; // 500ms animation

		const animate = (currentTime: number) => {
			const elapsed = currentTime - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const newOffset = 40 - (progress * 40);

			setDashOffset(newOffset);

			if (progress < 1) {
				requestAnimationFrame(animate);
			}
		};

		const animationId = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(animationId);
	}, []);

	return <div
		className={`flex items-center gap-1.5 w-fit
			${className ? className : `px-2 py-0.5 text-xs text-zinc-900 bg-zinc-100 rounded-sm`}
		`}
	>
		<svg className="size-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<path
				d="M5 13l4 4L19 7"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{
					strokeDasharray: 40,
					strokeDashoffset: dashOffset
				}}
			/>
		</svg>
		{text}
	</div>
}


const AddButton = ({ disabled, text = 'Add', ...props }: { disabled?: boolean, text?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {

	return <button
		disabled={disabled}
		className={`bg-[#0e70c0] px-3 py-1 text-white rounded-sm ${!disabled ? 'hover:bg-[#1177cb] cursor-pointer' : 'opacity-50 cursor-not-allowed bg-opacity-70'}`}
		{...props}
	>{text}</button>

}

// ---------------- Simplified Model Settings Dialog ------------------

// keys of ModelOverrides we allow the user to override



// This new dialog replaces the verbose UI with a single JSON override box.
const SimpleModelSettingsDialog = ({
	isOpen,
	onClose,
	modelInfo,
}: {
	isOpen: boolean;
	onClose: () => void;
	modelInfo: { modelName: string; providerName: ProviderName; type: 'autodetected' | 'custom' | 'default' } | null;
}) => {
	if (!isOpen || !modelInfo) return null;

	const { modelName, providerName, type } = modelInfo;
	const accessor = useAccessor()
	const settingsState = useSettingsState()
	const mouseDownInsideModal = useRef(false); // Ref to track mousedown origin
	const settingsStateService = accessor.get('IVoidSettingsService')

	// current overrides and defaults
	const defaultModelCapabilities = getModelCapabilities(providerName, modelName, undefined);
	const currentOverrides = settingsState.overridesOfModel?.[providerName]?.[modelName] ?? undefined;
	const { recognizedModelName, isUnrecognizedModel } = defaultModelCapabilities

	// Create the placeholder with the default values for allowed keys
	const partialDefaults: Partial<ModelOverrides> = {};
	for (const k of modelOverrideKeys) { if (defaultModelCapabilities[k]) partialDefaults[k] = defaultModelCapabilities[k] as any; }
	const placeholder = JSON.stringify(partialDefaults, null, 2);

	const [overrideEnabled, setOverrideEnabled] = useState<boolean>(() => !!currentOverrides);

	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

	// reset when dialog toggles
	useEffect(() => {
		if (!isOpen) return;
		const cur = settingsState.overridesOfModel?.[providerName]?.[modelName];
		setOverrideEnabled(!!cur);
		setErrorMsg(null);
	}, [isOpen, providerName, modelName, settingsState.overridesOfModel, placeholder]);

	const onSave = async () => {
		// if disabled override, reset overrides
		if (!overrideEnabled) {
			await settingsStateService.setOverridesOfModel(providerName, modelName, undefined);
			onClose();
			return;
		}

		// enabled overrides
		// parse json
		let parsedInput: Record<string, unknown>

		if (textAreaRef.current?.value) {
			try {
				parsedInput = JSON.parse(textAreaRef.current.value);
			} catch (e) {
				setErrorMsg('Invalid JSON');
				return;
			}
		} else {
			setErrorMsg('Invalid JSON');
			return;
		}

		// only keep allowed keys
		const cleaned: Partial<ModelOverrides> = {};
		for (const k of modelOverrideKeys) {
			if (!(k in parsedInput)) continue
			const isEmpty = parsedInput[k] === '' || parsedInput[k] === null || parsedInput[k] === undefined;
			if (!isEmpty) {
				cleaned[k] = parsedInput[k] as any;
			}
		}
		await settingsStateService.setOverridesOfModel(providerName, modelName, cleaned);
		onClose();
	};

	const sourcecodeOverridesLink = `https://github.com/voideditor/void/blob/2e5ecb291d33afbe4565921664fb7e183189c1c5/src/vs/workbench/contrib/void/common/modelCapabilities.ts#L146-L172`

	return (
		<div // Backdrop
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999999]"
			onMouseDown={() => {
				mouseDownInsideModal.current = false;
			}}
			onMouseUp={() => {
				if (!mouseDownInsideModal.current) {
					onClose();
				}
				mouseDownInsideModal.current = false;
			}}
		>
			{/* MODAL */}
			<div
				className="bg-void-bg-1 rounded-md p-4 max-w-xl w-full shadow-xl overflow-y-auto max-h-[90vh]"
				onClick={(e) => e.stopPropagation()} // Keep stopping propagation for normal clicks inside
				onMouseDown={(e) => {
					mouseDownInsideModal.current = true;
					e.stopPropagation();
				}}
			>
				<div className="flex justify-between items-center mb-4">
					<h3 className="text-lg font-medium">
						Change Defaults for {modelName} ({displayInfoOfProviderName(providerName).title})
					</h3>
					<button
						onClick={onClose}
						className="text-void-fg-3 hover:text-void-fg-1"
					>
						<X className="size-5" />
					</button>
				</div>

				{/* Display model recognition status */}
				<div className="text-sm text-void-fg-3 mb-4">
					{type === 'default' ? `${modelName} comes packaged with V3Code, so you shouldn't need to change these settings.`
						: isUnrecognizedModel
							? `Model not recognized by V3Code.`
							: `V3Code recognizes ${modelName} ("${recognizedModelName}").`}
				</div>


				{/* override toggle */}
				<div className="flex items-center gap-2 mb-4">
					<VoidSwitch size='xs' value={overrideEnabled} onChange={setOverrideEnabled} />
					<span className="text-void-fg-3 text-sm">Override model defaults</span>
				</div>

				{/* Informational link */}
				{overrideEnabled && <div className="text-sm text-void-fg-3 mb-4">
					<ChatMarkdownRender string={`See the [sourcecode](${sourcecodeOverridesLink}) for a reference on how to set this JSON (advanced).`} chatMessageLocation={undefined} />
				</div>}

				<textarea
					key={overrideEnabled + ''}
					ref={textAreaRef}
					className={`w-full min-h-[200px] p-2 rounded-sm border border-void-border-2 bg-void-bg-2 resize-none font-mono text-sm ${!overrideEnabled ? 'text-void-fg-3' : ''}`}
					defaultValue={overrideEnabled && currentOverrides ? JSON.stringify(currentOverrides, null, 2) : placeholder}
					placeholder={placeholder}
					readOnly={!overrideEnabled}
				/>
				{errorMsg && (
					<div className="text-red-500 mt-2 text-sm">{errorMsg}</div>
				)}


				<div className="flex justify-end gap-2 mt-4">
					<VoidButtonBgDarken onClick={onClose} className="px-3 py-1">
						Cancel
					</VoidButtonBgDarken>
					<VoidButtonBgDarken
						onClick={onSave}
						className="px-3 py-1 bg-[#0e70c0] text-white"
					>
						Save
					</VoidButtonBgDarken>
				</div>
			</div>
		</div>
	);
};




/** Re-render on account state changes (sign-in, plan) — the tier list and health badges gate on it. */
const useAccountServiceState = () => {
	const accessor = useAccessor()
	const accountService = accessor.get('IV3CodeAccountService')
	const [, force] = useState(0)
	useEffect(() => {
		const d = accountService.onDidChangeState(() => force(x => x + 1))
		return () => d.dispose()
	}, [accountService])
	return accountService
}

/** Inline key/gateway health for a provider card: probe result + a recheck action. */
export const ProviderHealthBadge = ({ providerName }: { providerName: ProviderName }) => {
	const accessor = useAccessor()
	const refreshModelService = accessor.get('IRefreshModelService')
	const health = useProviderHealth()[providerName as RefreshableProviderName]
	if (!(refreshableProviderNames as readonly string[]).includes(providerName) || !health || health.status === 'unknown') { return null }
	const recheck = () => refreshModelService.startRefreshingModels(providerName as RefreshableProviderName, { enableProviderOnSuccess: false, doNotFire: false })
	const agoMin = Math.max(0, Math.round((Date.now() - health.checkedAt) / 60_000))
	const agoLabel = agoMin === 0 ? 'just now' : `${agoMin} min ago`
	return <div className='px-4 py-2 flex items-center gap-2 text-xs'>
		{health.status === 'ok'
			? <><Check className='size-3' style={{ color: ACCENT }} /><span className='opacity-70'>{`Working · checked ${agoLabel}`}</span></>
			: health.status === 'badKey'
				? <><X className='size-3 text-red-500' /><span className='text-red-500'>{`Key rejected — models hidden from the picker`}</span></>
				: <><X className='size-3 opacity-50' /><span className='opacity-60'>{`Unreachable · checked ${agoLabel}`}</span></>}
		<button type='button' className='opacity-60 hover:opacity-100 underline' onClick={recheck}>Recheck</button>
	</div>
}

export const ModelDump = ({ filteredProviders }: { filteredProviders?: ProviderName[] }) => {
	const [openRouterExpanded, setOpenRouterExpanded] = useState(false);
	const [openRouterSearch, setOpenRouterSearch] = useState('');
	const accessor = useAccessor()
	const settingsStateService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()
	const accountService = useAccountServiceState()
	const activeTier = tierFromModelSelection(settingsState.modelSelectionOfFeature?.Chat ?? null)

	// State to track which model's settings dialog is open
	const [openSettingsModel, setOpenSettingsModel] = useState<{
		modelName: string,
		providerName: ProviderName,
		type: 'autodetected' | 'custom' | 'default'
	} | null>(null);

	// States for add model functionality
	const [isAddModelOpen, setIsAddModelOpen] = useState(false);
	const [showCheckmark, setShowCheckmark] = useState(false);
	const [userChosenProviderName, setUserChosenProviderName] = useState<ProviderName | null>(null);
	const [modelName, setModelName] = useState<string>('');
	const [errorString, setErrorString] = useState('');

	// a dump of all the enabled providers' models
	const modelDump: (VoidStatefulModelInfo & { providerName: ProviderName, providerEnabled: boolean })[] = []

	// Use either filtered providers or all providers
	const providersToShow = (filteredProviders || providerNames).filter(providerName => !isProviderTemporarilyDisabled(providerName));

	for (let providerName of providersToShow) {
		const providerSettings = settingsState.settingsOfProvider[providerName]
		// if (!providerSettings.enabled) continue
		modelDump.push(...providerSettings.models.map(model => ({ ...model, providerName, providerEnabled: !!providerSettings._didFillInProviderSettings })))
	}

	// sort by hidden
	modelDump.sort((a, b) => {
		return Number(b.providerEnabled) - Number(a.providerEnabled)
	})

	// Add model handler
	const handleAddModel = () => {
		if (!userChosenProviderName) {
			setErrorString('Please select a provider.');
			return;
		}
		if (!modelName) {
			setErrorString('Please enter a model name.');
			return;
		}

		// Check if model already exists
		if (settingsState.settingsOfProvider[userChosenProviderName].models.find(m => m.modelName === modelName)) {
			setErrorString(`This model already exists.`);
			return;
		}

		settingsStateService.addModel(userChosenProviderName, modelName);
		setShowCheckmark(true);
		setTimeout(() => {
			setShowCheckmark(false);
			setIsAddModelOpen(false);
			setUserChosenProviderName(null);
			setModelName('');
		}, 1500);
		setErrorString('');
	};

	return <>
		<SettingsSection label="Chat tiers">
			<SettingsCard>
				<div className='px-4 py-3'>
					<div className='flex flex-col gap-1'>
						{V3_MODEL_TIERS.map(tier => {
							const selected = activeTier?.id === tier.id
							// A tier the user can't actually run is shown locked with the reason,
							// instead of failing at send time: hosted tiers need a paid plan (or a
							// BYOK key for the tier's provider — the send path runs them on it);
							// Opus orchestration tiers need an Anthropic key.
							const acct = accountService.state
							const tierByok = !!(settingsState.settingsOfProvider[tier.selection.providerName as ProviderName] as { apiKey?: string } | undefined)?.apiKey?.trim()
							const usable = isHostedTierId(tier.id) ? ((acct.status === 'signedIn' && acct.isPaid) || tierByok) : tierByok
							const lockReason = isHostedTierId(tier.id)
								? (acct.status !== 'signedIn' ? 'Sign in & upgrade to use' : 'Upgrade to use')
								: `Add a ${displayInfoOfProviderName(tier.selection.providerName as ProviderName).title} key to use`
							return (
								<button
									key={tier.id}
									type='button'
									disabled={!usable}
									className={`flex items-center gap-2 px-2 py-2 rounded-sm text-left w-full ${!usable ? 'opacity-45 cursor-not-allowed' : selected ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-3)]/60'}`}
									onClick={() => { if (usable) { settingsStateService.setModelSelectionOfFeature('Chat', tier.selection) } }}
								>
									<span className='font-medium whitespace-nowrap'>{tier.label}{tierGlyph(tier.id) ? ` ${tierGlyph(tier.id)}` : ''}</span>
									<PowerBubbles n={TIER_POWER[tier.id]} />
									<BurnBadge burn={TIER_BURN[tier.id]} />
									<span className='opacity-60 text-xs truncate flex-1'>{usable ? tier.description : lockReason}</span>
									{selected && usable && <Check className='size-3 opacity-80' />}
								</button>
							)
						})}
					</div>
				</div>
			</SettingsCard>
		</SettingsSection>

		<SettingsCard>
		{providersToShow.map(groupProvider => {
			const groupModels = modelDump.filter(model => model.providerName === groupProvider);
			if (!groupModels.length) return null;
			const routed = groupProvider === 'openRouter';
			const shownModels = routed ? groupModels.filter(model => model.modelName.toLowerCase().includes(openRouterSearch.toLowerCase())) : groupModels;
			return <React.Fragment key={groupProvider}>
				{routed ? <div className='px-4 py-3 flex flex-col gap-2'>
					<div className='flex flex-wrap items-center gap-2'>
						<button type='button' className='flex-1 text-left font-medium' aria-expanded={openRouterExpanded} onClick={() => setOpenRouterExpanded(value => !value)}>{openRouterExpanded ? '\u25BE' : '\u25B8'} OpenRouter · {groupModels.length} models · {groupModels.filter(model => !model.isHidden).length} enabled</button>
						<button type='button' className='text-xs underline' onClick={() => { void settingsStateService.setSettingOfProvider('openRouter', 'models', settingsStateService.state.settingsOfProvider.openRouter.models.map(model => ({ ...model, isHidden: true }))); }}>Disable all</button>
					</div>
					{openRouterExpanded ? <input aria-label='Search OpenRouter models' placeholder='Search OpenRouter models…' value={openRouterSearch} onChange={event => setOpenRouterSearch(event.target.value)} className='w-full min-w-0 p-2 rounded border border-void-border-2 bg-void-bg-1' /> : null}
				</div> : null}
				<div style={routed ? { display: openRouterExpanded ? 'block' : 'none', maxHeight: 420, overflowY: 'auto', overflowX: 'hidden' } : undefined}>
		{(routed && !openRouterExpanded ? [] : shownModels).map((m, i) => {
			const { isHidden, type, modelName, providerName, providerEnabled } = m

			const isNewProviderName = !routed && i === 0

			const providerTitle = displayInfoOfProviderName(providerName).title

			const disabled = !providerEnabled
			const value = disabled ? false : !isHidden

			const tooltipName = (
				disabled ? `Add ${providerTitle} to enable`
					: value === true ? 'Show in Dropdown'
						: 'Hide from Dropdown'
			)


			const autodetectedTooltip = (localProviderNames as readonly ProviderName[]).includes(providerName)
				? 'Detected locally'
				: 'Detected from provider API'

			const detailAboutModel = type === 'autodetected' ?
				<Asterisk size={14} className="inline-block align-text-top brightness-115 stroke-[2] text-[#8FD96A]" data-tooltip-id='void-tooltip' data-tooltip-place='right' data-tooltip-content={autodetectedTooltip} />
				: type === 'custom' ?
					<Asterisk size={14} className="inline-block align-text-top brightness-115 stroke-[2] text-[#8FD96A]" data-tooltip-id='void-tooltip' data-tooltip-place='right' data-tooltip-content='Custom model' />
					: undefined

			const hasOverrides = Object.keys(settingsState.overridesOfModel?.[providerName]?.[modelName] ?? {}).some(key => key !== '_discoveredCapabilities')

			return <React.Fragment key={`${modelName}${providerName}`}>
				{isNewProviderName ? <ProviderHeader>{providerTitle}</ProviderHeader> : null}
				<SettingRow
					compact
					title={
						<span className="inline-flex items-center gap-2">
							<span className="truncate">{modelName}</span>
							{detailAboutModel}
						</span>
					}
					description={disabled ? `Configure ${providerTitle} to enable this model.` : undefined}
					control={
						<div className="flex items-center gap-2 group">
							{disabled ? null : (
								<button
									type="button"
									onClick={() => { setOpenSettingsModel({ modelName, providerName, type }) }}
									data-tooltip-id='void-tooltip'
									data-tooltip-place='right'
									data-tooltip-content='Advanced Settings'
									className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
								>
									<Plus size={12} className="text-void-fg-3 opacity-50" />
								</button>
							)}
							<VoidSwitch
								value={value}
								onChange={() => { settingsStateService.toggleModelHidden(providerName, modelName); }}
								disabled={disabled}
								size='sm'
								data-tooltip-id='void-tooltip'
								data-tooltip-place='right'
								data-tooltip-content={tooltipName}
							/>
							{type === 'default' || type === 'autodetected' ? null : (
								<button
									type="button"
									onClick={() => { settingsStateService.deleteModel(providerName, modelName); }}
									data-tooltip-id='void-tooltip'
									data-tooltip-place='right'
									data-tooltip-content='Delete'
									className="opacity-0 group-hover:opacity-100 transition-opacity"
								>
									<X size={12} className="text-void-fg-3 opacity-50" />
								</button>
							)}
						</div>
					}
				/>
			</React.Fragment>
		})}
				{routed && openRouterExpanded && !shownModels.length ? <p className='px-4 py-3 opacity-60'>No matching OpenRouter models.</p> : null}
				</div>
			</React.Fragment>
		})}

		{/* Add Model Section */}
		<CardDivider />
		<div className="px-4 py-3">
		{showCheckmark ? (
			<div>
				<AnimatedCheckmarkButton text='Added' className="bg-[#0e70c0] text-white px-3 py-1 rounded-sm" />
			</div>
		) : isAddModelOpen ? (
			<div className="mt-4">
				<form className="flex items-center gap-2">

					{/* Provider dropdown */}
					<ErrorBoundary>
						<VoidCustomDropdownBox
							options={providersToShow}
							selectedOption={userChosenProviderName}
							onChangeOption={(pn) => setUserChosenProviderName(pn)}
							getOptionDisplayName={(pn) => pn ? displayInfoOfProviderName(pn).title : 'Provider Name'}
							getOptionDropdownName={(pn) => pn ? displayInfoOfProviderName(pn).title : 'Provider Name'}
							getOptionsEqual={(a, b) => a === b}
							className="max-w-32 mx-2 w-full resize-none bg-void-bg-1 text-void-fg-1 placeholder:text-void-fg-3 border border-void-border-2 focus:border-void-border-1 py-1 px-2 rounded"
							arrowTouchesText={false}
						/>
					</ErrorBoundary>

					{/* Model name input */}
					<ErrorBoundary>
						<VoidSimpleInputBox
							value={modelName}
							compact={true}
							onChangeValue={setModelName}
							placeholder='Model Name'
							className='max-w-32'
						/>
					</ErrorBoundary>

					{/* Add button */}
					<ErrorBoundary>
						<AddButton
							type='button'
							disabled={!modelName || !userChosenProviderName}
							onClick={handleAddModel}
						/>
					</ErrorBoundary>

					{/* X button to cancel */}
					<button
						type="button"
						onClick={() => {
							setIsAddModelOpen(false);
							setErrorString('');
							setModelName('');
							setUserChosenProviderName(null);
						}}
						className='text-void-fg-4'
					>
						<X className='size-4' />
					</button>
				</form>

				{errorString && (
					<div className='text-red-500 truncate whitespace-nowrap mt-1'>
						{errorString}
					</div>
				)}
			</div>
		) : (
			<div
				className="text-void-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer"
				onClick={() => setIsAddModelOpen(true)}
			>
				<div className="flex items-center gap-1">
					<Plus size={16} />
					<span>Add a model</span>
				</div>
			</div>
		)}
		</div>
		</SettingsCard>

		{/* Model Settings Dialog */}
		<SimpleModelSettingsDialog
			isOpen={openSettingsModel !== null}
			onClose={() => setOpenSettingsModel(null)}
			modelInfo={openSettingsModel}
		/>
	</>
}

// providers

const ProviderSetting = ({ providerName, settingName, subTextMd }: { providerName: ProviderName, settingName: SettingName, subTextMd: React.ReactNode }) => {

	const { title: settingTitle, placeholder, isPasswordField } = displayInfoOfSettingName(providerName, settingName)

	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()

	const settingValue = settingsState.settingsOfProvider[providerName][settingName] as string // this should always be a string in this component
	if (typeof settingValue !== 'string') {
		console.log('Error: Provider setting had a non-string value.')
		return
	}

	// Create a stable callback reference using useCallback with proper dependencies
	const handleChangeValue = useCallback((newVal: string) => {
		voidSettingsService.setSettingOfProvider(providerName, settingName, newVal)
	}, [voidSettingsService, providerName, settingName]);

	return <ErrorBoundary>
		<div className='my-1'>
			<VoidSimpleInputBox
				value={settingValue}
				onChangeValue={handleChangeValue}
				placeholder={`${settingTitle} (${placeholder})`}
				passwordBlur={isPasswordField}
				compact={true}
			/>
			{!subTextMd ? null : <div className='py-1 px-3 opacity-50 text-sm'>
				{subTextMd}
			</div>}
		</div>
	</ErrorBoundary>
}

// const OldSettingsForProvider = ({ providerName, showProviderTitle }: { providerName: ProviderName, showProviderTitle: boolean }) => {
// 	const voidSettingsState = useSettingsState()

// 	const needsModel = isProviderNameDisabled(providerName, voidSettingsState) === 'addModel'

// 	// const accessor = useAccessor()
// 	// const voidSettingsService = accessor.get('IVoidSettingsService')

// 	// const { enabled } = voidSettingsState.settingsOfProvider[providerName]
// 	const settingNames = customSettingNamesOfProvider(providerName)

// 	const { title: providerTitle } = displayInfoOfProviderName(providerName)

// 	return <div className='my-4'>

// 		<div className='flex items-center w-full gap-4'>
// 			{showProviderTitle && <h3 className='text-xl truncate'>{providerTitle}</h3>}

// 			{/* enable provider switch */}
// 			{/* <VoidSwitch
// 				value={!!enabled}
// 				onChange={
// 					useCallback(() => {
// 						const enabledRef = voidSettingsService.state.settingsOfProvider[providerName].enabled
// 						voidSettingsService.setSettingOfProvider(providerName, 'enabled', !enabledRef)
// 					}, [voidSettingsService, providerName])}
// 				size='sm+'
// 			/> */}
// 		</div>

// 		<div className='px-0'>
// 			{/* settings besides models (e.g. api key) */}
// 			{settingNames.map((settingName, i) => {
// 				return <ProviderSetting key={settingName} providerName={providerName} settingName={settingName} />
// 			})}

// 			{needsModel ?
// 				providerName === 'ollama' ?
// 					<WarningBox text={`Please install an Ollama model. We'll auto-detect it.`} />
// 					: <WarningBox text={`Please add a model for ${providerTitle} (Models section).`} />
// 				: null}
// 		</div>
// 	</div >
// }


// Grok (Plan) authenticates via the `grok login` subscription token (~/.grok/auth.json), not an
// API key — so instead of a key field we show live sign-in status and a one-click "Sign in with
// Grok" that opens a terminal running `grok login`. Status is read live from the main process.
// Exported so Settings > Account can surface the same card: "log into my Grok account" is what a
// user looks for under Account, not buried under a provider row in Models.
export const GrokPlanSignInCard = () => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const commandService = accessor.get('ICommandService')

	const [status, setStatus] = useState<{ signedIn: boolean; email?: string; expiresAt?: string } | null>(null)
	const [checking, setChecking] = useState(false)
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

	const refresh = useCallback(async () => {
		setChecking(true)
		try { setStatus(await llmMessageService.grokPlanStatus()) }
		finally { setChecking(false) }
	}, [llmMessageService])

	useEffect(() => {
		refresh()
		return () => { if (pollRef.current) { clearInterval(pollRef.current) } }
	}, [refresh])

	const signIn = useCallback(async () => {
		await commandService.executeCommand('v3code.grok.signIn')
		// `grok login` completes out-of-band in the browser; poll so the card flips to signed-in
		// on its own (bounded — stop after ~1 min or once signed in).
		if (pollRef.current) { clearInterval(pollRef.current) }
		let tries = 0
		pollRef.current = setInterval(async () => {
			tries++
			const s = await llmMessageService.grokPlanStatus()
			if (s.signedIn || tries > 30) {
				setStatus(s)
				if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
			}
		}, 2000)
	}, [commandService, llmMessageService])

	const expiryText = useMemo(() => {
		if (!status?.expiresAt) { return null }
		const t = Date.parse(status.expiresAt)
		if (Number.isNaN(t)) { return null }
		const mins = Math.round((t - Date.now()) / 60000)
		if (mins <= 0) { return 'token expired — will refresh on next use' }
		if (mins < 90) { return `token valid ~${mins} min (auto-refreshes)` }
		return `token valid ~${Math.round(mins / 60)} h (auto-refreshes)`
	}, [status])

	return (
		<div className="px-4 py-3 flex flex-col gap-3">
			<div className="opacity-80 text-sm">
				<ChatMarkdownRender string={subTextMdOfProviderName('grokPlan')} chatMessageLocation={undefined} />
			</div>

			<div className="flex items-center gap-2 text-sm">
				{status === null ? (
					<span className="opacity-60 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking Grok sign-in…</span>
				) : status.signedIn ? (
					<span className="flex items-center gap-1.5">
						<Check className="w-4 h-4" style={{ color: ACCENT }} />
						<span>Signed in{status.email ? <> as <b>{status.email}</b></> : null}.</span>
						{expiryText ? <span className="opacity-60">({expiryText})</span> : null}
					</span>
				) : (
					<span className="opacity-70">Not signed in to Grok.</span>
				)}
			</div>

			<div className="flex items-center gap-2">
				<VoidButtonBgDarken onClick={signIn}>
					{status?.signedIn ? 'Re-sign in with Grok' : 'Sign in with Grok'}
				</VoidButtonBgDarken>
				<button
					onClick={refresh}
					disabled={checking}
					className="px-2 py-1 rounded-sm text-xs opacity-70 hover:opacity-100 flex items-center gap-1 disabled:opacity-40"
				>
					<RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /> Recheck
				</button>
			</div>
		</div>
	)
}

// The other CLI-backed subscription lanes (Claude Pro/Max, GitHub Copilot). Same shape as the
// Grok card above — live status from the main process, a button that opens a terminal running the
// vendor's login, then a bounded poll so the card flips to signed-in on its own once the
// out-of-band browser OAuth finishes. Grok keeps its own component because its store reports
// expiry as an ISO string where these report epoch ms.
type SubscriptionCardStatus = { signedIn: boolean; expiresAt?: number; detail?: string }

const SubscriptionSignInCard = ({ providerName, vendorLabel, signInCommandId, fetchStatus }: {
	providerName: ProviderName
	vendorLabel: string
	signInCommandId: string
	fetchStatus: () => Promise<SubscriptionCardStatus>
}) => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')

	const [status, setStatus] = useState<SubscriptionCardStatus | null>(null)
	const [checking, setChecking] = useState(false)
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

	const refresh = useCallback(async () => {
		setChecking(true)
		try { setStatus(await fetchStatus()) }
		finally { setChecking(false) }
	}, [fetchStatus])

	useEffect(() => {
		refresh()
		return () => { if (pollRef.current) { clearInterval(pollRef.current) } }
	}, [refresh])

	const signIn = useCallback(async () => {
		await commandService.executeCommand(signInCommandId)
		if (pollRef.current) { clearInterval(pollRef.current) }
		let tries = 0
		pollRef.current = setInterval(async () => {
			tries++
			const s = await fetchStatus()
			if (s.signedIn || tries > 30) {
				setStatus(s)
				if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
			}
		}, 2000)
	}, [commandService, signInCommandId, fetchStatus])

	const expiryText = useMemo(() => {
		if (typeof status?.expiresAt !== 'number') { return null }
		const mins = Math.round((status.expiresAt - Date.now()) / 60000)
		if (mins <= 0) { return 'token expired — will refresh on next use' }
		if (mins < 90) { return `token valid ~${mins} min (auto-refreshes)` }
		return `token valid ~${Math.round(mins / 60)} h (auto-refreshes)`
	}, [status])

	return (
		<div className="px-4 py-3 flex flex-col gap-3">
			<div className="opacity-80 text-sm">
				<ChatMarkdownRender string={subTextMdOfProviderName(providerName)} chatMessageLocation={undefined} />
			</div>

			<div className="flex items-center gap-2 text-sm">
				{status === null ? (
					<span className="opacity-60 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking {vendorLabel} sign-in…</span>
				) : status.signedIn ? (
					<span className="flex items-center gap-1.5">
						<Check className="w-4 h-4" style={{ color: ACCENT }} />
						<span>Signed in{status.detail ? <> as <b>{status.detail}</b></> : null}.</span>
						{expiryText ? <span className="opacity-60">({expiryText})</span> : null}
					</span>
				) : (
					<span className="opacity-70">Not signed in to {vendorLabel}.</span>
				)}
			</div>

			<div className="flex items-center gap-2">
				<VoidButtonBgDarken onClick={signIn}>
					{status?.signedIn ? `Re-sign in with ${vendorLabel}` : `Sign in with ${vendorLabel}`}
				</VoidButtonBgDarken>
				<button
					onClick={refresh}
					disabled={checking}
					className="px-2 py-1 rounded-sm text-xs opacity-70 hover:opacity-100 flex items-center gap-1 disabled:opacity-40"
				>
					<RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /> Recheck
				</button>
			</div>
		</div>
	)
}

export const ClaudePlanSignInCard = () => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const fetchStatus = useCallback(async (): Promise<SubscriptionCardStatus> => {
		const s = await llmMessageService.claudePlanStatus()
		// The credential store has no email field, so fall back to naming the plan tier — it is
		// the only identifying thing we can honestly show before the first token refresh.
		const detail = s.email ?? (s.subscriptionType ? `Claude ${s.subscriptionType}` : undefined)
		return { signedIn: s.signedIn, expiresAt: s.expiresAt, detail }
	}, [llmMessageService])
	return <SubscriptionSignInCard
		providerName="claudePlan"
		vendorLabel="Claude"
		signInCommandId="v3code.claude.signIn"
		fetchStatus={fetchStatus}
	/>
}

export const CopilotSignInCard = () => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const refreshModelService = accessor.get('IRefreshModelService')
	const fetchStatus = useCallback(async (): Promise<SubscriptionCardStatus> => {
		const s = await llmMessageService.copilotStatus()
		if (s.signedIn) {
			// Recheck is also the recovery button for a stale/partial model catalogue.
			refreshModelService.startRefreshingModels('copilot', { enableProviderOnSuccess: true, doNotFire: false })
		}
		// Copilot's session token is exchanged on demand and lives ~30 min, so there is no
		// user-facing expiry worth showing — the underlying GitHub token is long-lived.
		return { signedIn: s.signedIn, detail: s.login }
	}, [llmMessageService, refreshModelService])
	return <SubscriptionSignInCard
		providerName="copilot"
		vendorLabel="Copilot"
		signInCommandId="v3code.copilot.signIn"
		fetchStatus={fetchStatus}
	/>
}

export const GeminiPlanSignInCard = () => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const fetchStatus = useCallback(async (): Promise<SubscriptionCardStatus> => {
		const s = await llmMessageService.geminiPlanStatus()
		return { signedIn: s.signedIn, expiresAt: s.expiresAt, detail: s.email }
	}, [llmMessageService])
	return <SubscriptionSignInCard
		providerName="geminiPlan"
		vendorLabel="Google"
		signInCommandId="v3code.gemini.signIn"
		fetchStatus={fetchStatus}
	/>
}

/** ChatGPT Plus/Pro plan lane — no API key, so the card itself has to start the login.
 *  `codex login` (see subscriptionSignInActions.ts) opens the OAuth round trip and writes
 *  ~/.codex/auth.json, which openaiPlanSubscriptionAuth.ts reads live in the main process. */
export const OpenaiPlanSignInCard = () => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const fetchStatus = useCallback(async (): Promise<SubscriptionCardStatus> => {
		const s = await llmMessageService.openaiPlanStatus()
		return { signedIn: s.signedIn, expiresAt: s.expiresAt, detail: s.email }
	}, [llmMessageService])
	return <SubscriptionSignInCard
		providerName="openaiPlan"
		vendorLabel="ChatGPT"
		signInCommandId="v3code.openaiPlan.signIn"
		fetchStatus={fetchStatus}
	/>
}

/** Cursor (Local) has no in-editor login — the "API for Cursor" desktop app holds the key.
 *  We only probe whether that local server is reachable. */
export const CursorLocalSignInCard = () => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const voidSettingsState = useSettingsState()
	const endpoint = voidSettingsState.settingsOfProvider.cursorLocal?.endpoint

	const [status, setStatus] = useState<{ signedIn: boolean; models?: string[] } | null>(null)
	const [checking, setChecking] = useState(false)

	const refresh = useCallback(async () => {
		setChecking(true)
		try { setStatus(await llmMessageService.cursorLocalStatus(endpoint)) }
		finally { setChecking(false) }
	}, [llmMessageService, endpoint])

	useEffect(() => { refresh() }, [refresh])

	return (
		<div className="px-4 py-3 flex flex-col gap-3">
			<div className="opacity-80 text-sm">
				<ChatMarkdownRender string={subTextMdOfProviderName('cursorLocal')} chatMessageLocation={undefined} />
			</div>
			<div className="flex items-center gap-2 text-sm">
				{status === null ? (
					<span className="opacity-60 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking local Cursor app…</span>
				) : status.signedIn ? (
					<span className="flex items-center gap-1.5">
						<Check className="w-4 h-4" style={{ color: ACCENT }} />
						<span>Local Cursor app is running{status.models?.length ? <> ({status.models.length} models)</> : null}.</span>
					</span>
				) : (
					<span className="opacity-70">API for Cursor is not running at {endpoint || 'http://127.0.0.1:8788/v1'}.</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				<button
					onClick={refresh}
					disabled={checking}
					className="px-2 py-1 rounded-sm text-xs opacity-70 hover:opacity-100 flex items-center gap-1 disabled:opacity-40"
				>
					<RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /> Recheck
				</button>
			</div>
		</div>
	)
}

export const SettingsForProvider = ({ providerName, showProviderTitle, showProviderSuggestions, showHealthBadge = true }: { providerName: ProviderName, showProviderTitle: boolean, showProviderSuggestions: boolean, showHealthBadge?: boolean }) => {
	const voidSettingsState = useSettingsState()

	const needsModel = isProviderNameDisabled(providerName, voidSettingsState) === 'addModel'

	// const accessor = useAccessor()
	// const voidSettingsService = accessor.get('IVoidSettingsService')

	// const { enabled } = voidSettingsState.settingsOfProvider[providerName]
	const settingNames = customSettingNamesOfProvider(providerName)

	const { title: providerTitle } = displayInfoOfProviderName(providerName)

	return <SettingsSection label={showProviderTitle ? providerTitle : undefined}>
		<SettingsCard>
			{showHealthBadge ? <ProviderHealthBadge providerName={providerName} /> : null}
			{providerName === 'grokPlan' ? (
				<GrokPlanSignInCard />
			) : providerName === 'claudePlan' ? (
				<ClaudePlanSignInCard />
			) : providerName === 'copilot' ? (
				<CopilotSignInCard />
			) : providerName === 'geminiPlan' ? (
				<GeminiPlanSignInCard />
			) : providerName === 'openaiPlan' ? (
				<OpenaiPlanSignInCard />
			) : providerName === 'cursorLocal' ? (
				<>
					<CursorLocalSignInCard />
					{settingNames.map((settingName, i) => (
						<React.Fragment key={settingName}>
							<CardDivider />
							<div className="px-4 py-2">
								<ProviderSetting
									providerName={providerName}
									settingName={settingName}
									subTextMd={null}
								/>
							</div>
						</React.Fragment>
					))}
				</>
			) : settingNames.map((settingName, i) => (
				<React.Fragment key={settingName}>
					{i > 0 ? <CardDivider /> : null}
					<div className="px-4 py-2">
						<ProviderSetting
							providerName={providerName}
							settingName={settingName}
							subTextMd={i !== settingNames.length - 1 ? null
								: <ChatMarkdownRender string={subTextMdOfProviderName(providerName)} chatMessageLocation={undefined} />}
						/>
					</div>
				</React.Fragment>
			))}

			{showProviderSuggestions && needsModel ? (
				<>
					<CardDivider />
					<div className="px-4 py-3">
						{providerName === 'ollama'
							? <WarningBox text={`Please install an Ollama model. We'll auto-detect it.`} />
							: <WarningBox text={`Please add a model for ${providerTitle} (Models section).`} />}
					</div>
				</>
			) : null}
		</SettingsCard>
	</SettingsSection>
}


export const VoidProviderSettings = ({ providerNames }: { providerNames: ProviderName[] }) => {
	return <>
		{providerNames.map(providerName =>
			<SettingsForProvider key={providerName} providerName={providerName} showProviderTitle={true} showProviderSuggestions={true} />
		)}
	</>
}


type TabName = 'models' | 'general'
export const AutoDetectLocalModelsToggleControl = () => {
	const settingName: GlobalSettingName = 'autoRefreshModels'
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const metricsService = accessor.get('IMetricsService')
	const voidSettingsState = useSettingsState()
	const enabled = voidSettingsState.globalSettings[settingName]
	return <VoidSwitch
		size='xs'
		value={enabled}
		onChange={(newVal) => {
			voidSettingsService.setGlobalSetting(settingName, newVal)
			metricsService.capture('Click', { action: 'Autorefresh Toggle', settingName, enabled: newVal })
		}}
	/>
}

export const RefreshableModelsRows = () => {
	const settingsState = useSettingsState()
	const rows = refreshableProviderNames.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) return null
		return <RefreshModelRow key={providerName} providerName={providerName} />
	}).filter(Boolean)
	if (!rows.length) return null
	return <>{rows}</>
}

const RefreshModelRow = ({ providerName }: { providerName: RefreshableProviderName }) => {
	const refreshModelState = useRefreshModelState()
	const accessor = useAccessor()
	const refreshModelService = accessor.get('IRefreshModelService')
	const metricsService = accessor.get('IMetricsService')
	const [justFinished, setJustFinished] = useState<null | 'finished' | 'error'>(null)

	useRefreshModelListener(
		useCallback((providerName2, state) => {
			if (providerName2 !== providerName) return
			const { state: s } = state[providerName]
			if (!(s === 'finished' || s === 'error')) return
			setJustFinished(s)
			const tid = setTimeout(() => { setJustFinished(null) }, 2000)
			return () => clearTimeout(tid)
		}, [providerName])
	)

	const { state } = refreshModelState[providerName]
	const { title: providerTitle } = displayInfoOfProviderName(providerName)
	const busy = state === 'refreshing' || justFinished !== null

	return (
		<>
			<CardDivider />
			<SettingRow
				title={`Refresh ${providerTitle} models`}
				description={
					justFinished === 'finished' ? `${providerTitle} models are up to date.`
						: justFinished === 'error' ? `${providerTitle} not found.`
							: `Manually refresh detected ${providerTitle} models.`
				}
				control={
					<button
						type="button"
						className="@@v3code-settings-btn-secondary"
						disabled={busy}
						onClick={() => {
							refreshModelService.startRefreshingModels(providerName, { enableProviderOnSuccess: false, doNotFire: false })
							metricsService.capture('Click', { providerName, action: 'Refresh Models' })
						}}
					>
						{justFinished === 'finished' ? <Check className='stroke-green-500 size-3' />
							: justFinished === 'error' ? <X className='stroke-red-500 size-3' />
								: state === 'refreshing' ? <Loader2 className='size-3 animate-spin' />
									: <RefreshCw className='size-3' />}
					</button>
				}
			/>
		</>
	)
}

export const AutoDetectLocalModelsToggle = () => {
	const settingName: GlobalSettingName = 'autoRefreshModels'

	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const metricsService = accessor.get('IMetricsService')

	const voidSettingsState = useSettingsState()

	// right now this is just `enabled_autoRefreshModels`
	const enabled = voidSettingsState.globalSettings[settingName]

	return <ButtonLeftTextRightOption
		leftButton={<VoidSwitch
			size='xxs'
			value={enabled}
			onChange={(newVal) => {
				voidSettingsService.setGlobalSetting(settingName, newVal)
				metricsService.capture('Click', { action: 'Autorefresh Toggle', settingName, enabled: newVal })
			}}
		/>}
		text={`Automatically detect local providers and models (${refreshableProviderNames.map(providerName => displayInfoOfProviderName(providerName).title).join(', ')}).`}
	/>


}

export const AIInstructionsBox = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	return <VoidInputBox2
		className='min-h-[81px] p-3 rounded-sm'
		initValue={voidSettingsState.globalSettings.aiInstructions}
		placeholder={`Do not change my indentation or delete my comments. When writing TS or JS, do not add ;'s. Write new code using Rust if possible. `}
		multiline
		onChangeText={(newText) => {
			voidSettingsService.setGlobalSetting('aiInstructions', newText)
		}}
	/>
}

export const OllamaSetupInstructions = ({ sayWeAutoDetect }: { sayWeAutoDetect?: boolean }) => {
	return <div className='prose-p:my-0 prose-ol:list-decimal prose-p:py-0 prose-ol:my-0 prose-ol:py-0 prose-span:my-0 prose-span:py-0 text-void-fg-3 text-sm list-decimal select-text'>
		<div className=''><ChatMarkdownRender string={`Ollama Setup Instructions`} chatMessageLocation={undefined} /></div>
		<div className=' pl-6'><ChatMarkdownRender string={`1. Download [Ollama](https://ollama.com/download).`} chatMessageLocation={undefined} /></div>
		<div className=' pl-6'><ChatMarkdownRender string={`2. Open your terminal.`} chatMessageLocation={undefined} /></div>
		<div
			className='pl-6 flex items-center w-fit'
			data-tooltip-id='void-tooltip-ollama-settings'
		>
			<ChatMarkdownRender string={`3. Run \`ollama pull your_model\` to install a model.`} chatMessageLocation={undefined} />
		</div>
		{sayWeAutoDetect && <div className=' pl-6'><ChatMarkdownRender string={`V3Code automatically detects locally running models and enables them.`} chatMessageLocation={undefined} /></div>}
	</div>
}


export const RedoOnboardingButton = ({ className }: { className?: string }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	return <div
		className={`text-void-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer ${className}`}
		onClick={() => { voidSettingsService.setGlobalSetting('isOnboardingComplete', false) }}
	>
		See onboarding screen?
	</div>

}







export const ToolApprovalTypeSwitch = ({ approvalType, size, desc }: { approvalType: ToolApprovalType, size: "xxs" | "xs" | "sm" | "sm+" | "md", desc?: string }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	const metricsService = accessor.get('IMetricsService')

	const onToggleAutoApprove = useCallback((approvalType: ToolApprovalType, newValue: boolean) => {
		voidSettingsService.setGlobalSetting('autoApprove', {
			...voidSettingsService.state.globalSettings.autoApprove,
			[approvalType]: newValue
		})
		metricsService.capture('Tool Auto-Accept Toggle', { enabled: newValue })
	}, [voidSettingsService, metricsService])

	return <>
		<VoidSwitch
			size={size}
			value={voidSettingsState.globalSettings.autoApprove[approvalType] ?? false}
			onChange={(newVal) => onToggleAutoApprove(approvalType, newVal)}
		/>
		{desc ? <span className="text-void-fg-3 text-xs">{desc}</span> : null}
	</>
}



export const OneClickSwitchButton = ({ fromEditor = 'VS Code', className = '' }: { fromEditor?: TransferEditorType, className?: string }) => {
	const accessor = useAccessor()
	const extensionTransferService = accessor.get('IExtensionTransferService')

	const [transferState, setTransferState] = useState<{ type: 'done', error?: string } | { type: | 'loading' | 'justfinished' }>({ type: 'done' })



	const onClick = async () => {
		if (transferState.type !== 'done') return

		setTransferState({ type: 'loading' })

		const errAcc = await extensionTransferService.transferExtensions(os, fromEditor)

		// Even if some files were missing, consider it a success if no actual errors occurred
		const hadError = !!errAcc
		if (hadError) {
			setTransferState({ type: 'done', error: errAcc })
		}
		else {
			setTransferState({ type: 'justfinished' })
			setTimeout(() => { setTransferState({ type: 'done' }); }, 3000)
		}
	}

	return <>
		<VoidButtonBgDarken className={`max-w-48 p-4 ${className}`} disabled={transferState.type !== 'done'} onClick={onClick}>
			{transferState.type === 'done' ? `Transfer from ${fromEditor}`
				: transferState.type === 'loading' ? <span className='text-nowrap flex flex-nowrap'>Transferring<IconLoading /></span>
					: transferState.type === 'justfinished' ? <AnimatedCheckmarkButton text='Settings Transferred' className='bg-none' />
						: null
			}
		</VoidButtonBgDarken>
		{transferState.type === 'done' && transferState.error ? <WarningBox text={transferState.error} /> : null}
	</>
}

/** Second-click confirm for destructive actions (reset settings / chats). */
export const ConfirmButton = ({ children, onConfirm, className }: { children: React.ReactNode, onConfirm: () => void, className?: string }) => {
	const [confirm, setConfirm] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!confirm) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setConfirm(false);
			}
		};
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	}, [confirm]);
	return (
		<div ref={ref} className="inline-block">
			<VoidButtonBgDarken className={className} onClick={() => {
				if (!confirm) {
					setConfirm(true);
				} else {
					onConfirm();
					setConfirm(false);
				}
			}}>
				{confirm ? `Confirm Reset` : children}
			</VoidButtonBgDarken>
		</div>
	);
};
