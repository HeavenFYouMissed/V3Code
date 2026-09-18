/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The wire contract between V3Code and the native computer-use helper.
 *
 * Framing is newline-delimited JSON over the helper's stdio: exactly one JSON object per line
 * in each direction. The helper's stdout carries protocol traffic only — all logging goes to
 * stderr — so a stray `print` in the helper does not corrupt the stream.
 *
 * Everything here is pure data. This module must stay free of platform and Electron imports so
 * both the renderer and the main process can depend on it.
 */

/**
 * Bumped whenever the shape of a request or response changes incompatibly.
 *
 * The helper reports the version it was built against from {@link ComputerUsePingResult}, and the
 * service refuses to use a helper whose version differs. A stale helper left in `~/.v3code/bin`
 * after an app update would otherwise fail in ways that look like feature bugs.
 *
 * **Version 2** carries three changes that a version-1 helper cannot fake, which is precisely why
 * the version must move rather than the features being probed for:
 *
 * 1. **Refs are stable across snapshots.** A version-1 helper mints a fresh generation and drops its
 *    whole ref table on every `axTree` call, so no ref ever appears in two snapshots. Version 2 binds
 *    a ref to `(element identity, role, label)` and keeps it while those hold, and re-validates the
 *    fingerprint inside `resolve()` immediately before dispatch. Diffing is impossible without this,
 *    and — worse than impossible — a diff computed against a version-1 helper's snapshots would
 *    silently report the entire tree as replaced on every turn while looking like it worked.
 * 2. **`generation` means "snapshot sequence number", not "kill switch".** Callers may now hold a ref
 *    across generations. A version-1 helper would reject exactly those refs as stale.
 * 3. **New methods** — `axTreeDiff`, `settle`, `forceElectronAccessibility` and the three `observe*`
 *    methods. An older helper answers an unknown method with `internal`, which surfaces as a bug
 *    report rather than as "please update".
 *
 * So the failure mode this bump buys is the right one: a stale helper is rejected outright at `ping`
 * with `helperVersionMismatch` and reinstalled, instead of half-working with a diff engine quietly
 * comparing incomparable refs.
 *
 * Version 3 adds `drag`, `mouseMove`, `clipboardRead`, `clipboardWrite` and `openApplication`. Purely
 * additive — nothing existing changed shape — but the bump is still correct, because a version-2
 * helper answers those five with `internal` ("unknown method"), which reads to the model as a broken
 * tool rather than as an out-of-date helper. Failing at `ping` names the real problem.
 */
export const COMPUTER_USE_PROTOCOL_VERSION = 3;

/**
 * IPC channel name, registered in `src/vs/code/electron-main/app.ts`.
 *
 * Lives in the shared contract so the renderer service and the main-process registration cannot
 * drift apart, and so neither side has to import across a layer boundary to agree on it.
 */
export const COMPUTER_USE_CHANNEL_NAME = 'void-channel-computerUse';

/** Default long-edge budget, in pixels, for a screenshot handed to a vision model. */
export const COMPUTER_USE_DEFAULT_MAX_LONG_EDGE = 1080;

/**
 * Hard cap, in milliseconds, on how long `settle` may wait for the UI to stop moving.
 *
 * Chosen against the animations it has to outlast: AppKit sheet and window transitions run 200-350 ms,
 * Core Animation's implicit duration is 250 ms, and Windows Fluent "medium" motion is 250 ms. 1500 ms
 * clears all of them with room for a slow machine, while still being short enough that a chronically
 * noisy application costs a second and a half rather than hanging the agent.
 */
export const COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS = 1500;

/**
 * Default period of accessibility-notification silence that counts as quiescent.
 *
 * A 60 Hz frame is 16.7 ms, so 120 ms is more than seven frames of silence: comfortably longer than
 * the gap between notifications during an active animation, and short enough that the common case —
 * a menu opens, one structure-change fires, done — costs about 120 ms rather than a full budget.
 */
export const COMPUTER_USE_DEFAULT_SETTLE_QUIET_MS = 120;

/**
 * Default budget for `forceElectronAccessibility` to wait for a tree to appear.
 *
 * Chromium turns its accessibility engine on *asynchronously* after `AXManualAccessibility` is set,
 * so walking immediately returns the single placeholder node and looks like a permission failure.
 * A second is enough for every Electron application measured.
 */
export const COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS = 1000;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Machine-readable failure reasons. Callers branch on these; the accompanying message is for
 * humans only and must never be parsed.
 */
