/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The agent-facing computer-use tools.
 *
 * These are registered as native `IToolData`/`IToolImpl` pairs rather than going through V3Code's
 * `v3codeToolAdapters` bridge, because that bridge flattens every parameter to `type: 'string'` and
 * therefore cannot express a coordinate pair, a modifier list, or a click count. The integrated
 * browser tools are native for exactly the same reason.
 *
 * Every tool is a thin, typed shell over {@link IComputerUseService}, which is the only holder of the
 * main-process channel. All policy — consent, per-application approval, tier enforcement, resolving
 * the frontmost window per action, excluding V3Code's own window from captures — lives there. The
 * tools' job is to present a schema the model can hit reliably, and to turn a structured failure into
 * a sentence that tells the model what to do next.
 */

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { classifyComputerUseApp, isSelfApp } from '../../common/computerUseAppTiers.js';
import {
	COMPUTER_USE_DEFAULT_MAX_LONG_EDGE,
	COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS,
	type ComputerUseApp,
	type ComputerUseAxNode,
	type ComputerUseAxTreeParams,
	type ComputerUseAxTreeResult,
	type ComputerUseCaptureResult,
	type ComputerUseClipboardReadResult,
	type ComputerUseCursorResult,
	type ComputerUseOpenApplicationResult,
	type ComputerUseError,
	type ComputerUseMethod,
	type ComputerUseModifier,
	type ComputerUseMouseButton,
	type ComputerUseParamsFor,
	type ComputerUseResultFor,
	type ComputerUseScrollDirection,
	type ComputerUseSettleParams,
	type ComputerUseSettleResult,
	type ComputerUseTarget,
} from '../../common/computerUseTypes.js';
import { COMPUTER_USE_AX_DELTA_MAX_LINES, renderAxDelta } from '../../common/computerUseAxDiff.js';
import { physicalRectToImage, type ComputerUseCoordinateSpace } from '../../common/computerUseCoordinates.js';
import { IComputerUseExclusionStore } from '../../browser/computerUseExclusionStore.js';
import { IComputerUseService, isComputerUseFailure, type ComputerUseAxReading } from '../../browser/computerUseService.js';

/**
 * Reference names used when the user `#`-mentions a computer-use tool in chat.
 *
 * Camel-cased mirrors of the tool ids, matching the convention the integrated browser tools use.
 */
export const ComputerUseChatToolReferenceName = {
	ReadScreen: 'computerReadScreen',
	ReadScreenChanges: 'computerReadScreenChanges',
	Screenshot: 'computerScreenshot',
	Click: 'computerClick',
	Type: 'computerType',
	Key: 'computerKey',
	Scroll: 'computerScroll',
	Cursor: 'computerCursor',
	WaitForStable: 'computerWaitForStable',
	ListApps: 'computerListApps',
	Drag: 'computerDrag',
	Hover: 'computerHover',
	ClipboardRead: 'computerClipboardRead',
	ClipboardWrite: 'computerClipboardWrite',
	OpenApp: 'computerOpenApp',
} as const;

/** Every computer-use tool id, in the order they should be presented to the model. */
export const ComputerUseToolId = {
	ReadScreen: 'computer_read_screen',
	ReadScreenChanges: 'computer_read_screen_changes',
	Screenshot: 'computer_screenshot',
	Click: 'computer_click',
	Type: 'computer_type',
	Key: 'computer_key',
	Scroll: 'computer_scroll',
	Cursor: 'computer_cursor',
	WaitForStable: 'computer_wait_for_stable',
	ListApps: 'computer_list_apps',
	Drag: 'computer_drag',
	Hover: 'computer_hover',
	ClipboardRead: 'computer_clipboard_read',
	ClipboardWrite: 'computer_clipboard_write',
	OpenApp: 'computer_open_app',
} as const;

// ---------------------------------------------------------------------------------------------
// Service plumbing
// ---------------------------------------------------------------------------------------------

/** The failure half every folded outcome shares. */
interface IComputerUseCallFailure {
	readonly ok: false;
	readonly error: ComputerUseError;
}

/** Normalized outcome of a service call, so no call site has to write a `try`/`catch`. */
type ComputerUseCallOutcome<M extends ComputerUseMethod> =
	| {
		readonly ok: true;
		readonly result: ComputerUseResultFor<M>;
		/** Set only when the automatic settle around this call did not settle. */
		readonly unsettled?: ComputerUseSettleResult;
	}
	| IComputerUseCallFailure;

/** Normalized outcome of an incremental accessibility read. */
type ComputerUseReadingOutcome =
	| { readonly ok: true; readonly reading: ComputerUseAxReading }
	| IComputerUseCallFailure;

/** Normalized outcome of an explicit settle wait. */
type ComputerUseSettleOutcome =
	| { readonly ok: true; readonly settle: ComputerUseSettleResult }
	| IComputerUseCallFailure;

/**
 * Folds a rejection from the service into a value.
 *
 * The service throws {@link ComputerUseFailure} on refusal, which is right for its own callers but
 * wrong for a tool: a tool must always resolve with an {@link IToolResult} so the model gets the
 * corrective sentence instead of an opaque stack.
 */
function toCallFailure(err: unknown): IComputerUseCallFailure {
	if (isComputerUseFailure(err)) {
		return { ok: false, error: err.computerUseError };
	}
	return {
		ok: false,
		error: { code: 'internal', message: err instanceof Error ? err.message : String(err), retryable: false },
	};
}

