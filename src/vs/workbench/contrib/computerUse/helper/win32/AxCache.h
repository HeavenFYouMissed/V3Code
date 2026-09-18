/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Batched property reads for the accessibility walk: IUIAutomationCacheRequest.
//
// WHY THIS EXISTS NOW. Every UIA "Current*" read is a cross-process call into the target
// application's provider. The walk needs about fourteen of them per node — control type, name,
// password, enabled, focus, bounding rectangle, focusability, runtime id, seven pattern probes — so a
// 400-node window costs roughly 5600 round-trips. That was tolerable when a snapshot happened once
// per turn. It is not tolerable now: tier 4 turns the read-act-read loop into a read-act-read-DIFF
// loop, and the whole point of the diff is to make re-reading cheap.
//
// A cache request collapses those reads. One BuildUpdatedCache call with
// TreeScope_Element | TreeScope_Children fetches the node AND all of its children's properties in a
// single round-trip; the children then need no calls of their own unless they have children in turn.
// So the call count drops from ~14 per node to ~1 per node that HAS children, which for a typical
// control-view tree is a 20-50x reduction.
//
// WHY NOT TreeScope_Subtree, which would be one call for the whole window: a subtree request ignores
// the walk's depth bound, so a pathological tree would be fully materialized in the helper's address
// space before the depth cap ever got a chance to stop it. Per-level caching respects maxDepth for
// free and bounds the worst case to one window's breadth at a time.
//
// AutomationElementMode_Full is required, not optional. In AutomationElementMode_None the returned
// elements are inert property bags: they cannot be passed to a pattern call and cannot be used to mint
// a usable ref. Every element the walk mints a ref for must remain actionable, so Full it is — the
// cost is that each cached element keeps a real reference to its provider.
//
// FALLBACK. Nothing here is load-bearing: if the cache request cannot be created, or a
// BuildUpdatedCache call fails, or a cached property read fails, the caller reads that element the old
// way with live Current* calls. The two readers are deliberately kept to the same shape
// (ElementFacts) so the walk cannot behave differently depending on which one served it.
//
// NEEDS VERIFICATION ON WINDOWS — THE WHOLE FILE, and specifically:
//   - That BuildUpdatedCache with TreeScope_Element | TreeScope_Children populates the CHILDREN's
//     properties and not merely the parent's. This is the assumption the entire optimisation rests on.
//     The check is cheap: compare the node count and wall-clock time of an axTree with the cache path
//     against one forced down the live path, and confirm the emitted JSON is byte-identical.
//   - That a cached element returned by GetCachedChildren can itself be passed to BuildUpdatedCache to
//     descend another level. If it cannot, the walk must re-fetch a live element per level.
//   - That GetCachedPropertyValue returns the property's documented DEFAULT (VARIANT_FALSE, empty
//     string, zero) for a property the provider does not support, rather than failing. Both are handled
//     as "absent", but only one of them is silent.
//   - That GetCachedPropertyValue fails, rather than returning garbage, for a property that was never
//     added to the cache request. If it returns garbage, an omission from kCachedProperties becomes a
//     wrong value on the wire instead of a missing one.
//   - That GetCachedChildren returns S_OK with a null array (not a failure) for a node with no
//     children, since "no children" is the common case and must not be logged as an error.
//   - Whether the ControlView tree filter on the cache request really matches the ControlViewWalker
//     the live path uses. If the two disagree, the same window produces a different tree depending on
//     which path served it, which would be the worst possible outcome here.
//
#pragma once

#include "Common.h"
#include "UiaActions.h"

#include <string>
#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// Everything the walk needs from one element, read either from a cache or live.
struct ElementFacts {
	/// False when even the control type could not be read, which means the element is gone.
	bool ok = false;
	CONTROLTYPEID controlType = 0;
	bool isPassword = false;
	bool enabled = true;
	bool focused = false;
	std::string label;
	bool hasLabel = false;
	std::string value;
	bool hasValue = false;
	Rect frame;
	bool hasFrame = false;
	/// UIA runtime id, formatted by ReadElementRuntimeId. Empty when the provider supplies none.
	std::string runtimeId;
	ElementPatterns patterns;
};

/// A configured cache request, owned for the duration of one walk.
class AxCacheRequest {
public:
	/// Builds the request. Returns false with `error` set; the caller then uses the live path.
	bool Initialize(IUIAutomation* automation, std::string& error);

	bool Ok() const { return request_ != nullptr; }
	IUIAutomationCacheRequest* Get() const { return request_.Get(); }

private:
	Microsoft::WRL::ComPtr<IUIAutomationCacheRequest> request_;
};

/// Fetches `element` and its children's properties in one round-trip. Returns false when the call
/// failed, in which case the caller must fall back to the live path for this element.
bool BuildCachedNode(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	IUIAutomationCacheRequest* request, Microsoft::WRL::ComPtr<IUIAutomationElement>& out);

/// Children already present in `element`'s cache. An empty result means "no children" — it is not an
/// error, and the caller must not retry it live, or a leaf node would cost an extra round-trip each.
void ReadCachedChildren(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>>& out);

/// Reads one element's facts from its cache. `ok` is false when the cache does not hold them.
ElementFacts ReadFactsFromCache(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

/// Reads one element's facts with live Current* calls. This is the protocol-1 behaviour, kept as the
/// fallback and as the reference the cache path must agree with.
ElementFacts ReadFactsLive(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

} // namespace v3cu
