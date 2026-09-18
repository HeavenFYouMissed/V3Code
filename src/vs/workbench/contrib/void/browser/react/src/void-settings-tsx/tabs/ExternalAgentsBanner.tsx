/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import React from 'react';
import { externalAgentMarkUrls, v3ChromeAvatarUrl } from '../settingsExternals.js';

const positions = [{ x: 22, y: 38 }, { x: 78, y: 38 }, { x: 50, y: 82 }];

/** A static capability illustration, not a connection-status indicator. */
export const ExternalAgentsBanner = () => {
	const marks = externalAgentMarkUrls();
	return <section className='rounded-2xl border border-void-border-2 overflow-hidden' aria-label='Your agents inside V3Code'>
		<div className='px-6 pt-5 flex items-center justify-between gap-3'>
			<div><div className='text-lg font-medium'>Your agents. Your editor.</div><div className='text-xs text-void-fg-3 mt-1'>Native chat. Connected context. A browser you can watch.</div></div>
			<span className='text-[10px] tracking-widest text-void-fg-3 border border-void-border-2 rounded-full px-3 py-1'>ACP</span>
		</div>
		<div className='relative h-[250px]' aria-hidden='true'>
			<svg viewBox='0 0 100 100' preserveAspectRatio='none' className='absolute inset-0 w-full h-full'>
				<ellipse cx='50' cy='50' rx='28' ry='32' fill='none' stroke='var(--vscode-editorWidget-border)' strokeDasharray='1 2' strokeWidth='.3' />
				{positions.map(({ x, y }) => <path key={x} d={`M 50 43 Q 50 ${y} ${x} ${y}`} fill='none' stroke='var(--vscode-focusBorder)' strokeOpacity='.4' strokeWidth='.25' />)}
			</svg>
			<div className='absolute flex flex-col items-center gap-2' style={{ left: '50%', top: '43%', transform: 'translate(-50%, -50%)' }}>
				<img src={v3ChromeAvatarUrl()} width={80} height={80} alt='' className='rounded-full shadow-xl' />
				<span className='text-[10px] tracking-widest text-void-fg-2'>V3CODE</span>
			</div>
			{positions.map(({ x, y }, index) => <div key={x} className='absolute w-14 h-14 rounded-2xl border border-void-border-2 bg-void-bg-1 flex items-center justify-center shadow-lg' style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}>
				<img src={marks[index]} alt='' width={28} height={28} className='dark:invert' />
			</div>)}
		</div>
		<div className='px-6 py-3 border-t border-void-border-2 text-xs text-void-fg-3'>Choose an agent below. Connect Memory / Index and Browser per agent.</div>
	</section>;
};