/** Invokes one gated helper method, keeping the settle report the service attached to it. */
async function callComputerUse<M extends ComputerUseMethod>(
	service: IComputerUseService,
	method: M,
	params: ComputerUseParamsFor<M>,
): Promise<ComputerUseCallOutcome<M>> {
	try {
		const outcome = await service.invokeWithSettleReport(method, params);
		return { ok: true, result: outcome.result, unsettled: outcome.unsettled };
	} catch (err) {
		return toCallFailure(err);
	}
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** Builds a plain text tool result. */
function textResult(value: string): IToolResult {
	return { content: [{ kind: 'text', value }] };
}

/**
 * Appends a warning when the automatic settle around a call never reached a settled state.
 *
 * Reaching the model matters more than it looks: the service waits for the UI to stop moving before
 * every observation and after every action, and when that wait *fails* the result describes a state
 * that was still changing as it was read. A tool that swallowed that would hand the model a confident
 * snapshot of something in motion, which is the exact failure the wait exists to prevent.
 */
function withSettleNote(text: string, unsettled: ComputerUseSettleResult | undefined): string {
	if (!unsettled) {
		return text;
	}
	const warning = unsettled.reason === 'notificationsUnavailable'
		? localize(
			'computerUse.settle.noNotifications',
			"Note: this application reports no accessibility notifications, so V3Code could not confirm its UI had stopped changing (waited {0}ms). It probably draws its own interface: expect the element list to be thin, prefer '{1}' with coordinates, and re-check after every action.",
			unsettled.waitedMs,
			ComputerUseToolId.Screenshot,
		)
		: localize(
			'computerUse.settle.unsettled',
			"Warning: the UI had still not stopped changing after {0}ms ({1}), so treat this result as provisional — element references from it may already be stale and what you were shown may have moved. Something is animating or loading; wait with '{2}' and read again before acting on anything positional.",
			unsettled.waitedMs,
			unsettled.reason,
			ComputerUseToolId.WaitForStable,
		);
	return `${text}\n\n${warning}`;
}

/** Builds a failing tool result, so the chat surface shows it as an error rather than as output. */
function errorResult(message: string): IToolResult {
	return {
		content: [{ kind: 'text', value: message }],
		toolResultError: message,
	};
}

/**
 * Turns a structured helper failure into an instruction for the model.
 *
 * Naming the recovery action matters more than naming the fault: a model told only "stale
 * reference" retries the same reference, whereas a model told to re-read the screen recovers on the
 * next turn.
 */
function describeErrorForModel(error: ComputerUseError): string {
	switch (error.code) {
		case 'refStale':
			return localize(
				'computerUse.error.refStale',
				"That element reference is no longer valid because the screen changed: {0}. Call '{1}' again to get fresh references, then act on a reference from the new snapshot. Do not retry with the old reference.",
				error.message,
				ComputerUseToolId.ReadScreen,
			);
		case 'targetNotFound':
			return localize(
				'computerUse.error.targetNotFound',
				"No actionable element was found at that target: {0}. Call '{1}' to see what is actually on screen and pick a reference from the result.",
				error.message,
				ComputerUseToolId.ReadScreen,
			);
		case 'accessibilityNotTrusted':
			// Deliberately NOT "retrying will not help". That wording was wrong in the one case that
			// matters most — the first run, where a system permission dialog is open on screen right
			// now. The agent read "terminal failure", gave up, and reported the feature broken while
			// the user was still reaching for Allow. Ask, wait for the human, then try once more.
			return localize(
				'computerUse.error.accessibilityNotTrusted',
				"Computer use needs Accessibility permission, which has not been granted yet: {0}. A system dialog may be open on the user's screen this moment — tell them plainly what to approve (System Settings > Privacy & Security > Accessibility, enable V3Code), wait for them to say they have done it, then retry this call ONCE. Do not report computer use as broken before they have had the chance to answer. If it still fails after they confirm, the grant did not reach the running helper and V3Code needs restarting.",
				error.message,
			);
		case 'screenRecordingNotGranted':
			// The helper already raised the prompt and waited for an answer before returning this, so
			// by the time this is read the user has had their chance and either declined or not seen
			// it. Still worth one retry after they confirm, because a grant made while a process is
			// running does not reach it on every macOS version.
			return localize(
				'computerUse.error.screenRecordingNotGranted',
				"Screen capture needs Screen Recording permission, which has not been granted yet: {0}. Tell the user exactly what to approve (System Settings > Privacy & Security > Screen Recording, enable V3Code), wait for them to confirm, then retry ONCE — and if it still fails, V3Code has to be restarted for the grant to take effect. Meanwhile you are not stuck: '{1}' reads the screen through the accessibility tree and needs no screen-recording permission at all, so prefer it and carry on.",
				error.message,
				ComputerUseToolId.ReadScreen,
			);
		case 'appNotApproved':
			// "Retrying the same call will fail again" is true only while the approval dialog is
			// unanswered. Once the user approves, the same call is exactly the right thing to run.
			return localize(
				'computerUse.error.appNotApproved',
				"The user has not approved this application for computer use yet: {0}. An approval prompt may be waiting for them right now. Ask them to approve it, wait for their answer, then retry this same call ONCE — after approval it is the correct call to make. Only treat it as refused if they say no.",
				error.message,
			);
		case 'appTierForbidsAction':
			return localize(
				'computerUse.error.appTierForbidsAction',
				"That action is not permitted for this application: {0}. Use V3Code's browser tools to drive a browser, and the terminal tools to run commands, instead of synthesizing input.",
				error.message,
			);
		case 'permissionDenied':
			return localize(
				'computerUse.error.permissionDenied',
				"The user declined this action: {0}. Do not retry it; ask what to do instead.",
				error.message,
			);
		case 'helperMissing':
			return localize(
				'computerUse.error.helperMissing',
				"The computer-use helper is not installed: {0}. Computer use is unavailable in this session; fall back to tools that do not drive the desktop.",
				error.message,
			);
		case 'helperVersionMismatch':
			return localize(
				'computerUse.error.helperVersionMismatch',
				"The installed computer-use helper speaks a different protocol version: {0}. Tell the user to restart V3Code so the helper is reinstalled.",
				error.message,
			);
		case 'timeout':
			return localize(
				'computerUse.error.timeout',
				"The computer-use helper did not respond in time: {0}. The machine may be busy; one retry is reasonable, and if it fails again stop and report it.",
				error.message,
			);
		case 'cancelled':
			return localize(
				'computerUse.error.cancelled',
				"The action was cancelled: {0}. Do not retry automatically.",
				error.message,
			);
		default:
			return localize(
				'computerUse.error.internal',
				"Computer use failed: {0}. This is a bug rather than something you can work around; report it and continue without computer use.",
				error.message,
			);
	}
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/** The subset of tool parameters that identifies what to act on. */
interface IComputerUseTargetParams {
	ref?: string;
	x?: number;
	y?: number;
}

/**
 * Coerces a numeric tool parameter that may arrive as a string.
 *
 * These tools are advertised to the model through V3Code's XML tool definitions, which carry no
 * types, so every parameter reaches us as a string no matter what the native JSON Schema declares —
 * the model sends "1500" and the helper, whose protocol IS typed, rejects it. Coercing here keeps
 * the wire contract strict and fixes both platforms at once, rather than loosening the decoder in
 * the Swift and C++ helpers independently.
 *
 * Non-numeric text yields `undefined` rather than `NaN`, so a garbage value reads as "not supplied"
 * and the helper applies its default instead of failing.
 */
function num(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Resolves a tool's target parameters into a {@link ComputerUseTarget}.
 *
 * A reference wins over coordinates when both are supplied, because a reference is stable and
 * coordinates are not. Returns a string when the parameters are unusable, so the caller can hand
 * the model a corrective message instead of a silent mis-click.
 */
function resolveTarget(params: IComputerUseTargetParams, required: true): ComputerUseTarget | string;
function resolveTarget(params: IComputerUseTargetParams, required: false): ComputerUseTarget | string | undefined;
function resolveTarget(params: IComputerUseTargetParams, required: boolean): ComputerUseTarget | string | undefined {
	if (typeof params.ref === 'string' && params.ref.length > 0) {
		return { kind: 'ref', ref: params.ref };
	}
	const px = num(params.x);
	const py = num(params.y);
	if (px !== undefined && py !== undefined) {
		return { kind: 'point', x: px, y: py };
	}
	if (px !== undefined || py !== undefined) {
		return localize(
			'computerUse.target.halfPoint',
			"Both 'x' and 'y' are required when targeting by coordinates. Prefer 'ref' from '{0}' instead — coordinates are only for surfaces with no accessibility tree.",
			ComputerUseToolId.ReadScreen,
		);
	}
	if (required) {
		return localize(
			'computerUse.target.missing',
			"No target was given. Call '{0}' first and pass the 'ref' of the element you want, or pass 'x' and 'y' from a '{1}' image if the surface exposes no accessibility tree.",
			ComputerUseToolId.ReadScreen,
			ComputerUseToolId.Screenshot,
		);
	}
	return undefined;
}

/** Human-readable form of a target, for invocation messages. */
function describeTarget(params: IComputerUseTargetParams & { element?: string }): string {
	if (params.element) {
		return params.element;
	}
	if (params.ref) {
		return `ref=${params.ref}`;
	}
	const px = num(params.x);
	const py = num(params.y);
	if (px !== undefined && py !== undefined) {
		return `(${Math.round(px)}, ${Math.round(py)})`;
	}
	return localize('computerUse.target.unnamed', "the screen");
}

/** Shared schema properties for the ref-or-point target every action tool accepts. */
const targetSchemaProperties = {
	ref: {
		type: 'string',
		description: `Opaque element reference from '${ComputerUseToolId.ReadScreen}' or '${ComputerUseToolId.Screenshot}'. This is the preferred way to target an element: it survives scrolling and window movement. References go stale when the screen changes — if a call fails with a stale-reference error, read the screen again rather than retrying.`,
	},
	x: {
		type: 'number',
		description: `Horizontal coordinate, in pixels of the image returned by '${ComputerUseToolId.Screenshot}'. Fallback only, for canvas-like surfaces (games, drawing apps, custom-rendered UI) that expose no accessibility tree. Requires 'y'. Ignored when 'ref' is given.`,
	},
	y: {
		type: 'number',
		description: `Vertical coordinate, in pixels of the image returned by '${ComputerUseToolId.Screenshot}'. Fallback only; requires 'x'. Ignored when 'ref' is given.`,
	},
	element: {
		type: 'string',
		description: 'Short human-readable description of the target, e.g. "Save button" or "search field". Shown to the user; it does not affect targeting.',
	},
} as const;

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/** How many accessibility nodes a single read is allowed to report. */
const MAX_REPORTED_NODES = 400;

/**
 * Roles that only ever group other elements.
 *
 * These are dropped from the default listing: they never receive a useful click and they crowd out
 * the elements the model is actually looking for.
 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set([
	'group',
	'unknown',
	'splitGroup',
	'splitter',
	'layoutArea',
	'layoutItem',
	'scrollArea',
	'staticText',
]);

/** True when a node is worth showing to the model. */
function isInterestingNode(node: ComputerUseAxNode): boolean {
	if (node.focused) {
		return true;
	}
	if (node.actions && node.actions.length > 0) {
		return true;
	}
	if (node.value !== undefined && node.value.length > 0) {
		return true;
	}
	if (node.label !== undefined && node.label.length > 0) {
		return !CONTAINER_ROLES.has(node.role);
	}
	return false;
}

/** Formats one node as a single line, with the given indent depth. */
function formatNode(node: ComputerUseAxNode, depth: number, frame: string | undefined): string {
	const parts: string[] = [`${'  '.repeat(depth)}[ref=${node.ref}] ${node.role}`];
	if (node.label) {
		parts.push(JSON.stringify(node.label));
	}
	if (node.value !== undefined && node.value.length > 0) {
		parts.push(`value=${JSON.stringify(node.value)}`);
	}
	if (!node.enabled) {
		parts.push('disabled');
	}
	if (node.focused) {
		parts.push('focused');
	}
	if (frame) {
		parts.push(frame);
	}
	if (node.actions && node.actions.length > 0) {
		parts.push(`actions=${node.actions.join(',')}`);
	}
	return parts.join(' ');
}

/**
 * Flattens an accessibility tree into indented lines.
 *
 * Filtering is applied to what is *printed*, never to what is *traversed*: an uninteresting
 * container routinely holds the button the model needs.
 */
function formatNodes(
	nodes: readonly ComputerUseAxNode[],
	options: { readonly includeAll: boolean; readonly frameOf?: (node: ComputerUseAxNode) => string | undefined },
): { readonly lines: string[]; readonly truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const walk = (list: readonly ComputerUseAxNode[], depth: number): void => {
		for (const node of list) {
			if (lines.length >= MAX_REPORTED_NODES) {
				truncated = true;
				return;
			}
			const printed = options.includeAll || isInterestingNode(node);
			if (printed) {
				lines.push(formatNode(node, depth, options.frameOf?.(node)));
			}
			if (node.children && node.children.length > 0) {
				walk(node.children, printed ? depth + 1 : depth);
			}
		}
	};

	walk(nodes, 0);
	return { lines, truncated };
}

/**
 * Derives a coordinate space from a capture alone.
 *
 * The capture reports its own image dimensions and the image-to-physical scale, which is enough to
 * recover the physical size of what was captured. The display origin is unknown here and is left at
 * zero: the resulting space is used only to express element bounds in the image the model is shown,
 * which is origin-relative anyway.
 */
function spaceForCapture(capture: ComputerUseCaptureResult): ComputerUseCoordinateSpace {
	const scale = capture.scale > 0 ? capture.scale : 1;
	return {
		imageWidth: capture.width,
		imageHeight: capture.height,
		physicalWidth: capture.width / scale,
		physicalHeight: capture.height / scale,
	};
}

// ---------------------------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------------------------

/** Shared, gated helper access for every computer-use tool. */
abstract class ComputerUseToolBase implements IToolImpl {

	constructor(private readonly computerUseService: IComputerUseService) { }

	/** Invokes a helper method through the gate, folding any refusal into one outcome type. */
	protected call<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUseCallOutcome<M>> {
		return callComputerUse(this.computerUseService, method, params);
	}

	/** Reads the accessibility tree as a change set against the service's cached baseline. */
	protected async readChanges(params: ComputerUseAxTreeParams): Promise<ComputerUseReadingOutcome> {
		try {
			return { ok: true, reading: await this.computerUseService.readAxChanges(params) };
		} catch (err) {
			return toCallFailure(err);
		}
	}

	/** Waits for the UI to stop changing. A `settled: false` outcome is a success, not a failure. */
	protected async waitForStable(params: ComputerUseSettleParams): Promise<ComputerUseSettleOutcome> {
		try {
			return { ok: true, settle: await this.computerUseService.settle(params) };
		} catch (err) {
			return toCallFailure(err);
		}
	}

	abstract invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult>;
}

// ---------------------------------------------------------------------------------------------
// computer_read_screen
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseReadScreenTool}. */
interface IComputerUseReadScreenParams {
	pid?: number;
	max_depth?: number;
	include_all?: boolean;
}

/** Tool metadata for reading the accessibility tree. */
export const ComputerUseReadScreenToolData: IToolData = {
	id: ComputerUseToolId.ReadScreen,
	toolReferenceName: ComputerUseChatToolReferenceName.ReadScreen,
	displayName: localize('computerUse.readScreen.displayName', 'Read Screen'),
	userDescription: localize('computerUse.readScreen.userDescription', 'List the on-screen elements of the active application'),
	modelDescription: [
		`Lists the interactive elements of an application from its accessibility tree, each with a stable reference you can act on. Returns text only — no pixels — so it is far cheaper and far more precise than a screenshot.`,
		`Call this FIRST, before any other computer-use tool, whenever you need to interact with a desktop application: read the screen, find the element you want in the list, then pass its 'ref' to '${ComputerUseToolId.Click}', '${ComputerUseToolId.Type}' or '${ComputerUseToolId.Scroll}'.`,
		`Once you have read an application at least once, prefer '${ComputerUseToolId.ReadScreenChanges}' for every later look at it: it reports only what changed, which costs a fraction of this listing. Come back to this tool for a full picture when you have lost track of the state.`,
		`Always call one of the two again when another tool reports a stale reference.`,
		`Only reach for '${ComputerUseToolId.Screenshot}' when this tool returns nothing useful, or when the task genuinely depends on appearance.`,
	].join('\n'),
	icon: Codicon.listTree,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pid: {
				type: 'number',
				description: `Process id of the application to read, as reported by '${ComputerUseToolId.ListApps}'. Omit to read the frontmost application, which is what you usually want.`,
			},
			max_depth: {
				type: 'number',
				description: 'Maximum tree depth to walk. Omit for a sensible default. Lower it (for example to 6) when a large application returns an unwieldy tree.',
			},
			include_all: {
				type: 'boolean',
				description: 'Include purely structural elements that have no label and no actions. Defaults to false. Set true only when the element you need is missing from the filtered listing.',
			},
		},
		required: [],
	},
};

