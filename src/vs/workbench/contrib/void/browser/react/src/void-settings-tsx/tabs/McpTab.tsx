/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
	buildV3codeClaudeCodeConfig,
	buildV3codeMcpClientConfig,
	buildV3codeMcpStdioClientConfig,
	isMcpServerConnected,
	isMcpServerUsable,
	MCPServer,
	URI,
	V3CODE_MCP_EXPOSE_CHANNEL,
	BRAND_ICON_PATHS,
	CATALOG,
	CATALOG_CATEGORY_FILTERS,
	humanizeError,
	installEntryForCatalogEntry,
	isRemoteEntry,
	monogramOf,
	primaryActionFor,
	recoveryActionFor,
} from '../settingsExternals.js';
import type {
	McpInstanceDescriptor,
	V3codeMcpClientSetupResult,
	V3codeMcpExtensionResult,
	V3codeMcpInstallResult,
	CatalogCategory,
	CatalogEntry,
} from '../settingsExternals.js';
import { VoidButtonBgDarken, VoidSimpleInputBox, VoidSwitch } from '../../util/inputs.js'
import { useAccessor, useSettingsState, useMCPServiceState } from '../../util/services.js'
import { Plug, RefreshCw, Check, Copy, Search, Loader2, LogIn, Trash2, KeyRound, Terminal, Globe, BadgeCheck, Bot, BrainCircuit, Zap } from 'lucide-react'
import {
	SettingRow,
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js'
import { WarningBox } from '../WarningBox.js'
import ErrorBoundary from '../../util/ErrorBoundary.js'
import { ACCENT, accentMix } from '../settingsShared.js'

// ============================================================================
// Connector catalog — the canonical model in contrib/void/common/mcpCatalog.ts,
// re-exported through settingsExternals (deeper imports fail at runtime in this
// bundle). Do not declare a local catalog here again.
// ============================================================================

type Connector = CatalogEntry

/** Known-broken entries stay in data but never on the main surface. */
const CONNECTORS: readonly Connector[] = CATALOG.filter(e => e.kind !== 'unavailable')

const CATEGORY_FILTERS = CATALOG_CATEGORY_FILTERS.filter(f => f.id !== 'all' && CONNECTORS.some(c => c.category === f.id))

// ============================================================================
// Service surface
// ============================================================================

// Status values the MCP host can report. 'needs-user-interaction' is what upstream
// raises when a server answered 401 and the OAuth hop needs the user at the keyboard;
// it is read defensively so this file compiles against either version of the type.
type ServerStatus = MCPServer['status'] | 'needs-user-interaction'
const statusOf = (server: MCPServer | undefined): ServerStatus | undefined => server && (server.status as ServerStatus)
type MCPServerWithEnablement = MCPServer & { readonly isEnabled?: boolean }
const upstreamEnablementOf = (server: MCPServer | undefined): boolean | undefined => (server as MCPServerWithEnablement | undefined)?.isEnabled

// ============================================================================
// Small presentational pieces
// ============================================================================

const SettingsEmptyState = ({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; title: string; description: string; action?: React.ReactNode }) => (
	<div className='flex flex-col items-center justify-center gap-3 py-10 px-6 text-center'>
		<div className='flex items-center justify-center rounded-xl' style={{ width: 44, height: 44, background: accentMix(10), border: `1px solid ${accentMix(28)}` }}>
			<Icon size={20} style={{ color: ACCENT }} />
		</div>
		<div className='text-void-fg-1 text-sm font-semibold'>{title}</div>
		<div className='text-void-fg-3 text-xs max-w-[26rem] leading-relaxed'>{description}</div>
		{action ? <div className='mt-1'>{action}</div> : null}
	</div>
);

/** Real brand mark, bundled locally — no icon CDN, nothing to break offline. */
const ConnectorIcon = ({ connector, size = 30 }: { connector: Connector; size?: number }) => {
	const pathData = connector.brandIcon !== undefined ? BRAND_ICON_PATHS[connector.brandIcon] : undefined
	return (
		<div
			className='flex items-center justify-center rounded-lg shrink-0 overflow-hidden text-void-fg-1'
			style={{ width: size, height: size, background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}
		>
			{pathData !== undefined
				? <svg viewBox='0 0 24 24' width={size * 0.6} height={size * 0.6} fill='currentColor' aria-hidden='true'><path d={pathData} /></svg>
				: <span className='text-void-fg-2 font-semibold' style={{ fontSize: size * 0.42 }}>{monogramOf(connector)}</span>}
		</div>
	)
}

const Pill = ({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warn'; title?: string }) => {
	const style = tone === 'accent'
		? { background: accentMix(10), border: `1px solid ${accentMix(24)}`, color: ACCENT }
		: tone === 'warn'
			? { background: 'color-mix(in srgb, var(--v3-warning, #F59E0B) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--v3-warning, #F59E0B) 30%, transparent)', color: 'var(--v3-warning, #F59E0B)' }
			: { background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)', color: 'var(--void-fg-3)' }
	return (
		<span className='inline-flex items-center gap-1 px-1.5 py-[1px] rounded-md text-[10px] font-medium whitespace-nowrap' style={style} title={title}>
			{children}
		</span>
	)
}

/** Filled accent button — the single primary action on a card. */
const PrimaryButton = ({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) => (
	<button
		type='button'
		title={title}
		disabled={disabled}
		onClick={onClick}
		className='inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-opacity disabled:opacity-50 disabled:cursor-default'
		style={{ background: accentMix(18), border: `1px solid ${accentMix(42)}`, color: ACCENT, cursor: disabled ? 'default' : 'pointer' }}
	>
		{children}
	</button>
)

const StatusDot = ({ status, isOn = false }: { status: ServerStatus | undefined; isOn?: boolean }) => {
	const color = status === 'success' || (isOn && (status === undefined || status === 'offline')) ? 'var(--v3-success, #6AA3CC)'
		: status === 'error' ? 'var(--v3-error, #EF4444)'
			: status === 'ready' ? 'var(--vscode-charts-blue, #3794FF)'
				: status === 'loading' || status === 'needs-user-interaction' ? 'var(--v3-warning, #F59E0B)'
					: 'var(--void-fg-3)'
	return <span className='w-1.5 h-1.5 rounded-full shrink-0' style={{ background: color }} />
}

const statusLabel = (status: ServerStatus | undefined, isOn: boolean): string => {
	if (!isOn) { return 'Disabled' }
	switch (status) {
		case 'success': return 'Connected'
		case 'ready': return 'Ready — connects on first use'
		case 'error': return 'Error'
		case 'loading': return 'Connecting…'
		case 'needs-user-interaction': return 'Sign-in required'
		default: return 'Enabled'
	}
}

const ToolChips = ({ tools }: { tools: { name: string; description?: string }[] }) => {
	const [expanded, setExpanded] = useState(false)
	const shown = expanded ? tools : tools.slice(0, 8)
	const hidden = tools.length - shown.length
	return (
		<div className='flex flex-wrap gap-1.5'>
			{shown.map(tool => (
				<span
					key={tool.name}
					className='px-2 py-0.5 rounded-md text-[11px] text-void-fg-2 font-mono'
					style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}
					data-tooltip-id='void-tooltip'
					data-tooltip-content={tool.description || ''}
					data-tooltip-class-name='void-max-w-[300px]'
				>
					{tool.name.split('_').slice(1).join('_') || tool.name}
				</span>
			))}
			{hidden > 0 && (
				<button type='button' className='px-2 py-0.5 rounded-md text-[11px] text-void-fg-3 hover:text-void-fg-2' style={{ border: '1px dashed var(--void-border-2)' }} onClick={() => setExpanded(true)}>
					+{hidden} more
				</button>
			)}
		</div>
	)
}

// ============================================================================
// Connector card
// ============================================================================

// The exact loopback redirect the editor's OAuth flow listens on. Strict providers do
// exact-match (trailing slash included) — register BOTH of these on the OAuth app.
const OAUTH_REDIRECT_URIS = ['http://127.0.0.1:33418/', 'http://127.0.0.1/']

const ConnectorCard = ({ connector, server, isOn }: { connector: Connector; server: MCPServer | undefined; isOn: boolean | undefined }) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const commandService = accessor.get('ICommandService')

	const [busy, setBusy] = useState(false)
	const [localError, setLocalError] = useState<string | null>(null)
	/** Local commands are never installed unseen — Review command opens this first. */
	const [reviewOpen, setReviewOpen] = useState(false)
	/** Pre-registered providers (Slack/Google Drive class): sign-in works only from an
	 *  OAuth app the user registers themselves — this holds the "use my own app" flow. */
	const [ownAppOpen, setOwnAppOpen] = useState(false)
	const [clientId, setClientId] = useState('')

	const status = statusOf(server)
	const installed = server !== undefined
	const tools = server?.tools ?? []
	const needsSignIn = status === 'needs-user-interaction'

	const onConnect = useCallback(async () => {
		// Guides never get a connection path; local commands are ALWAYS reviewed first.
		if (connector.kind === 'local-command' && !reviewOpen) {
			setReviewOpen(true)
			setLocalError(null)
			return
		}
		// Pre-registered providers cannot complete automatic registration: route the
		// primary action into the guided "use your own app" flow instead of letting the
		// user hit a doomed sign-in that ends in a blind client-ID prompt.
		// Providers whose V3Code app is registered (catalog oauthClientId) sign in directly.
		if (connector.authHint === 'oauth-preregistered' && !connector.oauthClientId && !ownAppOpen && !clientId.trim()) {
			setOwnAppOpen(true)
			setLocalError(null)
			return
		}
		setBusy(true)
		setLocalError(null)
		try {
			// One shared payload builder for every surface. Required inputs (tokens,
			// headers) become secure, password-masked prompts at connect time — no token
			// field lives in this tab and no value is ever written into a config file.
			// ${workspaceFolder} stays symbolic; upstream resolves it per-window at launch.
			const entry = installEntryForCatalogEntry(connector)
			if (entry === undefined) { return }
			const withOAuth = clientId.trim() ? { ...entry, oauth: { clientId: clientId.trim() } } : entry
			await mcpService.installMcpServer(connector.id, withOAuth as { url?: URL } & typeof withOAuth, connector.requiredInputs)
			setReviewOpen(false)
			setOwnAppOpen(false)
		} catch (e) {
			setLocalError(humanizeError(e instanceof Error ? e.message : String(e), connector))
		} finally {
			setBusy(false)
		}
	}, [connector, mcpService, reviewOpen, ownAppOpen, clientId])

	const onSetClientSecret = useCallback(async () => {
		// Reuses the upstream Set Client Secret flow: password-masked input, stored in the
		// OS secret store keyed by (server url, client id) — never written to any file.
		const url = installEntryForCatalogEntry(connector)?.url
		if (!url || !clientId.trim()) { return }
		try {
			await commandService.executeCommand('workbench.mcp.setOAuthClientSecret', clientId.trim(), String(url), connector.name)
		} catch (e) {
			setLocalError(humanizeError(e instanceof Error ? e.message : String(e), connector))
		}
	}, [connector, commandService, clientId])

	const onDisconnect = useCallback(async () => {
		setBusy(true)
		setLocalError(null)
		try {
			await mcpService.uninstallMcpServer(connector.id)
		} catch (e) {
			setLocalError(humanizeError(e instanceof Error ? e.message : String(e), connector))
		} finally {
			setBusy(false)
		}
	}, [connector, mcpService])

	const onSignIn = useCallback(async (fresh = false) => {
		setBusy(true)
		setLocalError(null)
		try {
			// Reconnect = cheap stop/start; Sign in again = full fresh auth (wipes the
			// cached client registration and sessions — the only recovery from
			// authorize-time failures the browser saw but the editor did not).
			await (fresh ? mcpService.resetServerAuth(connector.id) : mcpService.reauthenticateServer(connector.id))
		} catch (e) {
			setLocalError(humanizeError(e instanceof Error ? e.message : String(e), connector))
		} finally {
			setBusy(false)
		}
	}, [connector, mcpService])

	const onRetry = useCallback(async () => {
		setBusy(true)
		setLocalError(null)
		try {
			await mcpService.toggleServerIsOn(connector.id, false)
			await mcpService.toggleServerIsOn(connector.id, true)
		} catch (e) {
			setLocalError(humanizeError(e instanceof Error ? e.message : String(e), connector))
		} finally {
			setBusy(false)
		}
	}, [connector, mcpService])

	const serverError = server && 'error' in server ? server.error : undefined
	const shownError = localError ?? (serverError && !needsSignIn ? humanizeError(serverError, connector) : null)

	return (
		<div
			className='@@v3code-settings-card flex flex-col gap-2.5 p-3.5'
			style={needsSignIn ? { borderColor: 'color-mix(in srgb, var(--v3-warning, #F59E0B) 40%, var(--void-border-2))' } : undefined}
		>
			<div className='flex items-start gap-2.5'>
				<ConnectorIcon connector={connector} />
				<div className='flex flex-col min-w-0 flex-1 gap-0.5'>
					<div className='flex items-center gap-1.5 min-w-0'>
						<span className='text-sm font-medium text-void-fg-1 truncate'>{connector.name}</span>
						{isRemoteEntry(connector)
							? <Globe size={11} className='text-void-fg-3 shrink-0' data-tooltip-id='void-tooltip' data-tooltip-content='Hosted by the service — signs in through your browser' />
							: <Terminal size={11} className='text-void-fg-3 shrink-0' data-tooltip-id='void-tooltip' data-tooltip-content='Runs as a process on this machine' />}
					</div>
					<div className='text-[11px] text-void-fg-3 leading-relaxed'>{connector.description}</div>
				</div>
			</div>

			<div className='flex flex-wrap items-center gap-1'>
				<Pill title='Published by the service itself'><BadgeCheck size={9} /> Official</Pill>
				{connector.unverified ? <Pill tone='warn' title='Endpoint reported by third parties, not confirmed against first-party docs'>Unconfirmed endpoint</Pill> : null}
				{(connector.requiredInputs ?? []).some(i => i.isSecret === true) ? <Pill title={(connector.requiredInputs ?? []).filter(i => i.isSecret === true).map(i => i.name).join(', ')}><KeyRound size={9} /> Token required</Pill> : null}
				{connector.authHint === 'oauth-preregistered' && connector.oauthClientId ? <Pill title='Signs in with the V3Code app registered with this provider; no client ID to paste'>One-click sign-in</Pill> : connector.authHint === 'oauth-preregistered' ? <Pill tone='warn' title='This provider only signs in pre-registered apps; automatic registration will not complete'>Client ID required</Pill> : null}
			</div>

			{connector.caveat ? <div className='text-[11px] text-void-fg-3 leading-relaxed'>{connector.caveat}</div> : null}

			{/* Guided pre-registered flow: these providers refuse automatic client
			    registration, so sign-in only works from an OAuth app the user registers
			    themselves. This panel is the guided alternative to the blind
			    paste-a-client-ID modal the DCR-failure fallback would otherwise show. */}
			{connector.authHint === 'oauth-preregistered' && !installed && ownAppOpen ? (
				<div className='flex flex-col gap-1.5 p-2 rounded border border-void-border-2 bg-void-bg-2'>
					<div className='text-[11px] text-void-fg-2 leading-relaxed'>
						{connector.name} only signs in apps registered with the provider. Create an OAuth app in your {connector.name} account, add BOTH redirect URLs below to it, then paste its client ID here.
					</div>
					<div className='flex items-center gap-1.5 text-[11px] text-void-fg-3 font-mono'>
						{OAUTH_REDIRECT_URIS.join('   ')}
						<VoidButtonBgDarken
							className='px-1.5 py-0.5 text-[10px] flex items-center gap-1'
							onClick={() => { void accessor.get('IClipboardService').writeText(OAUTH_REDIRECT_URIS.join('\n')) }}
						><Copy size={10} /> Copy</VoidButtonBgDarken>
					</div>
					{connector.docsUrl ? (
						<VoidButtonBgDarken
							className='px-1.5 py-0.5 text-[10px] self-start'
							onClick={() => { void accessor.get('ICommandService').executeCommand('vscode.open', URI.parse(connector.docsUrl!)) }}
						>Open provider setup docs</VoidButtonBgDarken>
					) : null}
					<VoidSimpleInputBox
						value={clientId}
						onChangeValue={setClientId}
						placeholder='Client ID from your OAuth app'
						compact={true}
					/>
					<div className='flex items-center gap-1.5'>
						<PrimaryButton onClick={onConnect} disabled={busy || !clientId.trim()}>
							{busy ? <><Loader2 size={12} className='animate-spin' /> Connecting…</> : <><Plug size={12} /> Connect with my app</>}
						</PrimaryButton>
						<VoidButtonBgDarken
							className='px-2 py-1 text-[11px] flex items-center gap-1'
							disabled={!clientId.trim()}
							onClick={onSetClientSecret}
						><KeyRound size={11} /> Set client secret…</VoidButtonBgDarken>
					</div>
					<div className='text-[10px] text-void-fg-3'>
						The client secret (if your provider issued one) is stored in the OS secret store, never in a config file. Set it BEFORE connecting so the first sign-in can use it.
					</div>
				</div>
			) : null}

			{/* Action row — one primary affordance, whatever the state calls for. */}
			<div className='flex items-center gap-2 mt-auto pt-0.5'>
				{!installed ? (
					<PrimaryButton onClick={onConnect} disabled={busy}>
						{busy ? <><Loader2 size={12} className='animate-spin' /> {isRemoteEntry(connector) ? 'Connecting…' : 'Installing…'}</>
							: primaryActionFor(connector) === 'connect' ? <><Plug size={12} /> Connect</>
								: primaryActionFor(connector) === 'set-up' ? <><Plug size={12} /> Set up</>
									: reviewOpen ? <><Plug size={12} /> Install</> : <><Terminal size={12} /> Review command</>}
					</PrimaryButton>
				) : needsSignIn ? (
					<PrimaryButton onClick={() => onSignIn()} disabled={busy}>
						{busy ? <><Loader2 size={12} className='animate-spin' /> Opening…</> : <><LogIn size={12} /> Sign in</>}
					</PrimaryButton>
				) : (
					<div className='flex items-center gap-1.5'>
						<StatusDot status={status} isOn={isOn ?? false} />
						<span className='text-[11px] text-void-fg-3'>
							{statusLabel(status, isOn ?? false)}
							{isOn && tools.length > 0 ? ` · ${tools.length} tool${tools.length === 1 ? '' : 's'}` : ''}
						</span>
					</div>
				)}

				{installed && connector.kind === 'local-command' && isOn && (status === 'offline' || status === 'error' || status === undefined) ? (
					<VoidButtonBgDarken className='px-2 py-1 text-[11px] flex items-center gap-1' disabled={busy} onClick={onRetry}>
						<RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Retry
					</VoidButtonBgDarken>
				) : null}

				{installed && !needsSignIn && (recoveryActionFor(connector, server, isOn ?? false) === 'sign-in-again' || recoveryActionFor(connector, server, isOn ?? false) === 'reconnect') ? (
					<VoidButtonBgDarken className='px-2 py-1 text-[11px] flex items-center gap-1' disabled={busy} onClick={() => onSignIn(recoveryActionFor(connector, server, isOn ?? false) === 'sign-in-again')}>
						<RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
						{recoveryActionFor(connector, server, isOn ?? false) === 'sign-in-again' ? 'Sign in again' : 'Reconnect'}
					</VoidButtonBgDarken>
				) : null}

				{installed && (
					<div className='flex items-center gap-2 ml-auto'>
						<VoidSwitch
							value={isOn ?? false}
							size='xs'
							onChange={() => mcpService.toggleServerIsOn(connector.id, !isOn)}
						/>
						<VoidButtonBgDarken className='px-2 py-1 text-[11px] flex items-center gap-1' disabled={busy} onClick={onDisconnect}>
							<Trash2 size={11} /> Disconnect
						</VoidButtonBgDarken>
					</div>
				)}
			</div>

			{needsSignIn && (
				<div className='text-[11px] leading-relaxed' style={{ color: 'var(--v3-warning, #F59E0B)' }}>
					{connector.name} asked you to authorize V3Code. Sign in opens {connector.domain} in your browser — approve there and the tools appear here.
				</div>
			)}

			{installed && isOn && tools.length > 0 && (
				<div className='max-h-28 overflow-y-auto'>
					<ToolChips tools={tools} />
				</div>
			)}

			{reviewOpen && connector.kind === 'local-command' && (
				<div className='flex flex-col gap-1.5 p-2 rounded-md' style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
					<div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>This command will run on your computer</div>
					<code className='text-[11px] font-mono whitespace-pre-wrap break-words text-void-fg-1'>{[connector.command, ...(connector.args ?? [])].join(' ')}</code>
					{(connector.requiredInputs ?? []).length > 0 ? (
						<div className='text-[10px] text-void-fg-3 leading-relaxed'>
							On first connect you will be asked for: {(connector.requiredInputs ?? []).map(i => i.name).join(', ')}. Secrets are entered in a masked prompt and stored encrypted — never in a config file.
						</div>
					) : null}
					<div className='text-[10px] leading-relaxed' style={{ color: 'var(--v3-warning, #F59E0B)' }}>
						Review the package and its publisher before installing. Install asks for confirmation before the process ever starts.
					</div>
					<div>
						<VoidButtonBgDarken className='px-2 py-1 text-[11px]' onClick={() => setReviewOpen(false)}>Cancel</VoidButtonBgDarken>
					</div>
				</div>
			)}

			{shownError && (
				<div title={serverError ?? undefined}>
					<WarningBox text={shownError} />
				</div>
			)}
		</div>
	)
}

// ============================================================================
// Gallery
// ============================================================================

const ConnectorGallery = () => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const mcpServiceState = useMCPServiceState()
	const voidSettings = useSettingsState()

	const [query, setQuery] = useState('')
	const [category, setCategory] = useState<CatalogCategory | 'all'>('all')

	// Install-identity map FIRST (the same resolution the action buttons use), so a
	// suffixed install ("slack-2") never shows one server's status while buttons act on
	// another. Loose id/name match remains the fallback for hand-edited mcp.json servers.
	const serverOfConnectorId = useMemo(() => {
		const byLowerName = new Map<string, MCPServer>()
		for (const [name, server] of Object.entries(mcpServiceState.mcpServerOfName)) {
			byLowerName.set(name.toLowerCase(), server)
		}
		const result = new Map<string, MCPServer>()
		for (const connector of CONNECTORS) {
			const installedName = mcpService.installedServerNameFor(connector.id)
			const mapped = installedName !== undefined ? mcpServiceState.mcpServerOfName[installedName] : undefined
			const hit = mapped ?? byLowerName.get(connector.id) ?? byLowerName.get(connector.name.toLowerCase())
			if (hit) { result.set(connector.id, hit) }
		}
		return result
	}, [mcpServiceState.mcpServerOfName, mcpService])

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase()
		return CONNECTORS.filter(c => {
			if (category !== 'all' && c.category !== category) { return false }
			if (!q) { return true }
			return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.id.includes(q)
		})
	}, [query, category])

	const configured = visible.filter(c => serverOfConnectorId.has(c.id))
	const configuredIsOn = (connector: Connector): boolean => {
		const server = serverOfConnectorId.get(connector.id)
		return upstreamEnablementOf(server) ?? voidSettings.mcpUserStateOfName[connector.id]?.isOn ?? true
	}
	const connected = configured.filter(c => {
		const server = serverOfConnectorId.get(c.id)
		return isMcpServerUsable(server, configuredIsOn(c), isRemoteEntry(c))
	})
	const enabled = configured.filter(c => {
		const server = serverOfConnectorId.get(c.id)
		const status = statusOf(server)
		return configuredIsOn(c) && status !== 'success' && status !== 'error' && status !== 'needs-user-interaction'
	})
	const needsAttention = configured.filter(c => {
		const server = serverOfConnectorId.get(c.id)
		const status = statusOf(server)
		return configuredIsOn(c) && (
			status === 'error'
			|| status === 'needs-user-interaction'
			|| (isRemoteEntry(c) && status === 'success' && (server?.tools?.length ?? 0) === 0)
		)
	})
	const disabled = configured.filter(c => {
		return !configuredIsOn(c)
	})
	const available = visible.filter(c => !serverOfConnectorId.has(c.id))

	const renderGrid = (items: Connector[]) => (
		<div className='grid gap-2.5' style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
			{items.map(c => (
				<ConnectorCard
					key={c.id}
					connector={c}
					server={serverOfConnectorId.get(c.id)}
					isOn={configuredIsOn(c)}
				/>
			))}
		</div>
	)

	return (
		<SettingsSection label='Connectors'>
			<div className='flex flex-col gap-3'>
				<div className='text-xs text-void-fg-3 leading-relaxed'>
					Connect a service and its tools become available to Agent mode. Hosted connectors sign you in through your browser — no keys to copy.
				</div>

				<div className='flex items-center gap-2 px-2.5 py-1.5 rounded-lg' style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
					<Search size={13} className='text-void-fg-3 shrink-0' />
					<input
						type='text'
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder='Search connectors'
						className='flex-1 bg-transparent border-none outline-none text-xs text-void-fg-1 placeholder:text-void-fg-3'
					/>
				</div>

				<div className='flex flex-wrap gap-1.5'>
					{[{ id: 'all' as const, label: 'All' }, ...CATEGORY_FILTERS].map(cat => {
						const active = category === cat.id
						return (
							<button
								key={cat.id}
								type='button'
								onClick={() => setCategory(cat.id)}
								className='px-2.5 py-[3px] rounded-full text-[11px] transition-colors'
								style={active
									? { background: accentMix(16), border: `1px solid ${accentMix(38)}`, color: ACCENT }
									: { background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)', color: 'var(--void-fg-3)' }}
							>
								{cat.label}
							</button>
						)
					})}
				</div>

				{connected.length > 0 && (
					<div className='flex flex-col gap-1.5'>
						<div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>Connected ({connected.length})</div>
						{renderGrid(connected)}
					</div>
				)}

				{enabled.length > 0 && (
					<div className='flex flex-col gap-1.5'>
						<div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>Enabled ({enabled.length})</div>
						{renderGrid(enabled)}
					</div>
				)}

				{needsAttention.length > 0 && (
					<div className='flex flex-col gap-1.5'>
						<div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>Needs attention ({needsAttention.length})</div>
						{renderGrid(needsAttention)}
					</div>
				)}

				{disabled.length > 0 && (
					<div className='flex flex-col gap-1.5'>
						<div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>Disabled ({disabled.length})</div>
						{renderGrid(disabled)}
					</div>
				)}

				{available.length > 0 && (
					<div className='flex flex-col gap-1.5'>
						{configured.length > 0 ? <div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>Available</div> : null}
						{renderGrid(available)}
					</div>
				)}

				{visible.length === 0 && (
					<SettingsCard>
						<SettingsEmptyState
							icon={Search}
							title='No connectors match'
							description='Try a different search or category. Any MCP server can still be added by hand below.'
						/>
					</SettingsCard>
				)}
			</div>
		</SettingsSection>
	)
}

