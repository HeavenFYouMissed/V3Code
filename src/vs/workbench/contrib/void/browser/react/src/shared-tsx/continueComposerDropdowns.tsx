/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Continue Dev-style mode + model controls (VS Code theme tokens, compact sizing).
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react'
import {
	AlertTriangle,
	Check,
	ChevronDown,
	Info,
	MessageCircle,
	Palette,
	Rocket,
	Settings,
	Sparkles,
	Box,
	Bug,
} from 'lucide-react'
import { useAccessor, useSettingsState } from '../util/services.js'
import { ChatMode, FeatureName, isFeatureNameDisabled, modelSelectionsEqual } from '../../../../common/voidSettingsTypes.js'
import { modelFilterOfFeatureName, ModelOption } from '../../../../common/voidSettingsService.js'
import { getModelCapabilities } from '../../../../common/modelCapabilities.js'
import { V3_MODEL_TIERS, tierFromModelSelection, TIER_POWER, TIER_BURN, TierBurn, tierGlyph, isHostedTierId } from '../../../../common/modelTiers.js'
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js'
import { WarningBox } from '../void-settings-tsx/WarningBox.js'

/** Continue ListboxButton / ModeSelect sizing — 11px, tight padding */
const COMPOSER_FONT = '11px'
const COMPOSER_LINE = '16px'

const getMetaKeyLabel = () =>
	typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

// NOTE: this .tsx file is NOT type-checked by the repo gate (tsconfig only includes .ts),
// so a new ChatMode must be added to EVERY map below by hand — a missing key renders a
// blank pill or throws at runtime with no compile error.
type ContinueModeId = 'chat' | 'read' | 'plan' | 'debug' | 'agent' | 'multitask' | 'background'

const VOID_MODE_TO_CONTINUE: Record<ChatMode, ContinueModeId> = {
	chat: 'chat',
	read: 'read',
	plan: 'plan',
	debug: 'debug',
	agent: 'agent',
	multitask: 'multitask',
}

const CONTINUE_TO_VOID: Record<Exclude<ContinueModeId, 'background'>, ChatMode> = {
	chat: 'chat',
	read: 'read',
	plan: 'plan',
	debug: 'debug',
	agent: 'agent',
	multitask: 'multitask',
}

const MODE_LABEL: Record<ContinueModeId, string> = {
	chat: 'Chat',
	read: 'Read',
	plan: 'Plan',
	debug: 'Debug',
	agent: 'Agent',
	multitask: 'Multitask',
	background: 'Background',
}

const MODE_TOOLTIP: Record<ContinueModeId, string> = {
	chat: 'Talk to the agent — no tools, no edits',
	read: 'Read-only tools — investigate without editing',
	plan: 'Investigate and write a markdown plan',
	debug: 'Reproduce, localise, prove the root cause, then a minimal guarded fix — read tools plus file writes, run_command and run_tests',
	agent: 'Full agent — edits, terminal, all tools',
	multitask: 'Foreman — plans, freezes contracts, dispatches parallel work subagents, reconciles. Never edits itself',
	background: 'Background mode (not available in V3Code yet)',
}

/** ~10px — smaller than 11px label text (Continue-style). Inline size beats missing Tailwind arbitrary classes. */
const COMPOSER_ICON_STYLE: React.CSSProperties = { width: 10, height: 10, flexShrink: 0, opacity: 0.85 }

const ContinueModeIcon = ({ mode, className }: { mode: ContinueModeId; className?: string }) => {
	const props = { className, style: COMPOSER_ICON_STYLE, strokeWidth: 2 as const }
	switch (mode) {
		case 'agent': return <Sparkles {...props} />
		case 'plan': return <Palette {...props} />
		case 'read': return <Palette {...props} />
		case 'debug': return <Bug {...props} style={{ ...COMPOSER_ICON_STYLE, color: 'var(--vscode-problemsErrorIcon-foreground)' }} />
		case 'chat': return <MessageCircle {...props} />
		case 'multitask': return <Box {...props} />
		case 'background': return <Rocket {...props} />
	}
}

