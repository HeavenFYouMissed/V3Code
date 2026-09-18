/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import './settings-layout.css';
import { searchSettings, type SettingsSearchHit } from './settingsSearchIndex.js';

export const SectionLabel = ({ children }: { children: React.ReactNode }) => (
	<p className="@@v3code-settings-section-label">{children}</p>
);

export const SettingsCard = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
	<div className={`@@v3code-settings-card ${className}`}>{children}</div>
);

export const CardDivider = () => <div className="@@v3code-settings-divider" role="separator" />;

export const ProviderHeader = ({ children }: { children: React.ReactNode }) => (
	<div className="@@v3code-settings-provider-header">{children}</div>
);

/**
 * A "?" affordance that reveals a longer explanation on demand, so a row can stay
 * one short line without hiding the detail. The panel is anchored to the button's
 * RIGHT edge and grows leftward -- anchoring left pushed wide popups past the
 * window edge where they were unreadable and unclosable.
 */
export const SettingHelp = ({ label, children }: { label: string; children: React.ReactNode }) => {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

	const placePopover = useCallback(() => {
		const button = buttonRef.current;
		const popover = popoverRef.current;
		if (!button || !popover) { return; }

		const viewportMargin = 12;
		const gap = 8;
		const buttonRect = button.getBoundingClientRect();
		const width = Math.max(160, Math.min(480, window.innerWidth - (viewportMargin * 2)));
		const left = Math.min(
			Math.max(viewportMargin, buttonRect.right - width),
			window.innerWidth - viewportMargin - width,
		);
		const roomBelow = Math.max(0, window.innerHeight - buttonRect.bottom - gap - viewportMargin);
		const roomAbove = Math.max(0, buttonRect.top - gap - viewportMargin);
		const openAbove = roomAbove > roomBelow && popover.scrollHeight > roomBelow;
		const maxHeight = Math.max(96, openAbove ? roomAbove : roomBelow);
		const renderedHeight = Math.min(popover.scrollHeight, maxHeight);
		const top = openAbove
			? Math.max(viewportMargin, buttonRect.top - gap - renderedHeight)
			: buttonRect.bottom + gap;

		setPopoverStyle({
			left,
			top,
			width,
			maxHeight,
			visibility: 'visible',
		});
	}, []);

	useLayoutEffect(() => {
		if (!open) {
			setPopoverStyle({ visibility: 'hidden' });
			return;
		}

		placePopover();
		window.addEventListener('resize', placePopover);
		window.addEventListener('scroll', placePopover, true);
		return () => {
			window.removeEventListener('resize', placePopover);
			window.removeEventListener('scroll', placePopover, true);
		};
	}, [open, placePopover]);

	useEffect(() => {
		if (!open) { return; }
		const onDocPointerDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { setOpen(false); }
		};
		// Capture phase: the settings pane stops propagation on some of its own handlers.
		document.addEventListener('mousedown', onDocPointerDown, true);
		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('mousedown', onDocPointerDown, true);
			document.removeEventListener('keydown', onKeyDown, true);
		};
	}, [open]);

	return (
		<span className="@@v3code-settings-help">
			<button
				ref={buttonRef}
				type="button"
				className="@@v3code-settings-help-btn"
				aria-expanded={open}
				aria-label={label}
				title={label}
				onClick={() => setOpen(v => !v)}
			>
				?
			</button>
			{open ? createPortal(
				<div
					ref={popoverRef}
					className="@@v3code-settings-help-pop"
					role="dialog"
					aria-label={label}
					style={popoverStyle}
				>
					{children}
				</div>,
				document.body,
			) : null}
		</span>
	);
};

export const SettingRow = ({
	title,
	description,
	control,
	children,
	compact,
	settingId,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	control?: React.ReactNode;
	children?: React.ReactNode;
	compact?: boolean;
	/** Deep-search target id — must match settingsSearchIndex.ts */
	settingId?: string;
}) => (
	<div
		className={`@@v3code-settings-row${compact ? ' @@v3code-settings-row--compact' : ''}`}
		data-setting-id={settingId}
	>
		<div className="@@v3code-settings-row-body">
			<p className="@@v3code-settings-row-title">{title}</p>
			{description ? <p className="@@v3code-settings-row-desc">{description}</p> : null}
			{children}
		</div>
		{control ? <div className="@@v3code-settings-row-control">{control}</div> : null}
	</div>
);