/** Reads the accessibility tree of an application and reports it as referenced element lines. */
export class ComputerUseReadScreenTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.readScreen.invocation', "Reading the screen"),
			pastTenseMessage: localize('computerUse.readScreen.past', "Read the screen"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseReadScreenParams;

		const outcome = await this.call('axTree', { pid: num(params.pid), maxDepth: num(params.max_depth) });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		return textResult(withSettleNote(formatAxTree(outcome.result, params.include_all === true), outcome.unsettled));
	}
}

/** Renders an accessibility tree result as the text the model reads. */
function formatAxTree(result: ComputerUseAxTreeResult, includeAll: boolean): string {
	const { lines, truncated } = formatNodes(result.nodes, {
		includeAll,
		frameOf: node => node.frame ? `at=${Math.round(node.frame.x)},${Math.round(node.frame.y)} size=${Math.round(node.frame.width)}x${Math.round(node.frame.height)}` : undefined,
	});

	const header = [
		localize('computerUse.readScreen.header', "Application: {0} ({1}, pid {2}). Reference generation {3}.", result.app.name, result.app.id, result.app.pid, result.generation),
		localize(
			'computerUse.readScreen.headerRefs',
			"Act on these elements by passing their 'ref' to '{0}', '{1}' or '{2}'. The 'at' and 'size' numbers are physical screen pixels for your orientation only — never pass them as 'x'/'y'; coordinates must come from a '{3}' image.",
			ComputerUseToolId.Click,
			ComputerUseToolId.Type,
			ComputerUseToolId.Scroll,
			ComputerUseToolId.Screenshot,
		),
	];

	if (lines.length === 0) {
		header.push(localize(
			'computerUse.readScreen.empty',
			"No labelled or actionable elements were reported. Retry with 'include_all' set to true, or fall back to '{0}' and target by coordinates — this application may render its own UI without an accessibility tree.",
			ComputerUseToolId.Screenshot,
		));
		return header.join('\n');
	}

	if (truncated) {
		header.push(localize(
			'computerUse.readScreen.truncated',
			"Listing truncated at {0} elements. Narrow the read with 'max_depth', or read a specific application by 'pid'.",
			MAX_REPORTED_NODES,
		));
	}

	return `${header.join('\n')}\n\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------------------------
// computer_read_screen_changes
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseReadScreenChangesTool}. */
interface IComputerUseReadScreenChangesParams {
	pid?: number;
	max_depth?: number;
	include_all?: boolean;
}

/** Tool metadata for the incremental accessibility read. */
export const ComputerUseReadScreenChangesToolData: IToolData = {
	id: ComputerUseToolId.ReadScreenChanges,
	toolReferenceName: ComputerUseChatToolReferenceName.ReadScreenChanges,
	displayName: localize('computerUse.readScreenChanges.displayName', 'Read Screen Changes'),
	userDescription: localize('computerUse.readScreenChanges.userDescription', 'List what changed on screen since the last read'),
	modelDescription: [
		`Reports only what has changed in an application's accessibility tree since your previous read of it: elements that appeared, disappeared, or changed label, value, state or available actions.`,
		`Call this INSTEAD of '${ComputerUseToolId.ReadScreen}' for every look after the first one — after a click, after typing, after a key press, after a scroll, or while waiting for something to finish. On a settled screen it answers "nothing changed" in a few tokens, and after an action it usually reports a handful of lines where a full read would repeat hundreds.`,
		`Elements that are not listed have not changed, and the references you already hold for them remain valid. Act on a reference from the change list exactly as you would one from a full read.`,
		`This tool can never fail for lack of a baseline: when there is nothing to compare against, when the previous snapshot's references have expired, or when so much changed that a change list would be harder to read than the tree, it returns the FULL listing instead and says so in the first line. When that happens, use the listing you were given — do not call this tool again for the same state, and do not call '${ComputerUseToolId.ReadScreen}' to get the same thing twice.`,
		`A menu whose items appear here without the menu becoming visible on screen has NOT failed to open. Clicking a menu invokes it through the accessibility API, which populates its items without necessarily drawing it, so the items are real and their references work: press the one you want. Do not re-click the menu title because you cannot see the menu — that closes what you just opened.`,
	].join('\n'),
	icon: Codicon.diffSingle,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pid: {
				type: 'number',
				description: `Process id of the application to read, as reported by '${ComputerUseToolId.ListApps}'. Omit for the frontmost application. Pass the same value you passed to the read you are comparing against; a different application has its own separate baseline.`,
			},
			max_depth: {
				type: 'number',
				description: 'Maximum tree depth to walk. Omit for a sensible default. Keep it the same across reads of one application, because a depth change alters what there is to compare.',
			},
			include_all: {
				type: 'boolean',
				description: 'Only affects the full listing this tool falls back to. Include purely structural elements that have no label and no actions. Defaults to false.',
			},
		},
		required: [],
	},
};

