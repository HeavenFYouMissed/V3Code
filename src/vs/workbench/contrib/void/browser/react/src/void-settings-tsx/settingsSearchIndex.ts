/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Deep search index for V3Code Settings — titles + descriptions → tab + row id.
 *--------------------------------------------------------------------------------------*/

export type SettingsTabId =
	| 'account'
	| 'general'
	| 'models'
	| 'localProviders'
	| 'providers'
	| 'featureOptions'
	| 'chatUi'
	| 'mcp'
	| 'mcpExpose'
	| 'indexingDocs'
	| 'feedback'
	| 'all';

export type SettingsSearchHit = {
	id: string;
	tab: Exclude<SettingsTabId, 'all'>;
	title: string;
	description: string;
	section?: string;
};

/** Static catalog of searchable settings. Keep in sync with SettingRow `settingId`s. */
export const SETTINGS_SEARCH_INDEX: SettingsSearchHit[] = [
	// Account
	{ id: 'account.usage', tab: 'account', title: 'Usage', description: 'Plan usage, tokens, and overage', section: 'Account' },
	{ id: 'account.plan', tab: 'account', title: 'Plan', description: 'Upgrade or manage your V3Code plan', section: 'Account' },
	{ id: 'account.privacy', tab: 'account', title: 'Privacy and cloud providers', description: 'V3Code training data local models cloud prompts third party providers', section: 'Privacy' },

	// Feedback & support
	{ id: 'feedback.send', tab: 'feedback', title: 'Share feedback', description: 'Tell Daniel and the V3Code team what would make the editor better', section: 'Feedback & Support' },
	{ id: 'feedback.report', tab: 'feedback', title: 'Report an issue', description: 'Report a bug crash performance problem or visual issue', section: 'Feedback & Support' },
	{ id: 'feedback.status', tab: 'feedback', title: 'Status & updates', description: 'Live messages service notices workarounds feature news from Daniel and V3Code', section: 'Feedback & Support' },
	{ id: 'feedback.agentsVote', tab: 'feedback', title: 'Vote on the Agents beta', description: 'Yes or no vote for a redesigned V3Code Grok Bot Agents experience', section: 'Feedback & Support' },

	// Models
	{ id: 'models.autodetect', tab: 'models', title: 'Auto-detect local models', description: 'Automatically detect local providers and models', section: 'Detection' },
	{ id: 'models.tiers', tab: 'models', title: 'Chat tiers', description: 'V3Fast V3Pro hosted model tiers', section: 'Chat tiers' },

	// Local / Main providers
	{ id: 'providers.local', tab: 'localProviders', title: 'Local providers', description: 'Ollama and other locally hosted models', section: 'Setup' },
	{ id: 'providers.main', tab: 'providers', title: 'Main providers', description: 'Anthropic OpenAI OpenRouter API keys', section: 'Providers' },

	// Feature options
	{ id: 'feature.autocomplete', tab: 'featureOptions', title: 'Autocomplete', description: 'FIM ghost-text autocomplete DeepSeek Codestral', section: 'Autocomplete' },
	{ id: 'feature.autocompleteSmarter', tab: 'featureOptions', title: 'Smarter completions', description: 'Add DeepSeek or Mistral key for cloud FIM prices', section: 'Autocomplete' },
	{ id: 'feature.nextEdit', tab: 'featureOptions', title: 'Next edit / V Go', description: 'Next-edit prediction after you pause typing', section: 'Autocomplete' },
	{ id: 'feature.turboDraftKeys', tab: 'featureOptions', title: 'Turbo Draft keyboard shortcuts', description: 'Shift+Tab Alt+Shift+Tab Ctrl+Shift+Q keybinding draft whole file diff review accept reject hunk deep multi-file', section: 'Turbo Draft' },
	{ id: 'feature.turboDraftSync', tab: 'featureOptions', title: 'Same as Chat model', description: 'Use the same model for Turbo Draft as Chat', section: 'Turbo Draft' },
	{ id: 'feature.turboDraftModel', tab: 'featureOptions', title: 'Turbo Draft model', description: 'Dedicated cloud model for Turbo Draft DeepSeek Claude GPT', section: 'Turbo Draft' },
	{ id: 'feature.turboDraftCompilerTruth', tab: 'featureOptions', title: 'Use compiler truth', description: 'Feed Turbo Draft language server types signatures problems call sites LSP', section: 'Turbo Draft' },
	{ id: 'feature.turboDraftVerifyDraft', tab: 'featureOptions', title: 'Verify after review', description: 'Check for errors the draft introduced and offer a fix', section: 'Turbo Draft' },
	{ id: 'feature.syncApply', tab: 'featureOptions', title: 'Same as Chat model', description: 'Use the same model for Apply as Chat', section: 'Apply' },
	{ id: 'feature.applyMethod', tab: 'featureOptions', title: 'Apply method', description: 'Fast Apply search/replace or Slow Apply whole files', section: 'Apply' },
	{ id: 'feature.lint', tab: 'featureOptions', title: 'Fix lint errors', description: 'Include lint errors in tool context', section: 'Tools' },
	{ id: 'feature.shadowVerify', tab: 'featureOptions', title: 'Shadow verify agent edits', description: 'Roll back edits when lint errors appear', section: 'Tools' },
	{ id: 'feature.softContinueNudges', tab: 'featureOptions', title: 'Nudge the agent when it stops early', description: 'Remind the agent to act or finish when a step ends without a tool call', section: 'Tools' },
	{ id: 'feature.computerUse', tab: 'featureOptions', title: 'Computer use (beta)', description: 'Let the agent see your screen and drive the mouse and keyboard', section: 'Tools' },
	{ id: 'feature.computerUseObservation', tab: 'featureOptions', title: 'Ambient observation (beta)', description: 'Continuously watch an approved application on a timer and keep a retained history of what was on screen', section: 'Tools' },
	{ id: 'feature.autoAccept', tab: 'featureOptions', title: 'Auto-accept LLM changes', description: 'Automatically accept LLM-proposed edits', section: 'Tools' },
	{ id: 'feature.inlineSuggestions', tab: 'featureOptions', title: 'Show suggestions on select', description: 'Visibility of V3Code suggestions in the editor', section: 'Editor' },
	{ id: 'feature.scmSync', tab: 'featureOptions', title: 'SCM same as Chat', description: 'Commit message model sync to Chat', section: 'SCM' },

	// Chat & UI
	{ id: 'chatUi.density', tab: 'chatUi', title: 'Show edit and terminal cards', description: 'Fold tool cards away while the agent works, always, or never — diffs, terminal output, collapse, expand', section: 'Chat' },
	{ id: 'chatUi.queue', tab: 'chatUi', title: 'Queue behavior', description: 'Queue or stop-and-send while agent runs', section: 'Chat' },
	{ id: 'chatUi.voice', tab: 'chatUi', title: 'Voice', description: 'Speech recognition language and push-to-talk', section: 'Voice' },
	{ id: 'chatUi.router', tab: 'chatUi', title: 'Auto router', description: 'Choose a Manual Economy Value Balanced or Premium model budget', section: 'Router' },

	// General
	{ id: 'general.appearance', tab: 'general', title: 'Appearance & motion', description: 'UI motion and visual density', section: 'Appearance' },
	// general.themeBuilder is deliberately absent: the section is hidden behind
	// SHOW_THEME_BUILDER in GeneralTab, and a search hit that scrolls to nothing is worse
	// than no hit. Restore this line if that switch is turned back on.
	{ id: 'general.transfer.vscode', tab: 'general', title: 'From VS Code', description: 'Transfer extensions and settings from VS Code', section: 'Transfer' },
	{ id: 'general.transfer.cursor', tab: 'general', title: 'From Cursor', description: 'Transfer extensions and settings from Cursor', section: 'Transfer' },
	{ id: 'general.importSettings', tab: 'general', title: 'Import settings', description: 'Load V3Code settings from a JSON file', section: 'Settings data' },
	{ id: 'general.exportSettings', tab: 'general', title: 'Export settings', description: 'Save your V3Code settings to a JSON file', section: 'Settings data' },
	{ id: 'general.resetSettings', tab: 'general', title: 'Reset settings', description: 'Restore all V3Code settings to defaults', section: 'Settings data' },
	{ id: 'general.importChats', tab: 'general', title: 'Import chats', description: 'Load chat history from a JSON file', section: 'Chat data' },
	{ id: 'general.exportChats', tab: 'general', title: 'Export chats', description: 'Save your chat history to a JSON file', section: 'Chat data' },
	{ id: 'general.resetChats', tab: 'general', title: 'Reset chats', description: 'Clear all chat threads', section: 'Chat data' },
	{ id: 'general.ideSettings', tab: 'general', title: 'General settings', description: 'Open VS Code general settings', section: 'IDE' },
	{ id: 'general.keybindings', tab: 'general', title: 'Keyboard shortcuts', description: 'Customize keybindings', section: 'IDE' },
	{ id: 'general.theme', tab: 'general', title: 'Theme', description: 'Change color theme', section: 'IDE' },
	{ id: 'general.logs', tab: 'general', title: 'Logs', description: 'Open log files folder', section: 'IDE' },
	{ id: 'general.metrics', tab: 'general', title: 'Opt out of metrics', description: 'Anonymous usage tracking opt-out', section: 'Privacy' },
	{ id: 'general.aiInstructions', tab: 'general', title: 'AI Instructions', description: 'System instructions included with all AI requests', section: 'AI Instructions' },
	{ id: 'general.disableAgentOs', tab: 'general', title: 'Disable Agent OS prompt', description: 'Remove built-in Agent OS prompt', section: 'AI Instructions' },
	{ id: 'general.imageDescribe', tab: 'general', title: 'Image describe for text-only models', description: 'Transcribe images for text-only chat models', section: 'AI Instructions' },
	{ id: 'general.visionDescribeModel', tab: 'general', title: 'Vision transcription model', description: 'Pick auto or a specific model to read images for text-only chat models', section: 'AI Instructions' },
	{ id: 'general.askUser', tab: 'general', title: 'Let the agent ask multiple-choice questions', description: 'Pause for clickable options at decision points', section: 'AI Instructions' },
	{ id: 'general.promptAssembly', tab: 'general', title: 'Prompt assembly', description: 'How much Agent OS prompt and memory is pushed each turn', section: 'AI Instructions' },

	// MCP
	{ id: 'mcp.add', tab: 'mcp', title: 'Add MCP server', description: 'Model Context Protocol tools for Agent mode', section: 'Servers' },
	{ id: 'mcp.v3code', tab: 'mcpExpose', title: 'Expose V3Code', description: 'Give Claude Code, Codex, or Cursor this editor\'s live code intelligence and memory', section: 'Expose V3Code' },

	// Indexing
	{ id: 'indexing.docs', tab: 'indexingDocs', title: 'Indexing & Docs', description: 'Semantic index and documentation sources', section: 'Indexing' },
];