export const SettingsPageTitle = ({
	title,
	subtitle,
}: {
	title: string;
	subtitle?: React.ReactNode;
}) => (
	<header className="mb-5">
		<h1 className="@@v3code-settings-page-title">{title}</h1>
		{subtitle ? <div className="@@v3code-settings-page-sub">{subtitle}</div> : null}
	</header>
);

export const SettingsTabTitle = ({ children }: { children: React.ReactNode }) => (
	<h2 className="@@v3code-settings-tab-title">{children}</h2>
);

export const SettingsSection = ({
	label,
	children,
}: {
	label?: string;
	children: React.ReactNode;
}) => (
	<section className="@@v3code-settings-section">
		{label ? <SectionLabel>{label}</SectionLabel> : null}
		{children}
	</section>
);

export type NavItem = {
	tab: string;
	label: string;
	icon: LucideIcon;
};

export type NavGroup = {
	items: NavItem[];
};

export const SettingsNavSidebar = ({
	groups,
	selectedTab,
	onSelect,
	onSearchHit,
	header,
}: {
	groups: NavGroup[];
	selectedTab: string;
	onSelect: (tab: string) => void;
	/** Called when user picks a deep-search result */
	onSearchHit?: (hit: SettingsSearchHit) => void;
	header?: React.ReactNode;
}) => {
	const [query, setQuery] = useState('');
	const q = query.trim().toLowerCase();

	const filteredGroups = useMemo(() => {
		if (!q) return groups;
		return groups
			.map(g => ({ items: g.items.filter(i => i.label.toLowerCase().includes(q)) }))
			.filter(g => g.items.length > 0);
	}, [groups, q]);

	const deepHits = useMemo(() => (q.length >= 2 ? searchSettings(q) : []), [q]);

	const showDeep = q.length >= 2 && !!onSearchHit;

	return (
		<aside className="@@v3code-settings-sidebar">
			{header ? <div className="@@v3code-settings-sidebar-header">{header}</div> : null}

			<input
				type="search"
				className="@@v3code-settings-search"
				placeholder="Search settings"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				aria-label="Search settings"
			/>

			{showDeep ? (
				deepHits.length > 0 ? (
					<div className="@@v3code-settings-search-hits" role="listbox" aria-label="Matching settings">
						{deepHits.map(hit => (
							<button
								key={hit.id}
								type="button"
								className="@@v3code-settings-search-hit"
								onClick={() => {
									onSearchHit?.(hit);
									setQuery('');
								}}
							>
								<span className="@@v3code-settings-search-hit-title">{hit.title}</span>
								<span className="@@v3code-settings-search-hit-meta">
									{hit.section ? `${hit.section} · ` : ''}{hit.tab}
								</span>
							</button>
						))}
					</div>
				) : (
					<p className="@@v3code-settings-search-empty">No matching settings</p>
				)
			) : null}

			{!showDeep || filteredGroups.length > 0 ? filteredGroups.map((group, gi) => (
				<div key={gi} className="@@v3code-settings-nav-group">
					{group.items.map(({ tab, label, icon: Icon }) => (
						<button
							key={tab}
							type="button"
							title={label}
							className={`@@v3code-settings-nav-btn${selectedTab === tab ? ' @@v3code-settings-nav-btn--active' : ''}`}
							onClick={() => onSelect(tab)}
						>
							<Icon size={15} strokeWidth={1.75} />
							<span>{label}</span>
						</button>
					))}
				</div>
			)) : null}

			{!showDeep && filteredGroups.length === 0 ? (
				<p className="@@v3code-settings-search-empty">No matching sections</p>
			) : null}
		</aside>
	);
};
