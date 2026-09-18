/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ImageDescribeMode, PromptAssemblyPresetSetting, OPT_OUT_KEY, StorageScope, StorageTarget, Severity, ConfigurationTarget, getModelCapabilities } from '../settingsExternals.js';
import { VoidButtonBgDarken, VoidSwitch } from '../../util/inputs.js';
import { useAccessor, useIsOptedOut, useSettingsState } from '../../util/services.js';
import {
	CardDivider,
	SettingRow,
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js';
import {
	AIInstructionsBox,
	ConfirmButton,
	OneClickSwitchButton,
} from '../settingsShared.js';

// Appearance / motion — exposes the venom-animations toggle (accessibility). The
// setting (v3code.chrome.venomAnimations) is also auto-off under OS "Reduce motion".
const AppearanceMotionSection = () => {
	const accessor = useAccessor()
	const configService = accessor.get('IConfigurationService')
	const [on, setOn] = useState(configService.getValue('v3code.chrome.venomAnimations') !== false)
	useEffect(() => {
		const d = configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('v3code.chrome.venomAnimations')) {
				setOn(configService.getValue('v3code.chrome.venomAnimations') !== false)
			}
		})
		return () => d.dispose()
	}, [configService])
	return (
		<SettingsSection label="Appearance">
			<SettingsCard>
				<SettingRow
					title="Venom animations"
					description="Show venom-green motion while the agent works — the composer beam, sticky-capsule snake, and accent glows. Turn off for calm grey-only chrome. Recommended if flashing or motion bothers you; your OS 'Reduce motion' setting also turns it off automatically."
					control={<VoidSwitch size='xs' value={on} onChange={(v) => { void configService.updateValue('v3code.chrome.venomAnimations', v) }} />}
				/>
			</SettingsCard>
		</SettingsSection>
	)
}

