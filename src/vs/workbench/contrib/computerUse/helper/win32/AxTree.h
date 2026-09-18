/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The axTree walk: UIA tree -> ComputerUseAxNode. Plus axTreeDiff and forceElectronAccessibility,
// which are the same walk wearing different hats.
//
// The walk uses the CONTROL view, not the RAW view. The raw view includes every layout container a
// framework happens to create — a WPF or Electron window has thousands of raw nodes and perhaps
// eighty control-view nodes — and sending the raw tree would blow the token budget for no gain.
//
// PROTOCOL 2 CHANGED WHAT A SNAPSHOT DOES. It no longer invalidates the previous one. `generation` is a
// snapshot sequence number the caller passes back as `sinceGeneration`, and refs survive across
// snapshots because they are bound to element identity and content rather than to a generation. See
// RefTable.h — that file is the contract, this one is a client of it. The practical consequence for
// this walk is that Mint is given a fingerprint, and the log line reports how many refs were REUSED:
// that number is the health metric for the whole diff feature, and a zero means the feature is silently
// doing nothing.
//
// Property reads are batched through a UIA cache request (AxCache.h), with the old per-property live
// path kept as the fallback. That mattered before and matters much more now: the read-act-read loop
// became a read-act-read-diff loop, so the walk runs more often, not less.
//
// The walk is bounded three ways, because an unbounded tree walk against a hostile or merely large
// application is a hang:
//   - maxDepth from the request, defaulting to kDefaultMaxDepth
//   - a total node cap, after which the walk stops and logs
//   - the cancellation flag, checked per node
//
// Multiple roots: an application's menus, dialogs and popups are separate top-level windows, so the
// result contains one root node per visible top-level window of the process, in z-order. A model
// that cannot see the open dropdown cannot click the item in it.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - REF REUSE. Walk a window twice untouched; the log must report a high `reused` count. This is the
//     single highest-value check on the first Windows machine, because everything tier 4 adds is built
//     on it and a failure is invisible from the outside — the diff just reports the whole tree as new,
//     every turn, and looks like it is working.
//   - Node counts and wall-clock time for a real application, with and without the cache path, and that
//     the two produce identical JSON.
//   - Whether Chromium exposes its tree at all before forceElectronAccessibility has been called
//     against it. If the tree comes back as a single root with no children, that is the cause, and
//     forceElectronAccessibility is the answer.
//   - ControlViewWalker skipping elements a caller needs; the fallback would be the content view.
//
#pragma once

#include "Apps.h"
#include "Json.h"
#include "Protocol.h"

#include <cstdint>
#include <string>
#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// Default depth bound when the request omits maxDepth. Deep enough for a real dialog, shallow
/// enough that a pathological tree does not stall the helper.
inline constexpr int kDefaultMaxDepth = 12;

/// Hard cap on emitted nodes per snapshot, regardless of depth.
inline constexpr int kMaxAxNodes = 1500;

/// Sampling period while forceElectronAccessibility waits for a tree to appear.
inline constexpr int kForceAccessibilityPollMs = 50;

/// Parsed ComputerUseAxTreeParams.
struct AxTreeOptions {
	bool hasPid = false;
	unsigned long pid = 0;
	int maxDepth = kDefaultMaxDepth;
};

/// The data behind ComputerUseForceAccessibilityResult.
struct ForceAccessibilityOutcome {
	/// True when the platform accepted the request. On Windows that means an assistive-technology probe
	/// was actually delivered to the target's window — see the long note in AxTree.cpp, because Windows
	/// has no direct equivalent of macOS's AXManualAccessibility and this field must not pretend it does.
	bool applied = false;
	/// True once a walk found more than the bare root an accessibility-disabled Chromium window reports.
	bool treePopulated = false;
	int waitedMs = 0;
	int rootNodeCount = 0;
};

/// The application and windows a read is about: `options.pid` when given, otherwise the frontmost
/// application. Shared with settle so the "which app did you mean" rules cannot drift between methods.
bool ResolveAxTarget(const AxTreeOptions& options, AppInfo& app, std::vector<HWND>& windows,
	ErrorCode& code, std::string& message);

/// UIA elements for an application's top-level windows, in z-order. Windows that expose no element are
/// skipped rather than failing the call: a tool window with no provider is normal.
std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>> RootElementsForWindows(
	const std::vector<HWND>& windows);

/// Builds the ComputerUseAxTreeResult body. On failure sets `code` and `message`.
bool BuildAxTree(const AxTreeOptions& options, JsonValue& out, ErrorCode& code,
	std::string& message);

/// Builds the ComputerUseAxTreeDiffResult body: the same tree, annotated with whether the caller's
/// baseline is comparable and whether anything changed at all. Answers with an empty node list when
/// nothing changed, which is the cheap and common case in a read-act-read loop.
bool BuildAxTreeDiff(const AxTreeOptions& options, uint64_t sinceGeneration, JsonValue& out,
	ErrorCode& code, std::string& message);

/// Asks a process to expose its accessibility tree and waits for it to appear.
bool ForceElectronAccessibility(unsigned long pid, int timeoutMs, ForceAccessibilityOutcome& out,
	ErrorCode& code, std::string& message);

/// Serializes a ComputerUseApp object. Shared with frontmostApp and listApps so the shape cannot
/// drift between methods.
JsonValue SerializeApp(const AppInfo& app, bool includeTitle);

} // namespace v3cu