const InfoTip = ({ content }: { content: string }) => (
	<span
		className='inline-flex opacity-60 hover:opacity-100 cursor-help'
		style={{ color: 'var(--vscode-descriptionForeground)' }}
		data-tooltip-id='void-tooltip'
		data-tooltip-content={content}
		data-tooltip-place='top'
	>
		<Info className='h-[10px] w-[10px] flex-shrink-0' strokeWidth={2} />
	</span>
)

const useContinueFloating = () => {
	const [isOpen, setIsOpen] = useState(false)
	const { x, y, strategy, refs } = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'bottom-start',
		middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	})
	useEffect(() => {
		if (!isOpen) return
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node
			const f = refs.floating.current
			const r = refs.reference.current
			if (f?.contains(t) || (r instanceof HTMLElement && r.contains(t))) return
			setIsOpen(false)
		}
		document.addEventListener('mousedown', onDown)
		return () => document.removeEventListener('mousedown', onDown)
	}, [isOpen, refs.floating, refs.reference])
	return { isOpen, setIsOpen, x, y, strategy, refs }
}

const panelStyle: React.CSSProperties = {
	background: 'var(--vscode-input-background)',
	border: '1px solid var(--vscode-widget-border)',
	borderRadius: 4,
	boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
	zIndex: 200000,
	fontSize: COMPOSER_FONT,
	lineHeight: COMPOSER_LINE,
}

const modePillStyle: React.CSSProperties = {
	fontSize: COMPOSER_FONT,
	lineHeight: COMPOSER_LINE,
	color: 'var(--vscode-descriptionForeground)',
	background: 'color-mix(in srgb, var(--vscode-input-background) 55%, var(--vscode-foreground) 8%)',
}

const tierPillStyle: React.CSSProperties = {
	fontSize: '9px',
	lineHeight: '12px',
	padding: '0 4px',
	borderRadius: 9999,
	color: 'var(--vscode-badge-foreground, #fff)',
	background: 'var(--vscode-badge-background, var(--vscode-textLink-foreground))',
	fontWeight: 600,
	flexShrink: 0,
}

// Power rating as 6 monochrome bubbles (N filled): same ladder as Settings > Chat tiers.
const PowerBubbles = ({ n }: { n: number }) => (
	<span className='inline-flex items-center gap-[2px] shrink-0' title={`Power ${n}/6`} aria-label={`Power ${n} of 6`}>
		{Array.from({ length: 6 }, (_, i) => (
			<span key={i} style={{
				width: 5, height: 5, borderRadius: 9999,
				background: 'var(--vscode-foreground)',
				opacity: i < n ? 0.85 : 0.22,
			}} />
		))}
	</span>
)

const BURN_LABEL: Record<TierBurn, string> = { cheap: 'Cheap', mid: 'Mid', heavy: 'Heavy' }
// Relative burn hint only (no price). Opacity scales with burn class.
const BurnBadge = ({ burn }: { burn: TierBurn }) => (
	<span title={`Burn: ${BURN_LABEL[burn]}`} className='shrink-0' style={{
		fontSize: '9px', letterSpacing: '0.4px', textTransform: 'uppercase', fontWeight: 600,
		padding: '1px 5px', borderRadius: 9999,
		border: '1px solid var(--vscode-foreground)', color: 'var(--vscode-foreground)',
		opacity: burn === 'heavy' ? 0.8 : burn === 'mid' ? 0.6 : 0.42,
	}}>{BURN_LABEL[burn]}</span>
)

const modelPillStyle: React.CSSProperties = {
	fontSize: COMPOSER_FONT,
	lineHeight: COMPOSER_LINE,
	color: 'var(--vscode-foreground)',
	background: 'var(--vscode-input-background)',
	border: '1px solid var(--vscode-widget-border)',
	borderRadius: 4,
}