// The color tokens that matter most for "make it yours" theming. Curated from the
// hundreds of registered VS Code colors — accent, surfaces, text, borders.
const CURATED_THEME_TOKENS: { group: string; items: { id: string; label: string; desc: string }[] }[] = [
	{
		group: 'Accent', items: [
			{ id: 'focusBorder', label: 'Focus / accent', desc: 'Focus rings and primary accent.' },
			{ id: 'button.background', label: 'Button', desc: 'Primary action buttons.' },
			{ id: 'textLink.foreground', label: 'Links', desc: 'Hyperlinks and inline accents.' },
			{ id: 'progressBar.background', label: 'Progress / usage', desc: 'Drives the V3 usage accent.' },
			{ id: 'activityBarBadge.background', label: 'Badge', desc: 'Activity-bar / notification badges.' },
		],
	},
	{
		group: 'Surfaces', items: [
			{ id: 'editor.background', label: 'Editor', desc: 'Main code surface.' },
			{ id: 'sideBar.background', label: 'Sidebar', desc: 'Explorer / side panels.' },
			{ id: 'panel.background', label: 'Bottom panel', desc: 'Terminal / problems.' },
			{ id: 'activityBar.background', label: 'Activity bar', desc: 'The left icon rail.' },
			{ id: 'titleBar.activeBackground', label: 'Title bar', desc: 'Top window bar.' },
			{ id: 'statusBar.background', label: 'Status bar', desc: 'Bottom strip.' },
			{ id: 'tab.activeBackground', label: 'Active tab', desc: 'The focused editor tab.' },
			{ id: 'tab.inactiveBackground', label: 'Inactive tabs', desc: 'Editor tabs you are not on.' },
			{ id: 'editorGroupHeader.tabsBackground', label: 'Tab strip', desc: 'The bar behind the tabs.' },
			{ id: 'input.background', label: 'Inputs', desc: 'Text fields and dropdowns.' },
			{ id: 'dropdown.background', label: 'Dropdowns', desc: 'Model picker and menu popups.' },
			{ id: 'editorWidget.background', label: 'Popups', desc: 'Hovers, suggestions, peek.' },
			{ id: 'menu.background', label: 'Menus', desc: 'Right-click and account menus.' },
			{ id: 'sideBarSectionHeader.background', label: 'Section headers', desc: 'Headings inside side panels.' },
		],
	},
	{
		group: 'Lists & rows', items: [
			{ id: 'list.hoverBackground', label: 'Row hover', desc: 'Explorer and agent rows under the pointer.' },
			{ id: 'list.activeSelectionBackground', label: 'Selected row', desc: 'The row you picked, focused.' },
			{ id: 'list.inactiveSelectionBackground', label: 'Selected (unfocused)', desc: 'The picked row when the list loses focus.' },
			{ id: 'badge.background', label: 'Badges', desc: 'Counts and the account avatar.' },
			{ id: 'scrollbarSlider.background', label: 'Scrollbars', desc: 'The draggable scrollbar thumb.' },
		],
	},
	{
		group: 'Chat', items: [
			{ id: 'chat.requestBubbleBackground', label: 'Your message', desc: 'The bubble around what you sent.' },
			{ id: 'chat.requestCodeBorder', label: 'Message edge', desc: 'Outline of your message bubble.' },
			{ id: 'chat.rollingWorkForeground', label: 'Work text', desc: "The agent's running tool and progress text." },
			{ id: 'textCodeBlock.background', label: 'Code pills', desc: 'Inline `code` chips in chat.' },
		],
	},
	{
		group: 'Text & borders', items: [
			{ id: 'foreground', label: 'Text', desc: 'Primary UI text.' },
			{ id: 'descriptionForeground', label: 'Muted text', desc: 'Secondary / description text.' },
			{ id: 'disabledForeground', label: 'Dim text', desc: 'Labels, placeholders, disabled items.' },
			{ id: 'input.foreground', label: 'Typed text', desc: 'What you type into fields.' },
			{ id: 'input.placeholderForeground', label: 'Placeholder text', desc: 'The grey prompt inside empty fields.' },
			{ id: 'editorCursor.foreground', label: 'Caret', desc: 'The text cursor.' },
		],
	},
	// The tokens that actually make a theme feel "too red": bracket pairs colour every
	// line of dense code, and the error/warning marks sit on top of everything else.
	{
		group: 'Code signals', items: [
			{ id: 'editorBracketHighlight.foreground1', label: 'Brackets', desc: 'First bracket-pair colour - the one you see everywhere in dense code.' },
			{ id: 'editorBracketHighlight.foreground2', label: 'Brackets (2nd)', desc: 'Second bracket-pair colour.' },
			{ id: 'editorError.foreground', label: 'Error marks', desc: 'Squiggles and error icons.' },
			{ id: 'editorWarning.foreground', label: 'Warning marks', desc: 'Squiggles and warning icons.' },
			{ id: 'editor.selectionBackground', label: 'Selection', desc: 'Selected text highlight.' },
			{ id: 'gitDecoration.modifiedResourceForeground', label: 'Changed files', desc: 'Modified entries in the explorer.' },
		],
	},
]

/**
 * Kill switch for the Theme Builder UI.
 *
 * Off because the feature does not honour its own picks: V3Code hardcodes colours in enough
 * places that most tokens set here are overridden downstream, so the control appears to do
 * nothing for reasons a user cannot see. The theme PICKER is unaffected and still works —
 * switching themes is a real fix for a mis-coloured surface.
 *
 * Deliberately hidden rather than deleted: this is still the quickest way to find out which
 * token actually drives a surface when diagnosing a colour bug. Flip to true to get it back.
 */
const SHOW_THEME_BUILDER = false