export type ComputerUseErrorCode =
	/** macOS Accessibility (or Windows UIA) trust has not been granted to the helper. */
	| 'accessibilityNotTrusted'
	/** Screen Recording permission has not been granted. */
	| 'screenRecordingNotGranted'
	/** A permission prompt was shown and the user declined. */
	| 'permissionDenied'
	/** No helper binary is installed, or it failed verification. */
	| 'helperMissing'
	/** The helper speaks a different {@link COMPUTER_USE_PROTOCOL_VERSION}. */
	| 'helperVersionMismatch'
	/** The frontmost application has not been approved by the user for computer use. */
	| 'appNotApproved'
	/** The action is not permitted for the frontmost application's tier (see computerUseAppTiers). */
	| 'appTierForbidsAction'
	/** The element reference is no longer live — the caller must re-read the screen. */
	| 'refStale'
	/** The reference or point did not resolve to an actionable element. */
	| 'targetNotFound'
	/** The helper did not answer within the per-method budget. */
	| 'timeout'
	/** The caller cancelled, or the user pressed Escape. */
	| 'cancelled'
	/** Anything not covered above. Treat as a bug. */
	| 'internal';

/** A structured failure from the helper or from the service's own pre-flight checks. */
export interface ComputerUseError {
	readonly code: ComputerUseErrorCode;
	/** Human-readable detail. Never parse this. */
	readonly message: string;
	/**
	 * True when retrying the identical request could plausibly succeed — for example a `timeout`
	 * on a busy machine. False for `appTierForbidsAction`, where retrying is pointless.
	 */
	readonly retryable?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Targets, buttons, modifiers
// ---------------------------------------------------------------------------------------------

/**
 * What an action acts upon.
 *
 * `ref` is the primary form: the caller reads the screen, receives opaque refs, and acts on one.
 * This mirrors the `aria-ref=` contract already used by V3Code's browser tools and is far more
 * robust than coordinates, which drift as soon as anything scrolls or resizes.
 *
 * `point` exists only for surfaces that expose no accessibility tree — canvases, games, some
 * Electron apps before accessibility is forced on. Coordinates are in *image* pixels of the
 * screenshot the caller was given; convert with computerUseCoordinates before use.
 */
export type ComputerUseTarget =
	| { readonly kind: 'ref'; readonly ref: string }
	| { readonly kind: 'point'; readonly x: number; readonly y: number };

/** Mouse buttons the helper can dispatch. */
export type ComputerUseMouseButton = 'left' | 'right' | 'middle';

/** Modifier keys, named platform-neutrally. The helper maps these to native flags. */
export type ComputerUseModifier = 'shift' | 'control' | 'alt' | 'meta';

/** Scroll axis and direction. */
export type ComputerUseScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * How an action was actually carried out.
 *
 * The accessibility path is strongly preferred; `synthesized` means the helper had to fall back to
 * raw event injection because the element exposed no usable action. Surfacing this lets the service
 * log the fallback rate, which is the health metric for the whole approach.
 */
export type ComputerUseDispatchMethod = 'accessibility' | 'synthesized';

// ---------------------------------------------------------------------------------------------
// Accessibility tree
// ---------------------------------------------------------------------------------------------

/** A rectangle in physical screen pixels, origin top-left of the primary display. */
export interface ComputerUseRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * One node of the accessibility tree, flattened for transport.
 *
 * `ref` is an opaque handle minted by the helper and valid only until the helper's generation
 * counter advances; acting on a stale ref yields {@link ComputerUseErrorCode} `refStale` rather
 * than silently hitting the wrong element.
 */
export interface ComputerUseAxNode {
	readonly ref: string;
	/** Platform role, normalized to lower camel case (e.g. `button`, `textField`, `checkBox`). */
	readonly role: string;
	/** Accessible label, title, or visible text. Absent when the element is unlabelled. */
	readonly label?: string;
	/** Current value for value-bearing elements (text fields, sliders, checkboxes). */
	readonly value?: string;
	readonly enabled: boolean;
	readonly focused: boolean;
	/** Screen bounds, when the platform reports them. */
	readonly frame?: ComputerUseRect;
	/** Actions the element advertises, e.g. `press`, `showMenu`. Drives dispatch-method choice. */
	readonly actions?: readonly string[];
	readonly children?: readonly ComputerUseAxNode[];
}

// ---------------------------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------------------------

/**
 * An application as the helper sees it.
 *
 * `id` is the stable identity used for approval decisions and tier classification: the bundle
 * identifier on macOS, the executable name on Windows.
 */
export interface ComputerUseApp {
	readonly id: string;
	readonly name: string;
	readonly pid: number;
}

/** The frontmost application, plus its focused window title when one is available. */
export interface ComputerUseFrontmostApp extends ComputerUseApp {
	readonly title?: string;
}

// ---------------------------------------------------------------------------------------------
// Method params and results
// ---------------------------------------------------------------------------------------------

/** Parameters for {@link ComputerUseMethod} `capture`. */
export interface ComputerUseCaptureParams {
	/** Which display to capture. Omit for the display containing the frontmost window. */
	readonly displayId?: number;
	/**
	 * Downscale so the longer edge does not exceed this many pixels. Defaults to
	 * {@link COMPUTER_USE_DEFAULT_MAX_LONG_EDGE}. Never upscales.
	 */
	readonly maxLongEdge?: number;
	/**
	 * Processes to omit from the capture. The service always passes V3Code's own pid so the agent
	 * never sees — and recurses on — its own window.
	 */
	readonly excludePids?: readonly number[];
}

/** A captured screenshot. */
export interface ComputerUseCaptureResult {
	/** Width of the returned image, in image pixels. */
	readonly width: number;
	/** Height of the returned image, in image pixels. */
	readonly height: number;
	/**
	 * Image pixels per physical pixel. `1` means no downscaling; `0.5` means the image is half the
	 * physical size. Feed this to computerUseCoordinates to map model coordinates back to the screen.
	 */
	readonly scale: number;
	readonly format: 'png';
	/** Base64-encoded image bytes, without a data-URI prefix. */
	readonly dataBase64: string;
	/** Which pids were actually excluded, so the caller can verify its request was honoured. */
	readonly excludedPids: readonly number[];
	/**
	 * Identity and physical bounds of the display this image came from.
	 *
	 * Required, not decorative: the model replies in *image* pixels, and turning those back into a
	 * clickable screen coordinate needs both the scale and the display's origin on the virtual
	 * desktop. Without the origin every point target on a secondary display lands on the primary one.
	 * The helper is the only component that knows which display it captured, so it must report this.
	 */
	readonly display: ComputerUseCaptureDisplay;
}

/** Identity and physical placement of a captured display. */
export interface ComputerUseCaptureDisplay {
	readonly displayId: number;
	/** Physical bounds on the virtual desktop, including origin. */
	readonly bounds: ComputerUseRect;
}

/** Parameters for a click. */
export interface ComputerUseClickParams {
	readonly target: ComputerUseTarget;
	/** Defaults to `left`. */
	readonly button?: ComputerUseMouseButton;
	readonly modifiers?: readonly ComputerUseModifier[];
	/** Number of clicks; 2 for a double-click. Defaults to 1. */
	readonly clickCount?: number;
}

/** Parameters for typing literal text. */
export interface ComputerUseTypeParams {
	readonly text: string;
	/** When set, the text replaces the target's existing value rather than being appended. */
	readonly target?: ComputerUseTarget;
}

/** Parameters for a key chord, e.g. `cmd+shift+p`. */
export interface ComputerUseKeyParams {
	/** Modifiers joined with `+`, then the key name. Case-insensitive. */
	readonly chord: string;
	/** Repeat count. Defaults to 1. */
	readonly repeat?: number;
}

/** Parameters for a drag: press at `from`, move to `to`, release. */
export interface ComputerUseDragParams {
	readonly from: ComputerUseTarget;
	readonly to: ComputerUseTarget;
	/** Defaults to `left`. */
	readonly button?: ComputerUseMouseButton;
	readonly modifiers?: readonly ComputerUseModifier[];
	/**
	 * How long the movement takes, in milliseconds. Defaults to a short humane glide.
	 *
	 * Not cosmetic. A drag delivered as a single instantaneous jump is missed entirely by a great deal
	 * of software, which samples pointer position on a timer and needs to observe intermediate
	 * positions to recognise a drag at all.
	 */
	readonly durationMs?: number;
}

/** Parameters for moving the pointer without pressing. */
export interface ComputerUseMouseMoveParams {
	readonly target: ComputerUseTarget;
	/**
	 * Milliseconds to remain there before returning.
	 *
	 * Hover-triggered UI appears on a delay, so returning the instant the pointer lands means the next
	 * screenshot shows the state *before* whatever the hover was meant to reveal.
	 */
	readonly settleMs?: number;
}

/** The clipboard's text contents. */
export interface ComputerUseClipboardReadResult {
	/** Empty when the clipboard holds no text — an image or a file reference reads as empty. */
	readonly text: string;
	/** Length in characters, so a caller can log the disclosure without logging the content. */
	readonly length: number;
	/** True when the clipboard holds something that is not text and therefore was not read. */
	readonly hasNonTextContent: boolean;
}

/** Parameters for replacing the clipboard's text. */
export interface ComputerUseClipboardWriteParams {
	readonly text: string;
}

/** Parameters for launching or focusing an application. */
export interface ComputerUseOpenApplicationParams {
	/**
	 * Bundle identifier, executable name, or display name.
	 *
	 * All three are accepted because the model will usually only know the name a human would say.
	 */
	readonly app: string;
	/**
	 * Milliseconds to wait for the application to become frontmost. Defaults to a few seconds.
	 *
	 * A cold launch is slow, and returning before the window exists hands the model an empty tree it
	 * will read as "the application failed to open".
	 */
	readonly waitMs?: number;
}

/** The application that was launched or focused. */
export interface ComputerUseOpenApplicationResult {
	readonly app: ComputerUseApp;
	/** True when this call started the process; false when it was already running and got focused. */
	readonly launched: boolean;
	/** True when it reached the foreground within the budget. */
	readonly frontmost: boolean;
}

/** Parameters for a scroll. */
export interface ComputerUseScrollParams {
	readonly target: ComputerUseTarget;
	readonly direction: ComputerUseScrollDirection;
	/** Scroll ticks. */
	readonly amount: number;
}

/** Parameters for reading the accessibility tree. */
export interface ComputerUseAxTreeParams {
	/** Process to read. Omit for the frontmost application. */
	readonly pid?: number;
	/** Depth limit; deep trees are expensive to walk and to send. Defaults to a helper-chosen bound. */
	readonly maxDepth?: number;
}

/** The accessibility tree for one application. */
export interface ComputerUseAxTreeResult {
	readonly app: ComputerUseApp;
	readonly nodes: readonly ComputerUseAxNode[];
	/**
	 * Generation counter for the refs in this snapshot. Every ref minted here carries this
	 * generation; the helper rejects refs from an earlier one.
	 */
	readonly generation: number;
}

/** Result of any action that merely succeeds or fails. */
export interface ComputerUseActionResult {
	readonly ok: true;
	/** How the action was dispatched — see {@link ComputerUseDispatchMethod}. */
	readonly method: ComputerUseDispatchMethod;
}

/** A cursor position in physical screen pixels. */
export interface ComputerUseCursorResult {
	readonly x: number;
	readonly y: number;
}

/** The helper's identity, returned from `ping`. */
export interface ComputerUsePingResult {
	readonly protocolVersion: number;
	readonly platform: 'darwin' | 'win32';
	/** Helper build version, for logs and bug reports. */
	readonly helperVersion: string;
}

/** OS-level permission state, for surfacing actionable guidance to the user. */
export interface ComputerUseStatusResult {
	readonly installed: boolean;
	readonly protocolVersion: number;
	readonly accessibilityTrusted: boolean;
	readonly screenRecordingGranted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Incremental accessibility reads
// ---------------------------------------------------------------------------------------------

/** Parameters for reading the accessibility tree relative to a snapshot the caller already has. */
export interface ComputerUseAxTreeDiffParams extends ComputerUseAxTreeParams {
	/**
	 * Generation of the snapshot the caller is holding.
	 *
	 * The helper uses it for two things: to answer `unchanged` outright when its notification observer
	 * has seen nothing since, and to say whether the refs from that generation are still comparable.
	 * It never diffs — that happens in `common/computerUseAxDiff.ts`, where it can be unit-tested
	 * once instead of being written twice in Swift and C++.
	 */
	readonly sinceGeneration: number;
}

/** An accessibility tree annotated with what it can safely be compared against. */
export interface ComputerUseAxTreeDiffResult extends ComputerUseAxTreeResult {
	/** Echo of the requested baseline, so a late response cannot be applied to the wrong snapshot. */
	readonly sinceGeneration: number;
	/**
	 * True when the helper vouches that refs minted in `sinceGeneration` still mean the same elements.
	 *
	 * False after anything that breaks the correspondence — the target application restarted, a
	 * `cancel` interrupted a walk, `sinceGeneration` is older than the helper's own history, or the
	 * helper has just forced accessibility on and the tree is about to appear from nothing. The caller
	 * **must** send the full tree when this is false; diffing against a baseline the helper cannot
	 * vouch for is silently wrong, which is worse than being verbose.
	 */
	readonly baselineComparable: boolean;
	/**
	 * True when nothing observable changed since `sinceGeneration`, in which case `nodes` is empty.
	 *
	 * The cheapest possible answer, and the common one in a read-act-read loop. Distinguished from an
	 * empty tree by `baselineComparable` plus this flag: an application with genuinely no accessible
	 * content reports `unchanged: false` with no nodes.
	 */
	readonly unchanged: boolean;
}

// ---------------------------------------------------------------------------------------------
// UI settle
// ---------------------------------------------------------------------------------------------

/** Why `settle` stopped waiting. */
export type ComputerUseSettleReason =
	/** No qualifying accessibility notification arrived for the quiet period. The good outcome. */
	| 'quiescent'
	/** Notifications never went quiet, but consecutive frames of the target window matched. */
	| 'frameStable'
	/** The budget ran out while the UI was still moving. `settled` is false. */
	| 'budgetExceeded'
	/**
	 * The surface exposes no accessibility notifications at all, so only frame comparison was
	 * available. Correlates with `method: 'synthesized'` — the same population of canvas-drawn and
	 * accessibility-less applications.
	 */
	| 'notificationsUnavailable';

/** Parameters for waiting until an application's UI stops changing. */
export interface ComputerUseSettleParams {
	/** Process to watch. Omit for the frontmost application. */
	readonly pid?: number;
	/** Hard cap on waiting. Defaults to {@link COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS}. */
	readonly timeoutMs?: number;
	/**
	 * Notification silence that counts as quiescent. Defaults to
	 * {@link COMPUTER_USE_DEFAULT_SETTLE_QUIET_MS}.
	 */
	readonly quietPeriodMs?: number;
	/**
	 * Confirm quiescence with frame comparison before reporting settled.
	 *
	 * Worth the cost because notification quiescence alone misses the exact case this exists to
	 * catch: a layer-backed Core Animation transition updates no accessibility geometry and fires no
	 * notification, so an application can be visually mid-slide and accessibility-silent. Defaults to
	 * true in the helper.
	 */
	readonly requireFrameStability?: boolean;
}

/** Outcome of a settle wait. */
export interface ComputerUseSettleResult {
	/**
	 * True only when the UI demonstrably stopped changing.
	 *
	 * A caller must surface `false` to the model rather than proceeding as though it were true: an
	 * action dispatched against a still-animating window lands on whatever used to be under the
	 * pointer, and the model needs to know to re-read instead of trusting a stale observation.
	 */
	readonly settled: boolean;
	readonly waitedMs: number;
	readonly reason: ComputerUseSettleReason;
	/** Frames compared, for tuning the sampling schedule against real applications. */
	readonly frameSamples?: number;
	/** Qualifying notifications seen while waiting; a large number means a chronically noisy app. */
	readonly notifications?: number;
}

// ---------------------------------------------------------------------------------------------
// Forcing accessibility on
// ---------------------------------------------------------------------------------------------

/** Parameters for asking a process to expose its accessibility tree. */
export interface ComputerUseForceAccessibilityParams {
	/** Process to enable. Required — this is never a guess about the frontmost application. */
	readonly pid: number;
	/**
	 * How long to poll for the tree to populate. Defaults to
	 * {@link COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS}.
	 */
	readonly timeoutMs?: number;
}

/** Result of forcing accessibility on for a process. */
export interface ComputerUseForceAccessibilityResult {
	/**
	 * True when the platform accepted the request — `AXManualAccessibility` on darwin, the equivalent
	 * provider hint on win32. Says nothing about whether a tree actually appeared.
	 */
	readonly applied: boolean;
	/** True once a walk returned more than the single placeholder node an unenabled Electron app reports. */
	readonly treePopulated: boolean;
	readonly waitedMs: number;
	/** Top-level nodes visible once the flag took effect, for logs and bug reports. */
	readonly rootNodeCount: number;
}

// ---------------------------------------------------------------------------------------------
// Ambient observation
// ---------------------------------------------------------------------------------------------

/** What an ambient observation session may collect. Mirrors the policy engine's mode vocabulary. */
export type ComputerUseObserveContent = 'axTree' | 'axTreeAndScreenshots';

/** Parameters for starting an ambient observation session. */
export interface ComputerUseObserveStartParams {
	/** Process to observe. Required: ambient observation is always per-application, never global. */
	readonly pid: number;
	/** Application identity as the policy engine knows it, so the helper's logs name what it watched. */
	readonly appId: string;
	/** Milliseconds between samples. */
	readonly intervalMs: number;
	/**
	 * Wall-clock epoch milliseconds at which the helper must stop by itself, whatever else happens.
	 *
	 * Mandatory, and it is the whole safety story for this method: if V3Code crashes, is force-quit,
	 * or loses the pipe, an already-running observation session must expire on its own rather than
	 * keep sampling the user's screen with nobody left to stop it. The caller sets it from the
	 * `permittedUntil` of the policy decision that authorized the session.
	 */
	readonly stopAtMs: number;
	readonly content: ComputerUseObserveContent;
	/** Screenshot long-edge budget. Ignored unless `content` includes screenshots. */
	readonly maxLongEdge?: number;
	/** Processes to omit from screenshots. The service always includes V3Code's own pid. */
	readonly excludePids?: readonly number[];
}

/** Parameters for stopping ambient observation. */
export interface ComputerUseObserveStopParams {
	/** Session to stop. Omit to stop every session, which is what a revocation or shutdown wants. */
	readonly pid?: number;
}

/** One running ambient observation session, as the helper reports it. */
export interface ComputerUseObserveSession {
	readonly pid: number;
	readonly appId: string;
	/** Epoch milliseconds the session began. */
	readonly startedAt: number;
	/** Epoch milliseconds the session will stop itself — see {@link ComputerUseObserveStartParams.stopAtMs}. */
	readonly stopAtMs: number;
	readonly intervalMs: number;
	readonly content: ComputerUseObserveContent;
	/** Samples taken so far, so the caller can tell a live session from a wedged one. */
	readonly samples: number;
}

/**
 * The helper's view of what it is currently observing.
 *
 * Returned from all three `observe*` methods so start and stop are self-verifying: the caller never
 * has to assume its request took effect, and a reconciliation loop can compare this against the
 * policy and stop anything the policy no longer permits.
 */
export interface ComputerUseObserveStatusResult {
	/** True when at least one session is running. Equivalent to `sessions.length > 0`. */
	readonly observing: boolean;
	readonly sessions: readonly ComputerUseObserveSession[];
}

// ---------------------------------------------------------------------------------------------
// Method table
// ---------------------------------------------------------------------------------------------

/**
 * Every method the helper implements, mapping name to its params and result.
 *
 * Declaring it as one table means the channel, the helper, and the tools cannot drift: adding a
 * method here produces a compile error everywhere it must be handled.
 */
export interface ComputerUseMethods {
	readonly ping: { params: void; result: ComputerUsePingResult };
	readonly status: { params: void; result: ComputerUseStatusResult };
	readonly capture: { params: ComputerUseCaptureParams; result: ComputerUseCaptureResult };
	readonly click: { params: ComputerUseClickParams; result: ComputerUseActionResult };
	readonly type: { params: ComputerUseTypeParams; result: ComputerUseActionResult };
	readonly key: { params: ComputerUseKeyParams; result: ComputerUseActionResult };
	readonly scroll: { params: ComputerUseScrollParams; result: ComputerUseActionResult };
	readonly cursorPosition: { params: void; result: ComputerUseCursorResult };
	readonly frontmostApp: { params: void; result: ComputerUseFrontmostApp };
	readonly listApps: { params: void; result: readonly ComputerUseApp[] };
	readonly axTree: { params: ComputerUseAxTreeParams; result: ComputerUseAxTreeResult };
	readonly cancel: { params: void; result: ComputerUseActionResult };

