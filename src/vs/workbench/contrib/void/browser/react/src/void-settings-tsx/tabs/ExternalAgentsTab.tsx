/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalAgentsBanner } from './ExternalAgentsBanner.js';
import { Bot, Loader2, MessageSquarePlus, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { VoidButtonBgDarken, VoidSimpleInputBox, VoidSwitch } from '../../util/inputs.js';
import { useAccessor } from '../../util/services.js';
import { SettingRow, SettingsCard, SettingsSection } from '../SettingsLayout.js';
import { WarningBox } from '../WarningBox.js';
import { describeExternalAgentLaunch, OFFICIAL_ACP_REGISTRY_URL, resolveExternalAgentLaunch } from '../settingsExternals.js';
import type { IExternalAgentEntry, IExternalAgentsState } from '../settingsExternals.js';

const useExternalAgentsState = (): IExternalAgentsState => {
	const accessor = useAccessor();
	const service = accessor.get('IExternalAgentsService');
	const [state, setState] = useState<IExternalAgentsState>(service.state);
	useEffect(() => {
		const disposable = service.onDidChangeState(next => setState(next));
		return () => disposable.dispose();
	}, [service]);
	return state;
};

type RowStatus = { label: string; tone: 'ok' | 'warn' | 'off' };

const statusOf = (entry: IExternalAgentEntry, state: IExternalAgentsState): RowStatus => {
	const enabled = state.catalogue.enabledIds.includes(entry.id);
	if (!resolveExternalAgentLaunch(entry)) {
		return { label: 'Manual installation required', tone: 'warn' };
	}
	if (!enabled) {
		return { label: 'Off', tone: 'off' };
	}
	if (!state.hostEnabled) {
		return { label: 'Local agent host is off', tone: 'warn' };
	}
	const hosted = state.hosted.get(entry.id);
	if (!hosted) {
		return { label: 'Waiting for the agent host', tone: 'warn' };
	}
	if (hosted.description.startsWith('Command not found') || hosted.description.startsWith('No launch command')) {
		return { label: hosted.description, tone: 'warn' };
	}
	return { label: 'Launcher available', tone: 'ok' };
};

const toneClass: Record<RowStatus['tone'], string> = {
	ok: 'text-green-600 dark:text-green-400',
	warn: 'text-amber-600 dark:text-amber-400',
	off: 'text-void-fg-3',
};

const AgentRow = ({ entry, state }: { entry: IExternalAgentEntry; state: IExternalAgentsState }) => {
	const accessor = useAccessor();
	const service = accessor.get('IExternalAgentsService');
	const enabled = state.catalogue.enabledIds.includes(entry.id);
	const status = statusOf(entry, state);
	const launchable = !!resolveExternalAgentLaunch(entry);
	const canOpen = enabled && state.hostEnabled && state.hosted.has(entry.id) && status.tone === 'ok';
	const [busy, setBusy] = useState(false);

	const toggle = useCallback(async (value: boolean) => {
		setBusy(true);
		try { await service.setEnabled(entry.id, value); } finally { setBusy(false); }
	}, [service, entry.id]);

	const meta = [
		entry.version ? `v${entry.version}` : undefined,
		entry.source === 'custom' ? 'Custom' : 'Registry',
		entry.license,
	].filter(Boolean).join(' · ');

	return (
		<SettingRow
			title={<span className='inline-flex flex-wrap items-center gap-2'>{entry.name}<span className={`text-[11px] font-normal ${toneClass[status.tone]}`}>{status.label}</span></span>}
			description={
				<span className='flex flex-col gap-0.5'>
					{launchable ? <span className='flex flex-wrap items-center gap-3 mb-2'>
						<label className='inline-flex items-center gap-2 text-xs'>Memory / Index {entry.memoryIndex !== false ? 'ON' : 'OFF'}<VoidSwitch size='sm' value={entry.memoryIndex !== false} onChange={value => { void service.setEditorAccess(entry.id, 'memoryIndex', value); }} /></label>
						<label className='inline-flex items-center gap-2 text-xs'>Browser {entry.browserAccess === true ? 'ON' : 'OFF'}<VoidSwitch size='sm' value={entry.browserAccess === true} onChange={value => { void service.setEditorAccess(entry.id, 'browserAccess', value); }} /></label>
					</span> : null}
					<span className='text-[11px] opacity-60'>Turn Browser on before choosing Open chat. Existing chats do not gain access mid-conversation. With MCP exposed, Browser ON allows this agent to read and control browser pages, including signed-in pages, without repeated action prompts. Pages stay open until closed.</span>
					{entry.description ? <span>{entry.description}</span> : null}
					<span className='text-[11px] opacity-70'>{launchable ? 'Launcher detection does not verify installation, credentials or a successful chat. Use Setup / sign in to configure the agent, then open a new chat.' : 'Automatic binary installation is not supported yet. Follow the setup documentation for this agent, then use Add custom agent with its installed ACP command. This does not mean the agent is incompatible.'}</span>
					<span className='font-mono text-[11px] opacity-70 break-all'>{describeExternalAgentLaunch(entry)}</span>
					{meta ? <span className='text-[11px] opacity-60'>{meta}</span> : null}
				<span className='flex flex-wrap items-center gap-2 mt-3'>
					<VoidButtonBgDarken onClick={() => { void service.openSetupTerminal(entry.id); }} className='text-xs'>Setup / sign in</VoidButtonBgDarken>
					{entry.website && /^https?:\/\//i.test(entry.website) ? <VoidButtonBgDarken onClick={() => { void service.openSetupDocs(entry.id); }} className='text-xs'>Setup docs</VoidButtonBgDarken> : null}
					{canOpen ? (
						<VoidButtonBgDarken onClick={() => { void service.openChat(entry.id, 'sidebar'); }} className='gap-1 text-xs'>
							<MessageSquarePlus size={13} /> Open chat
						</VoidButtonBgDarken>
					) : null}
					{entry.source === 'custom' ? (
						<button
							type='button'
							title='Remove'
							aria-label={`Remove ${entry.name}`}
							className='p-1 rounded-sm opacity-60 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10'
							onClick={() => { void service.remove(entry.id); }}
						>
							<Trash2 size={13} />
						</button>
					) : null}
					{launchable ? (busy ? <Loader2 size={14} className='animate-spin opacity-70' /> : <VoidSwitch size='sm' value={enabled} onChange={v => { void toggle(v); }} />) : null}
				</span>
				</span>
			}
		/>
	);
};

const parseEnv = (text: string): Record<string, string> | undefined => {
	const env: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) { continue; }
		const eq = line.indexOf('=');
		if (eq <= 0) { continue; }
		env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return Object.keys(env).length ? env : undefined;
};

/** Splits a command line on whitespace, honouring single and double quotes. */
const splitArgs = (text: string): string[] => {
	const out: string[] = [];
	let current = '';
	let quote: '"' | '\'' | undefined;
	let has = false;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) { quote = undefined; } else { current += ch; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; has = true; continue; }
		if (/\s/.test(ch)) {
			if (has || current) { out.push(current); current = ''; has = false; }
			continue;
		}
		current += ch;
		has = true;
	}
	if (has || current) { out.push(current); }
	return out;
};

