/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// axTree, axTreeDiff and forceElectronAccessibility. Read AxTree.h for the bounding rules and for what
// protocol 2 changed about what a snapshot means.
//
// NEEDS VERIFICATION ON WINDOWS (full list in AxTree.h):
//   - REF REUSE across two untouched walks. The "N nodes, R refs reused" log line exists for this.
//   - That the cache path and the live path emit identical JSON for the same window.
//   - That Chromium/Electron expose a tree at all before forceElectronAccessibility is called.
//   - Every claim in the WM_GETOBJECT note below, none of which has been observed running.
//
#include "AxTree.h"

#include "AxCache.h"
#include "AxWatch.h"
#include "Cancellation.h"
#include "Log.h"
#include "RefTable.h"
#include "UiaActions.h"
#include "UiaClient.h"
#include "UiaRoles.h"

#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

JsonValue SerializeRect(const Rect& rect) {
	JsonValue frame = JsonValue::MakeObject();
	frame.Set("x", JsonValue::MakeInt(rect.x));
	frame.Set("y", JsonValue::MakeInt(rect.y));
	frame.Set("width", JsonValue::MakeInt(rect.width));
	frame.Set("height", JsonValue::MakeInt(rect.height));
	return frame;
}

/// Walk state, so the bounds are checked in one place rather than threaded through every call.
struct WalkState {
	ComPtr<IUIAutomationTreeWalker> walker;
	AxCacheRequest cache;
	int maxDepth = kDefaultMaxDepth;
	int emitted = 0;
	int liveFallbacks = 0;
	bool truncated = false;
	bool cancelled = false;
};

/// Children by walking the live tree. Used when the cache request is unavailable, or when
/// BuildUpdatedCache failed for this particular node.
void ReadLiveChildren(const ComPtr<IUIAutomationElement>& element, WalkState& state,
	std::vector<ComPtr<IUIAutomationElement>>& out) {
	out.clear();
	if (!state.walker || !element) {
		return;
	}
	ComPtr<IUIAutomationElement> child;
	if (FAILED(state.walker->GetFirstChildElement(element.Get(), &child)) || !child) {
		return;
	}
	while (child) {
		out.push_back(child);
		ComPtr<IUIAutomationElement> sibling;
		if (FAILED(state.walker->GetNextSiblingElement(child.Get(), &sibling)) || !sibling) {
			break;
		}
		child = sibling;
	}
}

