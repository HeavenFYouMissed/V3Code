/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * In-page visual layer for browser sharing and agent-driven browser automation.
 * Sharing keeps a quiet viewport ring mounted. Active automation upgrades that same
 * ring with the phantom cursor, status badge, and "Stop agent" pill.
 *
 * Plain-JS strings only — never imported as runtime code in the page.
 */

export const AGENT_VIS_DRAIN_SCRIPT = `(function(){var q=window.__v3codeAgentVisOut||[];window.__v3codeAgentVisOut=[];return q.length?JSON.stringify(q):null;})()`;

export const AGENT_VIS_TEARDOWN_SCRIPT = `(function(){if(window.__v3codeAgentVis&&window.__v3codeAgentVis.teardown){window.__v3codeAgentVis.teardown();}})()`;

export const AGENT_VIS_BEGIN_ACTIVITY_SCRIPT = `(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.setActive(true);}})()`;

export const AGENT_VIS_END_ACTIVITY_SCRIPT = `(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.setActive(false);}})()`;

export const AGENT_VIS_INJECT_SCRIPT = `(function () {
	if (window.__v3codeAgentVis && window.__v3codeAgentVis.mount) {
		window.__v3codeAgentVis.mount();
		return 'v3av-rearmed';
	}
	if (!document.body) {
		return 'v3av-no-body';
	}

	window.__v3codeAgentVisOut = window.__v3codeAgentVisOut || [];
	var ACCENT = '#7c3aed';
	var CURSOR_MS = 180;
	var CURSOR_EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)';
	var reducedMotion = false;
	try {
		reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch (e) {}

	var state = {
		active: false,
		shared: false,
		shadow: null,
		host: null,
		cursor: null,
		glow: null,
		bar: null,
		badge: null,
		hidden: false,
		onStopBound: null
	};

	function pushOut(obj) {
		try {
			window.__v3codeAgentVisOut.push(JSON.stringify(obj));
		} catch (e) {}
	}

	function detach() {
		if (state.onStopBound) {
			window.removeEventListener('beforeunload', state.onStopBound);
			state.onStopBound = null;
		}
		if (state.host && state.host.parentElement) {
			state.host.parentElement.removeChild(state.host);
		}
		state.shadow = null;
		state.host = null;
		state.cursor = null;
		state.glow = null;
		state.bar = null;
		state.badge = null;
		state.hidden = false;
	}

	function syncPresentation() {
		if (!state.active && !state.shared) {
			detach();
			return;
		}
		if (!state.shadow) {
			mount();
			return;
		}

		var activeDisplay = state.active ? '' : 'none';
		state.cursor.style.display = activeDisplay;
		state.badge.style.display = activeDisplay;
		state.bar.style.display = state.active ? 'flex' : 'none';

		if (state.active) {
			state.glow.style.border = '3px solid rgba(124,58,237,.6)';
			state.glow.style.boxShadow = 'inset 0 0 40px rgba(124,58,237,.08),0 0 20px rgba(124,58,237,.15)';
			state.glow.style.animation = reducedMotion ? '' : 'v3av-glow-pulse 2.5s ease-in-out infinite';
		} else {
			state.glow.style.border = '2px solid rgba(124,58,237,.72)';
			state.glow.style.boxShadow = 'inset 0 0 24px rgba(124,58,237,.05)';
			state.glow.style.animation = '';
		}
	}

	function mount() {
		if (state.shadow) {
			syncPresentation();
			return;
		}
		if (!state.active && !state.shared) {
			return;
		}

		var host = document.createElement('div');
		host.id = 'v3code-agent-vis-host';
		host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
		document.body.appendChild(host);
		state.host = host;

		var shadow = host.attachShadow({ mode: 'closed' });
		state.shadow = shadow;
		var reset = document.createElement('style');
		reset.textContent = ':host{all:initial;} *{box-sizing:border-box;}';
		shadow.appendChild(reset);
		var anim = document.createElement('style');
		anim.textContent = '@keyframes v3av-glow-pulse{0%,100%{opacity:.5;}50%{opacity:1;}}' +
			'@keyframes v3av-dot-pulse{0%,100%{opacity:1;}50%{opacity:.5;}}';
		shadow.appendChild(anim);

		var svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svgLayer.setAttribute('width', '0');
		svgLayer.setAttribute('height', '0');
		shadow.appendChild(svgLayer);
		var cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		cursor.setAttribute('width', '32');
		cursor.setAttribute('height', '32');
		cursor.setAttribute('viewBox', '0 0 32 32');
		cursor.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;transform:translate(-16px,-16px);' +
			(reducedMotion ? '' : ('transition:transform ' + CURSOR_MS + 'ms ' + CURSOR_EASE + ';'));
		var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		ring.setAttribute('cx', '16');
		ring.setAttribute('cy', '16');
		ring.setAttribute('r', '12');
		ring.setAttribute('fill', 'none');
		ring.setAttribute('stroke', ACCENT);
		ring.setAttribute('stroke-width', '2.5');
		cursor.appendChild(ring);
		var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		dot.setAttribute('cx', '16');
		dot.setAttribute('cy', '16');
		dot.setAttribute('r', '4');
		dot.setAttribute('fill', ACCENT);
		cursor.appendChild(dot);
		svgLayer.appendChild(cursor);
		state.cursor = cursor;

		var glow = document.createElement('div');
		glow.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
		shadow.appendChild(glow);
		state.glow = glow;

		var badge = document.createElement('div');
		badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(15,15,20,.95);' +
			'border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:4px 10px;font:11px -apple-system,BlinkMacSystemFont,sans-serif;' +
			'color:rgba(255,255,255,.7);display:flex;align-items:center;gap:6px;pointer-events:none;user-select:none;';
		var badgeDot = document.createElement('span');
		badgeDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:' + ACCENT + ';box-shadow:0 0 6px rgba(124,58,237,.5);';
		badge.appendChild(badgeDot);
		var badgeText = document.createElement('span');
		badgeText.textContent = 'V3Code agent active';
		badge.appendChild(badgeText);
		shadow.appendChild(badge);
		state.badge = badge;

		var bar = document.createElement('div');
		bar.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:8px;' +
			'background:rgba(15,15,20,.97);border:1px solid rgba(255,255,255,.1);border-radius:28px;padding:6px 16px;' +
			'font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:rgba(255,255,255,.85);box-shadow:0 4px 24px rgba(0,0,0,.4);';
		var statusDot = document.createElement('span');
		statusDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.6);' +
			(reducedMotion ? '' : 'animation:v3av-dot-pulse 2s ease-in-out infinite;');
		bar.appendChild(statusDot);
		var statusLabel = document.createElement('span');
		statusLabel.className = 'v3av-status';
		statusLabel.textContent = 'V3Code agent active';
		bar.appendChild(statusLabel);
		var sep = document.createElement('span');
		sep.style.cssText = 'width:1px;height:16px;background:rgba(255,255,255,.15);margin:0 4px;';
		bar.appendChild(sep);
		var stopBtn = document.createElement('button');
		stopBtn.type = 'button';
		stopBtn.textContent = 'Stop agent';
		stopBtn.style.cssText = 'background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#ef4444;padding:4px 12px;border-radius:16px;' +
			'cursor:pointer;pointer-events:auto;font:inherit;font-size:12px;font-weight:500;user-select:none;';
		stopBtn.addEventListener('click', function (e) {
			e.stopPropagation();
			pushOut({ type: 'stop' });
		});
		bar.appendChild(stopBtn);
		shadow.appendChild(bar);
		state.bar = bar;

		state.onStopBound = function () { detach(); };
		window.addEventListener('beforeunload', state.onStopBound);
		state.hidden = false;
		syncPresentation();
	}

	function setActive(active) {
		state.active = !!active;
		mount();
		syncPresentation();
	}

	function setShared(shared) {
		state.shared = !!shared;
		mount();
		syncPresentation();
	}

	function teardown() {
		state.active = false;
		state.shared = false;
		detach();
	}

	function moveCursor(x, y, label) {
		if (!state.active || !state.cursor || state.hidden) {
			return;
		}
		state.cursor.style.transform = 'translate(' + (x - 16) + 'px,' + (y - 16) + 'px)';
		if (label && state.bar) {
			var el = state.bar.querySelector('.v3av-status');
			if (el) {
				el.textContent = String(label);
			}
		}
	}

	function setStatus(text) {
		if (!state.active || !state.bar || state.hidden) {
			return;
		}
		var el = state.bar.querySelector('.v3av-status');
		if (el) {
			el.textContent = String(text);
		}
	}

	function hideForToolUse() {
		state.hidden = true;
		if (state.host) {
			state.host.style.display = 'none';
		}
	}

	function showAfterToolUse() {
		state.hidden = false;
		if (state.host) {
			state.host.style.display = '';
		}
	}

	function setGlow(on) {
		if (state.glow) {
			state.glow.style.opacity = on ? '1' : '0';
		}
	}

	window.__v3codeAgentVis = {
		mount: mount,
		teardown: teardown,
		setActive: setActive,
		setShared: setShared,
		moveCursor: moveCursor,
		setStatus: setStatus,
		hideForToolUse: hideForToolUse,
		showAfterToolUse: showAfterToolUse,
		setGlow: setGlow,
		get hidden() { return state.hidden; }
	};
	return 'v3av-ready';
})()`;

export const buildAgentVisSharedScript = (shared: boolean): string =>
	`(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.setShared(${shared});}})()`;

/** Move phantom cursor; optional status label shown in the control bar. */
export const buildAgentVisMoveScript = (x: number, y: number, label?: string): string => {
	const lx = Math.round(x);
	const ly = Math.round(y);
	const lab = label === undefined ? 'null' : JSON.stringify(label);
	return `(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.moveCursor(${lx},${ly},${lab});}})()`;
};

export const AGENT_VIS_HIDE_SCRIPT = `(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.hideForToolUse();}})()`;

export const AGENT_VIS_SHOW_SCRIPT = `(function(){if(window.__v3codeAgentVis){window.__v3codeAgentVis.showAfterToolUse();}})()`;

export const AGENT_VIS_OVERLAY_HIDDEN_CHECK_SCRIPT = `(function(){if(!window.__v3codeAgentVis){return true;}if(!window.__v3codeAgentVis.hidden){return false;}var h=document.getElementById('v3code-agent-vis-host');if(!h){return true;}return h.style.display==='none';})()`;
