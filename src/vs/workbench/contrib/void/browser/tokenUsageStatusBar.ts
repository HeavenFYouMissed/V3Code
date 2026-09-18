/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Status-bar token/usage meter for the native V3Code agent.
 *
 * Always-visible glance: `$(graph) 12.3k tok · $0.0123` — ALL sessions and features this
 * app run (the service only holds in-memory totals; the scope labels must say so honestly).
 * Click opens a quick-pick breakdown per model, and — once a hosted-plan allowance
 * provider is registered (ITokenUsageService.registerAllowanceProvider) — the
 * remaining "buildup" allowance per model. BYOK shows cost; hosted shows remaining.
 *
 * Kept in the status bar (idiomatic, like Copilot/Continue) rather than the fragile
 * chat input toolbar. Alignment/priority can be changed in one line below.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import * as dom from '../../../../base/browser/dom.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntry, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ITokenUsageService, UsageTotals, ModelUsageTotals } from '../common/tokenUsageService.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';

const SHOW_USAGE_COMMAND_ID = 'v3code.tokenUsage.showBreakdown';

// Soft monthly budget used to frame the accumulated-spend meter. BYOK has no hosted
// limit, so this is a placeholder until a real budget/plan cap is wired in.
const ACCENT = 'var(--v3-accent, #9587ff)';
const accentMix = (pct: number) => `color-mix(in srgb, ${ACCENT} ${pct}%, transparent)`;
const fgMix = (pct: number) => `color-mix(in srgb, var(--vscode-foreground) ${pct}%, transparent)`;

