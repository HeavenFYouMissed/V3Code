/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, Check, Cloud, Cpu, CreditCard, KeyRound, PencilRuler, Plug, ShieldCheck, Sparkles, TerminalSquare, Users } from 'lucide-react';
import { useAccessor, useIsDark, useSettingsState } from '../util/services.js';
import { displayInfoOfProviderName, localProviderNames, type ProviderName } from '../../../../common/voidSettingsTypes.js';
import { OllamaSetupInstructions, SettingsForProvider } from '../void-settings-tsx/Settings.js';
import ErrorBoundary from '../util/ErrorBoundary.js';
import './onboarding.css';

const OVERRIDE_VALUE = false;
type SetupLane = 'cloud' | 'subscription' | 'local' | 'mcp' | 'later';
type OnboardingPage = 0 | 1 | 2 | 3;

const cloudProviders = ['openAI', 'anthropic', 'gemini', 'openRouter', 'xAI'] as const satisfies readonly ProviderName[];
const providerCloud = ['OpenAI', 'Anthropic', 'Gemini', 'OpenRouter', 'Grok', 'DeepSeek', 'Ollama', 'LM Studio'];

const laneOptions: Array<{ id: SetupLane; label: string; description: string; icon: typeof Cloud }> = [
	{ id: 'cloud', label: 'Connect a model', description: 'Add one provider key.', icon: KeyRound },
	{ id: 'subscription', label: 'Use a subscription', description: 'V3Code, Claude, Copilot, or Grok.', icon: CreditCard },
	{ id: 'local', label: 'Use local models', description: 'Private models on your machine.', icon: Cpu },
	{ id: 'mcp', label: 'Connect tools', description: 'Add MCP servers after setup.', icon: Plug },
	{ id: 'later', label: 'Decide later', description: 'Enter V3Code without blocking.', icon: Sparkles },
];

const V3Mark = ({ compact = false }: { compact?: boolean }) => {
	const gradientId = compact ? 'v3-mark-gradient-compact' : 'v3-mark-gradient';
	return <svg className={compact ? 'v3-onboarding-mark compact' : 'v3-onboarding-mark'} viewBox="0 0 120 120" role="img" aria-label="V3Code">
		<defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" /><stop offset=".48" stopColor="#a9b6ff" /><stop offset="1" stopColor="#6750d8" /></linearGradient></defs>
		<path d="M15 27 52 91 69 67 46 27Z" fill={`url(#${gradientId})`} opacity=".9" />
		<path d="M57 27v53l17-24V27Z" fill="#eef1ff" opacity=".9" />
		<path d="M80 27v38l25-34V27Z" fill="#c6ccda" opacity=".72" />
	</svg>;
};

export const VoidOnboarding = () => {
	const settingsState = useSettingsState();
	const isOnboardingComplete = settingsState.globalSettings.isOnboardingComplete || OVERRIDE_VALUE;
	const isDark = useIsDark();

	return <div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
		<div className={`v3-onboarding-root ${isOnboardingComplete ? 'is-complete' : ''}`}>
			<ErrorBoundary><OnboardingContent /></ErrorBoundary>
		</div>
	</div>;
};

const OnboardingContent = () => {
	const accessor = useAccessor();
	const settingsService = accessor.get('IVoidSettingsService');
	const metricsService = accessor.get('IMetricsService');
	const [page, setPage] = useState<OnboardingPage>(0);
	const [lane, setLane] = useState<SetupLane>('cloud');
	const [selectedProvider, setSelectedProvider] = useState<ProviderName>('openAI');

	useEffect(() => {
		if (lane === 'cloud' && !(cloudProviders as readonly ProviderName[]).includes(selectedProvider)) setSelectedProvider('openAI');
		if (lane === 'local' && !(localProviderNames as readonly ProviderName[]).includes(selectedProvider)) setSelectedProvider('ollama');
	}, [lane, selectedProvider]);

	const finish = () => {
		settingsService.setGlobalSetting('isOnboardingComplete', true);
		metricsService.capture('Completed Onboarding', { selectedProviderName: selectedProvider, setupLane: lane });
	};

	if (page === 0) return <WelcomePage onContinue={() => setPage(1)} onSkip={finish} />;
	if (page === 2) return <DiscoverPage onBack={() => setPage(1)} onContinue={() => setPage(3)} onSkip={finish} />;
	if (page === 3) return <VisualEditPage onBack={() => setPage(2)} onFinish={finish} />;
	return <SetupPage lane={lane} setLane={setLane} selectedProvider={selectedProvider} setSelectedProvider={setSelectedProvider} onBack={() => setPage(0)} onContinue={() => setPage(2)} onSkip={finish} />;
};

