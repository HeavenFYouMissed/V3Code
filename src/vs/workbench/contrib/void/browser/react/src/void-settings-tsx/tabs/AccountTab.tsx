/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { v3codeMessagePrefKeys, displayInfoOfMessagePref } from '../settingsExternals.js';
import { VoidButtonBgDarken, VoidSwitch } from '../../util/inputs.js'
import { useAccessor } from '../../util/services.js'
import { Check } from 'lucide-react'
import {
	CardDivider,
	SettingRow,
	SettingsCard,
	SettingsSection,
} from '../SettingsLayout.js'
import { ACCENT, accentMix, ClaudePlanSignInCard, CopilotSignInCard, CursorLocalSignInCard, GeminiPlanSignInCard, GrokPlanSignInCard, OpenaiPlanSignInCard } from '../settingsShared.js'

const formatUsageTokens = (n: number): string => {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${Math.round(n / 1_000)}k`; }
	return String(Math.round(n));
};

const formatUsageCost = (usd: number): string => {
	if (usd > 0 && usd < 0.01) { return '<$0.01'; }
	return `$${usd.toFixed(usd >= 1 ? 2 : 3)}`;
};

// Placeholder plan caps (visual only until plan/quota wiring lands — see PlanUsageSection).

type DaySnapshot = { date: string; promptTokens: number; completionTokens: number; costUsd: number };

// Big stat: small uppercase label above a large value (Cursor-style profile stats).
const BigStat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
	<div className='flex flex-col gap-0.5 min-w-[5.5rem]'>
		<span className='text-void-fg-3 text-[10px] uppercase tracking-wider font-medium'>{label}</span>
		<span className='text-void-fg-1 text-xl font-semibold tabular-nums leading-tight'>{value}</span>
		{sub != null ? <span className='text-void-fg-3 text-[11px]'>{sub}</span> : null}
	</div>
);

// Gorgeous interactive area chart — gradient fill + hover guide line + tooltip.
const UsageAreaChart = ({ history }: { history: DaySnapshot[] }) => {
	const [hover, setHover] = useState<number | null>(null);
	const W = 640, H = 150, PAD = 8;
	const n = history.length;
	const pts = history.map(d => d.promptTokens + d.completionTokens);
	const maxV = Math.max(1, ...pts);
	const xOf = (i: number) => n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2);
	const yOf = (v: number) => H - PAD - (v / maxV) * (H - PAD * 2);
	const linePath = pts.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' ');
	const areaPath = n > 1 ? `${linePath} L ${xOf(n - 1).toFixed(1)} ${(H - PAD).toFixed(1)} L ${xOf(0).toFixed(1)} ${(H - PAD).toFixed(1)} Z` : '';
	const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const rel = ((e.clientX - rect.left) / rect.width) * W;
		let best = 0, bestD = Infinity;
		for (let i = 0; i < n; i++) { const d = Math.abs(xOf(i) - rel); if (d < bestD) { bestD = d; best = i; } }
		setHover(best);
	};
	const hv = hover != null ? history[hover] : null;
	return (
		<div className='relative w-full'>
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className='block w-full' style={{ height: 150 }}
				onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
				<defs>
					<linearGradient id='v3-usage-grad' x1='0' y1='0' x2='0' y2='1'>
						<stop offset='0%' stopColor={ACCENT} stopOpacity='0.35' />
						<stop offset='100%' stopColor={ACCENT} stopOpacity='0' />
					</linearGradient>
				</defs>
				{n > 1 && <path d={areaPath} fill='url(#v3-usage-grad)' />}
				{n > 1 && <path d={linePath} fill='none' stroke={ACCENT} strokeWidth='1.75' vectorEffect='non-scaling-stroke' strokeLinejoin='round' strokeLinecap='round' />}
				{hover != null && n > 0 && (
					<g>
						<line x1={xOf(hover)} y1={PAD} x2={xOf(hover)} y2={H - PAD} stroke={accentMix(45)} strokeWidth='1' vectorEffect='non-scaling-stroke' />
						<circle cx={xOf(hover)} cy={yOf(pts[hover])} r='3.5' fill={ACCENT} stroke='var(--void-bg-1)' strokeWidth='1.5' vectorEffect='non-scaling-stroke' />
					</g>
				)}
			</svg>
			{hv && (
				<div className='pointer-events-none absolute top-0 px-2 py-1 rounded-md text-[11px] whitespace-nowrap z-10'
					style={{ left: `${(xOf(hover!) / W) * 100}%`, transform: 'translate(-50%, -110%)', background: 'var(--void-bg-1)', border: '1px solid var(--void-border-2)', boxShadow: 'var(--shadow-md)' }}>
					<div className='text-void-fg-1 font-semibold tabular-nums'>{formatUsageTokens(hv.promptTokens + hv.completionTokens)} tok</div>
					<div className='text-void-fg-3'>{hv.date.slice(5)} · {formatUsageCost(hv.costUsd)}</div>
				</div>
			)}
			<div className='flex justify-between mt-1 text-void-fg-3 text-[10px]'>
				<span>{history[0]?.date.slice(5) ?? ''}</span>
				<span>Today</span>
			</div>
		</div>
	);
};

// Compact activity strip — intensity is that day's total tokens (GitHub-style).
const UsageHeatmap = ({ history }: { history: DaySnapshot[] }) => {
	const max = Math.max(1, ...history.map(d => d.promptTokens + d.completionTokens));
	return (
		<div className='flex gap-[3px] flex-wrap'>
			{history.map(d => {
				const t = d.promptTokens + d.completionTokens;
				const intensity = t === 0 ? 0 : Math.round((0.18 + 0.82 * (t / max)) * 100);
				return (
					<div key={d.date} title={`${d.date}: ${formatUsageTokens(t)} tok`} className='rounded-[2px]'
						style={{ width: 11, height: 11, background: t === 0 ? 'var(--void-bg-3)' : accentMix(intensity) }} />
				);
			})}
		</div>
	);
};

type ModelRow = { provider: string; model: string; prompt: number; completion: number; cost: number; requests: number };

// Top models as ranked cards (Cursor "Models" row).
const ModelRankCards = ({ rows }: { rows: ModelRow[] }) => {
	const top = rows.slice(0, 3);
	if (top.length === 0) { return null; }
	return (
		<div className='grid grid-cols-1 sm:grid-cols-3 gap-2'>
			{top.map((r, i) => (
				<div key={`${r.provider}::${r.model}`} className='relative flex items-center gap-2.5 rounded-lg border border-void-border-2 bg-void-bg-2 px-3 py-2.5 overflow-hidden'>
					<span className='absolute top-1.5 right-2 text-void-fg-3 text-[11px] font-semibold tabular-nums'>{i + 1}</span>
					<div className='flex items-center justify-center rounded-md text-white text-xs font-bold shrink-0' style={{ width: 26, height: 26, background: accentMix(85) }}>{(r.provider || r.model).charAt(0).toUpperCase()}</div>
					<div className='flex flex-col min-w-0'>
						<span className='text-void-fg-1 text-sm font-medium truncate' title={r.model}>{r.model}</span>
						<span className='text-void-fg-3 text-[11px] tabular-nums'>{formatUsageTokens(r.prompt + r.completion)} tok · {formatUsageCost(r.cost)}</span>
					</div>
				</div>
			))}
		</div>
	);
};

const AccountUsageSection = () => {
	const accessor = useAccessor();
	const tokenUsageService = accessor.get('ITokenUsageService');
	const [, setTick] = useState(0);

	useEffect(() => {
		const d = tokenUsageService.onDidChangeUsage(() => setTick(t => t + 1));
		return () => d.dispose();
	}, [tokenUsageService]);

	const today = tokenUsageService.getRangeTotals(1);
	const week = tokenUsageService.getRangeTotals(7);
	const month = tokenUsageService.getRangeTotals(30);
	const allTime = tokenUsageService.getRangeTotals(365);
	const session = tokenUsageService.getAllTimeTotals();
	const history = tokenUsageService.getDailyHistory(30);
	const buckets = tokenUsageService.getDailyBucketsForRange(30);

	const modelRows = useMemo(() => {
		const merged = new Map<string, { provider: string; model: string; prompt: number; completion: number; cost: number; requests: number }>();
		for (const b of buckets) {
			const key = `${b.providerName}::${b.modelName}`;
			const prev = merged.get(key);
			if (prev) {
				prev.prompt += b.promptTokens;
				prev.completion += b.completionTokens;
				prev.cost += b.costUsd;
				prev.requests += b.requestCount;
			} else {
				merged.set(key, {
					provider: b.providerName,
					model: b.modelName,
					prompt: b.promptTokens,
					completion: b.completionTokens,
					cost: b.costUsd,
					requests: b.requestCount,
				});
			}
		}
		for (const m of session.byModel) {
			const key = `${m.providerName}::${m.modelName}`;
			const prev = merged.get(key);
			if (prev) {
				// session totals overlap today's buckets — skip double-count in table
			} else if (m.promptTokens || m.completionTokens) {
				merged.set(key, {
					provider: m.providerName,
					model: m.modelName,
					prompt: m.promptTokens,
					completion: m.completionTokens,
					cost: m.costUsd,
					requests: 0,
				});
			}
		}
		return [...merged.values()].sort((a, b) => (b.prompt + b.completion) - (a.prompt + a.completion));
	}, [buckets, session.byModel]);

	const totalTokens = (t: { promptTokens: number; completionTokens: number }) => t.promptTokens + t.completionTokens;
	const requests = useMemo(() => buckets.reduce((s, b) => s + b.requestCount, 0), [buckets]);
	const cacheReads = useMemo(() => buckets.reduce((s, b) => s + (b.promptCacheHitTokens || 0), 0), [buckets]);

	return (
		<SettingsSection label="Usage">
			<SettingsCard>
				<div className='px-4 py-4 flex flex-col gap-5'>
					<div className='flex flex-col gap-3'>
						<div className='flex items-baseline gap-2'>
							<span className='text-void-fg-1 text-2xl font-semibold tabular-nums leading-none'>{formatUsageTokens(totalTokens(allTime))}</span>
							<span className='text-void-fg-3 text-sm'>tokens · last 12 months</span>
						</div>
						<div className='flex flex-wrap gap-x-8 gap-y-3'>
							<BigStat label='This session' value={formatUsageTokens(totalTokens(session))} sub={formatUsageCost(session.costUsd)} />
							<BigStat label='Today' value={formatUsageTokens(totalTokens(today))} sub={formatUsageCost(today.costUsd)} />
							<BigStat label='7 days' value={formatUsageTokens(totalTokens(week))} sub={formatUsageCost(week.costUsd)} />
							<BigStat label='30 days' value={formatUsageTokens(totalTokens(month))} sub={formatUsageCost(month.costUsd)} />
							<BigStat label='Requests' value={requests.toLocaleString()} sub='30 days' />
							<BigStat label='Models' value={modelRows.length} sub='used' />
							{cacheReads > 0 ? <BigStat label='Cache reads' value={formatUsageTokens(cacheReads)} sub='saved on input' /> : null}
						</div>
					</div>

					<CardDivider />

					<div>
						<div className='text-void-fg-2 text-xs font-medium mb-2'>Tokens per day (30 days)</div>
						<UsageAreaChart history={history} />
					</div>

					<div>
						<div className='text-void-fg-2 text-xs font-medium mb-2'>Activity</div>
						<UsageHeatmap history={history} />
					</div>

					{modelRows.length > 0 && (
						<div className='flex flex-col gap-3'>
							<div className='text-void-fg-2 text-xs font-medium'>Top models (30 days)</div>
							<ModelRankCards rows={modelRows} />
							<details>
								<summary className='cursor-pointer text-void-fg-3 text-xs hover:text-void-fg-2 select-none w-fit'>All models ({modelRows.length})</summary>
								<div className='overflow-x-auto mt-2'>
									<table className='w-full text-xs border-collapse'>
										<thead>
											<tr className='text-void-fg-3 text-left border-b border-void-border-2'>
												<th className='py-1 pr-3 font-medium'>Model</th>
												<th className='py-1 pr-3 font-medium'>Provider</th>
												<th className='py-1 pr-3 font-medium text-right'>Input</th>
												<th className='py-1 pr-3 font-medium text-right'>Output</th>
												<th className='py-1 pr-3 font-medium text-right'>Reqs</th>
												<th className='py-1 pr-3 font-medium text-right'>Cost</th>
											</tr>
										</thead>
										<tbody>
											{modelRows.map(row => (
												<tr key={`${row.provider}::${row.model}`} className='border-b border-void-border-2/50 text-void-fg-1'>
													<td className='py-1.5 pr-3 truncate max-w-[10rem]' title={row.model}>{row.model}</td>
													<td className='py-1.5 pr-3 text-void-fg-3'>{row.provider}</td>
													<td className='py-1.5 pr-3 text-right tabular-nums'>{formatUsageTokens(row.prompt)}</td>
													<td className='py-1.5 pr-3 text-right tabular-nums'>{formatUsageTokens(row.completion)}</td>
													<td className='py-1.5 pr-3 text-right tabular-nums'>{row.requests || '—'}</td>
													<td className='py-1.5 pr-3 text-right tabular-nums'>{formatUsageCost(row.cost)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</details>
						</div>
					)}

					<p className='text-void-fg-3 text-[11px] m-0'>BYOK token usage is tracked locally and persists across restarts. Cost is a cache-aware estimate.</p>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
};

// Labeled usage meter bar (Cursor Plan & Usage style). Values come from real BYOK
// model usage where possible; caps are placeholders until plan/quota wiring lands.
const UsageBar = ({ label, used, limit, caption, formatUsed, warn }: { label: string; used: number; limit: number; caption?: string; formatUsed?: (n: number) => string; warn?: boolean }) => {
	const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
	const fmt = formatUsed ?? formatUsageTokens;
	return (
		<div className='flex flex-col gap-1.5'>
			<div className='flex items-center justify-between text-xs'>
				<span className='text-void-fg-1 font-medium'>{label}</span>
				<span className='text-void-fg-3 tabular-nums'>{fmt(used)} / {fmt(limit)}</span>
			</div>
			<div className='relative h-2 rounded-full overflow-hidden' style={{ background: 'var(--void-bg-3)' }}>
				<div className='absolute inset-y-0 left-0 rounded-full transition-all duration-300' style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%`, background: warn ? 'var(--v3-warning, #F59E0B)' : ACCENT, boxShadow: pct > 0 ? `0 0 8px ${accentMix(35)}` : 'none' }} />
			</div>
			{caption ? <span className='text-void-fg-3 text-[11px]'>{caption}</span> : null}
		</div>
	);
};