/** Reports the accessibility tree as a change set against the service's cached baseline. */
export class ComputerUseReadScreenChangesTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.readScreenChanges.invocation', "Checking what changed on screen"),
			pastTenseMessage: localize('computerUse.readScreenChanges.past', "Checked what changed on screen"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseReadScreenChangesParams;

		const outcome = await this.readChanges({ pid: num(params.pid), maxDepth: num(params.max_depth) });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		return textResult(withSettleNote(
			formatAxReading(outcome.reading, params.include_all === true),
			outcome.reading.unsettled,
		));
	}
}

/**
 * Renders an incremental read as the text the model sees.
 *
 * The three shapes are deliberately different sentences, not one message with a flag, because the
 * model has to do something different in each case: trust its existing references, act on the listed
 * changes, or discard what it thought it knew.
 */
function formatAxReading(reading: ComputerUseAxReading, includeAll: boolean): string {
	const app = reading.tree.app;

	if (reading.mode === 'unchanged') {
		return localize(
			'computerUse.readScreenChanges.unchanged',
			"Nothing changed in {0} ({1}, pid {2}) since your last read. Reference generation {3}. Every element reference you already have is still valid — act on it directly rather than reading again.",
			app.name,
			app.id,
			app.pid,
			reading.tree.generation,
		);
	}

	if (reading.mode === 'delta' && reading.delta) {
		const rendered = renderAxDelta(reading.delta, { maxLines: COMPUTER_USE_AX_DELTA_MAX_LINES });
		const header = [
			localize(
				'computerUse.readScreenChanges.header',
				"Changes in {0} ({1}, pid {2}). Reference generation {3}.",
				app.name,
				app.id,
				app.pid,
				reading.tree.generation,
			),
			localize(
				'computerUse.readScreenChanges.legend',
				"'+' appeared, '-' disappeared, '~' changed. Anything not listed is unchanged and its existing reference is still valid. Act on a 'ref' from this list with '{0}', '{1}' or '{2}' exactly as you would one from a full read.",
				ComputerUseToolId.Click,
				ComputerUseToolId.Type,
				ComputerUseToolId.Scroll,
			),
		];
		if (rendered.truncated) {
			header.push(localize(
				'computerUse.readScreenChanges.truncated',
				"Too much changed to list it all. Call '{0}' for the full picture rather than reading these changes as complete.",
				ComputerUseToolId.ReadScreen,
			));
		}
		return `${header.join('\n')}\n\n${rendered.text}`;
	}

	// Every remaining mode is a full listing wearing this tool's name. Saying why matters: the model has
	// to know whether its previous references survived, and whether calling again would help (it never
	// would — the listing below already is the full read).
	const reason = describeFullListingReason(reading);
	return `${reason}\n\n${formatAxTree(reading.tree, includeAll)}`;
}

/** The sentence explaining why an incremental read answered with the whole tree. */
function describeFullListingReason(reading: ComputerUseAxReading): string {
	switch (reading.mode) {
		case 'fullNoBaseline':
			return localize(
				'computerUse.readScreenChanges.noBaseline',
				"There was no earlier read of this application to compare against, so this is the full element listing. Later calls to this tool will report only what changed.",
			);
		case 'fullBaselineExpired':
			return localize(
				'computerUse.readScreenChanges.expired',
				"The earlier snapshot can no longer be compared — the application restarted, an action was cancelled, or its element references were discarded — so this is the full element listing. Discard every reference from your previous read and use only the ones below.",
			);
		case 'fullAppChanged':
			return localize(
				'computerUse.readScreenChanges.appChanged',
				"This read landed on a different application than your previous one, so there was nothing to compare and this is the full element listing. References from the other application do not apply here.",
			);
		default:
			return localize(
				'computerUse.readScreenChanges.tooManyChanges',
				"Too much of the screen changed for a change list to be readable ({0} of {1} elements), so this is the full element listing. Treat it as a fresh read: prefer these references over any you were holding.",
				reading.assessment?.deltaNodeCount ?? 0,
				reading.assessment?.fullNodeCount ?? 0,
			);
	}
}

// ---------------------------------------------------------------------------------------------
// computer_screenshot
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseScreenshotTool}. */
interface IComputerUseScreenshotParams {
	display_id?: number;
	max_long_edge?: number;
	include_elements?: boolean;
}

/** Tool metadata for capturing the screen. */
export const ComputerUseScreenshotToolData: IToolData = {
	id: ComputerUseToolId.Screenshot,
	toolReferenceName: ComputerUseChatToolReferenceName.Screenshot,
	displayName: localize('computerUse.screenshot.displayName', 'Screenshot Screen'),
	userDescription: localize('computerUse.screenshot.userDescription', 'Capture an image of the screen'),
	modelDescription: [
		`Captures an image of the screen and, alongside it, a compact list of on-screen elements with references you can act on.`,
		`Call this when appearance is part of the task — verifying a layout, reading a chart, describing what the user is looking at — or when '${ComputerUseToolId.ReadScreen}' came back empty because the application renders its own UI (a canvas, a game, a video, an unlabelled custom control).`,
		`Do NOT call this as a routine first step: it costs many times more than '${ComputerUseToolId.ReadScreen}' and gives you no better targeting. Prefer references from the element list over the coordinates you infer from the image; coordinates are the fallback, not the default.`,
		`Coordinates you read off this image are in image pixels and are exactly what '${ComputerUseToolId.Click}' and '${ComputerUseToolId.Scroll}' expect for 'x'/'y'. V3Code's own window is never included in the capture.`,
	].join('\n'),
	icon: Codicon.deviceCamera,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			display_id: {
				type: 'number',
				description: 'Display to capture. Omit to capture the display holding the frontmost window, which is almost always correct.',
			},
			max_long_edge: {
				type: 'number',
				description: `Downscale the capture so its longer edge is at most this many pixels. Defaults to ${COMPUTER_USE_DEFAULT_MAX_LONG_EDGE}. Raise it only when small text is unreadable; the image is never upscaled.`,
			},
			include_elements: {
				type: 'boolean',
				description: 'Also return the element list with references, positioned in image pixels. Defaults to true. Set false only when you want the image alone.',
			},
		},
		required: [],
	},
};

/** Captures the screen and returns the image plus a referenced element summary. */
export class ComputerUseScreenshotTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.screenshot.invocation', "Capturing the screen"),
			pastTenseMessage: localize('computerUse.screenshot.past', "Captured the screen"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseScreenshotParams;

		const capture = await this.call('capture', {
			displayId: num(params.display_id),
			maxLongEdge: num(params.max_long_edge),
		});
		if (!capture.ok) {
			return errorResult(describeErrorForModel(capture.error));
		}

		const summary = params.include_elements === false
			? undefined
			: await this.summarizeElements(capture.result);

		// V3Code excludes its own windows from every capture, so when V3Code is what the user is
		// looking at, the image is of the desktop behind it. That is correct and deliberate, but
		// without being told, the model reads a picture of the wallpaper as a broken screenshot and
		// starts debugging the capture path instead of focusing the application it meant to look at.
		// Cheap enough to ask on every capture, and it has to be asked separately because the
		// element summary is skipped entirely when `include_elements` is false.
		const frontmost = await this.call('frontmostApp', undefined);
		const capturedSelf = frontmost.ok && isSelfApp(frontmost.result);

		return {
			content: [
				{
					kind: 'data',
					value: {
						mimeType: 'image/png',
						data: decodeBase64(capture.result.dataBase64),
					},
				},
				{ kind: 'text', value: withSettleNote(describeCapture(capture.result, summary, capturedSelf), capture.unsettled) },
			],
		};
	}

	/**
	 * Reads the accessibility tree for the same moment as the capture and expresses element bounds
	 * in image pixels.
	 *
	 * Failure here is deliberately not fatal: an image with no element list is still useful, and a
	 * missing tree is the exact situation in which the model is supposed to fall back to
	 * coordinates.
	 */
	private async summarizeElements(capture: ComputerUseCaptureResult): Promise<string | undefined> {
		const tree = await this.call('axTree', {});
		if (!tree.ok) {
			return undefined;
		}
		const space = spaceForCapture(capture);
		const { lines, truncated } = formatNodes(tree.result.nodes, {
			includeAll: false,
			frameOf: node => {
				if (!node.frame) {
					return undefined;
				}
				const rect = physicalRectToImage(node.frame, space);
				return `at=${Math.round(rect.x)},${Math.round(rect.y)} size=${Math.round(rect.width)}x${Math.round(rect.height)}`;
			},
		});
		if (lines.length === 0) {
			return undefined;
		}
		const heading = localize(
			'computerUse.screenshot.elements',
			"Elements in {0} ({1}), positioned in image pixels. Prefer acting on 'ref' over the coordinates you infer from the image.",
			tree.result.app.name,
			tree.result.app.id,
		);
		const suffix = truncated
			? `\n${localize('computerUse.screenshot.elementsTruncated', "Listing truncated at {0} elements.", MAX_REPORTED_NODES)}`
			: '';
		return `${heading}\n${lines.join('\n')}${suffix}`;
	}
}