/** 12345 -> "12.3k", 1234567 -> "1.23M". */
export const formatTokens = (n: number): string => {
	if (n < 1000) { return `${n}`; }
	if (n < 1_000_000) { return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`; }
	return `${(n / 1_000_000).toFixed(2)}M`;
};

/** Dollars with sensible precision for tiny and large amounts. */
export const formatCost = (usd: number): string => {
	if (usd <= 0) { return '$0'; }
	if (usd < 0.01) { return `$${usd.toFixed(4)}`; }
	if (usd < 1) { return `$${usd.toFixed(3)}`; }
	return `$${usd.toFixed(2)}`;
};

/** Cost for a totals row, honest about unpriced usage: '$1.23+' means "at least" (some usage
 *  came from models with no price data), and pure-unpriced usage shows 'unpriced', never '$0'. */
export const formatCostScoped = (totals: { costUsd: number; hasUnpricedUsage: boolean }): string => {
	if (!totals.hasUnpricedUsage) { return formatCost(totals.costUsd); }
	if (totals.costUsd <= 0) { return localize('v3code.tokenUsage.unpriced', 'unpriced'); }
	return `${formatCost(totals.costUsd)}+`;
};

export class TokenUsageStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.tokenUsage.statusBar';

	private entry: IStatusbarEntryAccessor | null = null;

	constructor(
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@ITokenUsageService private readonly tokenUsageService: ITokenUsageService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(SHOW_USAGE_COMMAND_ID, () => this.showBreakdown()));
		this.render();
		this._register(this.tokenUsageService.onDidChangeUsage(() => this.render()));
		// A plan lapsing/activating flips this bar between the %-meter and the BYOK view.
		this._register(this.accountService.onDidChangeState(() => this.render()));
	}

	private render(): void {
		// Paid plan: percent-only meter (no tokens, no $ — the iron rule for customer
		// surfaces). BYOK/free keeps the token+cost view of the user's own spend.
		if (this.accountService.state.isPaid) {
			this.renderPaid();
			return;
		}

		const totals = this.tokenUsageService.getAllTimeTotals();
		const month = this.tokenUsageService.getRangeTotals(30);
		const totalTokens = totals.promptTokens + totals.completionTokens;
		const text = totalTokens === 0
			? `$(graph) ${localize('v3code.tokenUsage.idle', 'Usage')}`
			: `$(graph) ${formatTokens(totalTokens)} ${localize('v3code.tokenUsage.tok', 'tok')} · ${formatCostScoped(totals)}`;

		const entry: IStatusbarEntry = {
			name: localize('v3code.tokenUsage.name', 'V3Code Token Usage'),
			text,
			ariaLabel: localize('v3code.tokenUsage.aria', 'V3Code token usage, all sessions this app run'),
			tooltip: this.buildUsageCard(totals, month),
			command: SHOW_USAGE_COMMAND_ID,
		};
		this.setEntry(entry);
	}

	/** Paid-plan meter: percent of the monthly plan used — NEVER tokens or dollars. */
	private renderPaid(): void {
		const credit = this.accountService.state.credit;
		const percentUsed = Math.round(Math.max(0, Math.min(100, credit?.percentUsed ?? 0)));
		const entry: IStatusbarEntry = {
			name: localize('v3code.tokenUsage.name', 'V3Code Token Usage'),
			text: `$(graph) ${percentUsed}% · ${localize('v3code.tokenUsage.hostedAI', 'Hosted AI')}`,
			ariaLabel: localize('v3code.tokenUsage.ariaPaid', 'V3Code hosted plan usage, {0} percent used this cycle', percentUsed),
			tooltip: this.buildPaidCard(percentUsed),
			command: SHOW_USAGE_COMMAND_ID,
		};
		this.setEntry(entry);
	}

	private setEntry(entry: IStatusbarEntry): void {
		if (!this.entry) {
			this.entry = this._register(this.statusbar.addEntry(entry, 'v3code.tokenUsage', StatusbarAlignment.RIGHT, 55));
		} else {
			this.entry.update(entry);
		}
	}

	/** Paid hover card: master % + friendly remaining + the three burn lanes. No $/tokens. */
	private buildPaidCard(percentUsed: number): HTMLElement {
		const state = this.accountService.state;
		const credit = state.credit;
		const card = dom.$('div.v3-usage-card');
		card.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:250px;max-width:320px;padding:12px 14px;font-size:12px;line-height:1.45;color:var(--vscode-foreground);';

		const header = dom.$('div');
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
		const title = dom.$('span'); title.textContent = localize('v3code.tokenUsage.card.hostedTitle', 'Hosted AI'); title.style.cssText = 'font-weight:600;font-size:13px;';
		const chip = dom.$('span'); chip.textContent = state.tierLabel;
		chip.style.cssText = `font-size:10px;font-weight:600;letter-spacing:.3px;padding:1px 7px;border-radius:999px;background:${accentMix(18)};color:${ACCENT};border:1px solid ${accentMix(40)};`;
		header.append(title, chip);

		const masterBar = this.percentBar(localize('v3code.tokenUsage.card.monthly', 'Monthly usage'), percentUsed);

		const scope = dom.$('div');
		scope.textContent = credit?.remainingLabel
			? localize('v3code.tokenUsage.card.remaining', '{0} this cycle · well-cached requests burn less', credit.remainingLabel)
			: localize('v3code.tokenUsage.card.scopePaid', 'Plan usage this cycle · well-cached requests burn less');
		scope.style.cssText = 'opacity:.55;font-size:11px;';

		card.append(header, masterBar, scope);

		// Three burn lanes (Cheap / Mid / Heavy) — always shown, growing from 0.
		const laneLabels: Record<string, string> = {
			pro_fast: localize('v3code.tokenUsage.lane.cheap', 'V3Fast · V3Pro'),
			build_hybrid: localize('v3code.tokenUsage.lane.mid', 'V3Luna · Terra · Build'),
			opus: localize('v3code.tokenUsage.lane.heavy', 'V3Sol · Opus'),
		};
		const divider = dom.$('div'); divider.style.cssText = `height:1px;background:${fgMix(10)};margin:1px 0;`;
		card.append(divider);
		for (const id of ['pro_fast', 'build_hybrid', 'opus']) {
			const pct = Math.round(Math.max(0, Math.min(100, credit?.classes.find(c => c.id === id)?.percentOfBudget ?? 0)));
			card.append(this.percentBar(laneLabels[id], pct));
		}
		return card;
	}

	/** A labeled percent meter row (label + % + fill bar). */
	private percentBar(label: string, percent: number): HTMLElement {
		const row = dom.$('div');
		row.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
		const top = dom.$('div');
		top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;';
		const l = dom.$('span'); l.textContent = label; l.style.opacity = '.85';
		const v = dom.$('span'); v.textContent = `${percent}%`; v.style.cssText = 'opacity:.55;font-variant-numeric:tabular-nums;';
		top.append(l, v);
		const track = dom.$('div');
		track.style.cssText = `position:relative;height:6px;border-radius:999px;overflow:hidden;background:${fgMix(12)};`;
		const fill = dom.$('div');
		fill.style.cssText = `position:absolute;inset:0 auto 0 0;width:${Math.max(percent, percent > 0 ? 2 : 0)}%;border-radius:999px;background:${ACCENT};`;
		track.append(fill);
		row.append(top, track);
		return row;
	}

	/** Rich hover card: a monthly accumulated-spend meter + BYOK stats. */
	private buildUsageCard(totals: UsageTotals, month: UsageTotals): HTMLElement {
		const totalTokens = totals.promptTokens + totals.completionTokens;
		const spent = month.costUsd;

		const card = dom.$('div.v3-usage-card');
		card.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:250px;max-width:320px;padding:12px 14px;font-size:12px;line-height:1.45;color:var(--vscode-foreground);';

		const header = dom.$('div');
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
		const title = dom.$('span'); title.textContent = localize('v3code.tokenUsage.card.title', 'Usage'); title.style.cssText = 'font-weight:600;font-size:13px;';
		const chip = dom.$('span'); chip.textContent = 'BYOK';
		chip.style.cssText = `font-size:10px;font-weight:600;letter-spacing:.3px;padding:1px 7px;border-radius:999px;background:${accentMix(18)};color:${ACCENT};border:1px solid ${accentMix(40)};`;
		header.append(title, chip);

		// The user's own spend on their own keys — no invented budget/limit framing.
		const amountRow = dom.$('div');
		amountRow.style.cssText = 'display:flex;align-items:baseline;gap:6px;';
		const big = dom.$('span'); big.textContent = formatCost(spent); big.style.cssText = 'font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;';
		amountRow.append(big);

		const scope = dom.$('div');
		scope.textContent = localize('v3code.tokenUsage.card.scope', 'Last 30 days · spend on your own API keys');
		scope.style.cssText = 'opacity:.55;font-size:11px;';

		const divider = dom.$('div');
		divider.style.cssText = `height:1px;background:${fgMix(10)};margin:1px 0;`;

		const stats = dom.$('div');
		stats.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 14px;opacity:.9;';
		const stat = (label: string, val: string) => {
			const s = dom.$('span');
			const l = dom.$('span'); l.textContent = label + ' '; l.style.opacity = '.55';
			const v = dom.$('span'); v.textContent = val; v.style.fontVariantNumeric = 'tabular-nums';
			s.append(l, v);
			return s;
		};
		stats.append(
			stat(localize('v3code.tokenUsage.card.input', 'Input'), formatTokens(totals.promptTokens)),
			stat(localize('v3code.tokenUsage.card.output', 'Output'), formatTokens(totals.completionTokens)),
			stat(localize('v3code.tokenUsage.card.thisRun', 'This run'), `${formatTokens(totalTokens)} tok · ${formatCostScoped(totals)}`),
		);

		const top = [...totals.byModel].sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens))[0];
		let topEl: HTMLElement | null = null;
		if (top) {
			topEl = dom.$('div');
			topEl.style.cssText = 'opacity:.9;font-size:11px;';
			const l = dom.$('span'); l.textContent = localize('v3code.tokenUsage.card.top', 'Top') + ' '; l.style.opacity = '.55';
			const v = dom.$('span'); v.textContent = `${top.modelName} · ${formatTokens(top.promptTokens + top.completionTokens)} tok`; v.style.fontVariantNumeric = 'tabular-nums';
			topEl.append(l, v);
		}

		const hint = dom.$('div');
		hint.textContent = totals.hasUnpricedUsage
			? localize('v3code.tokenUsage.card.hintUnpriced', 'Some models are unpriced · click for the per-model breakdown')
			: localize('v3code.tokenUsage.card.hint', 'Cache-aware estimate · click for the per-model breakdown');
		hint.style.cssText = 'opacity:.45;font-size:11px;';

		card.append(header, amountRow, scope, divider, stats);
		if (topEl) { card.append(topEl); }
		card.append(hint);
		return card;
	}

	private async showBreakdown(): Promise<void> {
		const totals = this.tokenUsageService.getAllTimeTotals();
		const items: IQuickPickItem[] = [];

		const totalTokens = totals.promptTokens + totals.completionTokens;
		items.push({
			label: localize('v3code.tokenUsage.qp.total', '$(graph) Total (all sessions this app run)'),
			description: `${formatTokens(totalTokens)} tokens · ${formatCostScoped(totals)}`,
			detail: localize('v3code.tokenUsage.qp.totalDetail', '{0} input · {1} output', formatTokens(totals.promptTokens), formatTokens(totals.completionTokens)),
		});

		const byModel = [...totals.byModel].sort((a, b) =>
			(b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens));
		for (const m of byModel) {
			items.push(this.modelItem(m));
		}

		if (byModel.length === 0) {
			items.push({ label: localize('v3code.tokenUsage.qp.none', 'No usage recorded yet this app run'), description: '' });
		}

		// Read-only breakdown: pick() handles the picker lifecycle for us.
		await this.quickInputService.pick(items, {
			title: localize('v3code.tokenUsage.qp.title', 'V3Code — Token Usage'),
			matchOnDescription: true,
			matchOnDetail: true,
		});
	}

	private modelItem(m: ModelUsageTotals): IQuickPickItem {
		const modelTokens = m.promptTokens + m.completionTokens;
		// Hosted plans: if an allowance provider is registered, show remaining instead of cost.
		const allowance = this.tokenUsageService.getAllowance(m.providerName, m.modelName);
		if (allowance) {
			const remaining = Math.max(0, allowance.limit - allowance.used);
			const pct = allowance.limit > 0 ? Math.floor((allowance.used / allowance.limit) * 100) : 0;
			const bar = this.miniBar(pct);
			return {
				label: `$(server) ${m.modelName}`,
				description: `${bar} ${formatTokens(remaining)} ${allowance.unit} left`,
				detail: allowance.resetsLabel
					? localize('v3code.tokenUsage.qp.used', 'Used {0}/{1} · {2}', formatTokens(allowance.used), formatTokens(allowance.limit), allowance.resetsLabel)
					: localize('v3code.tokenUsage.qp.usedNoReset', 'Used {0}/{1}', formatTokens(allowance.used), formatTokens(allowance.limit)),
			};
		}
		return {
			label: `$(chip) ${m.modelName}`,
			description: `${formatTokens(modelTokens)} tokens · ${formatCostScoped({ costUsd: m.costUsd, hasUnpricedUsage: !!m.unpriced })}`,
			detail: localize('v3code.tokenUsage.qp.modelDetail', '{0} input · {1} output · {2}', formatTokens(m.promptTokens), formatTokens(m.completionTokens), m.providerName),
		};
	}

	/** Tiny text progress bar for the allowance %. */
	private miniBar(pct: number): string {
		const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * 10);
		// allow-any-unicode-next-line
		return '█'.repeat(filled) + '░'.repeat(10 - filled);
	}
}

registerWorkbenchContribution2(TokenUsageStatusBarContribution.ID, TokenUsageStatusBarContribution, WorkbenchPhase.AfterRestored);