export const ContinueModeSelect = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()
	const { isOpen, setIsOpen, x, y, strategy, refs } = useContinueFloating()

	const voidMode = settingsState.globalSettings.chatMode
	const mode = VOID_MODE_TO_CONTINUE[voidMode]
	const metaKey = getMetaKeyLabel()

	const modelSel = settingsState.modelSelectionOfFeature?.Chat ?? null
	const isGoodAtAgent = useMemo(() => {
		if (!modelSel) return true
		const caps = getModelCapabilities(modelSel.providerName, modelSel.modelName, settingsState.overridesOfModel)
		return !!caps.specialToolFormat
	}, [modelSel, settingsState.overridesOfModel])

	const setMode = useCallback((m: ContinueModeId) => {
		if (m === 'background') return
		voidSettingsService.setGlobalSetting('chatMode', CONTINUE_TO_VOID[m])
		setIsOpen(false)
	}, [voidSettingsService, setIsOpen])

	const cycleMode = useCallback(() => {
		const order: ContinueModeId[] = ['chat', 'read', 'plan', 'debug', 'agent', 'multitask']
		const i = order.indexOf(mode === 'background' ? 'agent' : mode)
		setMode(order[(i + 1) % order.length])
	}, [mode, setMode])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				cycleMode()
			}
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [cycleMode])

	const warn = !isGoodAtAgent ? (
		<AlertTriangle className='text-[var(--vscode-editorWarning-foreground,#cca700)] h-[10px] w-[10px] flex-shrink-0' strokeWidth={2} />
	) : null

	const renderOption = (id: ContinueModeId, disabled = false) => {
		const selected = mode === id
		return (
			<button
				key={id}
				type='button'
				disabled={disabled}
				className={`continue-composer-control w-full flex items-center gap-1 px-2 py-0.5 text-left transition-colors
					${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
					${!disabled && !selected ? 'hover:bg-[var(--vscode-list-hoverBackground)]' : ''}
					${selected ? 'bg-[var(--vscode-list-activeSelectionBackground)]' : ''}`}
				style={{ color: disabled ? 'var(--vscode-disabledForeground)' : 'var(--vscode-foreground)' }}
				onClick={() => !disabled && setMode(id)}
			>
				<div className='flex flex-row items-center gap-1 flex-1 min-w-0'>
					<ContinueModeIcon mode={id} />
					<span>{MODE_LABEL[id]}</span>
					<InfoTip content={MODE_TOOLTIP[id]} />
					{id === 'chat' && (
						<span className='ml-auto opacity-60' style={{ fontSize: '10px' }}>{metaKey}L</span>
					)}
				</div>
				{(id === 'plan' || id === 'debug' || id === 'agent' || id === 'multitask') && warn}
				<Check className={`h-[10px] w-[10px] flex-shrink-0 ml-0.5 ${selected ? 'opacity-90' : 'opacity-0'}`} strokeWidth={2.5} />
			</button>
		)
	}

	return (
		<div className='inline-block relative shrink-0'>
			<button
				type='button'
				ref={refs.setReference}
				className='continue-composer-control inline-flex items-center gap-1 rounded-full border-0 px-1.5 py-0.5 transition-all duration-200 hover:brightness-110 cursor-pointer h-5'
				style={modePillStyle}
				onClick={() => setIsOpen(v => !v)}
				data-tooltip-id='void-tooltip'
				data-tooltip-content={`${metaKey}. to cycle mode`}
				data-tooltip-place='top'
			>
				<ContinueModeIcon mode={mode} />
				<span>{MODE_LABEL[mode]}</span>
				<ChevronDown className='h-[8px] w-[8px] flex-shrink-0 opacity-60' strokeWidth={2.5} />
			</button>
			{isOpen && (
				<div
					ref={refs.setFloating}
					className='continue-composer-menu flex flex-col min-w-[8rem] max-w-[12rem] py-0.5 overflow-hidden'
					style={{ ...panelStyle, position: strategy, top: y ?? 0, left: x ?? 0, visibility: x === null || y === null ? 'hidden' : 'visible' }}
				>
					{renderOption('chat')}
					{renderOption('read')}
					{renderOption('plan')}
					{renderOption('debug')}
					{renderOption('agent')}
					{renderOption('multitask')}
					{renderOption('background', true)}
					<div className='px-2 py-0.5 opacity-60' style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
						{metaKey} . for next mode
					</div>
				</div>
			)}
		</div>
	)
}

const optionsEqual = (m1: ModelOption[], m2: ModelOption[]) => {
	if (m1.length !== m2.length) return false
	for (let i = 0; i < m1.length; i++) {
		if (!modelSelectionsEqual(m1[i].selection, m2[i].selection)) return false
	}
	return true
}