/** Describes a capture's geometry, and appends the element summary when there is one. */
function describeCapture(capture: ComputerUseCaptureResult, summary: string | undefined, capturedSelf: boolean): string {
	const header = localize(
		'computerUse.screenshot.geometry',
		"Screenshot is {0}x{1} image pixels at {2} of physical size. Any 'x'/'y' you pass to another computer-use tool must be in this image's pixel space.",
		capture.width,
		capture.height,
		`${Math.round(capture.scale * 100)}%`,
	);

	// Stated before anything else about the image, because it changes what the image *is*. Every
	// other line here describes geometry that is accurate but beside the point when the subject is
	// missing.
	const selfNote = capturedSelf
		? `\n${localize(
			'computerUse.screenshot.capturedSelf',
			"V3Code was frontmost, and V3Code is excluded from its own captures, so this image shows the desktop behind it rather than the editor. This is deliberate, not a capture failure. To look at another application, focus it with '{0}' first; to show the user something in V3Code, describe it instead — it cannot be screenshotted.",
			ComputerUseToolId.OpenApp,
		)}`
		: '';

	if (!summary) {
		return `${header}${selfNote}\n${localize(
			'computerUse.screenshot.noElements',
			"No accessibility element list was available for this capture, so target by 'x'/'y' read off the image.",
		)}`;
	}
	return `${header}${selfNote}\n\n${summary}`;
}

// ---------------------------------------------------------------------------------------------
// computer_click
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseClickTool}. */
interface IComputerUseClickParams extends IComputerUseTargetParams {
	element?: string;
	button?: ComputerUseMouseButton;
	modifiers?: ComputerUseModifier[];
	click_count?: number;
}

/** Tool metadata for clicking. */
export const ComputerUseClickToolData: IToolData = {
	id: ComputerUseToolId.Click,
	toolReferenceName: ComputerUseChatToolReferenceName.Click,
	displayName: localize('computerUse.click.displayName', 'Click on Screen'),
	userDescription: localize('computerUse.click.userDescription', 'Click an element or point on the screen'),
	modelDescription: [
		`Clicks an on-screen element in a desktop application.`,
		`Call this after '${ComputerUseToolId.ReadScreen}', passing the 'ref' of the element you want. A reference clicks the element wherever it actually is, so it keeps working when the window moves or the list scrolls.`,
		`Use 'x'/'y' only for surfaces with no accessibility tree, and only with coordinates read off a '${ComputerUseToolId.Screenshot}' image.`,
		`Set 'click_count' to 2 to double-click, use 'button' for right- and middle-clicks, and 'modifiers' for shift- or meta-clicks. If this reports a stale reference, read the screen again before trying anything else.`,
	].join('\n'),
	icon: Codicon.inspect,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			...targetSchemaProperties,
			button: {
				type: 'string',
				enum: ['left', 'right', 'middle'],
				description: 'Mouse button to press. Defaults to "left".',
			},
			modifiers: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['shift', 'control', 'alt', 'meta'],
				},
				description: 'Modifier keys held for the duration of the click, for example ["meta"] to open a link in a new tab or ["shift"] to extend a selection. Omit for an unmodified click.',
			},
			click_count: {
				type: 'number',
				description: 'Number of clicks. Defaults to 1; use 2 to double-click, 3 to select a line.',
			},
		},
		required: ['element'],
		$comment: `Exactly one of "ref" (preferred) or the "x"/"y" pair is required.`,
	},
};

/** Clicks a referenced element, or a raw point on canvas-like surfaces. */
export class ComputerUseClickTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IComputerUseClickParams;
		const target = escapeMarkdownSyntaxTokens(describeTarget(params));
		if (params.button === 'right') {
			return {
				invocationMessage: new MarkdownString(localize('computerUse.click.invocation.right', "Right-clicking {0}", target)),
				pastTenseMessage: new MarkdownString(localize('computerUse.click.past.right', "Right-clicked {0}", target)),
			};
		}
		if (params.button === 'middle') {
			return {
				invocationMessage: new MarkdownString(localize('computerUse.click.invocation.middle', "Middle-clicking {0}", target)),
				pastTenseMessage: new MarkdownString(localize('computerUse.click.past.middle', "Middle-clicked {0}", target)),
			};
		}
		if ((num(params.click_count) ?? 1) > 1) {
			return {
				invocationMessage: new MarkdownString(localize('computerUse.click.invocation.double', "Double-clicking {0}", target)),
				pastTenseMessage: new MarkdownString(localize('computerUse.click.past.double', "Double-clicked {0}", target)),
			};
		}
		return {
			invocationMessage: new MarkdownString(localize('computerUse.click.invocation', "Clicking {0}", target)),
			pastTenseMessage: new MarkdownString(localize('computerUse.click.past', "Clicked {0}", target)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseClickParams;

		const target = resolveTarget(params, true);
		if (typeof target === 'string') {
			return errorResult(target);
		}

		const outcome = await this.call('click', {
			target,
			button: params.button,
			modifiers: params.modifiers,
			clickCount: num(params.click_count),
		});
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		return textResult(withSettleNote(localize(
			'computerUse.click.result',
			"Clicked {0} (dispatched via {1}). V3Code waited for the UI to stop changing afterwards, so you can read now without a separate wait. Call '{2}' to see only what changed — the previous references may be stale.",
			describeTarget(params),
			outcome.result.method,
			ComputerUseToolId.ReadScreenChanges,
		), outcome.unsettled));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_type
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseTypeTool}. */
interface IComputerUseTypeParams extends IComputerUseTargetParams {
	element?: string;
	text: string;
}

/** Tool metadata for typing text. */
export const ComputerUseTypeToolData: IToolData = {
	id: ComputerUseToolId.Type,
	toolReferenceName: ComputerUseChatToolReferenceName.Type,
	displayName: localize('computerUse.type.displayName', 'Type on Screen'),
	userDescription: localize('computerUse.type.userDescription', 'Type text into the focused element or a target element'),
	modelDescription: [
		`Types literal text into a desktop application.`,
		`Call this to fill a field: pass the field's 'ref' from '${ComputerUseToolId.ReadScreen}' and the text replaces that field's current value, which is more reliable than clicking and clearing it by hand.`,
		`Omit the target to type into whatever already has keyboard focus — do that only when you have just confirmed the focus, for example from a 'focused' element in the last read.`,
		`This types characters only. For Return, Tab, Escape, or any shortcut, use '${ComputerUseToolId.Key}'.`,
	].join('\n'),
	icon: Codicon.keyboard,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			text: {
				type: 'string',
				description: 'Literal text to type. Newlines are typed as newlines; do not embed key names such as "Enter" here.',
			},
			...targetSchemaProperties,
		},
		required: ['text'],
		$comment: `Omit "ref" and "x"/"y" to type into the currently focused element.`,
	},
};

/** Types text, optionally replacing the value of a targeted element. */
export class ComputerUseTypeTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IComputerUseTypeParams;
		const target = escapeMarkdownSyntaxTokens(describeTarget(params));
		return {
			invocationMessage: new MarkdownString(localize('computerUse.type.invocation', "Typing into {0}", target)),
			pastTenseMessage: new MarkdownString(localize('computerUse.type.past', "Typed into {0}", target)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseTypeParams;

		if (typeof params.text !== 'string') {
			return errorResult(localize('computerUse.type.noText', "The 'text' parameter is required."));
		}

		const target = resolveTarget(params, false);
		if (typeof target === 'string') {
			return errorResult(target);
		}

		const outcome = await this.call('type', { text: params.text, target });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		return textResult(withSettleNote(localize(
			'computerUse.type.result',
			"Typed {0} characters into {1} (dispatched via {2}). Call '{3}' to confirm the value landed where you intended.",
			params.text.length,
			describeTarget(params),
			outcome.result.method,
			ComputerUseToolId.ReadScreenChanges,
		), outcome.unsettled));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_key
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseKeyTool}. */
interface IComputerUseKeyParams {
	chord: string;
	repeat?: number;
}

/** Tool metadata for pressing a key chord. */
export const ComputerUseKeyToolData: IToolData = {
	id: ComputerUseToolId.Key,
	toolReferenceName: ComputerUseChatToolReferenceName.Key,
	displayName: localize('computerUse.key.displayName', 'Press Keys'),
	userDescription: localize('computerUse.key.userDescription', 'Press a key or keyboard shortcut'),
	modelDescription: [
		`Presses a single key or a keyboard shortcut in the frontmost application.`,
		`Call this for keys that are not literal text — Return to submit, Tab to move between fields, Escape to dismiss a menu, ArrowDown to move a selection — and for shortcuts such as "meta+s" to save or "meta+shift+p" to open a command palette.`,
		`A shortcut is very often faster and more reliable than hunting for a menu item with '${ComputerUseToolId.ReadScreen}' and '${ComputerUseToolId.Click}'; reach for it first when the application has a well-known one.`,
		`This goes to whichever application is frontmost, so make sure the right one is in front before calling it.`,
	].join('\n'),
	icon: Codicon.recordKeys,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			chord: {
				type: 'string',
				description: 'Modifiers joined to the key with "+", for example "Return", "Escape", "Tab", "ArrowDown", "meta+s", "meta+shift+p", "control+alt+delete". Modifier names are shift, control, alt and meta; matching is case-insensitive.',
			},
			repeat: {
				type: 'number',
				description: 'Number of times to press the chord. Defaults to 1. Useful for moving a selection several rows at once.',
			},
		},
		required: ['chord'],
	},
};