/// Serializes one element and, recursively, its children. Returns false when nothing could be read
/// from the element at all, in which case the caller omits it.
bool SerializeElement(const ComPtr<IUIAutomationElement>& element, WalkState& state, int depth,
	JsonValue& out) {
	if (Cancellation::IsRequested()) {
		state.cancelled = true;
		return false;
	}
	if (state.emitted >= kMaxAxNodes) {
		state.truncated = true;
		return false;
	}

	const bool wantChildren = depth < state.maxDepth;

	// One cross-process call fetches this node's properties AND its children's. Only worth making when
	// the children are actually wanted: at the depth limit the node's own properties are already in the
	// parent's cache.
	ComPtr<IUIAutomationElement> node = element;
	bool cached = false;
	if (state.cache.Ok() && wantChildren) {
		ComPtr<IUIAutomationElement> updated;
		if (BuildCachedNode(element, state.cache.Get(), updated)) {
			node = updated;
			cached = true;
		}
	}

	ElementFacts facts;
	if (state.cache.Ok()) {
		facts = ReadFactsFromCache(node);
	}
	if (!facts.ok) {
		facts = ReadFactsLive(node);
		++state.liveFallbacks;
	}
	if (!facts.ok) {
		// The element went away mid-walk. Skip it rather than failing the whole snapshot.
		return false;
	}

	const char* const role = MapUiaControlTypeToRole(facts.controlType, facts.isPassword);

	JsonValue nodeJson = JsonValue::MakeObject();
	// Bound to identity, role and label, so an unchanged element keeps the ref the caller already has.
	// An empty fingerprint means the provider gave no runtime id; the ref is then fresh every snapshot
	// and the diff engine matches that node structurally instead.
	nodeJson.Set("ref",
		JsonValue::MakeString(RefTable::Instance().Mint(node,
			MakeElementFingerprint(facts.runtimeId, role, facts.label))));
	nodeJson.Set("role", JsonValue::MakeString(role));
	if (facts.hasLabel) {
		nodeJson.Set("label", JsonValue::MakeString(facts.label));
	}
	if (facts.hasValue) {
		// Already suppressed for password fields inside the readers, so no path here can leak one.
		nodeJson.Set("value", JsonValue::MakeString(facts.value));
	}
	nodeJson.Set("enabled", JsonValue::MakeBool(facts.enabled));
	nodeJson.Set("focused", JsonValue::MakeBool(facts.focused));
	if (facts.hasFrame) {
		nodeJson.Set("frame", SerializeRect(facts.frame));
	}

	const std::vector<std::string> actions = DescribeActions(facts.patterns);
	if (!actions.empty()) {
		JsonValue actionsJson = JsonValue::MakeArray();
		for (const std::string& action : actions) {
			actionsJson.Push(JsonValue::MakeString(action));
		}
		nodeJson.Set("actions", std::move(actionsJson));
	}

	++state.emitted;

	if (wantChildren) {
		std::vector<ComPtr<IUIAutomationElement>> children;
		if (cached) {
			// An empty result here is "no children", not a failure, and must not be retried live: doing so
			// would cost one extra round-trip for every leaf in the tree.
			ReadCachedChildren(node, children);
		} else {
			ReadLiveChildren(node, state, children);
		}

		JsonValue childArray = JsonValue::MakeArray();
		for (const ComPtr<IUIAutomationElement>& child : children) {
			JsonValue childNode;
			if (SerializeElement(child, state, depth + 1, childNode)) {
				childArray.Push(std::move(childNode));
			}
			if (state.cancelled || state.truncated) {
				break;
			}
		}
		if (!childArray.AsArray().empty()) {
			nodeJson.Set("children", std::move(childArray));
		}
	}

	out = std::move(nodeJson);
	return true;
}

/// Runs the walk over every root. Returns false with `code`/`message` set when the snapshot is unusable.
bool WalkRoots(const std::vector<ComPtr<IUIAutomationElement>>& roots, const AxTreeOptions& options,
	const AppInfo& app, JsonValue& nodes, uint64_t& generation, ErrorCode& code,
	std::string& message) {
	ComPtr<IUIAutomationTreeWalker> walker;
	if (FAILED(UiaClient::Instance().Get()->get_ControlViewWalker(&walker)) || !walker) {
		code = ErrorCode::Internal;
		message = "could not obtain the UIA control view walker";
		return false;
	}

	WalkState state;
	state.walker = walker;
	state.maxDepth = Clamp(options.maxDepth, 1, 64);
	std::string cacheError;
	if (!state.cache.Initialize(UiaClient::Instance().Get(), cacheError)) {
		// Correct, just slower: every node falls back to live property reads.
		LogWarn("no UIA cache request (" + cacheError + "); reading properties one at a time");
	}

	// Advance the snapshot number BEFORE minting anything, so every ref this walk touches is attributed
	// to this snapshot. Unlike protocol 1, this does NOT invalidate the previous snapshot's refs.
	generation = RefTable::Instance().BeginGeneration();

	nodes = JsonValue::MakeArray();
	for (const ComPtr<IUIAutomationElement>& root : roots) {
		JsonValue node;
		if (SerializeElement(root, state, 1, node)) {
			nodes.Push(std::move(node));
		}
		if (state.cancelled || state.truncated) {
			break;
		}
	}

	if (state.cancelled) {
		code = ErrorCode::Cancelled;
		message = "the accessibility tree read was cancelled";
		return false;
	}
	if (state.truncated) {
		LogWarn("axTree truncated at " + std::to_string(kMaxAxNodes) + " nodes for " + app.id);
	}
	if (nodes.AsArray().empty()) {
		code = ErrorCode::TargetNotFound;
		message = "no accessibility elements could be read from " + app.id;
		return false;
	}

	uint64_t reused = 0;
	uint64_t minted = 0;
	RefTable::Instance().SnapshotCounters(reused, minted);
	LogDebug("axTree: " + std::to_string(state.emitted) + " nodes, " + std::to_string(reused) +
		" refs reused, " + std::to_string(minted) + " minted, " + std::to_string(state.liveFallbacks) +
		" live fallbacks, generation " + std::to_string(generation) + ", app " + app.id);
	return true;
}