const PlanCard = ({ name, price, period, features, highlighted, onSelect }: { name: string; price: string; period: string; features: string[]; highlighted?: boolean; onSelect: () => void }) => (
	<div className='relative flex flex-col gap-3 rounded-xl border p-4'
		style={{ background: highlighted ? accentMix(8) : 'var(--void-bg-2)', borderColor: highlighted ? accentMix(45) : 'var(--void-border-2)' }}>
		{highlighted ? <span className='absolute -top-2 left-4 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white' style={{ background: ACCENT }}>Popular</span> : null}
		<div className='flex flex-col'>
			<span className='text-void-fg-1 text-sm font-semibold'>{name}</span>
			<div className='flex items-baseline gap-1'>
				<span className='text-void-fg-1 text-2xl font-bold tabular-nums'>{price}</span>
				<span className='text-void-fg-3 text-xs'>{period}</span>
			</div>
		</div>
		<ul className='flex flex-col gap-1.5 m-0 p-0 list-none'>
			{features.map(f => (
				<li key={f} className='flex items-start gap-1.5 text-void-fg-2 text-xs'>
					<Check size={13} className='mt-0.5 shrink-0' style={{ color: ACCENT }} />{f}
				</li>
			))}
		</ul>
		<button onClick={onSelect} className='mt-auto w-full rounded-md py-1.5 text-xs font-medium transition-colors'
			style={highlighted ? { background: ACCENT, color: '#fff' } : { background: 'var(--void-bg-3)', color: 'var(--void-fg-1)', border: '1px solid var(--void-border-2)' }}>
			Upgrade
		</button>
	</div>
);