/** Presses a key chord in the frontmost application. */
export class ComputerUseKeyTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IComputerUseKeyParams;
		const chord = escapeMarkdownSyntaxTokens(params.chord ?? '');
		return {
			invocationMessage: new MarkdownString(localize('computerUse.key.invocation', "Pressing {0}", chord)),
			pastTenseMessage: new MarkdownString(localize('computerUse.key.past', "Pressed {0}", chord)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseKeyParams;

		if (typeof params.chord !== 'string' || params.chord.length === 0) {
			return errorResult(localize('computerUse.key.noChord', "The 'chord' parameter is required, for example \"Return\" or \"meta+s\"."));
		}

		const outcome = await this.call('key', { chord: params.chord, repeat: num(params.repeat) });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		return textResult(withSettleNote(localize(
			'computerUse.key.result',
			"Pressed {0} {1} time(s) (dispatched via {2}). Call '{3}' to see what changed.",
			params.chord,
			num(params.repeat) ?? 1,
			outcome.result.method,
			ComputerUseToolId.ReadScreenChanges,
		), outcome.unsettled));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_scroll
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseScrollTool}. */
interface IComputerUseScrollParams extends IComputerUseTargetParams {
	element?: string;
	direction: ComputerUseScrollDirection;
	amount: number;
}

/** Tool metadata for scrolling. */
export const ComputerUseScrollToolData: IToolData = {
	id: ComputerUseToolId.Scroll,
	toolReferenceName: ComputerUseChatToolReferenceName.Scroll,
	displayName: localize('computerUse.scroll.displayName', 'Scroll Screen'),
	userDescription: localize('computerUse.scroll.userDescription', 'Scroll a scrollable area on the screen'),
	modelDescription: [
		`Scrolls a scrollable area of a desktop application.`,
		`Call this when the element you need is not in the element list because it is off-screen: scroll the containing area, then call '${ComputerUseToolId.ReadScreen}' again and act on a fresh reference.`,
		`Target the scrollable region by 'ref' — usually a list, table or scroll area from the last read — or, on surfaces with no accessibility tree, by 'x'/'y' from a '${ComputerUseToolId.Screenshot}' image. A target is required, because scrolling "the screen" is ambiguous when several panes are visible.`,
		`Scrolling invalidates the positions in your last read, so always read again before clicking.`,
	].join('\n'),
	icon: Codicon.arrowSwap,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			direction: {
				type: 'string',
				enum: ['up', 'down', 'left', 'right'],
				description: 'Direction the content moves toward: "down" reveals content further down the page.',
			},
			amount: {
				type: 'number',
				description: 'Number of scroll ticks. Use 3 for a small nudge, 10 or more to move by roughly a page.',
			},
			...targetSchemaProperties,
		},
		required: ['direction', 'amount', 'element'],
		$comment: `Exactly one of "ref" (preferred) or the "x"/"y" pair is required.`,
	},
};

/** Scrolls a targeted scrollable area. */
export class ComputerUseScrollTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IComputerUseScrollParams;
		const target = escapeMarkdownSyntaxTokens(describeTarget(params));
		const direction = escapeMarkdownSyntaxTokens(params.direction ?? 'down');
		return {
			invocationMessage: new MarkdownString(localize('computerUse.scroll.invocation', "Scrolling {0} in {1}", direction, target)),
			pastTenseMessage: new MarkdownString(localize('computerUse.scroll.past', "Scrolled {0} in {1}", direction, target)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseScrollParams;

		if (params.direction !== 'up' && params.direction !== 'down' && params.direction !== 'left' && params.direction !== 'right') {
			return errorResult(localize('computerUse.scroll.noDirection', "The 'direction' parameter must be one of \"up\", \"down\", \"left\" or \"right\"."));
		}

		const target = resolveTarget(params, true);
		if (typeof target === 'string') {
			return errorResult(target);
		}

		const amountValue = num(params.amount);
		const amount = amountValue !== undefined && amountValue > 0 ? amountValue : 3;
		const outcome = await this.call('scroll', { target, direction: params.direction, amount });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		return textResult(withSettleNote(localize(
			'computerUse.scroll.result',
			"Scrolled {0} by {1} tick(s) in {2} (dispatched via {3}). Element positions have moved — call '{4}' before acting on anything.",
			params.direction,
			amount,
			describeTarget(params),
			outcome.result.method,
			ComputerUseToolId.ReadScreenChanges,
		), outcome.unsettled));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_wait_for_stable
// ---------------------------------------------------------------------------------------------

/** Parameters accepted by {@link ComputerUseWaitForStableTool}. */
interface IComputerUseWaitForStableParams {
	pid?: number;
	timeout_ms?: number;
}

/** Tool metadata for waiting until the UI stops changing. */
export const ComputerUseWaitForStableToolData: IToolData = {
	id: ComputerUseToolId.WaitForStable,
	toolReferenceName: ComputerUseChatToolReferenceName.WaitForStable,
	displayName: localize('computerUse.waitForStable.displayName', 'Wait For Stable Screen'),
	userDescription: localize('computerUse.waitForStable.userDescription', 'Wait until an application stops changing on screen'),
	modelDescription: [
		`Waits until an application's UI stops changing, then reports whether it actually did.`,
		`You usually do NOT need this. V3Code already waits for the UI to settle after every click, keystroke and scroll, and before every read, so a normal action-then-read sequence is covered without asking.`,
		`Call this when a previous tool warned you that the UI had not stopped changing, or when you have started something that finishes on its own schedule — a file opening, a save, a progress bar, a window animating in — and you want to wait rather than read a half-finished screen.`,
		`Do not use it as a general sleep between steps: it returns as soon as the application goes quiet, and on an idle application it returns almost immediately, so calling it speculatively buys nothing.`,
		`If it reports that the UI was STILL changing when the budget ran out, do not simply retry in a loop — read the screen, treat what you see as provisional, and consider that the application may be waiting on something you need to deal with.`,
	].join('\n'),
	icon: Codicon.watch,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pid: {
				type: 'number',
				description: `Process id of the application to watch, as reported by '${ComputerUseToolId.ListApps}'. Omit for the frontmost application, which is almost always what you want.`,
			},
			timeout_ms: {
				type: 'number',
				description: `Hardest cap on the wait, in milliseconds. Defaults to ${COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS}, which already outlasts a normal window or sheet animation. Raise it only for something you know is slow, such as a large file opening; it is a cap, not a delay, so the call still returns as soon as the UI goes quiet.`,
			},
		},
		required: [],
	},
};

/** Waits for an application's UI to go quiet and reports the outcome verbatim. */
export class ComputerUseWaitForStableTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.waitForStable.invocation', "Waiting for the screen to settle"),
			pastTenseMessage: localize('computerUse.waitForStable.past', "Waited for the screen to settle"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IComputerUseWaitForStableParams;

		const outcome = await this.waitForStable({ pid: num(params.pid), timeoutMs: num(params.timeout_ms) });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		// Not an error result: the wait ran and answered. `settled: false` is a real answer about the
		// machine, and reporting it as a tool failure would invite a blind retry instead of a decision.
		const settle = outcome.settle;
		if (!settle.settled) {
			return textResult(localize(
				'computerUse.waitForStable.unsettled',
				"The UI was STILL changing when the {0}ms budget ran out ({1}). Something is animating, loading, or updating on a timer. Read the screen with '{2}' and treat what you see as provisional — element references may go stale immediately — or work out what the application is waiting for. Do not simply call this again in a loop.",
				settle.waitedMs,
				settle.reason,
				ComputerUseToolId.ReadScreenChanges,
			));
		}

		if (settle.reason === 'notificationsUnavailable') {
			return textResult(localize(
				'computerUse.waitForStable.noNotifications',
				"The screen looks stable after {0}ms, but this application publishes no accessibility notifications, so that is based on comparing frames alone. Expect a thin element list: prefer '{1}' and coordinates over element references here.",
				settle.waitedMs,
				ComputerUseToolId.Screenshot,
			));
		}

		return textResult(localize(
			'computerUse.waitForStable.settled',
			"The UI stopped changing after {0}ms ({1}). Read it now with '{2}' — references from that read will be as stable as this application allows.",
			settle.waitedMs,
			settle.reason,
			ComputerUseToolId.ReadScreenChanges,
		));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_cursor
// ---------------------------------------------------------------------------------------------

/** Tool metadata for reading the cursor position. */
export const ComputerUseCursorToolData: IToolData = {
	id: ComputerUseToolId.Cursor,
	toolReferenceName: ComputerUseChatToolReferenceName.Cursor,
	displayName: localize('computerUse.cursor.displayName', 'Get Cursor Position'),
	userDescription: localize('computerUse.cursor.userDescription', 'Report where the mouse cursor currently is'),
	modelDescription: [
		`Reports the current mouse cursor position in physical screen pixels.`,
		`Call this only when the cursor's own position is what you need — for example when the user says "the thing I'm pointing at", or when you are diagnosing why a drag or hover behaved unexpectedly.`,
		`Do not call it to decide where to click. These numbers are physical screen pixels, not the image pixels that '${ComputerUseToolId.Click}' expects for 'x'/'y', and clicking where the cursor happens to be is not a targeting strategy — use a 'ref' from '${ComputerUseToolId.ReadScreen}'.`,
	].join('\n'),
	icon: Codicon.symbolRuler,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {},
		required: [],
	},
};

