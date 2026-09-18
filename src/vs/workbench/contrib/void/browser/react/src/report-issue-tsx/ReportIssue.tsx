/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Report Issue / Feedback modal (ship-prep Component 4).
 *
 * Rendered into a workbench-owned overlay container by v3ReportIssue.ts. All
 * side effects (opening mailto, opening GitHub, closing) come in as callbacks so
 * this component stays pure React. Submit composes a prefilled mailto URL —
 * attachments are impossible over mailto, so the form says to attach files in
 * the mail client instead.
 */

import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useIsDark } from '../util/services.js';
import '../styles.css';

export type ReportIssueMode = 'issue' | 'feedback';

export type ReportIssueProps = {
	mode: ReportIssueMode;
	version: string;
	osName: string;
	onClose: () => void;
	onSubmitMailto: (mailtoUrl: string) => void;
	onOpenGitHub: () => void;
	/** True when a hub account is signed in — feedback POSTs to the admin inbox instead of mailto. */
	isSignedIn?: boolean;
	/** POST the feedback to the hub inbox; resolves true when it landed. */
	onSubmitApi?: (payload: { category?: string; severity?: string; message: string; context?: Record<string, unknown> }) => Promise<boolean>;
};

const CONTACT_EMAIL = 'daniel@publishd.app';
const DESCRIPTION_MAX = 1000;

const issueTypes = ['Bug', 'Crash', 'Performance', 'UI / Visual', 'Other'] as const;
type IssueType = typeof issueTypes[number];

const categories = ['Chat / Agent', 'Editor', 'Autocomplete', 'Terminal', 'Settings', 'Indexing', 'Other'] as const;
type Category = typeof categories[number];

