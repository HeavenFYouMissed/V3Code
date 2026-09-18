/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import ErrorBoundary from '../util/ErrorBoundary.js';
import { useAccessor, useIsDark } from '../util/services.js';
import { Settings as SettingsIcon, Cpu, HardDrive, Cloud, SlidersHorizontal, Plug, Globe, List, UserRound, MessageSquare, Share2, MessageCircleQuestion, Bot } from 'lucide-react';
import '../util/v3code-design-tokens.css';
import {
	SettingsNavSidebar,
	SettingsPageTitle,
	SettingsTabTitle,
} from './SettingsLayout.js';
import { flashSettingRow, type SettingsSearchHit } from './settingsSearchIndex.js';
import { IndexingDocsTab } from './IndexingDocsTab.js';
import { StorageScope } from '../../../../../../../platform/storage/common/storage.js';
import { RedoOnboardingButton } from './settingsShared.js';
import { AccountNavChip, AccountTab } from './tabs/AccountTab.js';
import { ModelsTab } from './tabs/ModelsTab.js';
import { LocalProvidersTab } from './tabs/LocalProvidersTab.js';
import { MainProvidersTab } from './tabs/MainProvidersTab.js';
import { FeatureOptionsTab } from './tabs/FeatureOptionsTab.js';
import { ChatUiTab } from './tabs/ChatUiTab.js';
import { GeneralTab } from './tabs/GeneralTab.js';
import { FeedbackTab } from './tabs/FeedbackTab.js';
import { McpTab, McpExposeTab } from './tabs/McpTab.js';
import { ExternalAgentsTab } from './tabs/ExternalAgentsTab.js';

const VOID_SETTINGS_INITIAL_TAB_KEY = 'void.settings.initialTab';

type Tab =
	| 'models'
	| 'localProviders'
	| 'providers'
	| 'featureOptions'
	| 'chatUi'
	| 'general'
	| 'mcp'
	| 'mcpExpose'
	| 'agents'
	| 'indexingDocs'
	| 'account'
	| 'feedback'
	| 'all';

/** Re-exports for onboarding / sidebar consumers */
export {
	OllamaSetupInstructions,
	OneClickSwitchButton,
	SettingsForProvider,
	ModelDump,
	ToolApprovalTypeSwitch,
	AnimatedCheckmarkButton,
	AutoDetectLocalModelsToggle,
	AutoDetectLocalModelsToggleControl,
	AIInstructionsBox,
	VoidProviderSettings,
} from './settingsShared.js';

