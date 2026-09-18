/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { refreshableProviderNames, displayInfoOfProviderName, Severity, ConfigurationTarget } from '../settingsExternals.js';
import { VoidButtonBgDarken, VoidCustomDropdownBox, VoidSlider, VoidSwitch } from '../../util/inputs.js'
import { useAccessor } from '../../util/services.js'
import {
	CardDivider,
	SettingRow,
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js'
import { WarningBox } from '../WarningBox.js'
import { AutoDetectLocalModelsToggleControl } from '../settingsShared.js'

// --- Chat & UI config helpers (backed by IConfigurationService user settings) ---

const GLOBAL_AUTO_APPROVE_SETTING = 'chat.tools.global.autoApprove';

function useConfigValue<T>(key: string): [T, (value: T) => void] {
	const accessor = useAccessor();
	const configService = accessor.get('IConfigurationService');
	const [value, setValue] = useState<T>(() => configService.getValue<T>(key));
	useEffect(() => {
		const d = configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(key)) {
				setValue(configService.getValue<T>(key));
			}
		});
		return () => d.dispose();
	}, [configService, key]);
	const update = useCallback((newVal: T) => {
		void configService.updateValue(key, newVal, ConfigurationTarget.USER);
	}, [configService, key]);
	return [value, update];
}

const ConfigToggle = ({ configKey, size = 'xs' }: { configKey: string; size?: 'xxs' | 'xs' | 'sm' | 'sm+' | 'md' }) => {
	const [value, setValue] = useConfigValue<boolean>(configKey);
	return <VoidSwitch size={size} value={!!value} onChange={setValue} />;
};

const AutoRouterConfigToggle = () => {
	const [enabled, setEnabled] = useConfigValue<boolean>('v3code.agent.autoRouter');
	const [rung, setRung] = useConfigValue<number>('v3code.agent.routerRung');
	const onChange = useCallback((next: boolean) => {
		setEnabled(next);
		setRung(next ? (typeof rung === 'number' && rung > 0 ? Math.min(4, Math.round(rung)) : 2) : 0);
	}, [rung, setEnabled, setRung]);
	return <VoidSwitch size='xs' value={!!enabled} onChange={onChange} />;
};

const ConfigEnumPicker = <T extends string>({
	configKey,
	options,
	getLabel,
	className = 'text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1',
}: {
	configKey: string;
	options: readonly T[];
	getLabel: (value: T) => string;
	className?: string;
}) => {
	const [value, setValue] = useConfigValue<T>(configKey);
	const selected = options.includes(value) ? value : options[0];
	return <VoidCustomDropdownBox
		className={className}
		options={[...options]}
		selectedOption={selected}
		onChangeOption={setValue}
		getOptionDisplayName={getLabel}
		getOptionDropdownName={getLabel}
		getOptionsEqual={(a, b) => a === b}
	/>;
};

const ConfigSlider = ({
	configKey,
	min,
	max,
	step = 0.05,
	width = 160,
	size = 'xs',
}: {
	configKey: string;
	min: number;
	max: number;
	step?: number;
	width?: number;
	size?: 'xxs' | 'xs' | 'sm' | 'sm+' | 'md';
}) => {
	const [value, setValue] = useConfigValue<number>(configKey);
	const clamped = Math.min(max, Math.max(min, typeof value === 'number' ? value : min));
	return <VoidSlider size={size} value={clamped} onChange={setValue} min={min} max={max} step={step} width={width} />;
};

const YoloModeConfigToggle = () => {
	const accessor = useAccessor();
	const configService = accessor.get('IConfigurationService');
	const notificationService = accessor.get('INotificationService');
	const [raw, setRaw] = useState<unknown>(() => configService.getValue(GLOBAL_AUTO_APPROVE_SETTING));

	useEffect(() => {
		const d = configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(GLOBAL_AUTO_APPROVE_SETTING)) {
				setRaw(configService.getValue(GLOBAL_AUTO_APPROVE_SETTING));
			}
		});
		return () => d.dispose();
	}, [configService]);

	const isOn = raw === true || (typeof raw === 'object' && raw !== null && Object.keys(raw).length > 0 && Object.values(raw as Record<string, unknown>).some(v => v === true));

	const onChange = async (next: boolean) => {
		if (next && !isOn) {
			const confirmed = await new Promise<boolean>(resolve => {
				notificationService.prompt(
					Severity.Warning,
					'Enable YOLO mode? The agent will auto-approve ALL tools (edits, terminal commands, deletes) in every workspace, with no confirmation. This is dangerous — only use it in code you trust.',
					[
						{ label: 'Enable YOLO', run: () => resolve(true) },
						{ label: 'Cancel', run: () => resolve(false) },
					],
					{ sticky: true }
				);
			});
			if (!confirmed) { return; }
		}
		await configService.updateValue(GLOBAL_AUTO_APPROVE_SETTING, next, ConfigurationTarget.USER);
	};

	return <VoidSwitch size='xs' value={isOn} onChange={onChange} />;
};