const CheckRow = ({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) => (
	<label className='flex items-center gap-2 cursor-pointer text-void-fg-2 text-xs py-0.5 select-none'>
		<input
			type='checkbox'
			checked={checked}
			onChange={onToggle}
			className='accent-[#8B5CF6] cursor-pointer'
		/>
		<span>{label}</span>
	</label>
);

export const ReportIssue = ({ mode, version, osName, onClose, onSubmitMailto, onOpenGitHub, isSignedIn, onSubmitApi }: ReportIssueProps) => {
	const isDark = useIsDark();

	const [issueType, setIssueType] = useState<IssueType>('Bug');
	const [selectedCategories, setSelectedCategories] = useState<Set<Category>>(new Set());
	const [description, setDescription] = useState('');
	const [email, setEmail] = useState('');
	const [includeVersion, setIncludeVersion] = useState(true);
	const [includeOS, setIncludeOS] = useState(true);

	const isIssue = mode === 'issue';
	const title = isIssue ? 'Report an Issue' : 'Send Feedback';
	const canSubmit = description.trim().length > 0;

	const toggleCategory = (c: Category) => {
		setSelectedCategories(prev => {
			const next = new Set(prev);
			if (next.has(c)) { next.delete(c); } else { next.add(c); }
			return next;
		});
	};

	const mailtoUrl = useMemo(() => {
		const subject = isIssue
			? `V3Code Issue Report — ${issueType}`
			: 'V3Code Feedback';

		const lines: string[] = [];
		if (isIssue) {
			lines.push(`Issue type: ${issueType}`);
			if (selectedCategories.size > 0) {
				lines.push(`Areas: ${[...selectedCategories].join(', ')}`);
			}
			lines.push('');
			lines.push('Description:');
		} else {
			lines.push('Feedback:');
		}
		lines.push(description.trim());
		lines.push('');
		if (email.trim()) {
			lines.push(`Contact email: ${email.trim()}`);
		}
		const sysInfo: string[] = [];
		if (includeVersion) { sysInfo.push(`V3Code version: ${version}`); }
		if (includeOS) { sysInfo.push(`OS: ${osName}`); }
		if (sysInfo.length > 0) {
			lines.push('---');
			lines.push(...sysInfo);
		}

		return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
	}, [isIssue, issueType, selectedCategories, description, email, includeVersion, includeOS, version, osName]);

	// Payload for the hub inbox (POST /api/feedback). Maps the form's issue type onto the API's
	// category enum; the finer areas + system info ride in context.
	const apiPayload = useMemo(() => ({
		category: !isIssue ? 'feature'
			: issueType === 'Performance' ? 'performance'
				: issueType === 'UI / Visual' ? 'ux'
					: (issueType === 'Bug' || issueType === 'Crash') ? 'bug'
						: 'other',
		severity: issueType === 'Crash' ? 'high' : 'low',
		message: description.trim(),
		context: {
			mode,
			issueType,
			areas: [...selectedCategories],
			contactEmail: email.trim() || undefined,
			version: includeVersion ? version : undefined,
			os: includeOS ? osName : undefined,
		},
	}), [isIssue, issueType, selectedCategories, description, email, includeVersion, includeOS, version, osName, mode]);

	// Signed-in: POST to the admin inbox; on failure or guest, fall back to the mailto draft.
	const handleSubmit = async () => {
		if (isSignedIn && onSubmitApi) {
			const ok = await onSubmitApi(apiPayload);
			if (ok) { onClose(); return; }
		}
		onSubmitMailto(mailtoUrl);
		onClose();
	};

	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
			<div
				className='fixed inset-0 z-[2500] flex items-center justify-center bg-black/50'
				onMouseDown={e => { if (e.target === e.currentTarget) { onClose(); } }}
			>
				<div className='bg-void-bg-2 text-void-fg-1 border border-void-border-1 rounded-lg shadow-2xl w-[480px] max-w-[90vw] max-h-[85vh] overflow-y-auto p-5 flex flex-col gap-4'>

					{/* Header */}
					<div className='flex items-center justify-between'>
						<h2 className='text-sm font-semibold m-0'>{title}</h2>
						<button className='text-void-fg-3 hover:text-void-fg-1 bg-transparent border-none cursor-pointer p-1' onClick={onClose} aria-label='Close'>
							<X size={16} />
						</button>
					</div>

					{/* Issue type */}
					{isIssue ? (
						<div className='flex flex-col gap-1.5'>
							<label className='text-xs text-void-fg-3 font-medium'>Issue type</label>
							<div className='flex flex-wrap gap-1.5'>
								{issueTypes.map(t => (
									<button
										key={t}
										onClick={() => setIssueType(t)}
										className={`text-xs px-2.5 py-1 rounded-full border cursor-pointer transition-colors
											${issueType === t
												? 'bg-[#8B5CF6]/20 border-[#8B5CF6]/60 text-void-fg-1'
												: 'bg-void-bg-1 border-void-border-2 text-void-fg-3 hover:text-void-fg-1'}`}
									>
										{t}
									</button>
								))}
							</div>
						</div>
					) : null}

					{/* Categories */}
					{isIssue ? (
						<div className='flex flex-col gap-1.5'>
							<label className='text-xs text-void-fg-3 font-medium'>Which areas are affected? (optional)</label>
							<div className='grid grid-cols-2 gap-x-3'>
								{categories.map(c => (
									<CheckRow key={c} label={c} checked={selectedCategories.has(c)} onToggle={() => toggleCategory(c)} />
								))}
							</div>
						</div>
					) : null}

					{/* Description */}
					<div className='flex flex-col gap-1.5'>
						<label className='text-xs text-void-fg-3 font-medium'>
							{isIssue ? 'Describe the issue' : 'Your feedback'}
						</label>
						<textarea
							value={description}
							onChange={e => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
							placeholder={isIssue
								? 'What happened? What did you expect to happen?'
								: 'What should we improve? What do you love?'}
							rows={5}
							className='w-full resize-none bg-void-bg-1 text-void-fg-1 placeholder:text-void-fg-3 border border-void-border-2 focus:border-void-border-1 rounded py-2 px-3 text-xs outline-none'
						/>
						<div className='text-[10px] text-void-fg-3 text-right'>{description.length}/{DESCRIPTION_MAX}</div>
					</div>

					{/* Email */}
					<div className='flex flex-col gap-1.5'>
						<label className='text-xs text-void-fg-3 font-medium'>Contact email (optional)</label>
						<input
							value={email}
							onChange={e => setEmail(e.target.value)}
							placeholder='you@example.com'
							className='w-full bg-void-bg-1 text-void-fg-1 placeholder:text-void-fg-3 border border-void-border-2 focus:border-void-border-1 rounded py-1.5 px-3 text-xs outline-none'
						/>
					</div>

					{/* System info */}
					<div className='flex flex-col gap-1'>
						<label className='text-xs text-void-fg-3 font-medium'>Include system info</label>
						<CheckRow label={`V3Code version (${version})`} checked={includeVersion} onToggle={() => setIncludeVersion(v => !v)} />
						<CheckRow label={`Operating system (${osName})`} checked={includeOS} onToggle={() => setIncludeOS(v => !v)} />
					</div>

					{/* Attachments note */}
					<p className='text-[11px] text-void-fg-3 m-0'>
						Need to attach screenshots or logs? Submit opens your mail client — attach files there before sending.
					</p>

					{/* Footer */}
					<div className='flex items-center justify-between pt-1'>
						{isIssue ? (
							<button
								onClick={onOpenGitHub}
								className='text-[11px] text-void-fg-3 hover:text-void-fg-1 underline bg-transparent border-none cursor-pointer p-0'
							>
								Open a GitHub issue instead
							</button>
						) : <span />}
						<div className='flex items-center gap-2'>
							<button
								onClick={onClose}
								className='text-xs px-3 py-1.5 rounded border border-void-border-2 bg-void-bg-1 text-void-fg-2 hover:text-void-fg-1 cursor-pointer'
							>
								Cancel
							</button>
							<button
								disabled={!canSubmit}
								onClick={handleSubmit}
								className={`text-xs px-3 py-1.5 rounded border cursor-pointer transition-colors
									${canSubmit
										? 'bg-[#8B5CF6] border-[#8B5CF6] text-white hover:bg-[#7C3AED]'
										: 'bg-void-bg-1 border-void-border-2 text-void-fg-3 cursor-not-allowed'}`}
							>
								{isIssue ? 'Submit Report' : 'Send Feedback'}
							</button>
						</div>
					</div>

				</div>
			</div>
		</div>
	);
};