// Theme Builder — surface the important color tokens as live pickers wired to
// workbench.colorCustomizations, scoped to the theme in use so each theme keeps its
// own look and Reset only clears the current one.
const ThemeBuilderSection = () => {
	const accessor = useAccessor()
	const configService = accessor.get('IConfigurationService')
	const themeService = accessor.get('IThemeService')
	const [, setR] = useState(0)
	useEffect(() => {
		const d = themeService.onDidColorThemeChange(() => setR(x => x + 1))
		return () => d.dispose()
	}, [themeService])

	const theme = themeService.getColorTheme()
	const swatch = (id: string): string => {
		const c = theme.getColor(id, true)
		if (!c) { return '#1a1a1d' }
		const { r, g, b, a } = c.rgba
		// color inputs can't represent alpha — don't pretend transparent is #000000
		// (or a leftover channel) or the picker will write a solid color on first edit.
		if (a < 0.05) { return '#2a2a30' }
		return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')
	}
	// Writes go under `[Active Theme]`, never flat. Unscoped keys paint every theme and
	// are stripped by grey chrome on launch, which is what made picks impossible to keep.
	const scopeKey = () => `[${themeService.getColorTheme().label}]`
	/** A mutable copy of the USER layer alone — APPLICATION defaults must never be copied in. */
	const userColorCustomizations = (): Record<string, unknown> => {
		const userVal = configService.inspect<Record<string, unknown>>('workbench.colorCustomizations').userValue
		return (userVal && typeof userVal === 'object' && !Array.isArray(userVal)) ? { ...userVal } : {}
	}
	const setColor = (id: string, value: string) => {
		// Read the USER layer only, never the merged value: getValue() folds in the
		// APPLICATION theme-scoped grey chrome, and writing that back to USER baked
		// poison (e.g. panel.border #ff0000) that made Reset look broken after relaunch.
		// Writes stay scoped to the active theme so each theme keeps its own look.
		const key = scopeKey()
		const next = userColorCustomizations()
		const scoped = (next[key] && typeof next[key] === 'object') ? { ...(next[key] as Record<string, unknown>) } : {}
		scoped[id] = value
		next[key] = scoped
		void configService.updateValue('workbench.colorCustomizations', next, ConfigurationTarget.USER)
	}
	const reset = () => {
		// Drop this theme's picks only — never switch the theme the user chose, and never
		// wipe customizations they made for other themes.
		const next = userColorCustomizations()
		delete next[scopeKey()]
		void configService.updateValue('workbench.colorCustomizations', next, ConfigurationTarget.USER)
	}

	return (
		<SettingsSection label="Theme Builder — Beta">
			<SettingsCard>
				<div className='px-4 py-4 flex flex-col gap-4'>
					<div className='flex items-start justify-between gap-3'>
						<p className='text-void-fg-3 text-xs m-0 max-w-[34rem] leading-relaxed'>Pick your own colors for the editor UI — changes apply live and are saved for the theme you are using right now, so switching themes keeps each one's look. Reset clears only this theme's picks.</p>
						<VoidButtonBgDarken className='px-3 py-1 text-xs shrink-0' onClick={reset}>Reset</VoidButtonBgDarken>
					</div>
					{CURATED_THEME_TOKENS.map(group => (
						<div key={group.group} className='flex flex-col gap-2'>
							<div className='text-[10px] text-void-fg-3 uppercase tracking-wider font-medium'>{group.group}</div>
							<div className='grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2.5'>
								{group.items.map(t => (
									<label key={t.id} className='flex items-center gap-2.5 cursor-pointer'>
										<input
											type='color'
											value={swatch(t.id)}
											onChange={e => setColor(t.id, e.target.value)}
											title={t.id}
											style={{ width: 28, height: 22, borderRadius: 5, border: '1px solid var(--void-border-2)', padding: 0, background: 'transparent', cursor: 'pointer', flex: '0 0 auto' }}
										/>
										<div className='flex flex-col min-w-0'>
											<span className='text-void-fg-1 text-xs font-medium truncate'>{t.label}</span>
											<span className='text-void-fg-3 text-[10px] truncate'>{t.desc}</span>
										</div>
									</label>
								))}
							</div>
						</div>
					))}
				</div>
			</SettingsCard>
		</SettingsSection>
	)
}