const WelcomePage = ({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) => <main className="v3-onboarding-welcome">
	<button className="v3-onboarding-corner-skip" onClick={onSkip}>Skip setup</button>
	<button className="v3-onboarding-wordmark-button" onClick={onContinue} aria-label="Continue to V3Code setup">
		<span className="v3-onboarding-wordmark">V3Code</span>
		<span className="v3-onboarding-wordmark-cue"><span>Click to begin</span><ArrowDown size={17} /></span>
	</button>
</main>;

const SetupPage = ({ lane, setLane, selectedProvider, setSelectedProvider, onBack, onContinue, onSkip }: {
	lane: SetupLane; setLane: (lane: SetupLane) => void; selectedProvider: ProviderName; setSelectedProvider: (provider: ProviderName) => void; onBack: () => void; onContinue: () => void; onSkip: () => void;
}) => {
	const providerChoices = lane === 'local' ? localProviderNames : [...cloudProviders];
	return <main className="v3-onboarding-setup">
		<OnboardingHeader page={1} onSkip={onSkip} />
		<section className="v3-onboarding-studio">
			<aside className="v3-onboarding-choice-rail">
				<div className="v3-onboarding-step-label">Your setup</div><h2>How do you want to start?</h2><p>Choose one. Everything stays editable in Settings.</p>
				<div className="v3-onboarding-lane-list">{laneOptions.map(option => { const Icon = option.icon; return <button key={option.id} className={lane === option.id ? 'active' : ''} onClick={() => setLane(option.id)}><span className="v3-onboarding-lane-icon"><Icon size={17} /></span><span><strong>{option.label}</strong><small>{option.description}</small></span>{lane === option.id ? <Check size={15} /> : null}</button>; })}</div>
			</aside>
			<div className="v3-onboarding-config">
				{lane === 'cloud' || lane === 'local' ? <ProviderSetup lane={lane} providers={providerChoices} selectedProvider={selectedProvider} setSelectedProvider={setSelectedProvider} /> : lane === 'subscription' ? <SubscriptionSetup /> : lane === 'mcp' ? <McpSetup /> : <LaterSetup />}
			</div>
			<ProviderArtwork lane={lane} />
		</section>
		<footer className="v3-onboarding-setup-footer"><button className="v3-onboarding-back" onClick={onBack}><ArrowLeft size={16} /> Back</button><div><ShieldCheck size={15} /><span>Keys stay in your local V3Code profile.</span></div><button className="v3-onboarding-primary compact" onClick={onContinue}>Continue <ArrowRight size={16} /></button></footer>
	</main>;
};

const OnboardingHeader = ({ page, onSkip }: { page: 1 | 2 | 3; onSkip: () => void }) => <header className="v3-onboarding-setup-header">
	<div className="v3-onboarding-brand-lockup"><V3Mark compact /><span>V3Code</span></div>
	<div className="v3-onboarding-progress"><span className="done" /><span className={page === 1 ? 'active' : 'done'} /><span className={page === 2 ? 'active' : page > 2 ? 'done' : ''} /><span className={page === 3 ? 'active' : ''} /></div>
	<button className="v3-onboarding-skip" onClick={onSkip}>Skip setup</button>
</header>;

const ProviderSetup = ({ lane, providers, selectedProvider, setSelectedProvider }: { lane: 'cloud' | 'local'; providers: readonly ProviderName[]; selectedProvider: ProviderName; setSelectedProvider: (provider: ProviderName) => void }) => <div className="v3-onboarding-provider-setup">
	<div className="v3-onboarding-step-label">{lane === 'local' ? 'Private runtime' : 'Model provider'}</div>
	<h2>{lane === 'local' ? 'Use models on your machine' : 'Bring one provider key'}</h2>
	<p>{lane === 'local' ? 'V3Code detects supported local runtimes and their available models.' : 'Pick a provider and add its key. These are the same settings used everywhere in V3Code.'}</p>
	<div className="v3-onboarding-provider-picker" role="tablist" aria-label="Model providers">{providers.map(provider => <button key={provider} className={selectedProvider === provider ? 'active' : ''} onClick={() => setSelectedProvider(provider)}><span>{displayInfoOfProviderName(provider).title.slice(0, 1)}</span>{displayInfoOfProviderName(provider).title}</button>)}</div>
	<div className="v3-onboarding-provider-card"><div className="v3-onboarding-provider-card-title"><div><span>{displayInfoOfProviderName(selectedProvider).title.slice(0, 1)}</span><strong>{displayInfoOfProviderName(selectedProvider).title}</strong></div><small>{lane === 'local' ? 'Local connection' : 'Provider key'}</small></div><SettingsForProvider providerName={selectedProvider} showProviderTitle={false} showProviderSuggestions showHealthBadge={false} />{selectedProvider === 'ollama' ? <OllamaSetupInstructions /> : null}</div>
	{lane === 'local' ? <div className="v3-onboarding-models"><div className="v3-onboarding-models-status"><Cpu size={16} /><div><strong>Models appear after the runtime connects</strong><span>V3Code detects the models served by your selected local provider and adds them to the model picker.</span></div></div></div> : null}
</div>;

type SubscriptionChoice = 'v3code' | 'claudePlan' | 'copilot' | 'grokPlan';
const subscriptionChoices: Array<{ id: SubscriptionChoice; label: string; mark: string }> = [
	{ id: 'v3code', label: 'V3Code Plan', mark: 'V' },
	{ id: 'claudePlan', label: 'Claude', mark: 'C' },
	{ id: 'copilot', label: 'Copilot', mark: 'G' },
	{ id: 'grokPlan', label: 'Grok', mark: 'X' },
];

const SubscriptionSetup = () => {
	const accessor = useAccessor();
	const accountService = accessor.get('IV3CodeAccountService');
	const [choice, setChoice] = useState<SubscriptionChoice>('v3code');
	const account = accountService.state;
	const provider = choice === 'v3code' ? null : choice;
	return <div className="v3-onboarding-provider-setup v3-onboarding-subscription-setup">
		<div className="v3-onboarding-step-label">Use a plan you already have</div>
		<h2>No API key required</h2>
		<p>Use V3Code hosted models or connect an existing Claude, GitHub Copilot, or Grok subscription.</p>
		<div className="v3-onboarding-provider-picker" role="tablist" aria-label="Subscription providers">{subscriptionChoices.map(item => <button key={item.id} className={choice === item.id ? 'active' : ''} onClick={() => setChoice(item.id)}><span>{item.mark}</span>{item.label}</button>)}</div>
		<div className="v3-onboarding-provider-card">
			<div className="v3-onboarding-provider-card-title"><div><span>{subscriptionChoices.find(item => item.id === choice)?.mark}</span><strong>{subscriptionChoices.find(item => item.id === choice)?.label}</strong></div><small>Subscription</small></div>
			{provider ? <SettingsForProvider providerName={provider} showProviderTitle={false} showProviderSuggestions showHealthBadge={false} /> : <div className="v3-onboarding-plan-card"><div><strong>{account.status === 'signedIn' ? `${account.tierLabel} plan` : 'V3Code hosted plans'}</strong><span>{account.status === 'signedIn' ? `Signed in as ${account.displayName}.` : 'Sign in once, then use V3Fast and V3Pro without managing provider keys.'}</span></div><FeatureList items={['One V3Code account across the editor', 'Hosted model access with plan usage shown in Settings', 'Switch back to BYOK or local models at any time']} /><div className="v3-onboarding-plan-actions">{account.status === 'signedIn' ? <button className="v3-onboarding-plan-secondary" onClick={() => accountService.manageAccount()}>Manage account</button> : <button className="v3-onboarding-plan-secondary" onClick={() => accountService.signIn()}>Sign in</button>}<button className="v3-onboarding-primary compact" onClick={() => accountService.openPlans()}>View plans <ArrowRight size={15} /></button></div></div>}
		</div>
	</div>;
};

const McpSetup = () => <div className="v3-onboarding-message-card"><div className="v3-onboarding-step-label">Tools and services</div><h2>Connect MCP after you enter</h2><p>MCP lets V3Code work with GitHub, databases, browsers, and your own tools. The gallery and custom-server setup live in Settings.</p><FeatureList items={['Install curated connectors', 'Add a custom local or remote server', 'See honest connected and offline states']} /><div className="v3-onboarding-note">Open <strong>Settings → MCP Servers</strong> whenever you are ready.</div></div>;
const LaterSetup = () => <div className="v3-onboarding-message-card"><div className="v3-onboarding-step-label">No pressure</div><h2>Start with the editor</h2><p>Configure providers, local models, or MCP servers later. Onboarding does not import or overwrite another editor's profile.</p><FeatureList items={['Open a project only when you need it', 'Start in the chat-first Flow layout', 'Return to setup from Settings']} /></div>;
const FeatureList = ({ items }: { items: string[] }) => <div className="v3-onboarding-message-list">{items.map(item => <div key={item}><Check size={15} /><span>{item}</span></div>)}</div>;

const ProviderArtwork = ({ lane }: { lane: SetupLane }) => <aside className={`v3-onboarding-art v3-onboarding-art-${lane}`} aria-hidden="true"><div className="v3-onboarding-art-haze" /><div className="v3-onboarding-art-orbit orbit-one" /><div className="v3-onboarding-art-orbit orbit-two" /><div className="v3-onboarding-art-core"><V3Mark compact /></div>{providerCloud.slice(0, 6).map((provider, index) => <span key={provider} className={`provider-${index + 1}`}>{provider}</span>)}<div className="v3-onboarding-art-caption"><small>{lane === 'cloud' ? 'YOUR MODELS' : lane === 'subscription' ? 'YOUR PLANS' : lane === 'local' ? 'PRIVATE RUNTIME' : lane === 'mcp' ? 'YOUR TOOLS' : 'YOUR WORKFLOW'}</small><strong>{lane === 'cloud' ? 'One editor. Any provider.' : lane === 'subscription' ? 'Use the access you already have.' : lane === 'local' ? 'Local by default.' : lane === 'mcp' ? 'Connected when you choose.' : 'Configure at your pace.'}</strong></div></aside>;

const terminalWordmark = `\u2588\u2588\u2557   \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557
\u2588\u2588\u2551   \u2588\u2588\u2551 \u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2557
\u2588\u2588\u2551   \u2588\u2588\u2551  \u2588\u2588\u2588\u2588\u2588\u2554\u255d
\u255a\u2588\u2588\u2557 \u2588\u2588\u2554\u255d  \u255a\u2550\u2550\u2550\u2588\u2588\u2557
 \u255a\u2588\u2588\u2588\u2588\u2554\u255d  \u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d
  \u255a\u2550\u2550\u2550\u255d   \u255a\u2550\u2550\u2550\u2550\u2550\u255d`;

const terminalThoughts = ['Verifying current handoff', 'Indexing project memory', 'Preparing agent context', 'Checking worktree state'];

const TerminalSignalPreview = () => {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const timer = window.setInterval(() => setFrame(value => value + 1), 720);
		return () => window.clearInterval(timer);
	}, []);
	const thought = terminalThoughts[Math.floor(frame / 3) % terminalThoughts.length];
	const elapsed = (1.4 + (frame % 7) / 10).toFixed(1);
	const facts = 151 + (frame % 4);
	const handoffs = 137 + (frame % 3);
	const kinetic = String(471852936147 + frame * 7919).slice(-12);

	return <div className="v3-terminal-real-preview" role="img" aria-label="V3Code Terminal showing an active agent session and memory cockpit">
	<div className="v3-terminal-live-brand" aria-hidden="true">
		<span className="v3-terminal-live-rail">////////////////////////////////////////////////////////////</span>
		<pre>{terminalWordmark}</pre>
		<span className="v3-terminal-live-rail">////////////////////////////////////////////////////////////</span>
	</div>
	<div className="v3-terminal-live-main" aria-hidden="true">
		<div className="v3-terminal-live-transcript">
			<div className="v3-terminal-live-tool"><b>●</b> Read PROJECT-HANDOFF.md</div>
			<div className="v3-terminal-live-tool"><b>{'\u2570\u2500\u25cf'}</b> Grep "First Trustworthy Milestone"</div>
			<div className="v3-terminal-live-thought">[+] Thought: <span>{thought}</span><i>_</i> · {elapsed}s</div>
			<div className="v3-terminal-live-saved"><b>●</b> memory.save roadmap</div>
			<div className="v3-terminal-live-tree">- Todos<br />| [x] Audit the existing harness and task suite<br />| [x] Create a durable project handoff<br />\ [x] Verify the current CLI behavior</div>
			<div className="v3-terminal-live-copy"><strong>Created the authoritative handoff at:</strong><br /><em>PROJECT-HANDOFF.md</em></div>
		</div>
		<div className="v3-terminal-live-prompt">
			<div><b>&gt;</b><i /></div>
			<div><span><strong>BUILD</strong> tab to switch · high</span><span>GPT-5.6 OpenAI</span></div>
			<div className="v3-terminal-live-ready"><span><i /><i /><i /><i /><i /><i /></span>Ready <em>{kinetic}</em></div>
			<div><span>/Users/daniel/v3code-terminal</span><span><b>/</b> commands · <strong>tab</strong> agent · <strong>/team</strong> team</span></div>
		</div>
	</div>
	<aside className="v3-terminal-live-cockpit" aria-hidden="true">
		<nav>SESSION&nbsp; FILES&nbsp; TASKS&nbsp; INDEX&nbsp; <b>MEMORY</b>&nbsp; TEAM</nav>
		<div className="v3-terminal-live-masthead"><span>V3</span><i className="v3-terminal-live-rail">/////////////////////////////////</i><pre>{terminalWordmark}</pre><i className="v3-terminal-live-rail">/////////////////////////////////</i></div>
		<section><header><strong>MEMORY COCKPIT</strong><span>local · shared</span></header><div><b>LOCAL INDEX</b><span>{facts} facts · {handoffs} searchable handoffs</span><b>AGENT LOOKUP</b><span>Recall searches facts and the indexed memory timeline.</span></div><div className="secondary"><b>TEAM RELAY</b><span>{120 + (frame % 5)} queued · 0 sent · 0 received</span><span>Local copy remains authoritative.</span></div></section>
		<footer><strong>V3CODE</strong> TERMINAL · local-first</footer>
	</aside>