	// --- protocol version 3 ------------------------------------------------------------------
	//
	// Four things a person can do at a machine that the first cut could not. Each was an omission
	// rather than a decision: the first pass built the read-then-act loop and stopped at its edges.

	/**
	 * Presses at one target, moves to another, and releases.
	 *
	 * Distinct from click-then-click because the button stays down throughout, which is the entire
	 * point for reordering a list, resizing by a handle, or a canvas selection. There is no
	 * accessibility equivalent, so this is always `synthesized`; a `press` action cannot express
	 * "and now move 200 pixels while still holding".
	 */
	readonly drag: { params: ComputerUseDragParams; result: ComputerUseActionResult };

	/**
	 * Moves the pointer without pressing anything.
	 *
	 * Needed because a great deal of UI only exists once hovered — menu bars that open on hover,
	 * disclosure controls, tooltips carrying the text the model needs to read. Without this the agent
	 * cannot reach any of it, and cannot tell that it is missing.
	 */
	readonly mouseMove: { params: ComputerUseMouseMoveParams; result: ComputerUseActionResult };

	/**
	 * Reads the system clipboard as text.
	 *
	 * Worth being deliberate about: the clipboard frequently holds something the user copied for their
	 * own reasons and never intended to send anywhere. Reading it is a real disclosure, so the result
	 * says how large it was and the tool description tells the model to read it only when the task
	 * actually concerns the clipboard.
	 */
	readonly clipboardRead: { params: void; result: ComputerUseClipboardReadResult };