export const GeneralTab = () => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const environmentService = accessor.get('IEnvironmentService');
	const nativeHostService = accessor.get('INativeHostService');
	const settingsState = useSettingsState();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const chatThreadsService = accessor.get('IChatThreadService');
	const notificationService = accessor.get('INotificationService');
	const storageService = accessor.get('IStorageService');
	const metricsService = accessor.get('IMetricsService');
	const isOptedOut = useIsOptedOut();

	const fileInputSettingsRef = useRef<HTMLInputElement>(null);
	const fileInputChatsRef = useRef<HTMLInputElement>(null);
	const [s, ss] = useState(0);

	const onDownload = (t: 'Chats' | 'Settings') => {
		const dataStr = t === 'Chats'
			? JSON.stringify(chatThreadsService.state, null, 2)
			: JSON.stringify(voidSettingsService.state, null, 2);
		const downloadName = t === 'Chats' ? 'void-chats.json' : 'void-settings.json';
		const blob = new Blob([dataStr], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = downloadName;
		a.click();
		URL.revokeObjectURL(url);
	};

	const handleUpload = (t: 'Chats' | 'Settings') => (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files) return;
		const file = files[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const json = JSON.parse(reader.result as string);
				if (t === 'Chats') {
					chatThreadsService.dangerousSetState(json as any);
				} else {
					voidSettingsService.dangerousSetState(json as any);
				}
				notificationService.info(`${t} imported successfully!`);
			} catch (err) {
				notificationService.notify({ message: `Failed to import ${t}`, source: err + '', severity: Severity.Error });
			}
		};
		reader.readAsText(file);
		e.target.value = '';
		ss(x => x + 1);
	};

	return (
		<div className='flex flex-col gap-8'>
<div data-setting-id="general.appearance"><AppearanceMotionSection /></div>
							{/* Theme Builder is hidden from users, not deleted. Its picks are overridden
								wherever V3Code hardcodes a colour, so it silently does nothing for most
								tokens — shipping a control that ignores you is worse than shipping none.
								The component stays because it is still the fastest way to work out which
								token actually drives a given surface; flip this to render it. */}
							{SHOW_THEME_BUILDER && <div data-setting-id="general.themeBuilder"><ThemeBuilderSection /></div>}
							<SettingsSection label="Transfer">
								<SettingsCard>
									<SettingRow settingId="general.transfer.vscode" title="From VS Code" description="Transfer extensions and settings from VS Code." control={<OneClickSwitchButton className='!p-2 !max-w-none' fromEditor="VS Code" />} />
									<CardDivider />
									<SettingRow settingId="general.transfer.cursor" title="From Cursor" description="Transfer extensions and settings from Cursor." control={<OneClickSwitchButton className='!p-2 !max-w-none' fromEditor="Cursor" />} />
									<CardDivider />
									<SettingRow title="From Windsurf" description="Transfer extensions and settings from Windsurf." control={<OneClickSwitchButton className='!p-2 !max-w-none' fromEditor="Windsurf" />} />
								</SettingsCard>
							</SettingsSection>

							<SettingsSection label="Settings data">
								<SettingsCard>
									<SettingRow
										settingId="general.importSettings"
										title="Import settings"
										description="Load V3Code settings from a JSON file."
										control={
											<>
												<input key={2 * s} ref={fileInputSettingsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Settings')} />
												<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { fileInputSettingsRef.current?.click() }}>Import</VoidButtonBgDarken>
											</>
										}
									/>
									<CardDivider />
									<SettingRow settingId="general.exportSettings" title="Export settings" description="Save your V3Code settings to a JSON file." control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => onDownload('Settings')}>Export</VoidButtonBgDarken>} />
									<CardDivider />
									<SettingRow settingId="general.resetSettings" title="Reset settings" description="Restore all V3Code settings to defaults." control={<ConfirmButton className='px-3 py-1 text-xs' onConfirm={() => { voidSettingsService.resetState(); }}>Reset</ConfirmButton>} />
								</SettingsCard>
							</SettingsSection>

							<SettingsSection label="Chat data">
								<SettingsCard>
									<SettingRow
										settingId="general.importChats"
										title="Import chats"
										description="Load chat history from a JSON file."
										control={
											<>
												<input key={2 * s + 1} ref={fileInputChatsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Chats')} />
												<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { fileInputChatsRef.current?.click() }}>Import</VoidButtonBgDarken>
											</>
										}
									/>
									<CardDivider />
									<SettingRow settingId="general.exportChats" title="Export chats" description="Save your chat history to a JSON file." control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => onDownload('Chats')}>Export</VoidButtonBgDarken>} />
									<CardDivider />
									<SettingRow settingId="general.resetChats" title="Reset chats" description="Clear all chat threads." control={<ConfirmButton className='px-3 py-1 text-xs' onConfirm={() => { chatThreadsService.resetState(); }}>Reset</ConfirmButton>} />
								</SettingsCard>
							</SettingsSection>

							<SettingsSection label="IDE">
								<SettingsCard>
									<SettingRow settingId="general.ideSettings" title="General settings" description="Open VS Code general settings." control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { commandService.executeCommand('workbench.action.openSettings') }}>Open</VoidButtonBgDarken>} />
									<CardDivider />
									<SettingRow settingId="general.keybindings" title="Keyboard shortcuts" description="Customize keybindings." control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { commandService.executeCommand('workbench.action.openGlobalKeybindings') }}>Open</VoidButtonBgDarken>} />
									<CardDivider />
									<SettingRow settingId="general.theme" title="Theme" description="Change color theme." control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { commandService.executeCommand('workbench.action.selectTheme') }}>Open</VoidButtonBgDarken>} />
									<CardDivider />
									<SettingRow settingId="general.logs" title="Logs" description="Open log files folder." control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { nativeHostService.showItemInFolder(environmentService.logsHome.fsPath) }}>Open</VoidButtonBgDarken>} />
								</SettingsCard>
							</SettingsSection>

							<SettingsSection label="Privacy">
								<SettingsCard>
									{/* Deliberately a statement, not a toggle. Telemetry is disabled at the
										sink (metricsMainService), so there is nothing here for a user to turn
										off — and a switch implying otherwise would be decoration. The previous
										copy also said "anonymous", which was not accurate: events carried a
										persistent device id and, when signed in, a user id. */}
									<SettingRow
										settingId="general.metrics"
										title="V3Code does not collect usage data"
										description="No analytics or usage events are sent from this app. Your code, prompts, files, and API keys never leave your machine except to the model provider you choose. If you report an issue, that form asks you each time before including anything about your setup."
									/>
								</SettingsCard>
							</SettingsSection>

							<SettingsSection label="AI Instructions">
								<SettingsCard>
									<div className="px-4 py-3" data-setting-id="general.aiInstructions">
										<p className="@@v3code-settings-row-desc mb-3 m-0">
											System instructions included with all AI requests. Alternatively, place a `.v3rules` file in your workspace root.
										</p>
										<AIInstructionsBox />
										<div className="mt-4 flex items-center gap-2" data-setting-id="general.disableAgentOs">
											<VoidSwitch
												size='xs'
												value={!!settingsState.globalSettings.disableSystemMessage}
												onChange={(newValue) => { voidSettingsService.setGlobalSetting('disableSystemMessage', newValue); }}
											/>
											<span className='text-void-fg-3 text-xs'>Disable Agent OS prompt</span>
										</div>
										<p className="@@v3code-settings-row-desc mt-2 m-0">
											Removes the built-in V3Code Agent OS prompt and workspace file overview. Your custom instructions, skills, auto-context, and tool schemas still apply.
										</p>
										<div className="mt-4" data-setting-id="general.imageDescribe">
											<p className="@@v3code-settings-row-desc mb-2 m-0">
												When your chat model is text-only (e.g. DeepSeek), images can be transcribed by a separate vision model.
											</p>
											<label className="text-void-fg-3 text-xs block mb-1">Image describe for text-only models</label>
											<select
												className="bg-void-bg-2 border border-void-border-3 rounded px-2 py-1 text-xs text-void-fg-2 w-full max-w-md"
												value={settingsState.globalSettings.imageDescribeMode ?? 'manual'}
												onChange={(e) => voidSettingsService.setGlobalSetting('imageDescribeMode', e.target.value as ImageDescribeMode)}
											>
												<option value="manual">Manual — Describe button / prompt on send</option>
												<option value="on_send">On send — auto-describe every image</option>
												<option value="off">Off — do not describe images</option>
											</select>
										</div>
										<div className="mt-4" data-setting-id="general.visionDescribeModel">
											<label className="text-void-fg-3 text-xs block mb-1">Vision transcription model</label>
											<select
												className="bg-void-bg-2 border border-void-border-3 rounded px-2 py-1 text-xs text-void-fg-2 w-full max-w-md"
												value={settingsState.globalSettings.visionDescribeModel || 'auto'}
												onChange={(e) => voidSettingsService.setGlobalSetting('visionDescribeModel', e.target.value)}
											>
												<option value="auto">Auto — cheapest available vision model</option>
												{(() => {
													const overrides = settingsState.overridesOfModel;
													const visionOpts = (settingsState._modelOptions ?? []).filter((o) => {
														try {
															return getModelCapabilities(o.selection.providerName, o.selection.modelName, overrides).supportsVision === true;
														} catch { return false; }
													});
													const savedRaw = settingsState.globalSettings.visionDescribeModel || 'auto';
													const encode = (sel: { providerName: string; modelName: string }) => JSON.stringify({ providerName: sel.providerName, modelName: sel.modelName });
													const rendered = visionOpts.map((o) => {
														const val = encode(o.selection);
														return <option key={val} value={val}>{o.name}</option>;
													});
													// Keep the user's saved pick visible even if it was later hidden/removed, so the
													// dropdown never silently blanks out or looks like it reset to Auto.
													if (savedRaw !== 'auto' && !visionOpts.some((o) => encode(o.selection) === savedRaw)) {
														let label = 'Saved model (unavailable)';
														try { const p = JSON.parse(savedRaw); if (p?.modelName) { label = `${p.modelName} (unavailable)`; } } catch { /* ignore */ }
														rendered.push(<option key={savedRaw} value={savedRaw}>{label}</option>);
													}
													return rendered;
												})()}
											</select>
											<p className="@@v3code-settings-row-desc mt-2 m-0">
												Which model reads images when your chat model is text-only. <strong>Auto</strong> picks the cheapest vision-capable model you have configured. Only the image plus a short describe instruction is sent — not your whole conversation — so the cost stays minimal even on a premium model.
											</p>
										</div>
										<div className="mt-4 flex items-center gap-2" data-setting-id="general.askUser">
											<VoidSwitch
												size='xs'
												value={settingsState.globalSettings.enableAskUserTool ?? true}
												onChange={(newValue) => { voidSettingsService.setGlobalSetting('enableAskUserTool', newValue); }}
											/>
											<span className='text-void-fg-3 text-xs'>Let the agent ask multiple-choice questions</span>
										</div>
										<p className="@@v3code-settings-row-desc mt-2 m-0">
											When the agent hits a real decision point (framework choice, scope ambiguity, an irreversible step), it can pause and show clickable options in the chat. Turn off to make it always decide on its own.
										</p>
										<div className="mt-4" data-setting-id="general.promptAssembly">
											<p className="@@v3code-settings-row-desc mb-2 m-0">
											Choose the full Agent OS or a compact local coding surface. Auto gives small local models 13 essential tools, gives large local models Lean, and never turns tool calling off. Configure Tools and custom agents can replace the tool set.
											</p>
											<label className="text-void-fg-3 text-xs block mb-1">Prompt assembly</label>
											<select
												className="bg-void-bg-2 border border-void-border-3 rounded px-2 py-1 text-xs text-void-fg-2 w-full max-w-md"
												value={settingsState.globalSettings.promptAssemblyPreset ?? 'auto'}
												onChange={(e) => voidSettingsService.setGlobalSetting('promptAssemblyPreset', e.target.value as PromptAssemblyPresetSetting)}
											>
												<option value="auto">Auto (recommended) — adaptive cloud and local model sizing</option>
												<option value="full">Full — complete Agent OS prompt</option>
												<option value="lean">Lean — compact cloud prompt (~3.5k inject; brief + environment)</option>
												<option value="minimal">Compact Local — focused prompt, 13-tool coding set</option>
											</select>
										</div>
									</div>
								</SettingsCard>
							</SettingsSection>
		</div>
	);
};
