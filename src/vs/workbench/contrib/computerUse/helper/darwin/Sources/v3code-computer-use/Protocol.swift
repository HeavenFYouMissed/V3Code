/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import Foundation

/// Mirrors `COMPUTER_USE_PROTOCOL_VERSION` in computerUseTypes.ts. Bump both together.
///
/// Version 2 is what makes this helper's refs stable across snapshots (see `RefTable`), redefines
/// `generation` as a snapshot sequence number rather than a kill switch, and adds `axTreeDiff`,
/// `settle`, `forceElectronAccessibility` and the three `observe*` methods. A version-1 caller is
/// rejected at the envelope, because a version-1 caller would treat every ref it holds as dead the
/// moment a new snapshot arrived — and, worse, a version-1 *helper* answering a version-2 caller
/// would produce diffs against refs it re-mints on every walk, which looks like it works.
let COMPUTER_USE_PROTOCOL_VERSION = 3

/// Mirrors `COMPUTER_USE_DEFAULT_MAX_LONG_EDGE`.
let COMPUTER_USE_DEFAULT_MAX_LONG_EDGE = 1080

/// Mirrors `COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS`.
let COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS = 1500

/// Mirrors `COMPUTER_USE_DEFAULT_SETTLE_QUIET_MS`.
let COMPUTER_USE_DEFAULT_SETTLE_QUIET_MS = 120

/// Mirrors `COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS`.
let COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS = 1000

/// Helper build version, reported by `ping` for logs and bug reports. Independent of the protocol.
let HELPER_VERSION = "1.2.0"

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

/// Mirrors `ComputerUseErrorCode`. The raw values are the wire strings.
enum ErrorCode: String, Encodable {
	case accessibilityNotTrusted
	case screenRecordingNotGranted
	case permissionDenied
	case helperMissing
	case helperVersionMismatch
	case appNotApproved
	case appTierForbidsAction
	case refStale
	case targetNotFound
	case timeout
	case cancelled
	case internalError = "internal"
}

/// A typed failure. Thrown by every handler; never a crash, because the caller cannot distinguish a
/// crashed helper from a denied permission and would report a bug instead of a fixable setting.
struct HelperError: Error {
	let code: ErrorCode
	let message: String
	/// Omitted from the wire when nil, matching `createComputerUseError`'s `undefined`.
	let retryable: Bool?

	init(_ code: ErrorCode, _ message: String, retryable: Bool? = nil) {
		self.code = code
		self.message = message
		self.retryable = retryable
	}
}

/// Wire shape of `ComputerUseError`.
struct WireError: Encodable {
	let code: ErrorCode
	let message: String
	let retryable: Bool?
}

// -------------------------------------------------------------------------------------------------
// Requests
// -------------------------------------------------------------------------------------------------

/// The part of a request line that is present for every method.
///
/// `params` is deliberately absent: it is decoded separately, per method, so an unknown method or a
/// malformed payload still yields a correlated error response rather than an unparseable line.
struct RequestHeader: Decodable {
	let id: Int
	let method: String
	let protocolVersion: Int?
}

/// Decodes just `params` out of a request line once the method is known.
///
/// `params` is optional because `JSON.stringify` omits `undefined`, so `void`-parameter methods
/// arrive with no `params` key at all.
struct ParamsEnvelope<P: Decodable>: Decodable {
	let params: P?
}

/// Mirrors `ComputerUseTarget`, a discriminated union on `kind`.
enum Target {
	case ref(String)
	case point(x: Double, y: Double)
}

extension Target: Decodable {
	private enum CodingKeys: String, CodingKey {
		case kind, ref, x, y
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		let kind = try container.decode(String.self, forKey: .kind)
		switch kind {
		case "ref":
			self = .ref(try container.decode(String.self, forKey: .ref))
		case "point":
			self = .point(
				x: try container.decode(Double.self, forKey: .x),
				y: try container.decode(Double.self, forKey: .y)
			)
		default:
			throw DecodingError.dataCorruptedError(
				forKey: .kind,
				in: container,
				debugDescription: "unknown target kind '\(kind)'"
			)
		}
	}
}

/// Mirrors `ComputerUseMouseButton`.
enum MouseButton: String, Decodable {
	case left, right, middle
}

/// Mirrors `ComputerUseModifier`. Named platform-neutrally; `Keyboard` maps these to CGEventFlags.
enum Modifier: String, Decodable {
	case shift, control, alt, meta
}

/// Mirrors `ComputerUseScrollDirection`.
enum ScrollDirection: String, Decodable {
	case up, down, left, right
}