/// Immediate children of every root, which is how "is there a real tree here" is judged.
int CountRootChildren(const std::vector<ComPtr<IUIAutomationElement>>& roots) {
	ComPtr<IUIAutomationTreeWalker> walker;
	if (FAILED(UiaClient::Instance().Get()->get_ControlViewWalker(&walker)) || !walker) {
		return 0;
	}
	int total = 0;
	for (const ComPtr<IUIAutomationElement>& root : roots) {
		ComPtr<IUIAutomationElement> child;
		if (FAILED(walker->GetFirstChildElement(root.Get(), &child)) || !child) {
			continue;
		}
		while (child) {
			++total;
			ComPtr<IUIAutomationElement> sibling;
			if (FAILED(walker->GetNextSiblingElement(child.Get(), &sibling)) || !sibling) {
				break;
			}
			child = sibling;
		}
	}
	return total;
}

/// Delivers an assistive-technology probe to a window. See the note in ForceElectronAccessibility for
/// what this does and does not mean.
bool ProbeWindowForAccessibility(HWND window) {
	DWORD_PTR result = 0;
	// SMTO_ABORTIFHUNG: a hung target must not hang the helper. WM_GETOBJECT with OBJID_CLIENT is the
	// message an MSAA client sends; the target answers with its accessible object, and Chromium takes it
	// as the signal that something is listening.
	const LRESULT sent = ::SendMessageTimeoutW(window, WM_GETOBJECT, 0,
		static_cast<LPARAM>(OBJID_CLIENT), SMTO_ABORTIFHUNG, 250, &result);
	return sent != 0;
}

} // namespace

bool ResolveAxTarget(const AxTreeOptions& options, AppInfo& app, std::vector<HWND>& windows,
	ErrorCode& code, std::string& message) {
	if (options.hasPid) {
		if (!GetAppInfoForPid(options.pid, app)) {
			code = ErrorCode::TargetNotFound;
			message = "no process with pid " + std::to_string(options.pid);
			return false;
		}
	} else if (!GetFrontmostApp(app)) {
		code = ErrorCode::TargetNotFound;
		message = "there is no foreground application";
		return false;
	}

	windows = FindAppWindowsForPid(app.pid);
	if (windows.empty()) {
		code = ErrorCode::TargetNotFound;
		message = "application " + app.id + " has no visible top-level window";
		return false;
	}
	return true;
}

std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>> RootElementsForWindows(
	const std::vector<HWND>& windows) {
	std::vector<ComPtr<IUIAutomationElement>> roots;
	roots.reserve(windows.size());
	for (const HWND window : windows) {
		ComPtr<IUIAutomationElement> root;
		if (UiaClient::Instance().ElementFromWindow(window, root)) {
			roots.push_back(root);
		}
	}
	return roots;
}

JsonValue SerializeApp(const AppInfo& app, bool includeTitle) {
	JsonValue json = JsonValue::MakeObject();
	json.Set("id", JsonValue::MakeString(app.id));
	json.Set("name", JsonValue::MakeString(app.name));
	json.Set("pid", JsonValue::MakeInt(static_cast<int64_t>(app.pid)));
	// `title` is optional in the contract, so it is omitted rather than emitted empty.
	if (includeTitle && app.hasTitle) {
		json.Set("title", JsonValue::MakeString(app.title));
	}
	return json;
}