</div>;
};

const VisualEditPreview = () => <div className="v3-visual-edit-preview" role="img" aria-label="V3Code Visual Edit panel selecting and styling an element on a live page">
	<div className="v3-visual-edit-browser" aria-hidden="true">
		<header><span>&lt;</span><span>&gt;</span><i>localhost:3000</i><strong>Visual Edit &#9998;</strong></header>
		<section><nav><b>OBSIDIAN</b><span>Product&nbsp;&nbsp;&nbsp;Platform&nbsp;&nbsp;&nbsp;Docs</span><i>Start building</i></nav><div className="v3-visual-edit-selection"><small>section.hero</small><em>DESIGN SYSTEM · 03</em><b>Shape the interface.<br />Ship the code.</b><p>Build a precise product surface with your agent beside you.</p><span>Explore system&nbsp; →</span></div><div className="v3-visual-edit-site-grid"><i><b>24</b><span>components</span></i><i><b>8ms</b><span>interaction</span></i><i><b>AA</b><span>contrast</span></i></div></section>
	</div>
	<aside className="v3-visual-edit-panel" aria-hidden="true">
		<header><div><strong>Visual Edit</strong><small>section.hero</small></div><span>ARMED</span><b>×</b></header>
		<section><small>STYLE</small><div><span>Text</span><i /><i /><i /><i className="active" /></div><div><span>Background</span><i /><i className="none" /><i className="blue" /><i className="light" /></div><div><span>Size</span><em><b /></em></div><div><span>Weight</span><strong>400</strong><strong>500</strong><strong className="selected">700</strong></div><div><span>Radius</span><em><b /></em></div></section>
		<footer><small>STAGED EDITS · 1</small><p><i /> section.hero</p><textarea readOnly value="Make the hero feel premium" aria-label="Visual Edit note" /><button>Send 1 edit to agent</button></footer>
	</aside>