// Name the behaviour, not the density. These map to CollapsedToolsDisplayMode Always / Off /
// WithThinking respectively (see v3codeConversationDensity.ts) -- i.e. whether a file edit or
// terminal card is folded into the thinking summary or shown in full.
const CONVERSATION_DENSITY_OPTIONS = ['compact-all-grouped', 'detailed', 'default'] as const;
const conversationDensityLabel = (v: typeof CONVERSATION_DENSITY_OPTIONS[number]) =>
	v === 'compact-all-grouped' ? 'Always folded' : v === 'detailed' ? 'Always open' : 'Folded while working';

const QUEUE_BEHAVIOR_OPTIONS = ['queue', 'stop-and-send'] as const;
const queueBehaviorLabel = (v: typeof QUEUE_BEHAVIOR_OPTIONS[number]) =>
	v === 'queue' ? 'Queue' : 'Stop and send';

const USAGE_SUMMARY_OPTIONS = ['auto', 'always', 'never'] as const;
const usageSummaryLabel = (v: typeof USAGE_SUMMARY_OPTIONS[number]) =>
	v === 'auto' ? 'Auto' : v === 'always' ? 'Always' : 'Never';

const ROUTER_RUNG_LABELS = ['Manual', 'Economy', 'Value', 'Balanced', 'Premium'] as const;

const VOICE_SPEECH_LANGUAGE_OPTIONS = ['auto', 'en-US', 'en-GB', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'zh-CN'] as const;
const voiceSpeechLanguageLabel = (v: typeof VOICE_SPEECH_LANGUAGE_OPTIONS[number]) =>
	v === 'auto' ? 'Auto (display language)' : v;