struct CaptureParams: Decodable {
	let displayId: UInt32?
	let maxLongEdge: Int?
	let excludePids: [Int32]?
}

struct ClickParams: Decodable {
	let target: Target
	let button: MouseButton?
	let modifiers: [Modifier]?
	let clickCount: Int?
}

struct TypeParams: Decodable {
	let text: String
	let target: Target?
}

struct KeyParams: Decodable {
	let chord: String
	let repeatCount: Int?

	private enum CodingKeys: String, CodingKey {
		case chord
		// `repeat` is a Swift keyword, so the wire name is remapped rather than back-ticked at every
		// use site.
		case repeatCount = "repeat"
	}
}

struct ScrollParams: Decodable {
	let target: Target
	let direction: ScrollDirection
	let amount: Double
}

// --- protocol 3 ------------------------------------------------------------------------------

struct DragParams: Decodable {
	let from: Target
	let to: Target
	let button: MouseButton?
	let modifiers: [Modifier]?
	let durationMs: Int?
}

struct MouseMoveParams: Decodable {
	let target: Target
	let settleMs: Int?
}

struct ClipboardWriteParams: Decodable {
	let text: String
}

struct OpenApplicationParams: Decodable {
	let app: String
	let waitMs: Int?
}

struct ClipboardReadResult: Encodable {
	let text: String
	let length: Int
	let hasNonTextContent: Bool
}

struct OpenApplicationResult: Encodable {
	let app: AppResult
	let launched: Bool
	let frontmost: Bool
}

struct AxTreeParams: Decodable {
	let pid: Int32?
	let maxDepth: Int?
}

/// Mirrors `ComputerUseAxTreeDiffParams`.
struct AxTreeDiffParams: Decodable {
	let pid: Int32?
	let maxDepth: Int?
	/// Generation the caller is holding. Not optional: a diff request with no baseline is a plain read.
	let sinceGeneration: Int
}

/// Mirrors `ComputerUseSettleParams`.
struct SettleParams: Decodable {
	let pid: Int32?
	let timeoutMs: Int?
	let quietPeriodMs: Int?
	let requireFrameStability: Bool?
}

/// Mirrors `ComputerUseForceAccessibilityParams`.
struct ForceAccessibilityParams: Decodable {
	/// Required. This is never a guess about the frontmost application: the flag is set on a process and
	/// stays set, so guessing wrong changes an application the caller never named.
	let pid: Int32
	let timeoutMs: Int?
}

/// Mirrors `ComputerUseObserveContent`.
enum ObserveContent: String, Codable {
	case axTree
	case axTreeAndScreenshots
}

/// Mirrors `ComputerUseObserveStartParams`.
///
/// Every field the safety story depends on is non-optional, so a truncated or hand-written request
/// fails to decode rather than being filled in with a default. There is deliberately no default
/// interval, no default content and no default expiry.
struct ObserveStartParams: Decodable {
	let pid: Int32
	let appId: String
	let intervalMs: Int
	/// Epoch milliseconds at which the session must stop itself, whatever else happens.
	let stopAtMs: Int64
	let content: ObserveContent
	/// Accepted and currently unused: this helper produces no image from an observation sample, so there
	/// is no long edge to bound. See the note on delivery in `Observation`.
	let maxLongEdge: Int?
	/// Accepted and currently unnecessary: an observation sample composites *only* the target
	/// application's own windows, so V3Code's window cannot appear in one by construction. Kept on the
	/// wire because that stops being true the moment samples become whole-display captures.
	let excludePids: [Int32]?
}

/// Mirrors `ComputerUseObserveStopParams`.
struct ObserveStopParams: Decodable {
	/// Omit to stop every session, which is what a revocation or a shutdown wants.
	let pid: Int32?
}

// -------------------------------------------------------------------------------------------------
// Results
// -------------------------------------------------------------------------------------------------

/// Mirrors `ComputerUseDispatchMethod`. `synthesized` is the fallback rate the service tracks.
enum DispatchMethod: String, Encodable {
	case accessibility
	case synthesized
}

/// Mirrors `ComputerUseActionResult`. The inner `ok` is part of the result, distinct from the
/// envelope's `ok`.
struct ActionResult: Encodable {
	let ok = true
	let method: DispatchMethod
}

/// Mirrors `ComputerUseRect`, in physical screen pixels with the origin at the primary display's
/// top-left.
struct Rect: Encodable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