/** Burn-bar labels for the hosted usage lanes (ids are the hub wire contract).
 *  Order + membership mirror the locked Cheap/Mid/Heavy burn design. */
const CREDIT_CLASS_LABELS: Record<string, string> = {
	pro_fast: 'V3Fast · V3Pro',
	build_hybrid: 'V3Luna · Terra · Build',
	opus: 'V3Sol · Opus',
};
/** Fixed display order — all three bars always render (empty → growing from 0). */
const CREDIT_CLASS_ORDER = ['pro_fast', 'build_hybrid', 'opus'] as const;

const formatPercent = (n: number): string => `${Math.round(n)}%`;


// Plan & Usage page (under Account) — current plan, usage meters, and upgrade
// cards. Paid accounts with hosted usage show the plan usage meter (percent +
// friendly label ONLY — dollar/token values never reach a customer surface);
// everyone else keeps the local BYOK meters.
const PlanUsageSection = () => {
	const accessor = useAccessor();
	const accountService = accessor.get('IV3CodeAccountService');
	const tokenUsageService = accessor.get('ITokenUsageService');
	const [, setTick] = useState(0);

	useEffect(() => {
		const d1 = tokenUsageService.onDidChangeUsage(() => setTick(t => t + 1));
		const d2 = accountService.onDidChangeState(() => setTick(t => t + 1));
		return () => { d1.dispose(); d2.dispose(); };
	}, [tokenUsageService, accountService]);

	const month = tokenUsageService.getRangeTotals(30);
	const tier = accountService.state.tierLabel;
	const isPaid = accountService.state.isPaid;
	const credit = accountService.state.credit;
	// A paid plan ALWAYS shows the % plan meter (master + 3 class bars), growing
	// from 0 — never the BYOK token fallback. If the hub meter hasn't landed yet,
	// fall back to a zeroed meter so a fresh plan still reads as a plan, not BYOK.
	const planCredit = isPaid
		? (credit ?? { percentUsed: 0, remainingLabel: 'Full', classes: [] as readonly { id: string; percentOfBudget: number; events: number }[] })
		: undefined;
	const showCredit = !!planCredit;
	const planExhausted = accountService.isPlanCreditExhausted();
	const overageEnabled = credit?.overage?.enabled === true;
	const classPercent = (id: string): number => planCredit?.classes.find(c => c.id === id)?.percentOfBudget ?? 0;
	const catTokens = (match: (m: string) => boolean) =>
		month.byModel.filter(m => match(m.modelName.toLowerCase())).reduce((s, m) => s + m.promptTokens + m.completionTokens, 0);
	const proTok = catTokens(m => m.includes('pro') || m.includes('fast'));
	const autoTok = catTokens(m => m.includes('auto') || m.includes('hybrid'));
	const opusTok = catTokens(m => m.includes('opus'));

	return (
		<SettingsSection label="Plan & Usage">
			<SettingsCard>
				<div className='px-4 py-4 flex flex-col gap-5'>
					<div className='flex items-center justify-between gap-3'>
						<div className='flex flex-col'>
							<span className='text-void-fg-3 text-[10px] uppercase tracking-wider font-medium'>Current plan</span>
							<div className='flex items-baseline gap-2'>
								<span className='text-void-fg-1 text-lg font-semibold'>{tier}</span>
								<span className='text-void-fg-3 text-xs'>
									{planCredit ? `Hosted AI · ${planCredit.remainingLabel.toLowerCase()} this cycle` : 'BYOK · your own API keys'}
								</span>
							</div>
						</div>
						<div className='flex items-center gap-2'>
							{planExhausted ? (
								<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => accountService.openOverageSettings()}>
									Enable overage
								</VoidButtonBgDarken>
							) : null}
							<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => accountService.manageAccount()}>Manage</VoidButtonBgDarken>
						</div>
					</div>

					{planExhausted ? (
						<div className='rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-void-fg-1'>
							You've used this month's included plan AI. Enable on-demand overage on v3code.dev to keep using V3Fast / V3Pro, or switch the composer to your own provider models (BYOK).
						</div>
					) : overageEnabled && planCredit && planCredit.percentUsed >= 100 ? (
						<div className='rounded-md border border-void-border-2 bg-void-bg-2 px-3 py-2 text-[12px] text-void-fg-2'>
							Included usage is used up — on-demand overage is on for this cycle.
						</div>
					) : null}

					<CardDivider />

					{planCredit ? (
						<div className='flex flex-col gap-4'>
							<div className='text-void-fg-2 text-xs font-medium'>This cycle</div>
							<UsageBar label='Monthly usage' used={planCredit.percentUsed} limit={100} formatUsed={formatPercent}
								caption='Every lane draws from the same monthly usage — well-cached requests burn less.' />
							{CREDIT_CLASS_ORDER.map(id => (
								<UsageBar key={id} label={CREDIT_CLASS_LABELS[id] ?? id} used={classPercent(id)}
									limit={100} formatUsed={formatPercent} />
							))}
						</div>
					) : (
						<div className='flex flex-col gap-3'>
							<div className='text-void-fg-2 text-xs font-medium'>This cycle · your own API keys</div>
							{([
								['V3 Pro / V3 Fast', proTok],
								['Auto / Hybrid', autoTok],
								['Opus', opusTok],
							] as const).map(([label, tok]) => (
								<div key={label} className='flex items-center justify-between text-xs'>
									<span className='text-void-fg-1 font-medium'>{label}</span>
									<span className='text-void-fg-3 tabular-nums'>{formatUsageTokens(tok)} tok</span>
								</div>
							))}
							<p className='text-void-fg-3 text-[11px] m-0'>
								Local BYOK usage, tracked on this machine only. Hosted plan usage appears here after your first hosted request.
							</p>
						</div>
					)}

					<CardDivider />

					<div>
						<div className='text-void-fg-2 text-xs font-medium mb-3'>Upgrade</div>
						<div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
							<PlanCard name='Pro' price='$20' period='/mo' onSelect={() => accountService.openPlans('starter')}
								features={['Everything in Free', 'A heavy month of daily usage', 'V3Fast · V3Pro · Hybrid Easy', 'On-demand overage']} />
							<PlanCard name='Power' price='$40' period='/mo' highlighted onSelect={() => accountService.openPlans('pro')}
								features={['Everything in Pro', '2× Pro usage', 'Hybrid Hard · V4.5 Build · Opus', 'Agent browser + MCP connect', 'Effort slider']} />
							<PlanCard name='Max' price='$100' period='/mo' onSelect={() => accountService.openPlans('power')}
								features={['Everything in Power', '5× Pro usage', 'Live in Opus all month', 'Priority support']} />
						</div>
						<p className='text-void-fg-3 text-[11px] mt-3 m-0'>
							{showCredit
								? 'Plans and billing are managed on v3code.dev.'
								: 'Plans are managed on v3code.dev. Meters reflect your BYOK model usage this cycle.'}
						</p>
					</div>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
};