export const ChatUiTab = () => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const [routerRung] = useConfigValue<number>('v3code.agent.routerRung');
	const rungIndex = Math.min(ROUTER_RUNG_LABELS.length - 1, Math.max(0, Math.round(typeof routerRung === 'number' ? routerRung : 0)));

	return (
		<div className='flex flex-col gap-8'>
			<SettingsSection label="Models">
				<SettingsCard>
					<SettingRow
						title="Auto-refresh models"
						description={`Poll local and API providers for new models (${refreshableProviderNames.map(p => displayInfoOfProviderName(p).title).join(', ')}).`}
						control={<AutoDetectLocalModelsToggleControl />}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Safety">
				<SettingsCard>
					<SettingRow
						title="YOLO mode (auto-approve all tools)"
						description="Skip every tool approval prompt in every workspace — edits, terminal, deletes. Dangerous."
						control={<YoloModeConfigToggle />}
					/>
					<div className='px-4 pb-3'>
						<WarningBox text="YOLO auto-approves ALL agent tools with no confirmation. Only enable in codebases you fully trust." />
					</div>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Tool cards">
				<SettingsCard>
					<SettingRow
						settingId="chatUi.density"
						title="Show edit and terminal cards"
						description="Whether file edits and terminal commands stay visible in the chat panel or fold away into the thinking summary. Folded while working shows them again once the turn finishes."
						control={<ConfigEnumPicker configKey='v3code.agent.conversationDensity' options={CONVERSATION_DENSITY_OPTIONS} getLabel={conversationDensityLabel} />}
					/>
					<CardDivider />
					<SettingRow
						title="Show them in inline editor chat"
						description="The same choice for chat opened inside an editor rather than the side panel."
						control={<ConfigEnumPicker configKey='v3code.agent.editorConversationDensity' options={CONVERSATION_DENSITY_OPTIONS} getLabel={conversationDensityLabel} />}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Visuals">
				<SettingsCard>
					<SettingRow
						title="Venom animations"
						description="Venom-green motion while the agent works (composer beam, capsule snake, accent glows). OS Reduce motion also turns this off."
						control={<ConfigToggle configKey='v3code.chrome.venomAnimations' />}
					/>
					<CardDivider />
					<SettingRow
						title="Chat text size"
						description="Scale AI message text relative to the 12px base."
						control={<ConfigSlider configKey='v3code.agent.textSizeScale' min={0.85} max={1.3} step={0.05} />}
					/>
					<CardDivider />
					<SettingRow
						title="Chat max width"
						description="Maximum width in pixels of chat content."
						control={<ConfigSlider configKey='v3code.chat.maxWidth' min={480} max={1200} step={20} width={200} />}
					/>
					<CardDivider />
					<SettingRow
						title="Reduce transparency"
						description="Replace translucent/vibrancy surfaces with opaque backgrounds."
						control={<ConfigToggle configKey='v3code.general.reduceTransparency' />}
					/>
					<CardDivider />
					<SettingRow
						title="Notifications same as chat"
						description="Show notification toasts in the same region as chat."
						control={<ConfigToggle configKey='v3code.preferNotificationsSameAsChat' />}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Behavior">
				<SettingsCard>
					<SettingRow
						title="Usage summary"
						description="When to show token usage at the bottom of chat."
						control={<ConfigEnumPicker configKey='v3code.agent.usageSummaryDisplay' options={USAGE_SUMMARY_OPTIONS} getLabel={usageSummaryLabel} />}
					/>
					<CardDivider />
					<SettingRow
						title="Empty-state tips"
						description="Show rotating tips on the empty chat screen."
						control={<ConfigToggle configKey='v3code.agent.showEmptyStateTips' />}
					/>
					<CardDivider />
					<SettingRow
						title="Suggest next prompt"
						description="Suggest a follow-up after each turn."
						control={<ConfigToggle configKey='v3code.agent.suggestNextPrompt' />}
					/>
					<CardDivider />
					<SettingRow
						title="Chime when chat finishes"
						description="Play a sound when a chat response completes."
						control={<ConfigToggle configKey='v3code.agent.shouldChimeAfterChatFinishes' />}
					/>
					<CardDivider />
					<SettingRow
						settingId="chatUi.queue"
						title="Queue while streaming"
						description="Default when sending a message while the agent is still streaming."
						control={<ConfigEnumPicker configKey='v3code.agent.queueMessageDefaultBehavior' options={QUEUE_BEHAVIOR_OPTIONS} getLabel={queueBehaviorLabel} />}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Voice input">
				<SettingsCard>
					<SettingRow
						settingId="chatUi.voice"
						title="Enable voice input"
						description="Show the microphone in chat and use built-in Web Speech transcription (hold mic or hold ⌘I while the composer is focused)."
						control={<ConfigToggle configKey='v3code.voice.enabled' />}
					/>
					<CardDivider />
					<SettingRow
						title="Speech language"
						description="Language for speech-to-text. Auto uses your display language when supported."
						control={<ConfigEnumPicker configKey='accessibility.voice.speechLanguage' options={VOICE_SPEECH_LANGUAGE_OPTIONS} getLabel={voiceSpeechLanguageLabel} />}
					/>
					<CardDivider />
					<SettingRow
						title="Auto-submit after silence (ms)"
						description="After you stop speaking, submit the composer automatically after this many milliseconds. 0 keeps text in the box until you press Send."
						control={<ConfigSlider configKey='accessibility.voice.speechTimeout' min={0} max={5000} step={250} width={200} />}
					/>
					<CardDivider />
					<SettingRow
						title="Hold-to-talk shortcut"
						description="Default: hold ⌘I while the chat input is focused. Customize in Keyboard Shortcuts (Start Voice Chat)."
						control={
							<VoidButtonBgDarken
								className='px-3 py-1 text-xs'
								onClick={() => { void commandService.executeCommand('workbench.action.openGlobalKeybindings', 'workbench.action.chat.startVoiceChat'); }}
							>
								Configure
							</VoidButtonBgDarken>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Router">
				<SettingsCard>
					<SettingRow
						settingId="chatUi.router"
						title="Auto router"
						description="Choose the cheapest capable model inside your current provider. Auto never crosses to another plan, API key, or billing lane."
						control={<AutoRouterConfigToggle />}
					/>
					<CardDivider />
					<SettingRow
						title="Model budget"
						description="Manual, Economy, Value, Balanced, or Premium. API keys use real catalog prices; plans and local models use capability. Value is the recommended Auto default."
						control={<span className='text-void-fg-2 text-xs tabular-nums'>{ROUTER_RUNG_LABELS[rungIndex]} ({rungIndex})</span>}
					/>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
};