const AddCustomAgent = () => {
	const accessor = useAccessor();
	const service = accessor.get('IExternalAgentsService');
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [commandLine, setCommandLine] = useState('');
	const [envText, setEnvText] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = useCallback(async () => {
		setError(null);
		const parts = splitArgs(commandLine);
		if (parts.length === 0) {
			setError('Enter the command that starts the agent in ACP stdio mode.');
			return;
		}
		setBusy(true);
		try {
			await service.addCustom({ name, command: parts[0], args: parts.slice(1), env: parseEnv(envText) });
			setName(''); setCommandLine(''); setEnvText(''); setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [service, name, commandLine, envText]);

	if (!open) {
		return (
			<VoidButtonBgDarken onClick={() => setOpen(true)} className='gap-1 text-xs self-start'>
				<Plus size={13} /> Add custom agent
			</VoidButtonBgDarken>
		);
	}

	return (
		<SettingsCard className='flex flex-col gap-3'>
			<div className='text-xs text-void-fg-3'>
				Any program that speaks the Agent Client Protocol over stdio can be added here. It runs as a local process with your user permissions and appears in the Agents rail once enabled.
			</div>
			<label className='flex flex-col gap-1 text-xs'>
				<span>Name</span>
				<VoidSimpleInputBox value={name} onChangeValue={setName} placeholder='My agent' compact />
			</label>
			<label className='flex flex-col gap-1 text-xs'>
				<span>Command</span>
				<VoidSimpleInputBox value={commandLine} onChangeValue={setCommandLine} placeholder='my-agent --acp' compact />
			</label>
			<label className='flex flex-col gap-1 text-xs'>
				<span>Environment (optional, one KEY=value per line)</span>
				<textarea
					className='w-full min-h-[56px] rounded-sm px-2 py-1 text-xs font-mono bg-void-bg-1 border border-void-border-3 outline-none focus:border-void-border-1'
					value={envText}
					onChange={e => setEnvText(e.target.value)}
					spellCheck={false}
				/>
			</label>
			{error ? <WarningBox text={error} /> : null}
			<div className='flex items-center gap-2'>
				<VoidButtonBgDarken onClick={() => { void submit(); }} disabled={busy} className='text-xs'>{busy ? 'Adding…' : 'Add agent'}</VoidButtonBgDarken>
				<VoidButtonBgDarken onClick={() => { setOpen(false); setError(null); }} disabled={busy} className='text-xs'>Cancel</VoidButtonBgDarken>
			</div>
		</SettingsCard>
	);
};

export const ExternalAgentsTab = () => {
	const accessor = useAccessor();
	const service = accessor.get('IExternalAgentsService');
	const state = useExternalAgentsState();
	const [registryUrl, setRegistryUrl] = useState(state.catalogue.registryUrl);
	useEffect(() => { setRegistryUrl(state.catalogue.registryUrl); }, [state.catalogue.registryUrl]);

	const agents = useMemo(() => {
		const enabled = new Set(state.catalogue.enabledIds);
		return [...state.catalogue.agents].sort((a, b) => Number(enabled.has(b.id)) - Number(enabled.has(a.id)) || a.name.localeCompare(b.name));
	}, [state.catalogue]);
	const availableAgents = agents.filter(entry => !!resolveExternalAgentLaunch(entry));
	const unavailableAgents = agents.filter(entry => !resolveExternalAgentLaunch(entry));

	const registryDirty = registryUrl.trim() !== state.catalogue.registryUrl.trim();
	const commitRegistryUrl = useCallback(async () => {
		if (registryDirty) {
			await service.setRegistryUrl(registryUrl);
		}
	}, [service, registryUrl, registryDirty]);
	const refresh = useCallback(async () => {
		await commitRegistryUrl();
		await service.refreshFromRegistry();
	}, [service, commitRegistryUrl]);

	return (
		<div className='flex flex-col gap-6'>
			<ExternalAgentsBanner />
			<SettingsSection label='External agents'>
				<div className='text-xs text-void-fg-3 mb-2'>
					Coding agents that speak the Agent Client Protocol (ACP) run as local processes and chat inside V3Code with native approvals and diffs. Nothing is fetched, installed or started until you ask for it here.
				</div>
				{!state.hostEnabled ? (
					<WarningBox text='The local agent host is turned off (chat.agentHost.enabled). External agents cannot start until it is on and the editor has restarted.' />
				) : null}
				{state.lastError ? <WarningBox text={state.lastError} /> : null}
				<SettingsCard>
					{availableAgents.length === 0 ? (
						<div className='flex items-center gap-2 text-xs text-void-fg-3 py-2'>
							<Bot size={14} /> No agents yet. Load the registry below or add a custom agent.
						</div>
					) : availableAgents.map(entry => <AgentRow key={entry.id} entry={entry} state={state} />)}
				</SettingsCard>
				{unavailableAgents.length > 0 ? <details className='text-xs'>
					<summary className='cursor-pointer py-2'>Manual installation / unsupported launch format ({unavailableAgents.length})</summary>
					<SettingsCard>{unavailableAgents.map(entry => <AgentRow key={entry.id} entry={entry} state={state} />)}</SettingsCard>
				</details> : null}
				<div className='mt-3'>
					{!agents.some(entry => entry.distribution.command?.command === 'v3code' && entry.distribution.command.args?.includes('acp')) ? (
						<VoidButtonBgDarken className='text-xs mb-3' onClick={() => { void service.addCustom({ name: 'V3Code Terminal', command: 'v3code', args: ['acp'], description: 'Use your installed V3Code Terminal inside the editor. No download or sign-in is performed.' }); }}>Add V3Code Terminal</VoidButtonBgDarken>
					) : null}
					<AddCustomAgent />
				</div>
			</SettingsSection>

			<SettingsSection label='Registry'>
				<SettingRow
					title='Registry URL'
					description='A published list of ACP agents. Refreshing only updates the list; enabling an agent is always a separate, explicit step.'
				>
					<div className='flex flex-col gap-2 mt-2'>
						<VoidSimpleInputBox value={registryUrl} onChangeValue={setRegistryUrl} placeholder='https://…/registry.json' compact onBlur={() => { void commitRegistryUrl(); }} />
						<div className='flex flex-wrap items-center gap-2'>
							{registryUrl.trim() !== OFFICIAL_ACP_REGISTRY_URL ? (
								<VoidButtonBgDarken onClick={() => setRegistryUrl(OFFICIAL_ACP_REGISTRY_URL)} className='text-xs'>Use the official ACP registry</VoidButtonBgDarken>
							) : null}
							<VoidButtonBgDarken onClick={() => { void refresh(); }} disabled={state.refreshing || !registryUrl.trim()} className='gap-1 text-xs'>
								{state.refreshing ? <Loader2 size={13} className='animate-spin' /> : <RefreshCw size={13} />} {state.refreshing ? 'Refreshing…' : 'Refresh list'}
							</VoidButtonBgDarken>
							{state.lastRefreshAt ? <span className='text-[11px] text-void-fg-3'>Updated {new Date(state.lastRefreshAt).toLocaleString()}</span> : null}
						</div>
					</div>
				</SettingRow>
			</SettingsSection>

			<SettingsSection label='What V3Code can and cannot see'>
				<div className='text-xs text-void-fg-3 flex flex-col gap-1'>
					<span>External agents are separate programs with the same access to your machine as you. V3Code shows and approves the file reads, writes and permission requests an agent routes through the protocol, and captures a git baseline so edits appear in the session's changes.</span>
					<span>When an agent supports managed sign-in, chat asks before starting its authentication flow. Terminal-only sign-in still uses the agent's own tooling. Agent-requested terminals and automatic binary downloads are not supported yet.</span>
				</div>
			</SettingsSection>
		</div>
	);
};