bool BuildAxTree(const AxTreeOptions& options, JsonValue& out, ErrorCode& code,
	std::string& message) {
	std::string uiaError;
	if (!UiaClient::Instance().Initialize(uiaError)) {
		code = ErrorCode::AccessibilityNotTrusted;
		message = uiaError;
		return false;
	}

	AppInfo app;
	std::vector<HWND> windows;
	if (!ResolveAxTarget(options, app, windows, code, message)) {
		return false;
	}

	const std::vector<ComPtr<IUIAutomationElement>> roots = RootElementsForWindows(windows);
	JsonValue nodes;
	uint64_t generation = 0;
	if (!WalkRoots(roots, options, app, nodes, generation, code, message)) {
		return false;
	}

	// Recorded even for a plain axTree, so a caller that reads with axTree and then diffs against that
	// generation gets a truthful `baselineComparable` rather than a blanket false. No watcher is started
	// here: that cost is only paid by callers that actually use the diff loop.
	AxWatch::Instance().RecordSnapshot(generation, app.pid);

	JsonValue result = JsonValue::MakeObject();
	result.Set("app", SerializeApp(app, false));
	result.Set("nodes", std::move(nodes));
	result.Set("generation", JsonValue::MakeInt(static_cast<int64_t>(generation)));
	out = std::move(result);
	return true;
}

bool BuildAxTreeDiff(const AxTreeOptions& options, uint64_t sinceGeneration, JsonValue& out,
	ErrorCode& code, std::string& message) {
	std::string uiaError;
	if (!UiaClient::Instance().Initialize(uiaError)) {
		code = ErrorCode::AccessibilityNotTrusted;
		message = uiaError;
		return false;
	}

	AppInfo app;
	std::vector<HWND> windows;
	if (!ResolveAxTarget(options, app, windows, code, message)) {
		return false;
	}

	AxWatch& watch = AxWatch::Instance();
	const bool comparable = watch.BaselineComparable(sinceGeneration, app.pid);

	if (comparable && watch.NothingChangedSince(sinceGeneration, app.pid)) {
		// The cheapest possible answer. The generation reported is the caller's own, because no new
		// snapshot was taken and the snapshot the caller holds is still the current one — reporting a new
		// number would tell it to discard refs that are perfectly good.
		JsonValue result = JsonValue::MakeObject();
		result.Set("app", SerializeApp(app, false));
		result.Set("nodes", JsonValue::MakeArray());
		result.Set("generation", JsonValue::MakeInt(static_cast<int64_t>(sinceGeneration)));
		result.Set("sinceGeneration", JsonValue::MakeInt(static_cast<int64_t>(sinceGeneration)));
		result.Set("baselineComparable", JsonValue::MakeBool(true));
		result.Set("unchanged", JsonValue::MakeBool(true));
		out = std::move(result);
		LogDebug("axTreeDiff: unchanged since generation " + std::to_string(sinceGeneration) +
			" for " + app.id);
		return true;
	}

	const std::vector<ComPtr<IUIAutomationElement>> roots = RootElementsForWindows(windows);

	// Started BEFORE the walk so that a change occurring DURING the walk is counted as part of this
	// snapshot. The alternative — start it afterwards — would let a change slip into the gap and be
	// reported as "nothing happened" on the next call.
	watch.EnsureWatching(app.pid, UiaClient::Instance().Get(), roots);

	JsonValue nodes;
	uint64_t generation = 0;
	if (!WalkRoots(roots, options, app, nodes, generation, code, message)) {
		return false;
	}
	watch.RecordSnapshot(generation, app.pid);

	JsonValue result = JsonValue::MakeObject();
	result.Set("app", SerializeApp(app, false));
	result.Set("nodes", std::move(nodes));
	result.Set("generation", JsonValue::MakeInt(static_cast<int64_t>(generation)));
	result.Set("sinceGeneration", JsonValue::MakeInt(static_cast<int64_t>(sinceGeneration)));
	result.Set("baselineComparable", JsonValue::MakeBool(comparable));
	result.Set("unchanged", JsonValue::MakeBool(false));
	out = std::move(result);
	return true;
}