// Account tab (ship-prep Component 5) — in-editor lite version of the account page.
// v1 renders the guest stub from IV3CodeAccountService; when hosted auth lands the
// same service starts reporting a real session and this tab lights up unchanged.
export const AccountTab = () => {
	const accessor = useAccessor()
	const accountService = accessor.get('IV3CodeAccountService')

	// bump to re-read service-backed values after any change
	const [, setRefreshCounter] = useState(0)
	const refresh = () => setRefreshCounter(c => c + 1)

	useEffect(() => {
		const d1 = accountService.onDidChangeState(refresh)
		const d2 = accountService.onDidChangePrefs(refresh)
		return () => { d1.dispose(); d2.dispose() }
	}, [accountService])

	const state = accountService.state

	return <>
		<SettingsSection label="Profile">
			<SettingsCard>
				<div className='flex items-center gap-3 px-4 py-3'>
					<div
						className='flex items-center justify-center rounded-full text-white font-bold text-sm shrink-0'
						style={{
							width: 36, height: 36,
							background: state.avatarUrl
								? `#0a0a0a center / cover no-repeat url("${state.avatarUrl}")`
								: '#0a0a0a',
							border: '1px solid rgba(180, 184, 192, 0.55)',
							boxShadow: '0 0 0 0.5px rgba(255, 255, 255, 0.12)',
						}}
					>
						{state.avatarUrl ? '' : 'V'}
					</div>
					<div className='flex flex-col min-w-0'>
						<span className='text-void-fg-1 text-sm font-medium truncate'>{state.displayName}</span>
						<span className='text-void-fg-3 text-xs'>{state.status === 'signedIn' ? 'Signed in' : 'Not signed in'}</span>
					</div>
					<span
						className='ml-auto shrink-0 text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full'
						style={{ background: accentMix(18), color: ACCENT, border: `1px solid ${accentMix(40)}` }}
					>
						{state.tierLabel}
					</span>
				</div>
				<CardDivider />
				<SettingRow
					title="Manage account"
					description="Sign in or manage your V3Code account on v3code.dev."
					control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => accountService.manageAccount()}>Manage Account</VoidButtonBgDarken>}
				/>
			</SettingsCard>
		</SettingsSection>

		{/* Subscription lanes signed in with a provider account rather than an API key. Grok (Plan)
		    lives here as well as under Models so "log in to my Grok account" is findable where a
		    user actually looks for sign-in. Both render the same live-status card. */}
		<SettingsSection label="Connected accounts">
			<SettingsCard>
				<div className='px-4 pt-3 text-void-fg-1 text-sm font-medium'>Grok (Plan)</div>
				<GrokPlanSignInCard />
				<CardDivider />
				<div className='px-4 pt-3 text-void-fg-1 text-sm font-medium'>Claude (Plan)</div>
				<ClaudePlanSignInCard />
				<CardDivider />
				<div className='px-4 pt-3 text-void-fg-1 text-sm font-medium'>Gemini (Plan)</div>
				<GeminiPlanSignInCard />
				<CardDivider />
				<div className='px-4 pt-3 text-void-fg-1 text-sm font-medium'>GitHub Copilot</div>
				<CopilotSignInCard />
				<CardDivider />
				<div className='px-4 pt-3 text-void-fg-1 text-sm font-medium'>Cursor (Local)</div>
				<CursorLocalSignInCard />
				<CardDivider />
				<div className='px-4 pt-3 text-void-fg-1 text-sm font-medium'>OpenAI (Plan)</div>
				<OpenaiPlanSignInCard />
			</SettingsCard>
		</SettingsSection>

		<PlanUsageSection />

		<AccountUsageSection />

		<SettingsSection label="Messages">
			<SettingsCard>
				{v3codeMessagePrefKeys.map((key, i) => (
					<React.Fragment key={key}>
						{i > 0 ? <CardDivider /> : null}
						<SettingRow
							title={displayInfoOfMessagePref[key].title}
							description={displayInfoOfMessagePref[key].description}
							control={
								<VoidSwitch
									size='xs'
									value={accountService.getMessagePref(key)}
									onChange={(newVal) => accountService.setMessagePref(key, newVal)}
								/>
							}
						/>
					</React.Fragment>
				))}
			</SettingsCard>
		</SettingsSection>

		<SettingsSection label="Privacy">
			<SettingsCard>
				<SettingRow
					settingId="account.privacy"
					title="V3Code does not use your work as training data"
					description="Your files, prompts, and responses are not used to train V3Code models. If you choose a cloud model or cloud feature, the prompt and context you select are sent to that third-party provider under its terms. Local models and on-device indexing stay on this computer."
				/>
			</SettingsCard>
		</SettingsSection>

		<SettingsSection label="Session">
			<SettingsCard>
				<SettingRow
					title="Log out"
					description="Sign out of your V3Code account on this machine."
					control={<VoidButtonBgDarken className='px-3 py-1 text-xs' onClick={() => accountService.signOut()}>Log Out</VoidButtonBgDarken>}
				/>
			</SettingsCard>
		</SettingsSection>
	</>
}

