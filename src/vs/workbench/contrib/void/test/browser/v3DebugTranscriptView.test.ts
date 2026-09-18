/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDebugSessionService } from '../../browser/debugSessionService.js';
import { isV3DebugResponse } from '../../browser/v3DebugResponse.js';
import { removeV3DebugLiveStatus, updateV3DebugLiveStatus, V3_DEBUG_LIVE_STATUS_CLASS, V3DebugEvidencePanel } from '../../browser/v3DebugTranscriptView.js';
import { V3CODE_TOOL_ID_PREFIX } from '../../browser/v3codeToolIds.js';
import { parseEvidenceLine, V3DebugEvidenceLine, V3DebugSessionState } from '../../common/debugSessionTypes.js';
import { V3_NATIVE_TOOL_ID_PREFIX } from '../../common/v3DebugTranscript.js';

/**
 * Stand-in for the real service. It deliberately exposes `onDidChange` as a plain function
 * returning `Disposable.None` rather than an `Emitter`: the panel only ever subscribes, and a
 * real Emitter here would be tracked by the leak checker for no benefit.
 */
function fakeDebugSession(state: V3DebugSessionState, lines: readonly V3DebugEvidenceLine[] = [], onRead?: () => void): IDebugSessionService {
	const fake = {
		_serviceBrand: undefined,
		onDidChange: () => Disposable.None,
		getState: () => state,
		start: async () => true,
		stop: async () => undefined,
		markRunBoundary: async () => undefined,
		read: async () => {
			onRead?.();
			return { lines, lineCount: lines.length, runMark: state.runMark };
		},
		clear: async () => undefined,
	};
	return fake as unknown as IDebugSessionService;
}

const clipboardStub = { writeText: async () => undefined } as unknown as never;
const openerStub = { open: async () => false } as unknown as never;

