/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useMemo } from 'react';
import {
	displayInfoOfFeatureName,
	StorageScope,
	StorageTarget,
	toolApprovalTypes,
	VOID_TURBO_DRAFT_ACTION_ID,
	VOID_TURBO_DRAFT_ACCEPT_HUNK_ACTION_ID,
	VOID_TURBO_DRAFT_DEEP_ACTION_ID,
	VOID_TURBO_DRAFT_DEEP_MULTI_FILE_ACTION_ID,
	VOID_TURBO_DRAFT_DISCARD_ACTION_ID,
	VOID_TURBO_DRAFT_REJECT_HUNK_ACTION_ID,
} from '../settingsExternals.js';
import ErrorBoundary from '../../util/ErrorBoundary.js';
import { VoidButtonBgDarken, VoidCustomDropdownBox, VoidSwitch } from '../../util/inputs.js';
import { useAccessor, useSettingsState } from '../../util/services.js';
import {
	CardDivider,
	SettingHelp,
	SettingRow,
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js';
import { ModelDropdown } from '../ModelDropdown.js';
import { ToolApprovalTypeSwitch } from '../settingsShared.js';

/** Same key Settings.tsx listens to for cross-tab jumps. */
const VOID_SETTINGS_INITIAL_TAB_KEY = 'void.settings.initialTab';

const FastApplyMethodDropdown = () => {
	const accessor = useAccessor();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const options = useMemo(() => [true, false], []);
	const onChangeOption = useCallback((newVal: boolean) => {
		voidSettingsService.setGlobalSetting('enableFastApply', newVal);
	}, [voidSettingsService]);

	return (
		<VoidCustomDropdownBox
			className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1'
			options={options}
			selectedOption={voidSettingsService.state.globalSettings.enableFastApply}
			onChangeOption={onChangeOption}
			getOptionDisplayName={(val) => val ? 'Fast Apply' : 'Slow Apply'}
			getOptionDropdownName={(val) => val ? 'Fast Apply' : 'Slow Apply'}
			getOptionDropdownDetail={(val) => val ? 'Output Search/Replace blocks' : 'Rewrite whole files'}
			getOptionsEqual={(a, b) => a === b}
		/>
	);
};

/** Fallbacks are only used if a command somehow has no binding (e.g. the user cleared it). */
const TURBO_SHORTCUTS: { id: string; fallback: string; what: string }[] = [
	{ id: VOID_TURBO_DRAFT_ACTION_ID, fallback: 'Shift+Tab', what: 'Draft this file' },
	{ id: VOID_TURBO_DRAFT_DEEP_ACTION_ID, fallback: 'Alt+Shift+Tab', what: 'Draft this file, thinking harder' },
	{ id: VOID_TURBO_DRAFT_DEEP_MULTI_FILE_ACTION_ID, fallback: 'Ctrl+Shift+Q', what: 'Draft across the files that call it' },
	{ id: VOID_TURBO_DRAFT_ACCEPT_HUNK_ACTION_ID, fallback: 'Tab', what: 'While reviewing: keep this change' },
	{ id: VOID_TURBO_DRAFT_REJECT_HUNK_ACTION_ID, fallback: 'Delete', what: 'While reviewing: drop this change' },
	{ id: VOID_TURBO_DRAFT_DISCARD_ACTION_ID, fallback: 'Escape', what: 'While reviewing: throw the draft away' },
];

const TurboDraftShortcuts = () => {
	const accessor = useAccessor();
	const keybindingService = accessor.get('IKeybindingService');
	return (
		<div className="@@v3code-settings-keys">
			{TURBO_SHORTCUTS.map(s => {
				const kb = keybindingService.lookupKeybinding(s.id);
				// getLabel() is the platform's own rendering: the Mac symbols here, spelled-out
				// "Shift+Tab" on Windows and Linux. getAriaLabel() is always spelled out, which
				// is what you want on hover the first time you meet a glyph like the Shift arrow.
				const label = kb?.getLabel() || s.fallback;
				const spelled = kb?.getAriaLabel() || s.fallback;
				return (
					<React.Fragment key={s.id}>
						<kbd title={spelled === label ? undefined : spelled}>{label}</kbd>
						<span>{s.what}</span>
					</React.Fragment>
				);
			})}
		</div>
	);
};

export const FeatureOptionsTab = () => {
	const settingsState = useSettingsState();
	const accessor = useAccessor();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const storageService = accessor.get('IStorageService');

	const deepseekKey = !!(settingsState.settingsOfProvider.deepseek as { apiKey?: string } | undefined)?.apiKey?.trim();
	const mistralKey = !!(settingsState.settingsOfProvider.mistral as { apiKey?: string } | undefined)?.apiKey?.trim();
	const hasCloudFimKey = deepseekKey || mistralKey;
	const autocompleteSel = settingsState.modelSelectionOfFeature.Autocomplete;
	const onLocalFim = !autocompleteSel || autocompleteSel.providerName === 'v3code-local';
	const showSmarterCta = settingsState.globalSettings.enableAutocomplete && (onLocalFim || !hasCloudFimKey);

	const goToProviders = useCallback(() => {
		storageService.store(VOID_SETTINGS_INITIAL_TAB_KEY, 'providers', StorageScope.APPLICATION, StorageTarget.MACHINE);
	}, [storageService]);

	const goToLocalProviders = useCallback(() => {
		storageService.store(VOID_SETTINGS_INITIAL_TAB_KEY, 'localProviders', StorageScope.APPLICATION, StorageTarget.MACHINE);
	}, [storageService]);

	return (
		<ErrorBoundary>
			<SettingsSection label="Autocomplete">
				<SettingsCard>
					<SettingRow
						settingId="feature.autocomplete"
						title={displayInfoOfFeatureName('Autocomplete')}
						description="FIM ghost-text as you type. Off by default to save resources; local Qwen is private, while DeepSeek or Mistral keys add cloud FIM. The hosted free DeepSeek model is chat-only."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.enableAutocomplete}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('enableAutocomplete', newVal)}
							/>
						}
					/>
					{settingsState.globalSettings.enableAutocomplete ? (
						<>
							<CardDivider />
							<div className="px-4 py-3">
								<ModelDropdown featureName={'Autocomplete'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
							</div>
							{showSmarterCta ? (
								<>
									<CardDivider />
									<div
										data-setting-id="feature.autocompleteSmarter"
										className="px-4 py-3 flex flex-col gap-2"
									>
										<div className="text-sm font-medium text-void-fg-1">Want smarter completions?</div>
										<p className="text-xs text-void-fg-3 m-0 leading-relaxed">
											Add an API key to unlock cloud FIM in the Autocomplete dropdown.
											{' '}<span className="text-void-fg-2">DeepSeek v4-flash</span> — $0.14 / $0.28 per M tokens (near-free on cache).
											{' '}<span className="text-void-fg-2">Codestral</span> (Mistral) — $0.30 / $0.90, purpose-built FIM.
											{' '}Local Qwen stays free and private.
										</p>
										<div className="flex flex-wrap gap-2 pt-1">
											<VoidButtonBgDarken className="px-3 py-1 text-xs" onClick={goToProviders}>
												Add DeepSeek / Mistral key
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className="px-3 py-1 text-xs" onClick={goToLocalProviders}>
												Local models
											</VoidButtonBgDarken>
										</div>
									</div>
								</>
							) : null}
							<CardDivider />
							<SettingRow
								settingId="feature.nextEdit"
								title={displayInfoOfFeatureName('NextEdit')}
								description={`Model for next-edit prediction (rewrites the code around your cursor after you pause). Continue's Instinct via Ollama (ollama run nate/instinct) is the recommended pick.`}
								control={
									<ModelDropdown featureName={'NextEdit'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
								}
							/>
						</>
					) : null}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Turbo Draft">
				<SettingsCard>
					<SettingRow
						settingId="feature.turboDraftKeys"
						title="Keyboard shortcuts"
						description="Turbo Draft writes a whole change into the file and hands it to you as a diff to tab through. Nothing is saved until you accept it."
						control={
							<SettingHelp label="About Turbo Draft">
								Put the cursor where you want work done and press the draft key. Turbo reads the
								file, your recent edits, and the language server's real types and problems, then
								writes the change as a reviewable diff. Tab keeps a change, Delete drops one,
								Escape throws away the rest.
								<br /><br />
								It never asks what you want — it reads that off what you already wrote, and the
								strongest signal wins: <b>a selection</b>, then <b>a TODO, FIXME, HACK or XXX within
								40 lines of the cursor</b>, then <b>a short note at the top of the file</b> (only when
								the whole file is 8 lines or fewer and every line is a comment), then <b>an open
								plan.md, spec.md or design.md</b>. A plan has to be open in a tab — it is read from
								your editors, not from disk. Selecting the lines you care about is the most reliable
								way to steer it.
								<br /><br />
								The dock tells you which one it used, on the line beginning "Intent:" — worth a
								glance before you accept.
								<br /><br />
								Deep gathers more surrounding code before drafting. Multi-file additionally drafts the
								files that <i>call</i> what you changed, up to three, which it finds through the
								language server's call hierarchy — so it needs a language it can analyse and code that
								something else actually calls. On a file with no callers, or in Markdown, multi-file
								quietly behaves the same as Deep. That is the usual reason it looks like it did
								nothing.
							</SettingHelp>
						}
					>
						<TurboDraftShortcuts />
					</SettingRow>
					<CardDivider />
					<SettingRow
						settingId="feature.turboDraftSync"
						title="Same as Chat model"
						description="When on, Shift+Tab uses whatever Chat is set to. When off, pick a dedicated Turbo Draft model below."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.syncTurboDraftToChat}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('syncTurboDraftToChat', newVal)}
							/>
						}
					/>
					{!settingsState.globalSettings.syncTurboDraftToChat ? (
						<>
							<CardDivider />
							<SettingRow
								settingId="feature.turboDraftModel"
								title={displayInfoOfFeatureName('TurboDraft')}
								description="Cloud Chat models only (DeepSeek / Claude / GPT...). Local FIM 0.5b-1.5b is blocked - too weak for whole-file drafts."
								control={
									<ModelDropdown featureName={'TurboDraft'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
								}
							/>
						</>
					) : null}
					<CardDivider />
					<SettingRow
						settingId="feature.turboDraftCompilerTruth"
						title="Use compiler truth"
						description="Feed Turbo Draft the language server's live problems, real signatures and call sites for the file, so it matches your actual types instead of guessing from similar-looking code."
						control={
							<>
								<SettingHelp label="About compiler truth">
									Signatures and problems come from the same language server that powers hover and
									the Problems panel, so they are what the compiler actually thinks - not a guess
									from similar-looking code. It is time-boxed: if the language server is slow,
									drafting starts without it. A language with no server installed simply
									contributes nothing here, and multi-file drafting has no call graph to follow.
								</SettingHelp>
								<VoidSwitch
									size='xs'
									value={settingsState.globalSettings.turboDraftCompilerTruth !== false}
									onChange={(newVal) => voidSettingsService.setGlobalSetting('turboDraftCompilerTruth', newVal)}
								/>
							</>
						}
					/>
					<CardDivider />
					<SettingRow
						settingId="feature.turboDraftVerifyDraft"
						title="Verify after review"
						description="Once you finish tabbing through a draft, check the language server for errors the draft introduced and offer a targeted fix as another reviewable draft."
						control={
							<>
								<SettingHelp label="About verification">
									Only errors the draft itself introduced count. Problems that were already in the
									file before you drafted are ignored, and new warnings are ignored too, so a messy
									file does not trigger a fix pass every time. The fix arrives as another diff you
									review - it is never written for you.
								</SettingHelp>
								<VoidSwitch
									size='xs'
									value={settingsState.globalSettings.turboDraftVerifyDraft !== false}
									onChange={(newVal) => voidSettingsService.setGlobalSetting('turboDraftVerifyDraft', newVal)}
								/>
							</>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Apply">
				<SettingsCard>
					<SettingRow
						settingId="feature.syncApply"
						title="Same as Chat model"
						description="Use the same model for Apply as Chat."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.syncApplyToChat}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('syncApplyToChat', newVal)}
							/>
						}
					/>
					{!settingsState.globalSettings.syncApplyToChat ? (
						<>
							<CardDivider />
							<div className="px-4 py-3">
								<ModelDropdown featureName={'Apply'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
							</div>
						</>
					) : null}
					<CardDivider />
					<SettingRow
						settingId="feature.applyMethod"
						title="Apply method"
						description="Fast Apply outputs search/replace blocks; Slow Apply rewrites whole files."
						control={<FastApplyMethodDropdown />}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Tools">
				<SettingsCard>
					{[...toolApprovalTypes].map((approvalType, i) => (
						<React.Fragment key={approvalType}>
							{i > 0 ? <CardDivider /> : null}
							<SettingRow
								title={`Auto-approve ${approvalType}`}
								description="Skip approval prompts for this tool category."
								control={<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc="" />}
							/>
						</React.Fragment>
					))}
					<CardDivider />
					<SettingRow
						settingId="feature.lint"
						title="Fix lint errors"
						description="Include lint errors in tool context."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.includeToolLintErrors}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('includeToolLintErrors', newVal)}
							/>
						}
					/>
					<CardDivider />
					<SettingRow
						settingId="feature.shadowVerify"
						title="Shadow verify agent edits"
						description="Roll back edit_file / rewrite_file when lint errors appear after apply (waits up to 5s for diagnostics). Requires TypeScript/ESLint markers on the file — if the language server is silent, rollback cannot trigger (tool result will say so). MemLegend is separate (time ledger)."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.shadowVerify ?? false}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('shadowVerify', newVal)}
							/>
						}
					/>
					<CardDivider />
					<SettingRow
						settingId="feature.softContinueNudges"
						title="Nudge the agent when it stops early"
						description="When a step ends without running a tool, the agent gets a private reminder to either act or say it is finished. Keeps a chat from dying right after a thinking step. Turn it off if you would rather the agent simply stop when it stops — nothing will prompt it to continue."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.softContinueNudges ?? true}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('softContinueNudges', newVal)} />
						} />

					<CardDivider />
					<SettingRow
						settingId="feature.computerUse"
						title="Computer use (beta)"
						description="Let the agent see your screen and drive the mouse and keyboard. This controls the whole machine, not just the editor, so you are asked to confirm once, and to approve each application the first time it is used. Screenshots go to your configured model provider. Browsers are read-only (the browser tools are better for them) and terminals and editors are click-only (use the terminal tools to run commands)."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.enableComputerUse ?? false}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('enableComputerUse', newVal)}
							/>
						}
					/>
					<CardDivider />
					<SettingRow
						settingId="feature.computerUseObservation"
						title="Ambient observation (beta)"
						description="Let the agent watch one approved application continuously, on a timer, instead of only when a tool call asks. It reads that application's on-screen contents — and, if you allow it, takes screenshots — roughly every 15 seconds while the app is in front, and keeps a history of one-line summaries that is folded into V3Code's memory. Requires computer use, a second one-time permission, and a per-application grant that expires. Screenshots are summarized and discarded, but the summaries and the history are retained until the retention window elapses or you clear them. An indicator stays visible the whole time, with Pause and Stop."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.enableComputerUseObservation ?? false}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('enableComputerUseObservation', newVal)}
							/>
						}
					/>
					<CardDivider />
					<SettingRow
						settingId="feature.autoAccept"
						title="Auto-accept LLM changes"
						description="Automatically accept LLM-proposed edits."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.autoAcceptLLMChanges}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('autoAcceptLLMChanges', newVal)}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="Editor">
				<SettingsCard>
					<SettingRow
						settingId="feature.inlineSuggestions"
						title="Show suggestions on select"
						description="Control visibility of V3Code suggestions in the code editor."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.showInlineSuggestions}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('showInlineSuggestions', newVal)}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection label="SCM">
				<SettingsCard>
					<SettingRow
						settingId="feature.scmSync"
						title="Same as Chat model"
						description="Use the same model for commit message generation as Chat."
						control={
							<VoidSwitch
								size='xs'
								value={settingsState.globalSettings.syncSCMToChat}
								onChange={(newVal) => voidSettingsService.setGlobalSetting('syncSCMToChat', newVal)}
							/>
						}
					/>
					{!settingsState.globalSettings.syncSCMToChat ? (
						<>
							<CardDivider />
							<div className="px-4 py-3">
								<ModelDropdown featureName={'SCM'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
							</div>
						</>
					) : null}
				</SettingsCard>
			</SettingsSection>
		</ErrorBoundary>
	);
};