/// Mirrors `ComputerUseAxNode`. Optionals are omitted from the wire, which is what the TS optional
/// properties expect.
struct AxNode: Encodable {
	let ref: String
	let role: String
	let label: String?
	let value: String?
	let enabled: Bool
	let focused: Bool
	let frame: Rect?
	let actions: [String]?
	let children: [AxNode]?
}

/// Mirrors `ComputerUseApp`.
struct AppResult: Encodable {
	let id: String
	let name: String
	let pid: Int32
}

/// Mirrors `ComputerUseFrontmostApp`.
struct FrontmostAppResult: Encodable {
	let id: String
	let name: String
	let pid: Int32
	let title: String?
}

/// Identity and physical placement of the captured display.
///
/// The service needs the origin, not just the size: point targets come back in the image space of a
/// downscaled screenshot, and converting them to a clickable screen coordinate requires knowing where
/// on the virtual desktop this display sits. Without it, every point on a secondary display resolves
/// onto the primary one.
struct CaptureDisplay: Encodable {
	let displayId: Int
	let bounds: Rect
}

struct CaptureResult: Encodable {
	let width: Int
	let height: Int
	let scale: Double
	let format = "png"
	let dataBase64: String
	let excludedPids: [Int32]
	let display: CaptureDisplay
}

struct AxTreeResult: Encodable {
	let app: AppResult
	let nodes: [AxNode]
	let generation: Int
}

/// Mirrors `ComputerUseAxTreeDiffResult`.
///
/// Note what this is *not*: it is not a patch. The helper returns nodes and two facts only it can know
/// — whether the caller's baseline refs still mean the same elements, and whether anything has happened
/// at all since. The patch is computed in `common/computerUseAxDiff.ts`, where it is written once and
/// unit-tested headlessly instead of twice, in Swift and in C++.
struct AxTreeDiffResult: Encodable {
	let app: AppResult
	let nodes: [AxNode]
	let generation: Int
	/// Echo of the request, so a late response cannot be applied to the wrong snapshot.
	let sinceGeneration: Int
	let baselineComparable: Bool
	/// True when nothing observable changed, in which case `nodes` is empty and `generation` is unmoved.
	let unchanged: Bool
}

/// Mirrors `ComputerUseSettleReason`.
enum SettleReason: String, Encodable {
	case quiescent
	case frameStable
	case budgetExceeded
	case notificationsUnavailable
}

/// Mirrors `ComputerUseSettleResult`.
struct SettleResult: Encodable {
	let settled: Bool
	let waitedMs: Int
	let reason: SettleReason
	let frameSamples: Int?
	let notifications: Int?
}

/// Mirrors `ComputerUseForceAccessibilityResult`.
struct ForceAccessibilityResult: Encodable {
	/// The platform accepted the request. Says nothing about whether a tree appeared.
	let applied: Bool
	let treePopulated: Bool
	let waitedMs: Int
	let rootNodeCount: Int
}

/// Mirrors `ComputerUseObserveSession`.
struct ObserveSession: Encodable {
	let pid: Int32
	let appId: String
	let startedAt: Int64
	let stopAtMs: Int64
	let intervalMs: Int
	let content: ObserveContent
	let samples: Int
}

/// Mirrors `ComputerUseObserveStatusResult`.
///
/// Returned from all three `observe*` methods so start and stop are self-verifying: the caller never
/// has to assume its request took effect, and a supervisor can compare this against the policy and stop
/// anything no longer permitted.
struct ObserveStatusResult: Encodable {
	let observing: Bool
	let sessions: [ObserveSession]

	/// `observing` is derived rather than passed, so the two can never disagree.
	init(sessions: [ObserveSession]) {
		self.observing = !sessions.isEmpty
		self.sessions = sessions
	}
}

struct CursorResult: Encodable {
	let x: Double
	let y: Double
}

struct PingResult: Encodable {
	let protocolVersion: Int
	let platform = "darwin"
	let helperVersion: String
}

struct StatusResult: Encodable {
	let installed: Bool
	let protocolVersion: Int
	let accessibilityTrusted: Bool
	let screenRecordingGranted: Bool
}

// -------------------------------------------------------------------------------------------------
// Response envelopes
// -------------------------------------------------------------------------------------------------

/// Mirrors `ComputerUseSuccessResponse`.
struct SuccessResponse<R: Encodable>: Encodable {
	let id: Int
	let ok = true
	let result: R
}

/// Mirrors `ComputerUseErrorResponse`.
struct ErrorResponse: Encodable {
	let id: Int
	let ok = false
	let error: WireError
}