suite('V3Code Debug transcript view', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the common helper mirrors the native tool id prefix', () => {
		assert.strictEqual(V3_NATIVE_TOOL_ID_PREFIX, V3CODE_TOOL_ID_PREFIX);
	});

	test('Debug responses are recognised from the persisted request mode name only', () => {
		assert.strictEqual(isV3DebugResponse({ model: { request: { modeInfo: { modeName: 'debug' } } } }), true);
		assert.strictEqual(isV3DebugResponse({ model: { request: { modeInfo: { modeName: 'Debug' } } } }), true);
		assert.strictEqual(isV3DebugResponse({ model: { request: { modeInfo: { modeName: 'agent' } } } }), false);
		assert.strictEqual(isV3DebugResponse({ model: { request: { modeInfo: { kind: 'agent' } } } }), false);
		assert.strictEqual(isV3DebugResponse({ model: {} }), false);
		assert.strictEqual(isV3DebugResponse(undefined), false);
	});

	test('one polite, atomic live status region per response, always last', () => {
		const container = document.createElement('div');
		const first = document.createElement('div');
		container.appendChild(first);

		const status = updateV3DebugLiveStatus(container, undefined, 'Running 2 operations', true);
		assert.strictEqual(status.className, V3_DEBUG_LIVE_STATUS_CLASS + ' v3-sheen');
		assert.strictEqual(status.getAttribute('aria-live'), 'polite');
		assert.strictEqual(status.getAttribute('aria-atomic'), 'true');
		assert.strictEqual(status.textContent, 'Running 2 operations');
		assert.strictEqual(container.lastElementChild, status);

		// A later part appended after it: the next update moves it back to the end, same node.
		container.appendChild(document.createElement('div'));
		const same = updateV3DebugLiveStatus(container, status, 'Running 1 operation · 1 operation awaiting your approval', true);
		assert.strictEqual(same, status);
		assert.strictEqual(container.lastElementChild, status);
		assert.strictEqual(container.querySelectorAll('.' + V3_DEBUG_LIVE_STATUS_CLASS).length, 1);

		// The sheen is a claim about the machine, so it must STOP when the only thing in flight
		// is the user being asked something. The previous `text.length > 0` check animated an
		// "awaiting your answer" prompt exactly when nothing was running — the lie this
		// `active` parameter exists to prevent.
		updateV3DebugLiveStatus(container, status, 'Waiting for your answer', false);
		assert.strictEqual(status.textContent, 'Waiting for your answer');
		assert.strictEqual(status.classList.contains('v3-sheen'), false, 'no shimmer while nothing is running');

		// Same text, but work IS happening: the sheen comes back.
		updateV3DebugLiveStatus(container, status, 'Running 1 operation', true);
		assert.strictEqual(status.classList.contains('v3-sheen'), true, 'shimmer while work is running');

		// Idle: text cleared, sheen off, node kept (so the next announcement still fires).
		updateV3DebugLiveStatus(container, status, '', false);
		assert.strictEqual(status.textContent, '');
		assert.strictEqual(status.classList.contains('v3-sheen'), false);

		// Finished: removed.
		assert.strictEqual(removeV3DebugLiveStatus(status), undefined);
		assert.strictEqual(container.querySelector('.' + V3_DEBUG_LIVE_STATUS_CLASS), null);
	});

	test('the evidence panel renders the sink tail and marks the run boundary', async () => {
		const container = document.createElement('div');
		// runMark=1: line 0 belongs to the previous run, line 1 to the current one. Without a
		// mark every line counts as current, which is the case this test exists to distinguish.
		const lines = [
			parseEvidenceLine('{"message":"previous run: entered login()"}', 0, 1),
			parseEvidenceLine('{"message":"token was null","location":"auth.ts:91","hypothesisId":"H1","data":{"token":null}}', 1, 1),
		];
		const session = fakeDebugSession(
			{ phase: 'running', runMark: 1, lineCount: 2, config: { sessionId: 'abc123', endpoint: 'http://127.0.0.1:7642/ingest/abc123', logPath: '/w/.v3code/debug-abc123.log', configPath: '/w/.v3code/c.json', port: 7642, workspaceRoot: '/w', startedAt: 0 } },
			lines,
		);
		let heightChanges = 0;
		const panel = new V3DebugEvidencePanel(container, () => false, () => heightChanges++, session, clipboardStub, openerStub);

		await panel.refreshNow();

		const root = container.querySelector('.v3-debug-evidence') as HTMLElement;
		assert.ok(root, 'the panel mounts itself into the response');
		assert.strictEqual(root.getAttribute('data-v3-tone'), 'live');
		assert.ok(root.querySelector('.v3-debug-evidence-summary')!.textContent!.includes('127.0.0.1:7642'));
		assert.strictEqual(root.querySelectorAll('.v3-debug-evidence-line').length, 2);
		assert.strictEqual(root.querySelectorAll('.v3-debug-evidence-line.v3-earlier').length, 1, 'the previous run is dimmed, not dropped');
		assert.ok(root.querySelector('.v3-debug-evidence-divider'), 'the run boundary is visible');
		assert.strictEqual(root.querySelector('.v3-debug-evidence-location')!.textContent, 'auth.ts:91');
		assert.strictEqual(root.querySelector('.v3-debug-evidence-hypothesis')!.textContent, 'H1');

		// Identical content must not fire the height listener: the panel polls, and reconcile runs
		// on every streamed diff, so a redundant fire here would relayout the list constantly.
		const afterFirstRender = heightChanges;
		await panel.refreshNow();
		assert.strictEqual(heightChanges, afterFirstRender);

		panel.dispose();
		assert.strictEqual(container.querySelector('.v3-debug-evidence'), null, 'disposal takes the node with it');
	});

	test('with a sink up but nothing recorded, the panel offers the one-line proof instead of an empty box', async () => {
		const container = document.createElement('div');
		const session = fakeDebugSession({ phase: 'running', runMark: 0, lineCount: 0, config: { sessionId: 'abc123', endpoint: 'http://127.0.0.1:7642/ingest/abc123', logPath: '/w/.v3code/debug-abc123.log', configPath: '/w/.v3code/c.json', port: 7642, workspaceRoot: '/w', startedAt: 0 } });
		const panel = new V3DebugEvidencePanel(container, () => false, () => undefined, session, clipboardStub, openerStub);

		await panel.refreshNow();

		const root = container.querySelector('.v3-debug-evidence') as HTMLElement;
		assert.strictEqual(root.getAttribute('data-v3-tone'), 'waiting');
		assert.strictEqual(root.querySelector('.v3-debug-evidence-badge')!.textContent, 'Waiting');
		const actions = root.querySelectorAll('button.v3-debug-evidence-action');
		assert.strictEqual((actions[0] as HTMLButtonElement).hidden, false, 'the instrument line is offered');
		// There is no file yet — the sink creates it on first write — so there is nothing to open.
		assert.strictEqual((actions[1] as HTMLButtonElement).hidden, true);
		assert.strictEqual((actions[2] as HTMLButtonElement).hidden, true, 'nothing to clear');
		panel.dispose();
	});

	test('an unavailable sink is reported and offers no instrumentation at all', async () => {
		const container = document.createElement('div');
		let reads = 0;
		const session = fakeDebugSession({ phase: 'unavailable', runMark: 0, lineCount: 0, reason: 'Workspace is not trusted.' }, [], () => reads++);
		const panel = new V3DebugEvidencePanel(container, () => false, () => undefined, session, clipboardStub, openerStub);

		await panel.refreshNow();

		const root = container.querySelector('.v3-debug-evidence') as HTMLElement;
		assert.strictEqual(root.getAttribute('data-v3-tone'), 'off');
		assert.strictEqual(root.querySelector('.v3-debug-evidence-summary')!.textContent, 'Workspace is not trusted.');
		assert.strictEqual(root.querySelectorAll('.v3-debug-evidence-line').length, 0);
		for (const action of Array.from(root.querySelectorAll('button.v3-debug-evidence-action'))) {
			assert.strictEqual((action as HTMLButtonElement).hidden, true, 'no action is offered without a sink');
		}
		assert.strictEqual(reads, 0, 'an off sink is never polled — there is nothing to read');
		panel.dispose();
	});

	test('a sink that is still coming up renders as starting, never as absent', async () => {
		const container = document.createElement('div');
		let reads = 0;
		const session = fakeDebugSession({ phase: 'starting', runMark: 0, lineCount: 0 }, [], () => reads++);
		const panel = new V3DebugEvidencePanel(container, () => false, () => undefined, session, clipboardStub, openerStub);

		await panel.refreshNow();

		const root = container.querySelector('.v3-debug-evidence') as HTMLElement;
		assert.strictEqual(root.getAttribute('data-v3-tone'), 'starting', 'its own tone, not the absent one');
		assert.strictEqual(root.querySelector('.v3-debug-evidence-badge')!.textContent, 'Starting');
		assert.strictEqual(root.querySelector('.v3-debug-evidence-summary')!.textContent!.includes('No runtime-evidence sink is running'), false);
		for (const action of Array.from(root.querySelectorAll('button.v3-debug-evidence-action'))) {
			assert.strictEqual((action as HTMLButtonElement).hidden, true, 'nothing to offer before the sink is listening');
		}
		assert.strictEqual(reads, 0, 'a starting sink is not polled either — there is nothing on disk yet');
		panel.dispose();
	});
});
