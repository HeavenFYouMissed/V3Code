/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { VoidButtonBgDarken } from '../../util/inputs.js';
import { useAccessor } from '../../util/services.js';
import { CardDivider, SettingRow, SettingsCard, SettingsSection } from '../SettingsLayout.js';
import type { IV3CodeStatusBoard } from '../settingsExternals.js';

const AgentsConceptPreview = () => (
	<figure className="@@v3code-agents-concept" aria-label="Concept preview of a redesigned V3Code multi-agent workspace">
		<figcaption className="@@v3code-agents-concept-title">
			<span>V3 Agents</span>
			<span>Concept</span>
		</figcaption>
		<div className="@@v3code-agents-concept-shell">
			<div className="@@v3code-agents-concept-sidebar">
				<div className="@@v3code-agents-concept-sidebar-head"><span>Agents</span><span>+</span></div>
				<div className="@@v3code-agents-concept-search">Search V agents</div>
				{['V Build', 'V Research', 'V Review'].map((name, index) => (
					<div key={name} className={`@@v3code-agents-concept-agent${index === 0 ? ' @@v3code-agents-concept-agent--active' : ''}`}>
						<span className="@@v3code-agents-concept-orb">V</span>
						<span><strong>{name}</strong><small>{index === 0 ? 'Working now' : index === 1 ? '2 sources ready' : 'Waiting'}</small></span>
					</div>
				))}
			</div>
			<div className="@@v3code-agents-concept-chat">
				<div className="@@v3code-agents-concept-chat-head"><span className="@@v3code-agents-concept-orb">V</span><span><strong>Launch workspace</strong><small>V Build coordinating the team</small></span></div>
				<div className="@@v3code-agents-concept-thread">
					<div className="@@v3code-agents-concept-user">Turn the launch plan into a working release.</div>
					<div className="@@v3code-agents-concept-reply"><strong>V Build</strong><span>Research is checking the market while Review verifies the release. I'll bring back one clean result.</span></div>
				</div>
				<div className="@@v3code-agents-concept-composer">Message your V team… <span>↑</span></div>
			</div>
			<div className="@@v3code-agents-concept-work">
				<div className="@@v3code-agents-concept-work-title">Live work <span>3</span></div>
				<div className="@@v3code-agents-concept-task"><span className="@@v3code-agents-concept-task-dot" />Researching competitors<small>V Research · running</small></div>
				<div className="@@v3code-agents-concept-task"><span className="@@v3code-agents-concept-task-dot" />Building release<small>V Build · 4 files</small></div>
				<div className="@@v3code-agents-concept-task @@v3code-agents-concept-task--approval"><span>✓</span>Ready for approval<small>V Review · verified</small></div>
			</div>
		</div>
	</figure>
);