export const ContinueModelSelect = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const commandService = accessor.get('ICommandService')
	const accountService = accessor.get('IV3CodeAccountService')
	const settingsState = useSettingsState()
	// Re-render on sign-in/plan changes: which branded tiers are offered gates on it.
	const [, forceAccount] = useState(0)
	useEffect(() => {
		const d = accountService.onDidChangeState(() => forceAccount(x => x + 1))
		return () => d.dispose()
	}, [accountService])
	// Only offer tiers the user can actually run: hosted tiers need a paid plan (or a BYOK
	// key for the tier's provider — the send path runs them on it); Opus tiers need an
	// Anthropic key. Unusable tiers used to sit in this menu and fail at send time.
	const acctState = accountService.state
	const usableTiers = V3_MODEL_TIERS.filter(tier => {
		const byok = !!(settingsState.settingsOfProvider[tier.selection.providerName as keyof typeof settingsState.settingsOfProvider] as { apiKey?: string } | undefined)?.apiKey?.trim()
		return isHostedTierId(tier.id) ? ((acctState.status === 'signedIn' && acctState.isPaid) || byok) : byok
	})
	const { isOpen, setIsOpen, x, y, strategy, refs } = useContinueFloating()
	const oldOptionsRef = useRef<ModelOption[]>([])
	const [options, setOptions] = useState<ModelOption[]>(oldOptionsRef.current)

	const { filter, emptyMessage } = modelFilterOfFeatureName[featureName]
	const selection = voidSettingsService.state.modelSelectionOfFeature[featureName]
	const selectedOption = selection
		? voidSettingsService.state._modelOptions.find(v => modelSelectionsEqual(v.selection, selection))
		: undefined

	useEffect(() => {
		const _seen = new Set<string>()
		const newOptions = settingsState._modelOptions
			.filter(o => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))
			.filter(o => {
				const k = `${o.selection.providerName}:${o.selection.modelName}`
				if (_seen.has(k)) return false
				_seen.add(k)
				return true
			})
		if (!optionsEqual(oldOptionsRef.current, newOptions)) {
			setOptions(newOptions)
		}
		oldOptionsRef.current = newOptions
	}, [settingsState._modelOptions, filter, settingsState.globalSettings.chatMode, settingsState.overridesOfModel])

	const isDisabled = isFeatureNameDisabled(featureName, settingsState)
	const metaKey = getMetaKeyLabel()
	const selectionOptions = selection ? settingsState.optionsOfModelSelection[featureName]?.[selection.providerName]?.[selection.modelName] : undefined
	const activeTier = tierFromModelSelection(selection ?? null, selectionOptions)
	const displayName = activeTier?.label ?? selectedOption?.selection.modelName ?? 'Select model'

	const onPickTier = (tier: typeof V3_MODEL_TIERS[number]) => {
		voidSettingsService.setModelSelectionOfFeature(featureName, tier.selection)
		if (tier.options) {
			voidSettingsService.setOptionsOfModelSelection(featureName, tier.selection.providerName, tier.selection.modelName, tier.options)
		}
		setIsOpen(false)
	}

	const onPick = (opt: ModelOption) => {
		voidSettingsService.setModelSelectionOfFeature(featureName, opt.selection)
		setIsOpen(false)
	}

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "'" && (e.metaKey || e.ctrlKey) && !e.shiftKey && options.length > 0) {
				e.preventDefault()
				const idx = Math.max(0, options.findIndex(o => modelSelectionsEqual(o.selection, selection!)))
				const next = options[(idx + 1) % options.length]
				voidSettingsService.setModelSelectionOfFeature(featureName, next.selection)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [options, selection, featureName, voidSettingsService])

	if (isDisabled) {
		return (
			<WarningBox
				onClick={() => commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID)}
				text={
					emptyMessage?.priority === 'always' ? emptyMessage.message
						: isDisabled === 'needToEnableModel' ? 'Enable a model'
							: isDisabled === 'addModel' ? 'Add a model'
								: 'Provider required'
				}
			/>
		)
	}

	if (options.length === 0) {
		return <WarningBox text={emptyMessage?.message || 'No models available'} />
	}

	return (
		<div className='inline-block relative shrink-0 max-w-[160px]'>
			<button
				type='button'
				ref={refs.setReference}
				className='continue-composer-control inline-flex items-center gap-1 px-1 py-0.5 cursor-pointer transition-colors duration-200 max-w-full h-5'
				style={modelPillStyle}
				onClick={() => setIsOpen(v => !v)}
			>
				<span className='truncate'>{displayName}</span>
				{activeTier && <span style={tierPillStyle}>DeepSeek</span>}
				<ChevronDown className='h-[8px] w-[8px] flex-shrink-0 opacity-60' strokeWidth={2.5} />
			</button>
			{isOpen && (
				<div
					ref={refs.setFloating}
					className='continue-composer-menu flex flex-col w-max min-w-[220px] max-w-[320px] max-h-72 overflow-auto py-0.5'
					style={{ ...panelStyle, position: strategy, top: y ?? 0, left: x ?? 0, visibility: x === null || y === null ? 'hidden' : 'visible' }}
				>
					{usableTiers.length > 0 && <div className='px-2 py-0.5 font-medium opacity-70' style={{ color: 'var(--vscode-descriptionForeground)' }}>Branded</div>}
					{usableTiers.map(tier => {
						const isSelected = activeTier?.id === tier.id
						const glyph = tierGlyph(tier.id)
						return (
							<button
								key={tier.id}
								type='button'
								className={`continue-composer-control w-full flex items-center gap-1.5 px-2 py-0.5 text-left cursor-pointer
									${isSelected ? 'bg-[var(--vscode-list-activeSelectionBackground)]' : 'hover:bg-[var(--vscode-list-hoverBackground)]'}`}
								style={{ color: 'var(--vscode-foreground)' }}
								onClick={() => onPickTier(tier)}
							>
								<Sparkles style={COMPOSER_ICON_STYLE} strokeWidth={2} />
								<span className='truncate flex-1 whitespace-nowrap'>{tier.label}{glyph ? ` ${glyph}` : ''}</span>
								<PowerBubbles n={TIER_POWER[tier.id]} />
								<BurnBadge burn={TIER_BURN[tier.id]} />
								{isSelected && <Check style={COMPOSER_ICON_STYLE} strokeWidth={2.5} />}
							</button>
						)
					})}
					<div className='px-2 py-0.5 font-medium opacity-70' style={{ color: 'var(--vscode-descriptionForeground)' }}>Models</div>
					{options.map((opt, idx) => {
						const isSelected = selectedOption && modelSelectionsEqual(opt.selection, selectedOption.selection)
						return (
							<button
								key={`${opt.selection.providerName}-${opt.selection.modelName}-${idx}`}
								type='button'
								className={`continue-composer-control w-full flex items-center gap-1.5 px-2 py-0.5 text-left cursor-pointer
									${isSelected ? 'bg-[var(--vscode-list-activeSelectionBackground)]' : 'hover:bg-[var(--vscode-list-hoverBackground)]'}`}
								style={{ color: 'var(--vscode-foreground)' }}
								onClick={() => onPick(opt)}
							>
								<Box style={COMPOSER_ICON_STYLE} strokeWidth={2} />
								<span className='truncate flex-1'>{opt.selection.modelName}</span>
								{isSelected && <Check style={COMPOSER_ICON_STYLE} strokeWidth={2.5} />}
							</button>
						)
					})}
					<div className='my-0.5 mx-2 border-t' style={{ borderColor: 'var(--vscode-widget-border)' }} />
					<button
						type='button'
						className='continue-composer-control w-full flex items-center gap-1.5 px-2 py-0.5 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)]'
						style={{ color: 'var(--vscode-descriptionForeground)' }}
						onClick={() => { setIsOpen(false); commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID) }}
					>
						<Settings style={COMPOSER_ICON_STYLE} strokeWidth={2} />
						Configure models
					</button>
					<div className='px-2 py-0.5 opacity-60' style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
						{metaKey}&apos; to toggle model
					</div>
				</div>
			)}
		</div>
	)
}