// ============================================================================
// Manually configured servers (everything not in the catalog)
// ============================================================================

const CustomServerRow = ({ name, server }: { name: string, server: MCPServer }) => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');

	const voidSettings = useSettingsState()
	const isOn = upstreamEnablementOf(server) ?? voidSettings.mcpUserStateOfName[name]?.isOn ?? true

	const status = statusOf(server)
	const needsSignIn = status === 'needs-user-interaction'
	const tools = server.tools ?? []
	const serverError = 'error' in server ? server.error : undefined

	const [signInError, setSignInError] = useState<string | null>(null)
	const onSignIn = useCallback(async () => {
		setSignInError(null)
		try {
			await mcpService.reauthenticateServer(name)
		} catch (e) {
			setSignInError(humanizeError(e instanceof Error ? e.message : String(e)))
		}
	}, [mcpService, name])

	return (
		<div className='@@v3code-settings-card my-2 py-3 px-4'>
			<div className='flex items-center justify-between gap-3'>
				<div className='flex items-center gap-2.5 min-w-0'>
					<div className='flex items-center justify-center rounded-md shrink-0' style={{ width: 28, height: 28, background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
						<Plug size={14} className='text-void-fg-2' />
					</div>
					<div className='flex flex-col min-w-0'>
						<div className='text-sm font-medium text-void-fg-1 truncate'>{name}</div>
						<div className='flex items-center gap-1.5'>
							<StatusDot status={status} isOn={isOn ?? false} />
							<span className='text-[11px] text-void-fg-3'>
								{statusLabel(status, isOn ?? false)}
								{isOn && tools.length > 0 ? ` · ${tools.length} tool${tools.length === 1 ? '' : 's'}` : ''}
							</span>
						</div>
					</div>
				</div>

				<div className='flex items-center gap-2 shrink-0'>
					{needsSignIn && (
						<PrimaryButton onClick={() => void onSignIn()}>
							<LogIn size={12} /> Sign in
						</PrimaryButton>
					)}
					<VoidSwitch
						value={isOn ?? false}
						size='xs'
						onChange={() => mcpService.toggleServerIsOn(name, !isOn)}
					/>
				</div>
			</div>

			{isOn && tools.length > 0 && (
				<div className='mt-3 max-h-32 overflow-y-auto'>
					<ToolChips tools={tools} />
				</div>
			)}

			{isOn && server.command && (
				<div className='mt-3'>
					<div className='text-[10px] text-void-fg-3 mb-1 uppercase tracking-wider font-medium'>Command</div>
					<div className='px-2 py-1 bg-void-bg-2 text-xs font-mono overflow-x-auto whitespace-nowrap text-void-fg-2 rounded-md border border-void-border-2'>
						{server.command}
					</div>
				</div>
			)}

			{needsSignIn && (
				<div className='mt-3 text-[11px] leading-relaxed' style={{ color: 'var(--v3-warning, #F59E0B)' }}>
					This server needs you to authorize V3Code. Sign in opens the provider in your browser.
				</div>
			)}

			{serverError && !needsSignIn && (
				<div className='mt-3' title={serverError}>
					<WarningBox text={humanizeError(serverError)} />
				</div>
			)}
		</div>
	);
};

const CustomServersList = () => {
	const mcpServiceState = useMCPServiceState()

	if (mcpServiceState.error) {
		return <div className='my-2'>
			<WarningBox text={humanizeError(mcpServiceState.error)} />
		</div>
	}

	const catalogNames = new Set(CONNECTORS.flatMap(c => [c.id, c.name.toLowerCase()]))
	const entries = Object.entries(mcpServiceState.mcpServerOfName)
		.filter(([name]) => !name.includes('context-bridge'))
		.filter(([name]) => !catalogNames.has(name.toLowerCase()))

	if (entries.length === 0) {
		return <div className='@@v3code-settings-card my-2'>
			<SettingsEmptyState
				icon={Plug}
				title='No custom servers'
				description='Everything you have connected lives in the gallery above. Add servers by hand here when they are not in the catalog — internal servers, forks, or anything running on your own machine.'
			/>
		</div>
	}

	return <div className='my-2'>
		{entries.map(([name, server]) => <CustomServerRow key={name} name={name} server={server} />)}
	</div>
};

// ============================================================================
// V3Code's own MCP server — exposes this editor's intelligence to EXTERNAL agents
// ============================================================================

// Read this process's descriptor over IPC. Do not read the shared legacy endpoint.json:
// with two builds open it belongs to whichever process wrote last, not necessarily this UI.
type V3codeMcpEndpoint = McpInstanceDescriptor

const V3CODE_EXPOSED_TOOLS = [
	'orient', 'semantic_search', 'pack_context', 'get_symbol_context', 'get_call_graph',
	'get_file_context', 'get_file_dependencies', 'get_project_briefing',
	'find_text', 'list_notes', 'search_notes', 'workspace_delta', 'search_memory',
	'get_memory_checkpoint', 'deep_recall', 'get_shadow_record', 'get_build_errors',
	'session_diff', 'index_health', 'recent_edits', 'remember', 'forget',
	'run_subagent', 'send_chat', 'get_chat', 'cancel_chat', 'symbol_lookup', 'impact_trace',
]

const V3CODE_CLAUDE_SKILL = `---
name: v3code
description: Use V3Code's live workspace intelligence and durable memory for project orientation, conceptual search, symbol tracing, impact analysis, prior decisions, and verified handoffs.
---

# V3Code intelligence

Use the v3code MCP server proactively for this workspace:

- Start unfamiliar, resumed, or non-trivial work with orient.
- Use semantic_search for concepts and architecture; use find_text for exact strings.
- Use get_symbol_context, get_call_graph, get_file_context, and get_file_dependencies before proposing cross-file changes.
- Use pack_context when you need a bounded evidence packet for a task.
- Use search_memory when the user references earlier work, decisions, corrections, preferences, or asks why something is built a certain way. Expand decisive hits with get_memory_checkpoint.
- Search list_notes or search_notes before claiming durable symbol notes are unknown.
- Use get_build_errors and session_diff to verify work before reporting completion.
- Use send_chat only when the user explicitly asks you to drive the live V3Code agent. Keep auto_approve false unless the user explicitly authorizes unattended execution.
- Call remember only for confirmed durable decisions, preferences, goals, or handoff facts. Never store secrets or unresolved speculation.
- Prefer tool evidence over guessing. If V3Code is unavailable, say so and continue with normal local inspection.
`

/**
 * A compact, responsive version of the MCP connection diagram supplied with
 * the V3Code design system. The original reference showed a generic MCP hub;
 * this screen is specifically V3Code acting as the server, so the labels match
 * the real traffic direction instead of implying that V3Code is another client.
 */
const V3codeMcpConnectionMap = () => (
	<figure
		className="@@v3code-mcp-connection-map"
		data-v3code-mcp-connection-map="0095"
		aria-label="Claude Code, Codex, and other agents connect to the V3Code MCP server to use code search, project memory, and actions"
	>
		<div className="@@v3code-mcp-connection-map-title">
			<span>Connect your agents to V3Code</span>
			<span>Local MCP</span>
		</div>
		<div className="@@v3code-mcp-connection-map-canvas" aria-hidden="true">
			<svg className="@@v3code-mcp-connection-map-lines" viewBox="0 0 720 300" preserveAspectRatio="none">
				<path className="@@v3code-mcp-map-wire" d="M90 52 C238 52 252 150 360 150" />
				<path className="@@v3code-mcp-map-wire" d="M90 150 C238 150 252 150 360 150" />
				<path className="@@v3code-mcp-map-wire" d="M90 248 C238 248 252 150 360 150" />
				<path className="@@v3code-mcp-map-wire" d="M360 150 C468 150 482 52 630 52" />
				<path className="@@v3code-mcp-map-wire" d="M360 150 C468 150 482 150 630 150" />
				<path className="@@v3code-mcp-map-wire" d="M360 150 C468 150 482 248 630 248" />
				<path className="@@v3code-mcp-map-beam" d="M90 52 C238 52 252 150 360 150" />
				<path className="@@v3code-mcp-map-beam @@v3code-mcp-map-beam--2" d="M90 150 C238 150 252 150 360 150" />
				<path className="@@v3code-mcp-map-beam @@v3code-mcp-map-beam--3" d="M90 248 C238 248 252 150 360 150" />
				<path className="@@v3code-mcp-map-beam @@v3code-mcp-map-beam--4" d="M360 150 C468 150 482 52 630 52" />
				<path className="@@v3code-mcp-map-beam @@v3code-mcp-map-beam--5" d="M360 150 C468 150 482 150 630 150" />
				<path className="@@v3code-mcp-map-beam @@v3code-mcp-map-beam--6" d="M360 150 C468 150 482 248 630 248" />
			</svg>

			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--left @@v3code-mcp-map-node--top">
				<div className="@@v3code-mcp-map-node-icon @@v3code-mcp-map-node-icon--claude"><span>&#10022;</span></div>
				<span>Claude Code</span>
			</div>
			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--left @@v3code-mcp-map-node--middle">
				<div className="@@v3code-mcp-map-node-icon"><Terminal size={22} /></div>
				<span>Codex</span>
			</div>
			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--left @@v3code-mcp-map-node--bottom">
				<div className="@@v3code-mcp-map-node-icon"><Bot size={22} /></div>
				<span>Other agents</span>
			</div>

			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--hub">
				<div className="@@v3code-mcp-map-hub-rings" />
				<div className="@@v3code-mcp-map-node-icon"><Plug size={30} /></div>
				<span>V3Code MCP</span>
			</div>

			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--right @@v3code-mcp-map-node--top">
				<div className="@@v3code-mcp-map-node-icon"><Search size={22} /></div>
				<span>Code search</span>
			</div>
			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--right @@v3code-mcp-map-node--middle">
				<div className="@@v3code-mcp-map-node-icon"><BrainCircuit size={22} /></div>
				<span>Memory</span>
			</div>
			<div className="@@v3code-mcp-map-node @@v3code-mcp-map-node--right @@v3code-mcp-map-node--bottom">
				<div className="@@v3code-mcp-map-node-icon"><Zap size={22} /></div>
				<span>Actions</span>
			</div>
		</div>
		<figcaption>
			Claude Code and Codex connect locally to this V3Code window, then use its live code intelligence, project memory, and agent actions.
		</figcaption>
	</figure>
)

const V3codeMcpServerCard = () => {
	const accessor = useAccessor()
	const clipboardService = accessor.get('IClipboardService')
	const mainProcessService = accessor.get('IMainProcessService')
	const nativeHostService = accessor.get('INativeHostService')
	const notificationService = accessor.get('INotificationService')
	const channel = useMemo(() => mainProcessService.getChannel(V3CODE_MCP_EXPOSE_CHANNEL), [mainProcessService])

	const [endpoint, setEndpoint] = useState<V3codeMcpEndpoint | null>(null)
	const [setup, setSetup] = useState<V3codeMcpClientSetupResult | null>(null)
	const [loaded, setLoaded] = useState(false)
	/** Why the endpoint could not be loaded — shown verbatim instead of a generic hint. */
	const [loadError, setLoadError] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [copiedSkill, setCopiedSkill] = useState(false)
	const [copiedClaude, setCopiedClaude] = useState(false)
	const [working, setWorking] = useState<'codex' | 'claude' | null>(null)

	const load = useCallback(async () => {
		try {
			const [descriptor, setupResult] = await Promise.all([
				channel.call('getDescriptor') as Promise<V3codeMcpEndpoint | undefined>,
				channel.call('getClientSetupStatus') as Promise<V3codeMcpClientSetupResult>,
			])
			if (!descriptor) { throw new Error('V3Code MCP has not started.') }
			// Validate both the direct URL and the stable bridge config before showing either.
			buildV3codeMcpClientConfig(descriptor.url)
			if (!descriptor.bridge) { throw new Error('This V3Code build does not include the stable MCP bridge.') }
			buildV3codeMcpStdioClientConfig(descriptor.bridge)
			setEndpoint(descriptor)
			setSetup(setupResult)
			setLoadError(null)
		} catch (e) {
			// Surface the REAL reason. This used to swallow everything into "Not started —
			// open a workspace window", which is what the panel showed for a build whose
			// main-process channel simply lacked the bridge commands — a running server
			// reported as not running, with the whole panel hidden behind the wrong hint.
			setEndpoint(null)
			setLoadError(e instanceof Error ? e.message : String(e))
			try { setSetup(await channel.call('getClientSetupStatus') as V3codeMcpClientSetupResult) } catch { setSetup(null) }
		} finally {
			setLoaded(true)
		}
	}, [channel])

	useEffect(() => { load() }, [load])

	const clientConfig = useMemo(() => endpoint
		? buildV3codeMcpStdioClientConfig(endpoint.bridge!)
		: '', [endpoint])
	const claudeCodeConfig = useMemo(() => endpoint ? buildV3codeClaudeCodeConfig(endpoint.bridge!) : '', [endpoint])

	const onCopy = useCallback(async () => {
		if (!clientConfig) { return }
		await clipboardService.writeText(clientConfig)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}, [clientConfig, clipboardService])

	const onCopyClaudeCode = useCallback(async () => {
		if (!claudeCodeConfig) { return }
		await clipboardService.writeText(claudeCodeConfig)
		setCopiedClaude(true)
		setTimeout(() => setCopiedClaude(false), 1500)
	}, [claudeCodeConfig, clipboardService])

	const onInstallCodex = useCallback(async () => {
		setWorking('codex')
		try {
			const result = await channel.call('installCodex') as V3codeMcpInstallResult
			notificationService.info(`V3Code connected in ${result.configPath}. Restart Codex or ChatGPT desktop once to load it.`)
			setSetup(await channel.call('getClientSetupStatus') as V3codeMcpClientSetupResult)
		} catch (error) {
			notificationService.error(`Could not connect Codex: ${error instanceof Error ? error.message : String(error)}`)
		} finally { setWorking(null) }
	}, [channel, notificationService])

	const onCreateClaudeExtension = useCallback(async () => {
		setWorking('claude')
		try {
			const result = await channel.call('createClaudeDesktopExtension') as V3codeMcpExtensionResult
			await nativeHostService.showItemInFolder(result.path)
			notificationService.info('V3Code.mcpb is ready. Double-click it to install in Claude Desktop.')
		} catch (error) {
			notificationService.error(`Could not create the Claude Desktop extension: ${error instanceof Error ? error.message : String(error)}`)
		} finally { setWorking(null) }
	}, [channel, nativeHostService, notificationService])

	const onCopyClaudeSkill = useCallback(async () => {
		await clipboardService.writeText(V3CODE_CLAUDE_SKILL)
		setCopiedSkill(true)
		setTimeout(() => setCopiedSkill(false), 1500)
	}, [clipboardService])

	return (
		<SettingsSection label="V3Code MCP Server">
			<SettingsCard>
				<span data-v3code-mcp-ui-version="0093" className="hidden" aria-hidden="true" />
				<div className="px-4 py-4 flex flex-col gap-4">
					<div className="flex items-center gap-3">
						<div className='flex items-center justify-center rounded-lg shrink-0' style={{ width: 34, height: 34, background: accentMix(12), border: `1px solid ${accentMix(28)}` }}>
							<Plug size={16} style={{ color: ACCENT }} />
						</div>
						<div className="flex flex-col min-w-0">
							<div className="text-sm font-medium text-void-fg-1">Expose to external agents</div>
							<div className="flex items-center gap-1.5">
								<span className='w-1.5 h-1.5 rounded-full shrink-0' style={{ background: endpoint ? 'var(--v3-success, #6AA3CC)' : 'var(--void-fg-3)' }} />
								<span className='text-[11px] text-void-fg-3'>{endpoint ? 'Running' : loaded ? (loadError ? `Not available — ${loadError}` : 'Not started — open a workspace window and reopen Settings') : 'Checking…'}</span>
							</div>
						</div>
						<VoidButtonBgDarken className="ml-auto px-2 py-1 text-xs flex items-center gap-1" onClick={load}>
							<RefreshCw size={12} /> Refresh
						</VoidButtonBgDarken>
					</div>

					<div className="text-xs text-void-fg-3 leading-relaxed">
						Connect once, then V3Code follows the right running editor automatically — even when its port changes after an update or when two builds are open. The connection stays on this computer and needs no V3Code account.
					</div>

					<V3codeMcpConnectionMap />

					{endpoint && (
						<>
							<div className="flex flex-col gap-2">
								<div className="rounded-lg px-3 py-3 flex items-center gap-3" style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
									<div className="min-w-0 flex-1">
										<div className="text-xs font-medium text-void-fg-1">Codex + ChatGPT desktop</div>
										<div className="text-[10px] text-void-fg-3 leading-relaxed">
											{setup?.codex.status === 'current' ? 'Connected. Restart the app only if V3Code tools are not visible yet.' : setup?.codex.status === 'stale' ? 'An older fixed-port connection was found. Repair it so updates cannot break it.' : 'Add V3Code to the shared Codex MCP configuration.'}
										</div>
									</div>
									<VoidButtonBgDarken className="shrink-0 px-2.5 py-1.5 text-xs flex items-center gap-1" onClick={onInstallCodex} disabled={working !== null}>
										{working === 'codex' ? <><Loader2 size={12} className="animate-spin" /> Connecting</> : setup?.codex.status === 'current' ? <><Check size={12} /> Connected</> : <><Plug size={12} /> {setup?.codex.status === 'stale' ? 'Repair' : 'Connect'}</>}
									</VoidButtonBgDarken>
								</div>

								<div className="rounded-lg px-3 py-3 flex items-center gap-3" style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
									<div className="min-w-0 flex-1">
										<div className="text-xs font-medium text-void-fg-1">Claude Desktop</div>
										<div className="text-[10px] text-void-fg-3 leading-relaxed">Create a local extension, then double-click it. Claude installs the bridge and shows V3Code as a connector.</div>
									</div>
									<VoidButtonBgDarken className="shrink-0 px-2.5 py-1.5 text-xs flex items-center gap-1" onClick={onCreateClaudeExtension} disabled={working !== null}>
										{working === 'claude' ? <><Loader2 size={12} className="animate-spin" /> Creating</> : <><Plug size={12} /> Create extension</>}
									</VoidButtonBgDarken>
								</div>

								<div className="rounded-lg px-3 py-3 flex items-center gap-3" style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
									<div className="min-w-0 flex-1">
										<div className="text-xs font-medium text-void-fg-1">Claude Code + other local agents</div>
										<div className="text-[10px] text-void-fg-3 leading-relaxed">Copy the stable stdio definition. It works in clients that accept a local MCP command.</div>
									</div>
									<VoidButtonBgDarken className="shrink-0 px-2.5 py-1.5 text-xs flex items-center gap-1" onClick={onCopyClaudeCode}>
										{copiedClaude ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy config</>}
									</VoidButtonBgDarken>
								</div>
							</div>

							<div className="flex flex-col gap-1">
								<div className="text-[10px] text-void-fg-3 uppercase tracking-wider font-medium">Current direct endpoint (advanced)</div>
								<div className="px-2.5 py-1.5 text-xs font-mono overflow-x-auto whitespace-nowrap text-void-fg-2 rounded-md" style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>
									{endpoint.url}
								</div>
							</div>

							<div className="flex flex-col gap-1">
								<div className="text-[10px] text-void-fg-3 uppercase tracking-wider font-medium">Universal stable config</div>
								<div className="relative">
									<pre className="px-2.5 py-2 m-0 text-xs font-mono overflow-x-auto text-void-fg-2 rounded-md whitespace-pre" style={{ background: 'var(--void-bg-2)', border: '1px solid var(--void-border-2)' }}>{clientConfig}</pre>
									<VoidButtonBgDarken className="absolute top-2 right-2 px-2 py-1 text-xs flex items-center gap-1" onClick={onCopy}>
										{copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
									</VoidButtonBgDarken>
								</div>
							</div>

							<div className="flex flex-col gap-1.5 rounded-lg px-3 py-2.5" style={{ background: accentMix(6), border: `1px solid ${accentMix(16)}` }}>
								<div className="flex items-center gap-2">
									<div className="min-w-0 flex-1">
										<div className="text-xs font-medium text-void-fg-1">Teach Claude when to use V3Code</div>
										<div className="text-[10px] text-void-fg-3 leading-relaxed">Copy this as <span className="font-mono text-void-fg-2">.claude/skills/v3code/SKILL.md</span>. Connecting tools alone does not guarantee Claude will reach for them proactively.</div>
									</div>
									<VoidButtonBgDarken className="shrink-0 px-2 py-1 text-xs flex items-center gap-1" onClick={onCopyClaudeSkill}>
										{copiedSkill ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy skill</>}
									</VoidButtonBgDarken>
								</div>
							</div>

							{(endpoint.workspaces?.length ?? 0) > 0 && (
								<div className="text-xs text-void-fg-3">
									Serving workspace: <span className="font-mono text-void-fg-2">{endpoint.workspaces!.join(', ')}</span>
								</div>
							)}

							<div className="flex flex-col gap-1.5">
								<div className="text-[10px] text-void-fg-3 uppercase tracking-wider font-medium">Exposed tools ({V3CODE_EXPOSED_TOOLS.length})</div>
								<div className="flex flex-wrap gap-1.5">
									{V3CODE_EXPOSED_TOOLS.map(t => (
										<span key={t} className="px-2 py-0.5 rounded-md text-[11px] font-mono text-void-fg-2" style={{ background: accentMix(8), border: `1px solid ${accentMix(20)}` }}>{t}</span>
									))}
								</div>
							</div>
						</>
					)}
				</div>
			</SettingsCard>
		</SettingsSection>
	)
};


/**
 * "Expose V3Code" — this editor acting as an MCP SERVER for outside agents.
 *
 * Split out of McpTab because it is the opposite direction of traffic: everything else on
 * that tab is V3Code consuming other people's servers, while this is Claude Code / Codex /
 * another editor consuming V3Code. Sharing one tab meant this card sat below a scrolling marketplace
 * and was effectively undiscoverable — which matters now that a second running build makes
 * "which instance am I connected to?" a real question the user has to answer here.
 */
export const McpExposeTab = () => {
	return (
		<ErrorBoundary>
			<V3codeMcpServerCard />
		</ErrorBoundary>
	)
}


export const McpTab = () => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')

	return (
		<ErrorBoundary>
			<SettingsSection label="Custom servers">
				<SettingsCard>
					<SettingRow
						settingId="mcp.add"
						title="Add MCP server"
						description="Edit your MCP config directly to add a server that is not in the gallery."
						control={
							<VoidButtonBgDarken className='px-3 py-1 text-xs flex items-center gap-1' onClick={async () => { await mcpService.revealMCPConfigFile() }}>
								Add
							</VoidButtonBgDarken>
						}
					/>
				</SettingsCard>
			</SettingsSection>
			<CustomServersList />
			<ConnectorGallery />
		</ErrorBoundary>
	)
}