	/** Replaces the system clipboard contents with text. */
	readonly clipboardWrite: { params: ComputerUseClipboardWriteParams; result: ComputerUseActionResult };

	/**
	 * Launches an application, or brings it to the front when it is already running.
	 *
	 * Everything else in this table operates on what is already open, which meant the agent could not
	 * begin a task that started with "open X". Resolves by bundle identifier or by display name, and
	 * reports the pid so the caller can immediately read the tree it just created.
	 */
	readonly openApplication: { params: ComputerUseOpenApplicationParams; result: ComputerUseOpenApplicationResult };

	// --- protocol version 2 ------------------------------------------------------------------

	/**
	 * Reads the accessibility tree annotated against a snapshot the caller already holds.
	 *
	 * Not a diff: the helper still returns nodes, and `common/computerUseAxDiff.ts` computes the
	 * patch. What the helper adds is the two things only it can know — whether its refs from
	 * `sinceGeneration` are still comparable, and whether its notification observer saw anything at
	 * all since then, which lets the common case answer `unchanged` with an empty node list.
	 */
	readonly axTreeDiff: { params: ComputerUseAxTreeDiffParams; result: ComputerUseAxTreeDiffResult };

	/**
	 * Waits until the target application's UI stops changing, or the budget runs out.
	 *
	 * Runs in the helper of necessity: notification quiescence needs an `AXObserver` or UIA callback
	 * on a run loop, and frame comparison needs raster frames that must never cross the pipe.
	 * Reports `settled: false` on timeout rather than pretending — see
	 * {@link ComputerUseSettleResult.settled}.
	 */
	readonly settle: { params: ComputerUseSettleParams; result: ComputerUseSettleResult };