/** Reports the current cursor position. */
export class ComputerUseCursorTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.cursor.invocation', "Checking the cursor position"),
			pastTenseMessage: localize('computerUse.cursor.past', "Checked the cursor position"),
		};
	}

	async invoke(_invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const outcome = await this.call('cursorPosition', undefined);
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}
		const position = outcome.result as ComputerUseCursorResult;
		return textResult(localize(
			'computerUse.cursor.result',
			"Cursor is at {0}, {1} in physical screen pixels. Do not pass these numbers as 'x'/'y' to another computer-use tool; those take image pixels from a '{2}' capture.",
			Math.round(position.x),
			Math.round(position.y),
			ComputerUseToolId.Screenshot,
		));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_list_apps
// ---------------------------------------------------------------------------------------------

/** Tool metadata for listing applications. */
export const ComputerUseListAppsToolData: IToolData = {
	id: ComputerUseToolId.ListApps,
	toolReferenceName: ComputerUseChatToolReferenceName.ListApps,
	displayName: localize('computerUse.listApps.displayName', 'List Applications'),
	userDescription: localize('computerUse.listApps.userDescription', 'List the running applications available to computer use'),
	modelDescription: [
		`Lists the running applications, each with its process id, the permissions tier computer use grants it, and whether the user has approved it.`,
		`Call this when you do not know what is running, when you need a 'pid' to read a specific application with '${ComputerUseToolId.ReadScreen}', or when an action failed because the application was not approved or its tier forbade the action — the listing tells you which of those it was.`,
		`Read the tier before planning: a "read" application can be observed but not driven (use V3Code's browser tools for browsers), a "click" application accepts clicks but no typing (use the terminal tools to run commands), and only a "full" application accepts the whole tool set.`,
	].join('\n'),
	icon: Codicon.window,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {},
		required: [],
	},
};

/** Lists running applications with their computer-use tier and approval state. */
export class ComputerUseListAppsTool extends ComputerUseToolBase {

	constructor(
		@IComputerUseService computerUseService: IComputerUseService,
		@IComputerUseExclusionStore private readonly exclusionStore: IComputerUseExclusionStore,
	) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.listApps.invocation', "Listing applications"),
			pastTenseMessage: localize('computerUse.listApps.past', "Listed applications"),
		};
	}

	async invoke(_invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const outcome = await this.call('listApps', undefined);
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}

		const apps = outcome.result as readonly ComputerUseApp[];
		const visible = apps.filter(app => classifyComputerUseApp(app) !== 'self');
		if (visible.length === 0) {
			return textResult(localize('computerUse.listApps.empty', "No applications are visible to computer use."));
		}

		const lines = visible.map(app => {
			const tier = classifyComputerUseApp(app);
			// Only exclusions are worth reporting. Everything else is available, so saying so for each
			// application would be noise the model has to read past on every listing.
			const excluded = this.exclusionStore.isExcluded(app.id)
				? ` ${localize('computerUse.listApps.excluded', "— EXCLUDED by the user, actions here will be refused")}`
				: '';
			return `${app.name} (${app.id}, pid ${app.pid}) kind=${tier}${excluded}`;
		});

		return textResult([
			localize(
				'computerUse.listApps.header',
				"Applications available to computer use. Pass a 'pid' to '{0}' to read one that is not frontmost.",
				ComputerUseToolId.ReadScreen,
			),
			...lines,
		].join('\n'));
	}
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/**
 * Every computer-use tool's metadata, in presentation order.
 *
 * Exported for call sites that need the whole surface without instantiating it — chat presenters,
 * settings UI listing what the feature exposes, and tests asserting the schemas.
 */
// ---------------------------------------------------------------------------------------------
// computer_drag
// ---------------------------------------------------------------------------------------------

export const ComputerUseDragToolData: IToolData = {
	id: ComputerUseToolId.Drag,
	toolReferenceName: ComputerUseChatToolReferenceName.Drag,
	displayName: localize('computerUse.drag.displayName', 'Drag'),
	userDescription: localize('computerUse.drag.userDescription', 'Press at one place, move, and release'),
	modelDescription: [
		`Presses the mouse at one target, moves to a second target while holding, and releases.`,
		`Call this when the task needs the button held down across a movement: reordering a list, moving a file onto a folder, resizing by a handle, selecting a range on a canvas, or moving a window by its title bar.`,
		`Do NOT use two '${ComputerUseToolId.Click}' calls for this. A press and a separate release are seen as two clicks, not a drag, and the drop never happens.`,
		`Target each end with a 'ref' from '${ComputerUseToolId.ReadScreen}' where possible; 'from_x'/'from_y' and 'to_x'/'to_y' are image pixels from a '${ComputerUseToolId.Screenshot}' capture and are only for surfaces with no accessibility tree.`,
		`Take a screenshot afterwards to confirm the drop landed. Drag is the least reliable action here, because whether a drop is accepted depends entirely on the target application.`,
	].join('\n'),
	icon: Codicon.move,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			from_ref: { type: 'string', description: `Element reference to start from, from '${ComputerUseToolId.ReadScreen}'.` },
			from_x: { type: 'number', description: 'Start X in image pixels. Fallback when there is no accessibility tree; requires fromY.' },
			from_y: { type: 'number', description: 'Start Y in image pixels. Requires from_x.' },
			to_ref: { type: 'string', description: 'Element reference to drop onto.' },
			to_x: { type: 'number', description: 'Destination X in image pixels. Requires to_y.' },
			to_y: { type: 'number', description: 'Destination Y in image pixels. Requires to_x.' },
			button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to hold. Defaults to left.' },
			modifiers: {
				type: 'array',
				items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] },
				description: 'Modifier keys held for the whole gesture. Often meaningful — alt commonly means copy rather than move.',
			},
			duration_ms: { type: 'number', description: 'How long the movement takes. Defaults to 250. Raise it if the target ignores the drag; some applications need a slower gesture to register one.' },
			element: { type: 'string', description: 'Short human description of what is being dragged where, shown to the user.' },
		},
		required: ['element'],
	},
};

/** Presses at one target, moves to another, releases. */
export class ComputerUseDragTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const element = describeTarget(context.parameters as IComputerUseTargetParams & { element?: string });
		return {
			invocationMessage: localize('computerUse.drag.invocation', "Dragging {0}", element),
			pastTenseMessage: localize('computerUse.drag.past', "Dragged {0}", element),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as {
			from_ref?: string; from_x?: number; from_y?: number;
			to_ref?: string; to_x?: number; to_y?: number;
			button?: ComputerUseMouseButton; modifiers?: ComputerUseModifier[]; duration_ms?: number;
		};
		const from = resolveTarget({ ref: params.from_ref, x: num(params.from_x), y: num(params.from_y) }, true);
		if (typeof from === 'string') {
			return errorResult(from);
		}
		const to = resolveTarget({ ref: params.to_ref, x: num(params.to_x), y: num(params.to_y) }, true);
		if (typeof to === 'string') {
			return errorResult(to);
		}
		const outcome = await this.call('drag', {
			from,
			to,
			button: params.button,
			modifiers: params.modifiers,
			durationMs: num(params.duration_ms),
		});
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}
		return textResult(localize(
			'computerUse.drag.result',
			"Drag performed. Whether the drop was accepted is up to the target application — take a '{0}' to confirm it landed.",
			ComputerUseToolId.Screenshot,
		));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_hover
// ---------------------------------------------------------------------------------------------

