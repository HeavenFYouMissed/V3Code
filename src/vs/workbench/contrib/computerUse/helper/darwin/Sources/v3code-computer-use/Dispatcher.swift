/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import CoreGraphics
import Foundation

/// Routes one request line to one handler.
///
/// Every method in `ComputerUseMethods` is handled here and nowhere else, so the wire surface is
/// enumerable by reading a single switch.
final class Dispatcher {
	private let writer: ResponseWriter
	private let refTable = RefTable()
	private let cancellation = Cancellation()
	private let decoder = JSONDecoder()
	private let watcher = AxWatcher()
	private let snapshots = AxSnapshots()
	private let observation: Observation

	/// Actions run one at a time.
	///
	/// Concurrent input dispatch is meaningless — there is one pointer and one focused element — and
	/// overlapping a click with a tree read would hand out refs describing a screen that no longer exists.
	/// Ambient observation samples go through this same queue for the same reason.
	private let workQueue = DispatchQueue(label: "dev.v3code.computerUse.work", qos: .userInitiated)

	init(writer: ResponseWriter) {
		self.writer = writer
		self.observation = Observation(
			workQueue: workQueue,
			refTable: refTable,
			snapshots: snapshots,
			watcher: watcher
		)
	}

	/// Handles a line from stdin.
	///
	/// `cancel`, `ping`, `status`, `observeStop` and `observeStatus` are answered inline on the calling
	/// (reader) thread; everything else is queued. That split is what makes cancellation work at all:
	/// queued behind a running action, a cancel could only ever arrive after the thing it was meant to
	/// stop had finished. `observeStop` is inline for the same reason and it matters more — a revocation
	/// that waits its turn behind a wedged tree walk is a revocation that keeps sampling the user's
	/// screen for as long as the walk takes.
	func handle(line: Data) {
		guard !line.isEmpty else { return }
		guard let header = try? decoder.decode(RequestHeader.self, from: line) else {
			// No id means no correlation, so there is nothing to answer. Dropping the line is the only
			// option; a response with a fabricated id would resolve someone else's request.
			Log.error("dropping an unparseable request line (\(line.count) bytes)")
			return
		}

		if let version = header.protocolVersion, version != COMPUTER_USE_PROTOCOL_VERSION {
			writer.send(
				id: header.id,
				error: HelperError(
					.helperVersionMismatch,
					"caller speaks protocol \(version); this helper speaks \(COMPUTER_USE_PROTOCOL_VERSION)"
				)
			)
			return
		}

		switch header.method {
		case "cancel":
			cancellation.cancel()
			writer.send(id: header.id, result: ActionResult(method: .accessibility))
		case "ping":
			writer.send(
				id: header.id,
				result: PingResult(
					protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
					helperVersion: HELPER_VERSION
				)
			)
		case "status":
			writer.send(
				id: header.id,
				result: StatusResult(
					installed: true,
					protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
					accessibilityTrusted: Ax.isProcessTrusted(),
					screenRecordingGranted: CGPreflightScreenCaptureAccess()
				)
			)
		case "observeStop":
			// No tier gate and no failure path: stopping is always the safe direction. A malformed
			// `params` is treated as "stop everything" rather than rejected, because the one thing this
			// must never do is decline to stop.
			let params: ObserveStopParams? = try? decodeParams(line)
			writer.send(id: header.id, result: observation.stop(pid: params?.pid))
		case "observeStatus":
			writer.send(id: header.id, result: observation.status())
		default:
			workQueue.async { [weak self] in
				self?.runQueued(header: header, line: line)
			}
		}
	}