	/**
	 * Asks a process to expose its accessibility tree, and waits for it to appear.
	 *
	 * Electron and Chromium applications report a single placeholder node until
	 * `AXManualAccessibility` is set, which makes them look permission-blocked when they are merely
	 * switched off. Call this at application-approval time rather than at first walk: the tree
	 * populates asynchronously, so paying that latency once and off the critical path is the
	 * difference between a slow approval and a slow every-turn. Expect the first `axTree` afterwards
	 * to diff as one enormous addition — that is correct, not a bug.
	 */
	readonly forceElectronAccessibility: {
		params: ComputerUseForceAccessibilityParams;
		result: ComputerUseForceAccessibilityResult;
	};

	/**
	 * Starts sampling one application on a timer.
	 *
	 * The most privileged method in the table: it captures without a tool call behind it. Callers must
	 * obtain a permitting decision from `common/computerUseObservation.ts` first and pass that
	 * decision's `permittedUntil` as {@link ComputerUseObserveStartParams.stopAtMs}, so the session
	 * dies on its own if V3Code stops supervising it.
	 */
	readonly observeStart: { params: ComputerUseObserveStartParams; result: ComputerUseObserveStatusResult };

	/** Stops one ambient observation session, or every session when no pid is given. */
	readonly observeStop: { params: ComputerUseObserveStopParams; result: ComputerUseObserveStatusResult };