// Compact account chip pinned atop the settings nav (avatar + name + tier).
export const AccountNavChip = () => {
	const accessor = useAccessor()
	const accountService = accessor.get('IV3CodeAccountService')
	const [, setR] = useState(0)
	useEffect(() => {
		const d = accountService.onDidChangeState(() => setR(x => x + 1))
		return () => d.dispose()
	}, [accountService])
	const state = accountService.state
	return (
		<button
			type='button'
			onClick={() => accountService.manageAccount()}
			title='Manage account'
			className='flex items-center gap-2.5 w-full px-1.5 py-1.5 rounded-md text-left transition-colors hover:bg-void-bg-2'
		>
			<div className='flex items-center justify-center rounded-full text-white font-bold text-xs shrink-0'
				style={{
					width: 28, height: 28,
					background: state.avatarUrl
						? `#0a0a0a center / cover no-repeat url("${state.avatarUrl}")`
						: '#0a0a0a',
					border: '1px solid rgba(180, 184, 192, 0.55)',
					boxShadow: '0 0 0 0.5px rgba(255, 255, 255, 0.12)',
				}}>
				{state.avatarUrl ? '' : 'V'}
			</div>
			<div className='v3-account-chip-text flex flex-col min-w-0'>
				<span className='text-void-fg-1 text-xs font-medium truncate'>{state.displayName}</span>
				<span className='text-[10px] font-semibold' style={{ color: ACCENT }}>{state.tierLabel}</span>
			</div>
		</button>
	)
}