</div>;

const DiscoverPage = ({ onBack, onContinue, onSkip }: { onBack: () => void; onContinue: () => void; onSkip: () => void }) => <main className="v3-onboarding-setup v3-onboarding-discover">
	<OnboardingHeader page={2} onSkip={onSkip} />
	<section className="v3-onboarding-discover-body">
		<div className="v3-onboarding-discover-copy"><div className="v3-onboarding-step-label">Built into the editor</div><h2>There is more waiting inside.</h2><p>Start with chat, then bring in the terminal and your team when the work calls for it.</p></div>
		<div className="v3-onboarding-discover-grid">
			<article className="v3-onboarding-product-card terminal-card"><div className="v3-onboarding-product-preview"><TerminalSignalPreview /></div><div className="v3-onboarding-product-copy"><TerminalSquare size={18} /><div><small>AVAILABLE NOW</small><h3>Try the V3Code Terminal</h3><p>Leave the editor without leaving your project context, memory, or agent session behind.</p></div></div></article>
			<article className="v3-onboarding-product-card team-card"><div className="v3-onboarding-team-preview"><div className="team-orbit"><span>D</span><span>M</span><span>V</span><span>AI</span><strong><Users size={24} /></strong></div></div><div className="v3-onboarding-product-copy"><Users size={18} /><div><small>COMING SOON</small><h3>V3Code for teams</h3><p>Shared project context, agent handoffs, and one place for the work your team remembers.</p></div></div></article>
		</div>
	</section>
	<footer className="v3-onboarding-setup-footer"><button className="v3-onboarding-back" onClick={onBack}><ArrowLeft size={16} /> Back</button><div><ShieldCheck size={15} /><span>One more feature worth seeing.</span></div><button className="v3-onboarding-primary compact" onClick={onContinue}>Continue <ArrowRight size={16} /></button></footer>