	/**
	 * Reports what the helper is currently observing.
	 *
	 * The reconciliation input: a supervisor compares this against the policy and stops anything the
	 * policy no longer permits, so a revoked grant takes effect even if the revocation's own
	 * `observeStop` was lost.
	 */
	readonly observeStatus: { params: void; result: ComputerUseObserveStatusResult };
}

/** Name of a helper method. */
export type ComputerUseMethod = keyof ComputerUseMethods;

/** Params type for a given method. */
export type ComputerUseParamsFor<M extends ComputerUseMethod> = ComputerUseMethods[M]['params'];

/** Result type for a given method. */
export type ComputerUseResultFor<M extends ComputerUseMethod> = ComputerUseMethods[M]['result'];

/** Methods that mutate the machine, and therefore require approval and tier checks. */
export const COMPUTER_USE_MUTATING_METHODS: readonly ComputerUseMethod[] = [
	'click',
	'type',
	'key',
	'scroll',
	'drag',
	'clipboardWrite',
	'openApplication',
	// `mouseMove` is deliberately absent. It presses nothing and changes no application state; treating
	// a hover as mutating would put the overlay up for every pointer move in a read-then-act loop.
	// `clipboardRead` is likewise absent — it reads, and the disclosure it carries is handled by the
	// tool description telling the model when reading is warranted, not by an action gate.
];

/**
 * True when a method changes machine state rather than merely observing it.
 *
 * Read-only methods still require consent and a granted OS permission, but they skip the
 * per-action approval gate, which keeps the read-then-act loop usable.
 */
export function isMutatingComputerUseMethod(method: ComputerUseMethod): boolean {
	return COMPUTER_USE_MUTATING_METHODS.includes(method);
}

/**
 * Methods that capture without a tool call behind them, and so need their own gate.
 *
 * Declared separately from {@link COMPUTER_USE_MUTATING_METHODS} rather than folded into it because
 * "mutating" is the wrong word for it: `observeStart` changes nothing on the machine, it changes what
 * V3Code is allowed to see, and it must be gated on a permitting decision from
 * `common/computerUseObservation.ts` rather than on the per-action approval prompt. Adding it to the
 * mutating list would have run it through the wrong check and, worse, silently changed the meaning of
 * a list five landed files already consult.
 */
export const COMPUTER_USE_PRIVILEGED_METHODS: readonly ComputerUseMethod[] = [
	'observeStart',
];

/** True when a method requires an ambient-observation policy decision rather than an action approval. */
export function isPrivilegedComputerUseMethod(method: ComputerUseMethod): boolean {
	return COMPUTER_USE_PRIVILEGED_METHODS.includes(method);
}

/**
 * Methods the service must precede with an implicit `settle`.
 *
 * Observing an application that is still animating produces a snapshot of a state that no longer
 * exists by the time the model reads it, and every subsequent ref is then suspect.
 */
export const COMPUTER_USE_SETTLE_BEFORE_METHODS: readonly ComputerUseMethod[] = [
	'capture',
	'axTree',
	'axTreeDiff',
];

/**
 * Methods the service must follow with an implicit `settle`, on by default.
 *
 * **This is the design point the whole settle feature rests on, so it is a contract and not a
 * suggestion.** The failure this exists to fix — clicking while a sheet is still sliding in — is only
 * actually fixed if settling happens automatically at the point of action. A `computer_settle` tool
 * the model has to remember to call will not get called, and a `waitForSettle` parameter defaulting
 * to false is the same bug wearing a different hat. The service applies this; the four action param
 * types were deliberately left unchanged so no landed file has to move for it.
 */
export const COMPUTER_USE_SETTLE_AFTER_METHODS: readonly ComputerUseMethod[] = [
	'click',
	'type',
	'key',
	'scroll',
];

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

/** A request line written to the helper's stdin. */
export interface ComputerUseRequest<M extends ComputerUseMethod = ComputerUseMethod> {
	/** Correlation id, unique per helper process. */
	readonly id: number;
	readonly method: M;
	readonly params: ComputerUseParamsFor<M>;
	/** Protocol version of the *caller*, so the helper can reject a mismatch symmetrically. */
	readonly protocolVersion: number;
}

/** A successful response line read from the helper's stdout. */
export interface ComputerUseSuccessResponse<M extends ComputerUseMethod = ComputerUseMethod> {
	readonly id: number;
	readonly ok: true;
	readonly result: ComputerUseResultFor<M>;
}

/** A failed response line read from the helper's stdout. */
export interface ComputerUseErrorResponse {
	readonly id: number;
	readonly ok: false;
	readonly error: ComputerUseError;
}

/** Either outcome of a request. */
export type ComputerUseResponse<M extends ComputerUseMethod = ComputerUseMethod> =
	| ComputerUseSuccessResponse<M>
	| ComputerUseErrorResponse;

/**
 * Narrows a response to its success form.
 *
 * Written as a type guard so callers cannot read `.result` off a failure by accident.
 */
export function isComputerUseSuccess<M extends ComputerUseMethod>(
	response: ComputerUseResponse<M>,
): response is ComputerUseSuccessResponse<M> {
	return response.ok === true;
}

/** Builds a {@link ComputerUseError}, so call sites do not hand-roll the shape. */
export function createComputerUseError(
	code: ComputerUseErrorCode,
	message: string,
	retryable?: boolean,
): ComputerUseError {
	return { code, message, retryable };
}