/** Keeps both existing feedback routes visible from one permanent Settings destination. */
export const FeedbackTab = () => {
	const commandService = useAccessor().get('ICommandService');
	const run = useCallback((commandId: string) => {
		void commandService.executeCommand(commandId);
	}, [commandService]);
	const sendFeedback = useCallback(() => run('v3code.sendFeedback'), [run]);
	const reportIssue = useCallback(() => run('v3code.reportIssue'), [run]);
	const [vote, setVote] = useState<'yes' | 'no' | null>(null);
	const [voteBusy, setVoteBusy] = useState(false);
	const [statusBoard, setStatusBoard] = useState<IV3CodeStatusBoard>({ state: 'loading', updates: [] });
	const [statusBusy, setStatusBusy] = useState(false);

	const refreshStatus = useCallback(async () => {
		setStatusBusy(true);
		try {
			const result = await commandService.executeCommand<IV3CodeStatusBoard>('v3code.getStatusBoard');
			setStatusBoard(result ?? { state: 'unavailable', checkedAt: Date.now(), updates: [] });
		} finally {
			setStatusBusy(false);
		}
	}, [commandService]);

	useEffect(() => {
		void refreshStatus();
		const timer = window.setInterval(() => void refreshStatus(), 5 * 60 * 1000);
		return () => window.clearInterval(timer);
	}, [refreshStatus]);

	const submitAgentsVote = useCallback(async (choice: 'yes' | 'no') => {
		if (voteBusy) { return; }
		setVoteBusy(true);
		try {
			const sent = await commandService.executeCommand<boolean>('v3code.voteAgentsBeta', choice);
			if (sent) { setVote(choice); }
		} finally {
			setVoteBusy(false);
		}
	}, [commandService, voteBusy]);

	return (
		<>
			<SettingsSection label="Status & updates">
				<SettingsCard>
					<div className="@@v3code-status-board" data-setting-id="feedback.status" aria-live="polite">
						<div className="@@v3code-status-board-head">
							<div>
								<span className={`@@v3code-status-board-dot @@v3code-status-board-dot--${statusBoard.state}`} />
								<strong>Live from Daniel & V3Code</strong>
								<p>Service notices, feature news, workarounds, and important messages appear here without an app update.</p>
							</div>
							<VoidButtonBgDarken className="px-3 py-1 text-xs" disabled={statusBusy} onClick={() => void refreshStatus()}>
								{statusBusy ? 'Checking…' : 'Refresh'}
							</VoidButtonBgDarken>
						</div>
						{statusBoard.state === 'loading' && <p className="@@v3code-status-board-empty">Checking for live updates…</p>}
						{statusBoard.state === 'unavailable' && (
							<p className="@@v3code-status-board-empty">The live board cannot be reached right now. V3Code will keep working normally; try Refresh again later.</p>
						)}
						{statusBoard.state === 'ready' && statusBoard.updates.length === 0 && (
							<p className="@@v3code-status-board-empty">All clear. There are no active notices right now.</p>
						)}
						{statusBoard.updates.map(update => (
							<article key={update.id} className={`@@v3code-status-update @@v3code-status-update--${update.severity ?? 'info'}`}>
								<div className="@@v3code-status-update-copy">
									<span>{update.sender?.trim() || 'Daniel — V3Code'}</span>
									{update.title && <strong>{update.title}</strong>}
									<p>{update.body}</p>
								</div>
								{!!update.actions?.length && (
									<div className="@@v3code-status-update-actions">
										{update.actions.map(action => (
											<button key={action.href} type="button" onClick={() => void commandService.executeCommand('v3code.openStatusUpdate', action.href)}>
												{action.label}
											</button>
										))}
									</div>
								)}
							</article>
						))}
					</div>
				</SettingsCard>
			</SettingsSection>
			<div className="@@v3code-feedback-callout" role="note">
				<p className="@@v3code-feedback-callout-title">We need your feedback.</p>
				<p className="@@v3code-feedback-callout-copy">
					V3Code is built from what users tell us. A short note about what works, what is confusing, or what broke helps Daniel and the team fix the right things first.
				</p>
			</div>
			<SettingsSection label="Agents beta vote">
				<SettingsCard>
					<AgentsConceptPreview />
					<CardDivider />
					<SettingRow
						settingId="feedback.agentsVote"
						title="Would you rather have this?"
						description="The old beta panel was buggy and confusing, so it is not shipping. This is the direction we could build instead: a real V3Code agent system where V agents coordinate in one workspace. Vote Yes for this redesigned experience, or No to keep the editor focused on Chat."
						control={
							<div className="flex items-center gap-2" role="group" aria-label="Vote on a redesigned Agents experience">
								<button
									type="button"
									className="px-3 py-1 text-xs bg-black/10 dark:bg-white/10 rounded-sm whitespace-nowrap"
									disabled={voteBusy}
									aria-pressed={vote === 'yes'}
									onClick={() => void submitAgentsVote('yes')}
								>
									{vote === 'yes' ? 'Yes ✓' : 'Yes'}
								</button>
								<button
									type="button"
									className="px-3 py-1 text-xs bg-black/10 dark:bg-white/10 rounded-sm whitespace-nowrap"
									disabled={voteBusy}
									aria-pressed={vote === 'no'}
									onClick={() => void submitAgentsVote('no')}
								>
									{vote === 'no' ? 'No ✓' : 'No'}
								</button>
							</div>
						}
					/>
				</SettingsCard>
			</SettingsSection>
			<SettingsSection label="Talk directly to V3Code">
				<SettingsCard>
					<SettingRow
						settingId="feedback.send"
						title="Share feedback"
						description="Ideas, rough edges, missing features, or anything you want us to know."
						control={
							<VoidButtonBgDarken className="px-3 py-1 text-xs" onClick={sendFeedback}>
								Send Feedback
							</VoidButtonBgDarken>
						}
					/>
					<CardDivider />
					<SettingRow
						settingId="feedback.report"
						title="Report an issue"
						description="Tell us about a bug, crash, slowdown, broken tool, or visual problem."
						control={
							<VoidButtonBgDarken className="px-3 py-1 text-xs" onClick={reportIssue}>
								Report an Issue
							</VoidButtonBgDarken>
						}
					/>
				</SettingsCard>
			</SettingsSection>
		</>
	);
};