bool ForceElectronAccessibility(unsigned long pid, int timeoutMs, ForceAccessibilityOutcome& out,
	ErrorCode& code, std::string& message) {
	// WHAT THIS METHOD MEANS ON WINDOWS, because it is NOT the same thing as on macOS and reporting it as
	// though it were would be a lie the caller cannot detect.
	//
	// macOS has an explicit switch: set AXManualAccessibility on the application element and Chromium
	// turns its accessibility engine on. Windows has no such attribute. What Chromium does on Windows is
	// DETECT that an assistive technology is present and enable itself in response, and the signal it
	// detects is a client asking a window for its accessible object.
	//
	// So this method sends that signal — WM_GETOBJECT with OBJID_CLIENT, which is exactly what an MSAA
	// client sends — and then polls for a tree to appear. `applied` therefore means "the probe was
	// delivered to the window", not "the platform promised to enable accessibility", and `treePopulated`
	// is the field that actually says whether it worked.
	//
	// When the tree is already populated, this returns applied:false with treePopulated:true. That is the
	// honest answer: nothing was needed and nothing was done. A no-op that claimed applied:true would
	// make it impossible to tell "Windows needs no help here" from "the request was accepted", and the
	// difference is the entire reason a caller would look at this field.
	std::string uiaError;
	if (!UiaClient::Instance().Initialize(uiaError)) {
		code = ErrorCode::AccessibilityNotTrusted;
		message = uiaError;
		return false;
	}

	AppInfo app;
	if (!GetAppInfoForPid(pid, app)) {
		code = ErrorCode::TargetNotFound;
		message = "no process with pid " + std::to_string(pid);
		return false;
	}
	std::vector<HWND> windows = FindAppWindowsForPid(pid);
	if (windows.empty()) {
		code = ErrorCode::TargetNotFound;
		message = "application " + app.id + " has no visible top-level window";
		return false;
	}

	const ULONGLONG start = ::GetTickCount64();
	std::vector<ComPtr<IUIAutomationElement>> roots = RootElementsForWindows(windows);
	out.rootNodeCount = static_cast<int>(roots.size());

	if (CountRootChildren(roots) > 0) {
		out.applied = false;
		out.treePopulated = true;
		out.waitedMs = static_cast<int>(::GetTickCount64() - start);
		LogDebug("forceElectronAccessibility: " + app.id + " already exposes a tree; nothing to do");
		return true;
	}

	for (const HWND window : windows) {
		if (ProbeWindowForAccessibility(window)) {
			out.applied = true;
		}
	}
	if (out.applied) {
		// The tree is about to appear from nothing, so every earlier snapshot of this application is a
		// useless diff baseline. Saying so here is cheaper than letting the next diff report a whole tree
		// as inserted and hoping the caller notices.
		RefTable::Instance().MarkBaselineUnreliable();
	}

	const int budget = timeoutMs > 0 ? timeoutMs : 1000;
	while (static_cast<int>(::GetTickCount64() - start) < budget) {
		if (Cancellation::IsRequested()) {
			code = ErrorCode::Cancelled;
			message = "the accessibility enable was cancelled";
			return false;
		}
		::Sleep(kForceAccessibilityPollMs);

		// Re-fetch the root elements: Chromium replaces its provider tree when it enables accessibility,
		// and an element obtained before the switch may not see the new children.
		windows = FindAppWindowsForPid(pid);
		roots = RootElementsForWindows(windows);
		out.rootNodeCount = static_cast<int>(roots.size());
		if (CountRootChildren(roots) > 0) {
			out.treePopulated = true;
			break;
		}
	}

	out.waitedMs = static_cast<int>(::GetTickCount64() - start);
	LogInfo("forceElectronAccessibility: " + app.id + " applied=" +
		(out.applied ? "true" : "false") + " populated=" + (out.treePopulated ? "true" : "false") +
		" waited=" + std::to_string(out.waitedMs) + "ms");
	return true;
}

} // namespace v3cu