</main>;

const VisualEditPage = ({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) => <main className="v3-onboarding-setup v3-onboarding-visual-edit-page">
	<OnboardingHeader page={3} onSkip={onFinish} />
	<section className="v3-onboarding-feature-stage">
	<div className="v3-onboarding-feature-copy"><div className="v3-onboarding-step-label">Available now · browser</div><div className="v3-onboarding-feature-icon"><PencilRuler size={22} /></div><h2>Click the page.<br />Change it yourself.</h2><p>Turn on Visual Edit in V3Code's browser, select any live element, and tune its styles by hand. Your changes stage safely until you send the exact edit to the agent.</p><FeatureList items={['Select real elements on the live page', 'Adjust color, size, weight, spacing, and radius', 'Send staged edits to chat in one click']} /><small>Open Browser → Visual Edit</small></div>
		<div className="v3-onboarding-feature-demo"><VisualEditPreview /></div>
	</section>
	<footer className="v3-onboarding-setup-footer"><button className="v3-onboarding-back" onClick={onBack}><ArrowLeft size={16} /> Back</button><div><ShieldCheck size={15} /><span>Visual changes stay staged until you send them.</span></div><button className="v3-onboarding-primary compact" onClick={onFinish}>Enter V3Code <ArrowRight size={16} /></button></footer>
</main>;