	/// Waits for already-accepted work to finish, up to `timeout`.
	///
	/// Called when stdin closes. Without it the process would exit the instant the pipe went away and any
	/// request still on the queue would never be answered — from the caller's side an action that silently
	/// vanished, which is indistinguishable from one that ran.
	func drain(timeout: TimeInterval) {
		// Before anything else. The pipe is gone, so nobody is supervising ambient observation any more,
		// and the drain window is up to ten seconds of sampling with nobody left to stop it.
		observation.stop(pid: nil)
		let semaphore = DispatchSemaphore(value: 0)
		workQueue.async { semaphore.signal() }
		if semaphore.wait(timeout: .now() + timeout) != .success {
			Log.warn("exiting with work still in flight after \(timeout)s")
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Queued methods
	// ---------------------------------------------------------------------------------------------

	private func runQueued(header: RequestHeader, line: Data) {
		let token = cancellation.begin()
		do {
			try token.check()
			switch header.method {
			case "capture":
				let params: CaptureParams? = try decodeParams(line)
				writer.send(id: header.id, result: try Capture.run(params, cancellation: token))
			case "click":
				let params: ClickParams = try requireParams(line, method: "click")
				writer.send(id: header.id, result: try click(params, token: token))
			case "type":
				let params: TypeParams = try requireParams(line, method: "type")
				writer.send(id: header.id, result: try type(params, token: token))
			case "key":
				let params: KeyParams = try requireParams(line, method: "key")
				writer.send(id: header.id, result: try key(params, token: token))
			case "scroll":
				let params: ScrollParams = try requireParams(line, method: "scroll")
				writer.send(id: header.id, result: try scroll(params, token: token))
			case "drag":
				let params: DragParams = try requireParams(line, method: "drag")
				writer.send(id: header.id, result: try drag(params, token: token))
			case "mouseMove":
				let params: MouseMoveParams = try requireParams(line, method: "mouseMove")
				writer.send(id: header.id, result: try mouseMove(params, token: token))
			case "clipboardRead":
				let contents = SystemAccess.readClipboard()
				writer.send(id: header.id, result: ClipboardReadResult(
					text: contents.text,
					length: contents.length,
					hasNonTextContent: contents.hasNonTextContent
				))
			case "clipboardWrite":
				let params: ClipboardWriteParams = try requireParams(line, method: "clipboardWrite")
				try SystemAccess.writeClipboard(text: params.text)
				writer.send(id: header.id, result: ActionResult(method: .accessibility))
			case "openApplication":
				let params: OpenApplicationParams = try requireParams(line, method: "openApplication")
				writer.send(id: header.id, result: try openApplication(params))
			case "cursorPosition":
				writer.send(id: header.id, result: cursorPosition())
			case "frontmostApp":
				writer.send(id: header.id, result: try frontmostApp())
			case "listApps":
				writer.send(id: header.id, result: Apps.list())
			case "axTree":
				let params: AxTreeParams? = try decodeParams(line)
				writer.send(id: header.id, result: try axTree(params, token: token))
			case "axTreeDiff":
				let params: AxTreeDiffParams = try requireParams(line, method: "axTreeDiff")
				writer.send(id: header.id, result: try axTreeDiff(params, token: token))
			case "settle":
				let params: SettleParams? = try decodeParams(line)
				writer.send(id: header.id, result: try settle(params, token: token))
			case "forceElectronAccessibility":
				let params: ForceAccessibilityParams = try requireParams(
					line,
					method: "forceElectronAccessibility"
				)
				writer.send(id: header.id, result: try forceElectronAccessibility(params, token: token))
			case "observeStart":
				let params: ObserveStartParams = try requireParams(line, method: "observeStart")
				writer.send(id: header.id, result: try observeStart(params))
			default:
				writer.send(
					id: header.id,
					error: HelperError(.internalError, "unknown method '\(header.method)'")
				)
			}
		} catch let error as HelperError {
			writer.send(id: header.id, error: error)
		} catch {
			// Anything unexpected still becomes a typed response. A helper that dies on a bad request looks
			// to the user like a broken feature rather than a rejected action.
			writer.send(
				id: header.id,
				error: HelperError(.internalError, "unhandled failure: \(error)")
			)
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------------------------

	private func click(_ params: ClickParams, token: Cancellation.Token) throws -> ActionResult {
		try requireAccessibility()
		let actions = Actions(refTable: refTable, cancellation: token)
		let (resolved, pid) = try actions.resolve(params.target)
		try requireTarget(method: "click", pid: pid)
		return ActionResult(method: try actions.click(params, resolved: resolved))
	}

	private func type(_ params: TypeParams, token: Cancellation.Token) throws -> ActionResult {
		try requireAccessibility()
		let actions = Actions(refTable: refTable, cancellation: token)
		var resolved: Actions.Resolved?
		var pid: pid_t?
		if let target = params.target {
			let outcome = try actions.resolve(target)
			resolved = outcome.resolved
			pid = outcome.pid
		}
		// With no target the keystrokes go to whatever holds focus, so the frontmost app's tier governs.
		try requireTarget(method: "type", pid: pid ?? Apps.frontmost()?.pid)
		return ActionResult(method: try actions.type(params, resolved: resolved))
	}

	private func key(_ params: KeyParams, token: Cancellation.Token) throws -> ActionResult {
		try requireAccessibility()
		try requireTarget(method: "key", pid: Apps.frontmost()?.pid)
		let actions = Actions(refTable: refTable, cancellation: token)
		return ActionResult(method: try actions.key(params))
	}

	private func scroll(_ params: ScrollParams, token: Cancellation.Token) throws -> ActionResult {
		try requireAccessibility()
		let actions = Actions(refTable: refTable, cancellation: token)
		let (resolved, pid) = try actions.resolve(params.target)
		try requireTarget(method: "scroll", pid: pid)
		return ActionResult(method: try actions.scroll(params, resolved: resolved))
	}

	/// Presses at one target, glides to another, releases.
	///
	/// Both ends are resolved before anything is pressed. Resolving `to` only after the button is down
	/// would mean a failure there leaves the pointer held — a stuck mouse button the user has to clear
	/// by clicking, with no idea why their machine stopped responding to selection.
	private func drag(_ params: DragParams, token: Cancellation.Token) throws -> ActionResult {
		Overlay.announce("Dragging")
		try requireAccessibility()
		let actions = Actions(refTable: refTable, cancellation: token)
		let (from, fromPid) = try actions.resolve(params.from)
		let (to, _) = try actions.resolve(params.to)
		try requireTarget(method: "drag", pid: fromPid ?? Apps.frontmost()?.pid)
		try Synthesizer.drag(
			from: from.point,
			to: to.point,
			button: params.button ?? .left,
			flags: Keyboard.flags(for: params.modifiers ?? []),
			durationSeconds: Double(params.durationMs ?? 250) / 1000,
			cancellation: token
		)
		// Always synthesized: no accessibility action can express "hold this while moving elsewhere".
		return ActionResult(method: .synthesized)
	}

	private func mouseMove(_ params: MouseMoveParams, token: Cancellation.Token) throws -> ActionResult {
		Overlay.announce("Moving to")
		try requireAccessibility()
		let actions = Actions(refTable: refTable, cancellation: token)
		let (resolved, pid) = try actions.resolve(params.target)
		try requireTarget(method: "mouseMove", pid: pid ?? Apps.frontmost()?.pid)
		try Synthesizer.mouseMove(
			to: resolved.point,
			settleSeconds: Double(params.settleMs ?? 0) / 1000,
			cancellation: token
		)
		return ActionResult(method: .synthesized)
	}

	/// Launches or focuses an application.
	///
	/// Needs no accessibility permission: it asks the window server to open something, which is what a
	/// double-click in Finder does. Requiring the permission here would mean the agent could not even
	/// open the application whose tree it is about to be granted access to.
	private func openApplication(_ params: OpenApplicationParams) throws -> OpenApplicationResult {
		let outcome = try SystemAccess.openApplication(
			app: params.app,
			waitSeconds: Double(params.waitMs ?? 5000) / 1000
		)
		return OpenApplicationResult(
			app: AppResult(id: outcome.id, name: outcome.name, pid: outcome.pid),
			launched: outcome.launched,
			frontmost: outcome.frontmost
		)
	}

	private func cursorPosition() -> CursorResult {
		let point = Synthesizer.cursorPosition()
		let physical = Geometry.physicalPoint(fromPoints: point, displays: Geometry.displays())
		return CursorResult(x: Double(physical.x), y: Double(physical.y))
	}

	private func frontmostApp() throws -> FrontmostAppResult {
		guard let app = Apps.frontmost() else {
			throw HelperError(.targetNotFound, "no application is frontmost")
		}
		return FrontmostAppResult(
			id: app.id,
			name: app.name,
			pid: app.pid,
			title: Apps.focusedWindowTitle(pid: app.pid)
		)
	}

	private func axTree(_ params: AxTreeParams?, token: Cancellation.Token) throws -> AxTreeResult {
		let target = try resolveTarget(method: "axTree", pid: params?.pid)
		let tree = try walk(pid: target.pid, maxDepth: params?.maxDepth, token: token)
		return AxTreeResult(
			app: AppResult(id: target.identity.id, name: target.identity.name, pid: target.pid),
			nodes: tree.nodes,
			generation: tree.generation
		)
	}

	/// Reads a tree annotated against a baseline the caller already holds.
	///
	/// Two answers, and the cheap one is the common one. When the helper can vouch for the baseline *and*
	/// has evidence that nothing has happened since, it returns no nodes at all and leaves the generation
	/// where it was, so the caller keeps both its tree and its refs. Otherwise it walks and says whether
	/// the baseline is still worth diffing against — never silently, because a caller that diffs against a
	/// baseline the helper cannot vouch for gets a confident description of a screen that never existed.
	private func axTreeDiff(
		_ params: AxTreeDiffParams,
		token: Cancellation.Token
	) throws -> AxTreeDiffResult {
		let target = try resolveTarget(method: "axTreeDiff", pid: params.pid)
		let app = AppResult(id: target.identity.id, name: target.identity.name, pid: target.pid)
		watcher.ensureWatching(pid: target.pid)

		let vouched = snapshots.vouch(pid: target.pid, generation: params.sinceGeneration)
		if let record = vouched, record.notificationsAvailable {
			// Both conditions are required, and neither is sufficient. The fingerprint is the strong one —
			// it notices shape changes an application may report late or not at all — and the notification
			// counter covers what the fingerprint cannot see, a label or value changing with no change of
			// shape. The fingerprint is computed inside a suppression scope so that the notifications its
			// own traversal provokes are attributed to us; without that, this check would poison the next
			// one and the cheap path could never fire twice in a row.
			let fingerprint = watcher.withSuppression(pid: target.pid) {
				AxSnapshots.fingerprint(pid: target.pid)
			}
			let activity = watcher.activity(pid: target.pid)
			// Logged because "why did the cheap path not fire" is the first question anyone tuning this
			// asks, and the answer is one of exactly three things.
			Log.debug(
				"axTreeDiff pid \(target.pid) baseline generation \(record.generation): notifications "
					+ "\(activity.count) vs \(record.activity), fingerprint "
					+ "\(fingerprint == record.fingerprint ? "unchanged" : "changed")"
			)
			if activity.notificationsAvailable,
				activity.count == record.activity,
				fingerprint == record.fingerprint {
				snapshots.refresh(
					pid: target.pid,
					generation: record.generation,
					activity: activity.count,
					fingerprint: fingerprint
				)
				Log.debug("axTreeDiff for pid \(target.pid) is unchanged since generation \(record.generation)")
				return AxTreeDiffResult(
					app: app,
					nodes: [],
					generation: record.generation,
					sinceGeneration: params.sinceGeneration,
					baselineComparable: true,
					unchanged: true
				)
			}
		}

		let tree = try walk(pid: target.pid, maxDepth: params.maxDepth, token: token)
		return AxTreeDiffResult(
			app: app,
			nodes: tree.nodes,
			generation: tree.generation,
			sinceGeneration: params.sinceGeneration,
			baselineComparable: vouched != nil,
			unchanged: false
		)
	}

	private func settle(_ params: SettleParams?, token: Cancellation.Token) throws -> SettleResult {
		try requireAccessibility()
		let target = try resolveTarget(method: "settle", pid: params?.pid)
		return try Settle.run(params, pid: target.pid, watcher: watcher, cancellation: token)
	}

	private func forceElectronAccessibility(
		_ params: ForceAccessibilityParams,
		token: Cancellation.Token
	) throws -> ForceAccessibilityResult {
		// The tier gate runs on the named pid, not the frontmost application: this method changes the
		// process it names, and it names it precisely so that it cannot be aimed by accident.
		_ = try resolveTarget(method: "forceElectronAccessibility", pid: params.pid)
		return try ForceAccessibility.run(
			params,
			refTable: refTable,
			snapshots: snapshots,
			cancellation: token
		)
	}

	private func observeStart(_ params: ObserveStartParams) throws -> ObserveStatusResult {
		_ = try resolveTarget(method: "observeStart", pid: params.pid)
		return try observation.start(params)
	}

	// ---------------------------------------------------------------------------------------------
	// Shared read plumbing
	// ---------------------------------------------------------------------------------------------

	/// The application a read method will act on, tier-checked.
	private func resolveTarget(
		method: String,
		pid requested: Int32?
	) throws -> (pid: pid_t, identity: (id: String, name: String)) {
		let pid: pid_t
		let identity: (id: String, name: String)
		if let requested {
			guard let found = Apps.identity(pid: requested) else {
				throw HelperError(.targetNotFound, "no running application with pid \(requested)")
			}
			pid = requested
			identity = found
		} else {
			guard let frontmost = Apps.frontmost() else {
				throw HelperError(.targetNotFound, "no application is frontmost")
			}
			pid = frontmost.pid
			identity = (frontmost.id, frontmost.name)
		}
		Log.debug("\(method) targeting \(identity.id) (\(identity.name))")
		return (pid, identity)
	}

	/// Walks a tree and records the watermark the next `axTreeDiff` will compare against.
	///
	/// **The watermark is taken after the walk, not before, and that is a decision worth defending.**
	/// Reading a tree provokes notifications: a full-depth walk of Finder measured 639 nodes and 23
	/// `AXValueChanged` notifications *arriving during the walk*, because asking an element for its value
	/// is enough to make some applications report one. A watermark taken before the walk therefore never
	/// goes quiet again, and `unchanged` — the whole point of `axTreeDiff` — would fire only for trivial
	/// applications while every real one paid a full walk on every turn.
	///
	/// The honest reading of a post-walk watermark is "nothing has changed since the walk *finished*",
	/// and that is exactly as accurate as the tree it stands in for. A walk is not instantaneous: it is a
	/// smear over its own duration, so a change landing mid-walk is already reflected for the nodes
	/// visited after it and already missing for the nodes visited before. `unchanged` inherits precisely
	/// that property and adds no new class of error.
	///
	/// The walk and the fingerprint both run inside one suppression scope, so the notifications they
	/// provoke are attributed to the helper rather than to the application. Only the counter read
	/// afterwards is left unsuppressed, and by then it counts only what the application did by itself.
	private func walk(
		pid: pid_t,
		maxDepth: Int?,
		token: Cancellation.Token
	) throws -> (nodes: [AxNode], generation: Int) {
		watcher.ensureWatching(pid: pid)
		do {
			let (tree, fingerprint) = try watcher.withSuppression(pid: pid) {
				let tree = try AxTreeReader.read(
					pid: pid,
					maxDepth: maxDepth,
					refTable: refTable,
					cancellation: token
				)
				return (tree, AxSnapshots.fingerprint(pid: pid))
			}
			let activity = watcher.activity(pid: pid)
			snapshots.record(
				pid: pid,
				generation: tree.generation,
				activity: activity.count,
				notificationsAvailable: activity.notificationsAvailable,
				fingerprint: fingerprint
			)
			return tree
		} catch {
			// A walk that stopped early — cancelled, or the application stopped answering — leaves a tree
			// that was never fully described. Nothing may be diffed against it, so the baselines are marked
			// incomparable rather than the refs being thrown away: the caller keeps its handles and is told
			// to send a full tree next time.
			snapshots.invalidate(
				pid: pid,
				currentGeneration: refTable.generation,
				reason: "a walk did not complete"
			)
			throw error
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Gates
	// ---------------------------------------------------------------------------------------------

	private func requireAccessibility() throws {
		guard Ax.isProcessTrusted() else {
			throw HelperError(
				.accessibilityNotTrusted,
				"Accessibility permission has not been granted to the computer-use helper"
			)
		}
	}

	/// Resolves which application a method would act on, and logs it. **Authorises nothing.**
	///
	/// Authorisation lives entirely in the renderer service, because that is the only component that
	/// knows what the user granted for this application — and the user's grant is the only thing that
	/// decides. V3Code classifies applications to *suggest* a default at approval time; it does not
	/// overrule the answer. A mirror of that classification here could only ever contradict the user's
	/// own choice (a terminal the user deliberately granted typing on would be refused anyway), so there
	/// is deliberately no policy check on this side.
	///
	/// An unidentifiable pid is still refused, but on the honest ground that we cannot say what the
	/// action would hit — `targetNotFound`, not a policy refusal.
	private func requireTarget(method: String, pid: pid_t?) throws {
		guard let pid else {
			throw HelperError(
				.targetNotFound,
				"could not determine which application '\(method)' would act on"
			)
		}
		guard let identity = Apps.identity(pid: pid) else {
			throw HelperError(
				.targetNotFound,
				"pid \(pid) could not be identified, so '\(method)' has no known target",
				retryable: false
			)
		}
		Log.debug("\(method) targeting \(identity.id) (\(identity.name))")
	}

	// ---------------------------------------------------------------------------------------------
	// Params decoding
	// ---------------------------------------------------------------------------------------------

	/// Decodes `params`, tolerating its absence — `void`-parameter methods omit the key entirely.
	private func decodeParams<P: Decodable>(_ line: Data) throws -> P? {
		do {
			return try decoder.decode(ParamsEnvelope<P>.self, from: line).params
		} catch {
			throw HelperError(.internalError, "malformed params: \(error)")
		}
	}

	private func requireParams<P: Decodable>(_ line: Data, method: String) throws -> P {
		guard let params: P = try decodeParams(line) else {
			throw HelperError(.internalError, "'\(method)' requires params")
		}
		return params
	}
}