export function searchSettings(query: string, limit = 12): SettingsSearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const tokens = q.split(/\s+/).filter(Boolean);
	const scored: { hit: SettingsSearchHit; score: number }[] = [];
	for (const hit of SETTINGS_SEARCH_INDEX) {
		const hay = `${hit.title} ${hit.description} ${hit.section ?? ''} ${hit.tab}`.toLowerCase();
		let score = 0;
		let ok = true;
		for (const t of tokens) {
			if (!hay.includes(t)) { ok = false; break; }
			if (hit.title.toLowerCase().includes(t)) score += 3;
			else if ((hit.section ?? '').toLowerCase().includes(t)) score += 2;
			else score += 1;
		}
		if (ok) scored.push({ hit, score });
	}
	scored.sort((a, b) => b.score - a.score || a.hit.title.localeCompare(b.hit.title));
	return scored.slice(0, limit).map(s => s.hit);
}

export function flashSettingRow(settingId: string): void {
	// Quoted attribute match — do not CSS.escape (that would look for literal \.)
	const safe = settingId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const el = document.querySelector(`[data-setting-id="${safe}"]`) as HTMLElement | null;
	if (!el) return;
	el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	el.classList.add('v3code-settings-row--flash');
	window.setTimeout(() => el.classList.remove('v3code-settings-row--flash'), 1400);
}