export const ComputerUseHoverToolData: IToolData = {
	id: ComputerUseToolId.Hover,
	toolReferenceName: ComputerUseChatToolReferenceName.Hover,
	displayName: localize('computerUse.hover.displayName', 'Hover'),
	userDescription: localize('computerUse.hover.userDescription', 'Move the pointer somewhere without clicking'),
	modelDescription: [
		`Moves the mouse pointer onto a target without pressing anything.`,
		`Call this when the thing you need only exists while hovered: a menu that opens on hover, a control that appears on row hover, or a tooltip carrying text you need to read.`,
		`After hovering, read the screen again — the point is that the UI is now different. Set 'settle_ms' to wait for it to appear; hover UI is usually on a short delay and reading immediately shows the state before it.`,
		`This is not a substitute for clicking. If you want to activate something, use '${ComputerUseToolId.Click}'.`,
	].join('\n'),
	icon: Codicon.inspect,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			ref: { type: 'string', description: `Element reference to hover, from '${ComputerUseToolId.ReadScreen}'.` },
			x: { type: 'number', description: 'X in image pixels. Fallback only; requires y.' },
			y: { type: 'number', description: 'Y in image pixels. Requires x.' },
			settle_ms: { type: 'number', description: 'How long to remain there before returning, so hover-triggered UI has time to appear. Defaults to 0; 300 is usually enough for a menu.' },
			element: { type: 'string', description: 'Short human description of what is being hovered, shown to the user.' },
		},
		required: ['element'],
	},
};

/** Moves the pointer without pressing. */
export class ComputerUseHoverTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const element = describeTarget(context.parameters as IComputerUseTargetParams & { element?: string });
		return {
			invocationMessage: localize('computerUse.hover.invocation', "Hovering {0}", element),
			pastTenseMessage: localize('computerUse.hover.past', "Hovered {0}", element),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as { ref?: string; x?: number; y?: number; settle_ms?: number };
		const target = resolveTarget(params, true);
		if (typeof target === 'string') {
			return errorResult(target);
		}
		const outcome = await this.call('mouseMove', { target, settleMs: num(params.settle_ms) });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}
		return textResult(localize(
			'computerUse.hover.result',
			"Pointer moved. Read the screen again with '{0}' to see whatever the hover revealed.",
			ComputerUseToolId.ReadScreen,
		));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_clipboard_read / computer_clipboard_write
// ---------------------------------------------------------------------------------------------

export const ComputerUseClipboardReadToolData: IToolData = {
	id: ComputerUseToolId.ClipboardRead,
	toolReferenceName: ComputerUseChatToolReferenceName.ClipboardRead,
	displayName: localize('computerUse.clipboardRead.displayName', 'Read Clipboard'),
	userDescription: localize('computerUse.clipboardRead.userDescription', 'Read the text currently on the clipboard'),
	modelDescription: [
		`Reads the system clipboard as text.`,
		`Call this when the task is actually about the clipboard — the user said "what I just copied", or you copied something yourself and need it back.`,
		`Do not read it speculatively. The clipboard usually holds something the user copied for their own reasons and did not intend to share; reading it puts that content into this conversation.`,
		`Returns empty text when the clipboard holds an image or files rather than text, and says so separately so you can tell "nothing there" from "something I cannot read".`,
	].join('\n'),
	icon: Codicon.clippy,
	source: ToolDataSource.Internal,
	inputSchema: { type: 'object', properties: {}, required: [] },
};

/** Reads clipboard text. */
export class ComputerUseClipboardReadTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.clipboardRead.invocation', "Reading the clipboard"),
			pastTenseMessage: localize('computerUse.clipboardRead.past', "Read the clipboard"),
		};
	}

	async invoke(_invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const outcome = await this.call('clipboardRead', undefined);
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}
		const contents = outcome.result as ComputerUseClipboardReadResult;
		if (contents.text.length === 0) {
			return textResult(contents.hasNonTextContent
				? localize('computerUse.clipboardRead.nonText', "The clipboard holds something that is not text (an image or files), so there is nothing to read.")
				: localize('computerUse.clipboardRead.empty', "The clipboard is empty."));
		}
		return textResult(localize(
			'computerUse.clipboardRead.result',
			"Clipboard ({0} characters):\n{1}",
			contents.length,
			contents.text,
		));
	}
}

export const ComputerUseClipboardWriteToolData: IToolData = {
	id: ComputerUseToolId.ClipboardWrite,
	toolReferenceName: ComputerUseChatToolReferenceName.ClipboardWrite,
	displayName: localize('computerUse.clipboardWrite.displayName', 'Write Clipboard'),
	userDescription: localize('computerUse.clipboardWrite.userDescription', 'Replace the clipboard contents with text'),
	modelDescription: [
		`Replaces the system clipboard with text.`,
		`Call this when pasting is the practical way to get text somewhere — a long passage, or a field that mangles synthesized keystrokes. Write the clipboard, then press the paste chord with '${ComputerUseToolId.Key}'.`,
		`This destroys whatever the user had on their clipboard, and there is no undo. For short text, typing it with '${ComputerUseToolId.Type}' is the politer choice.`,
	].join('\n'),
	icon: Codicon.clippy,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			text: { type: 'string', description: 'Text to place on the clipboard.' },
		},
		required: ['text'],
	},
};

/** Replaces clipboard text. */
export class ComputerUseClipboardWriteTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			invocationMessage: localize('computerUse.clipboardWrite.invocation', "Putting text on the clipboard"),
			pastTenseMessage: localize('computerUse.clipboardWrite.past', "Put text on the clipboard"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as { text?: string };
		if (typeof params.text !== 'string') {
			return errorResult(localize('computerUse.clipboardWrite.noText', "No 'text' was given to put on the clipboard."));
		}
		const outcome = await this.call('clipboardWrite', { text: params.text });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}
		return textResult(localize(
			'computerUse.clipboardWrite.result',
			"Clipboard set ({0} characters). Paste it with '{1}' — the paste chord is cmd+v on macOS and control+v on Windows.",
			params.text.length,
			ComputerUseToolId.Key,
		));
	}
}

// ---------------------------------------------------------------------------------------------
// computer_open_app
// ---------------------------------------------------------------------------------------------

export const ComputerUseOpenAppToolData: IToolData = {
	id: ComputerUseToolId.OpenApp,
	toolReferenceName: ComputerUseChatToolReferenceName.OpenApp,
	displayName: localize('computerUse.openApp.displayName', 'Open Application'),
	userDescription: localize('computerUse.openApp.userDescription', 'Launch an application or bring it to the front'),
	modelDescription: [
		`Launches an application, or brings it to the front when it is already running.`,
		`Call this first whenever the task names an application that is not currently frontmost. Every other computer-use tool acts on whatever is in front, so acting before the right thing is focused targets the wrong window.`,
		`The name can be what a person would say ("TextEdit", "Safari") or a bundle identifier. Check '${ComputerUseToolId.ListApps}' if you are unsure what is available.`,
		`Reports whether it actually reached the foreground. If it did not, do not proceed to click — read the screen and find out what has focus instead.`,
	].join('\n'),
	icon: Codicon.window,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			app: { type: 'string', description: 'Application display name, bundle identifier, or executable name.' },
			wait_ms: { type: 'number', description: 'How long to wait for it to come to the front. Defaults to 5000; a cold launch of a large application can need more.' },
		},
		required: ['app'],
	},
};

/** Launches or focuses an application. */
export class ComputerUseOpenAppTool extends ComputerUseToolBase {

	constructor(@IComputerUseService computerUseService: IComputerUseService) {
		super(computerUseService);
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const app = String((context.parameters as { app?: unknown }).app ?? '').trim() || localize('computerUse.openApp.unnamed', "an application");
		return {
			invocationMessage: localize('computerUse.openApp.invocation', "Opening {0}", app),
			pastTenseMessage: localize('computerUse.openApp.past', "Opened {0}", app),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as { app?: string; wait_ms?: number };
		if (typeof params.app !== 'string' || params.app.trim().length === 0) {
			return errorResult(localize('computerUse.openApp.noApp', "No 'app' was named."));
		}
		const outcome = await this.call('openApplication', { app: params.app, waitMs: num(params.wait_ms) });
		if (!outcome.ok) {
			return errorResult(describeErrorForModel(outcome.error));
		}
		const result = outcome.result as ComputerUseOpenApplicationResult;
		const verb = result.launched
			? localize('computerUse.openApp.launched', "Launched")
			: localize('computerUse.openApp.focused', "Focused already-running");
		if (!result.frontmost) {
			return textResult(localize(
				'computerUse.openApp.notFrontmost',
				"{0} {1} (pid {2}), but it did not reach the foreground within the wait. Do not click yet — read the screen to see what actually has focus.",
				verb, result.app.name, result.app.pid,
			));
		}
		return textResult(localize(
			'computerUse.openApp.result',
			"{0} {1} (pid {2}) and it is now frontmost.",
			verb, result.app.name, result.app.pid,
		));
	}
}

export const computerUseToolDataList: readonly IToolData[] = [
	ComputerUseReadScreenToolData,
	ComputerUseReadScreenChangesToolData,
	ComputerUseScreenshotToolData,
	ComputerUseClickToolData,
	ComputerUseTypeToolData,
	ComputerUseKeyToolData,
	ComputerUseScrollToolData,
	ComputerUseCursorToolData,
	ComputerUseWaitForStableToolData,
	ComputerUseListAppsToolData,
	ComputerUseDragToolData,
	ComputerUseHoverToolData,
	ComputerUseClipboardReadToolData,
	ComputerUseClipboardWriteToolData,
	ComputerUseOpenAppToolData,
];