export const Settings = () => {
	const isDark = useIsDark();
	const [selectedSection, setSelectedSection] = useState<Tab>('models');

	const navGroups = [
		{
			items: [
				{ tab: 'account', label: 'Account', icon: UserRound },
				{ tab: 'feedback', label: 'Feedback', icon: MessageCircleQuestion },
				{ tab: 'general', label: 'General', icon: SettingsIcon },
				{ tab: 'models', label: 'Models', icon: Cpu },
			],
		},
		{
			items: [
				{ tab: 'localProviders', label: 'Local Providers', icon: HardDrive },
				{ tab: 'providers', label: 'Main Providers', icon: Cloud },
				{ tab: 'featureOptions', label: 'Feature Options', icon: SlidersHorizontal },
				{ tab: 'chatUi', label: 'Chat & UI', icon: MessageSquare },
			],
		},
		{
			items: [
				{ tab: 'agents', label: 'Agents', icon: Bot },
				{ tab: 'mcp', label: 'MCP Servers', icon: Plug },
				{ tab: 'mcpExpose', label: 'Expose V3Code', icon: Share2 },
				{ tab: 'indexingDocs', label: 'Indexing & Docs', icon: Globe },
			],
		},
		{
			items: [
				{ tab: 'all', label: 'All Settings', icon: List },
			],
		},
	];

	const pageTitleForTab = (tab: Tab): string => {
		switch (tab) {
			case 'account': return 'Account';
			case 'feedback': return 'Feedback & Support';
			case 'models': return 'Models';
			case 'localProviders': return 'Local Providers';
			case 'providers': return 'Main Providers';
			case 'featureOptions': return 'Feature Options';
			case 'chatUi': return 'Chat & UI';
			case 'general': return 'General';
			case 'agents': return 'Agents';
			case 'mcp': return 'MCP Servers';
			case 'mcpExpose': return 'Expose V3Code';
			case 'indexingDocs': return 'Indexing & Docs';
			default: return 'All Settings';
		}
	};

	const showPageHeader = selectedSection !== 'all';

	const SectionHeader = ({ tab, title }: { tab: Tab; title: string }) => {
		if (selectedSection === 'all') {
			return <SettingsTabTitle>{title}</SettingsTabTitle>;
		}
		return null;
	};

	const shouldShowTab = (tab: Tab) => selectedSection === 'all' || selectedSection === tab;

	const accessor = useAccessor();
	const storageService = accessor.get('IStorageService');
	const mainScrollRef = useRef<HTMLElement>(null);
	const pendingFlashRef = useRef<string | null>(null);

	useEffect(() => {
		const store = new DisposableStore();
		const isTab = (v: string | undefined): v is Tab =>
			v === 'account' || v === 'feedback' || v === 'general' || v === 'models' || v === 'localProviders' || v === 'providers' || v === 'featureOptions' || v === 'chatUi' || v === 'mcp' || v === 'mcpExpose' || v === 'agents' || v === 'indexingDocs' || v === 'all';
		const applyInitialTab = () => {
			const initialTab = storageService.get(VOID_SETTINGS_INITIAL_TAB_KEY, StorageScope.APPLICATION);
			if (isTab(initialTab)) {
				setSelectedSection(initialTab);
			}
			if (initialTab !== undefined) {
				storageService.remove(VOID_SETTINGS_INITIAL_TAB_KEY, StorageScope.APPLICATION);
			}
		};
		applyInitialTab();
		store.add(storageService.onDidChangeValue(StorageScope.APPLICATION, VOID_SETTINGS_INITIAL_TAB_KEY, store)(applyInitialTab));
		return () => store.dispose();
	}, [storageService]);

	const scrollMainTop = useCallback(() => {
		mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
	}, []);

	const onSearchHit = useCallback((hit: SettingsSearchHit) => {
		pendingFlashRef.current = hit.id;
		setSelectedSection(hit.tab);
	}, []);

	useEffect(() => {
		const id = pendingFlashRef.current;
		if (!id) return;
		pendingFlashRef.current = null;
		const t = window.setTimeout(() => flashSettingRow(id), 80);
		return () => window.clearTimeout(t);
	}, [selectedSection]);

	return (
		<div className={`@@void-scope @@v3code-settings-page ${isDark ? 'dark' : ''}`}>
			<div className="@@v3code-settings-shell">
				<SettingsNavSidebar
					groups={navGroups}
					selectedTab={selectedSection}
					header={<AccountNavChip />}
					onSearchHit={onSearchHit}
					onSelect={(tab) => {
						setSelectedSection(tab as Tab);
						scrollMainTop();
					}}
				/>

				<main ref={mainScrollRef} className="@@v3code-settings-main select-none">
					<div className="@@v3code-settings-main-inner">
						{showPageHeader ? (
							<SettingsPageTitle
								title={pageTitleForTab(selectedSection)}
								subtitle={
									<ErrorBoundary>
										<RedoOnboardingButton />
									</ErrorBoundary>
								}
							/>
						) : (
							<SettingsPageTitle title="All Settings" />
						)}

						<div className="flex flex-col gap-8">
							{shouldShowTab('account') && (
								<div className="flex flex-col gap-8">
									<SectionHeader tab="account" title="Account" />
									<ErrorBoundary>
										<AccountTab />
									</ErrorBoundary>
								</div>
							)}

							{shouldShowTab('feedback') && (
								<div className="flex flex-col gap-8">
									<SectionHeader tab="feedback" title="Feedback & Support" />
									<ErrorBoundary>
										<FeedbackTab />
									</ErrorBoundary>
								</div>
							)}

							{shouldShowTab('models') && (
								<div>
									<SectionHeader tab="models" title="Models" />
									<ModelsTab />
								</div>
							)}

							{shouldShowTab('localProviders') && (
								<div>
									<SectionHeader tab="localProviders" title="Local Providers" />
									<LocalProvidersTab />
								</div>
							)}

							{shouldShowTab('providers') && (
								<div>
									<SectionHeader tab="providers" title="Main Providers" />
									<MainProvidersTab />
								</div>
							)}

							{shouldShowTab('featureOptions') && (
								<div>
									<SectionHeader tab="featureOptions" title="Feature Options" />
									<FeatureOptionsTab />
								</div>
							)}

							{shouldShowTab('chatUi') && (
								<div>
									<SectionHeader tab="chatUi" title="Chat & UI" />
									<ErrorBoundary>
										<ChatUiTab />
									</ErrorBoundary>
								</div>
							)}

							{shouldShowTab('general') && (
								<div className="flex flex-col gap-8">
									<SectionHeader tab="general" title="General" />
									<GeneralTab />
								</div>
							)}

							{shouldShowTab('indexingDocs') && (
								<div>
									<SectionHeader tab="indexingDocs" title="Indexing & Docs" />
									<ErrorBoundary>
										<div data-setting-id="indexing.docs">
											<IndexingDocsTab />
										</div>
									</ErrorBoundary>
								</div>
							)}

							{shouldShowTab('agents') && (
								<div>
									<SectionHeader tab="agents" title="Agents" />
									<ErrorBoundary>
										<ExternalAgentsTab />
									</ErrorBoundary>
								</div>
							)}

							{shouldShowTab('mcp') && (
								<div>
									<SectionHeader tab="mcp" title="MCP Servers" />
									<McpTab />
								</div>
							)}

							{shouldShowTab('mcpExpose') && (
								<div>
									<SectionHeader tab="mcpExpose" title="Expose V3Code" />
									<McpExposeTab />
								</div>
							)}
						</div>
					</div>
				</main>
			</div>
		</div>
	);
};
