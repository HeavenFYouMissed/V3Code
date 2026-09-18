/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Notification watcher implementation. Read UiaEvents.h first — what is watched, what is deliberately
// not, and the deadlock exposure are all documented there.
//
// EVERY CALLBACK BELOW RUNS ON A UIA-OWNED THREAD. So they do exactly two things: bump an atomic
// counter and store a tick. No locks, no logging, no UIA calls, no allocation. A callback that blocks
// blocks the target application's event delivery, and a callback that calls back into UIA can deadlock
// against the thread that is unregistering it.
//
// NEEDS VERIFICATION ON WINDOWS (full list in UiaEvents.h):
//   - That callbacks arrive at all from the MTA worker thread.
//   - That Stop() does not hang when a callback is in flight.
//   - That every UIA_*EventId and UIA_*PropertyId name below compiles against the SDK in use.
//
#include "UiaEvents.h"

#include "Log.h"

#include <new>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// Properties whose change a model can see. Bounding rectangle is included on purpose: it is the one
/// that fires continuously during an animation, which is what `settle` needs.
const PROPERTYID kWatchedProperties[] = {
	UIA_NamePropertyId,
	UIA_ValueValuePropertyId,
	UIA_ToggleToggleStatePropertyId,
	UIA_IsEnabledPropertyId,
	UIA_BoundingRectanglePropertyId,
	UIA_ExpandCollapseExpandCollapseStatePropertyId,
	UIA_SelectionItemIsSelectedPropertyId,
};

/// Coarse-grained events that mean "the UI is doing something".
const EVENTID kWatchedEvents[] = {
	UIA_LayoutInvalidatedEventId,
	UIA_Window_WindowOpenedEventId,
	UIA_Window_WindowClosedEventId,
	UIA_MenuOpenedEventId,
	UIA_MenuClosedEventId,
	UIA_AsyncContentLoadedEventId,
};

/// How many top-level windows one watch registers on. An application with more windows than this is
/// almost certainly a tool window farm; registering on all of them would cost more than it tells us.
constexpr size_t kMaxWatchedRoots = 4;

} // namespace

UiaChangeCounter::UiaChangeCounter() {
	lastEventTick_.store(::GetTickCount64(), std::memory_order_release);
}

ULONG STDMETHODCALLTYPE UiaChangeCounter::AddRef() {
	return references_.fetch_add(1, std::memory_order_acq_rel) + 1;
}

ULONG STDMETHODCALLTYPE UiaChangeCounter::Release() {
	const ULONG remaining = references_.fetch_sub(1, std::memory_order_acq_rel) - 1;
	if (remaining == 0) {
		delete this;
	}
	return remaining;
}

HRESULT STDMETHODCALLTYPE UiaChangeCounter::QueryInterface(REFIID riid, void** ppInterface) {
	if (ppInterface == nullptr) {
		return E_POINTER;
	}
	*ppInterface = nullptr;

	if (::IsEqualIID(riid, __uuidof(IUnknown)) ||
		::IsEqualIID(riid, __uuidof(IUIAutomationStructureChangedEventHandler))) {
		*ppInterface = static_cast<IUIAutomationStructureChangedEventHandler*>(this);
	} else if (::IsEqualIID(riid, __uuidof(IUIAutomationPropertyChangedEventHandler))) {
		*ppInterface = static_cast<IUIAutomationPropertyChangedEventHandler*>(this);
	} else if (::IsEqualIID(riid, __uuidof(IUIAutomationEventHandler))) {
		*ppInterface = static_cast<IUIAutomationEventHandler*>(this);
	} else {
		return E_NOINTERFACE;
	}

	AddRef();
	return S_OK;
}

HRESULT STDMETHODCALLTYPE UiaChangeCounter::HandleStructureChangedEvent(
	IUIAutomationElement* sender, StructureChangeType changeType, SAFEARRAY* runtimeId) {
	(void)sender;
	(void)changeType;
	(void)runtimeId;
	// The SAFEARRAY is owned by UIA; the handler must not free it.
	MarkActivity();
	return S_OK;
}

HRESULT STDMETHODCALLTYPE UiaChangeCounter::HandlePropertyChangedEvent(IUIAutomationElement* sender,
	PROPERTYID propertyId, VARIANT newValue) {
	(void)sender;
	(void)propertyId;
	(void)newValue;
	// The VARIANT is passed by value and owned by UIA; clearing it here would be a double free.
	MarkActivity();
	return S_OK;
}

HRESULT STDMETHODCALLTYPE UiaChangeCounter::HandleAutomationEvent(IUIAutomationElement* sender,
	EVENTID eventId) {
	(void)sender;
	(void)eventId;
	MarkActivity();
	return S_OK;
}

uint64_t UiaChangeCounter::Events() const {
	return events_.load(std::memory_order_acquire);
}

uint64_t UiaChangeCounter::LastEventTick() const {
	return lastEventTick_.load(std::memory_order_acquire);
}

void UiaChangeCounter::MarkActivity() {
	events_.fetch_add(1, std::memory_order_acq_rel);
	lastEventTick_.store(::GetTickCount64(), std::memory_order_release);
}

void UiaChangeCounter::MarkQuiet() {
	lastEventTick_.store(::GetTickCount64(), std::memory_order_release);
}

UiaWatch::~UiaWatch() {
	Stop();
}

bool UiaWatch::Start(IUIAutomation* automation,
	const std::vector<ComPtr<IUIAutomationElement>>& roots, std::string& error) {
	Stop();

	if (automation == nullptr) {
		error = "no UI Automation client";
		return false;
	}
	if (roots.empty()) {
		error = "the application exposes no window to watch";
		return false;
	}

	UiaChangeCounter* counter = new (std::nothrow) UiaChangeCounter();
	if (counter == nullptr) {
		error = "out of memory";
		return false;
	}

	automation_ = automation;
	size_t registered = 0;
	for (const ComPtr<IUIAutomationElement>& root : roots) {
		if (roots_.size() >= kMaxWatchedRoots) {
			break;
		}
		if (!root) {
			continue;
		}

		// Structure changes first: it is the single most informative signal, so a root that accepts
		// nothing else is still worth keeping.
		const HRESULT structureResult = automation->AddStructureChangedEventHandler(root.Get(),
			TreeScope_Subtree, nullptr, static_cast<IUIAutomationStructureChangedEventHandler*>(counter));
		if (FAILED(structureResult)) {
			LogDebug("AddStructureChangedEventHandler failed (" + FormatHResult(structureResult) + ")");
			continue;
		}

		roots_.push_back(root);
		++registered;

		const HRESULT propertyResult = automation->AddPropertyChangedEventHandlerNativeArray(root.Get(),
			TreeScope_Subtree, nullptr,
			static_cast<IUIAutomationPropertyChangedEventHandler*>(counter),
			const_cast<PROPERTYID*>(kWatchedProperties),
			static_cast<int>(sizeof(kWatchedProperties) / sizeof(kWatchedProperties[0])));
		if (FAILED(propertyResult)) {
			// Not fatal. Structure changes alone still detect most of what matters; losing property
			// changes mostly costs the animation signal, which frame comparison covers.
			LogDebug("AddPropertyChangedEventHandlerNativeArray failed (" +
				FormatHResult(propertyResult) + ")");
		}
	}

	if (registered == 0) {
		counter->Release();
		automation_.Reset();
		error = "no UIA event handler could be registered for this application";
		return false;
	}

	// Coarse events are registered once, against the first root that took a structure handler.
	for (const EVENTID eventId : kWatchedEvents) {
		const HRESULT hr = automation->AddAutomationEventHandler(eventId, roots_.front().Get(),
			TreeScope_Subtree, nullptr, static_cast<IUIAutomationEventHandler*>(counter));
		if (SUCCEEDED(hr)) {
			registeredEvents_.push_back(eventId);
		} else {
			LogDebug("AddAutomationEventHandler for " + std::to_string(static_cast<long>(eventId)) +
				" failed (" + FormatHResult(hr) + ")");
		}
	}

	counter_ = counter;
	// Measure quiet periods from now, not from the moment the counter object was constructed. Does not
	// count as an event: the number reported to the caller must be real notifications only.
	counter_->MarkQuiet();
	LogDebug("watching " + std::to_string(roots_.size()) + " window(s) for UIA changes");
	return true;
}

void UiaWatch::Stop() {
	if (counter_ == nullptr) {
		roots_.clear();
		registeredEvents_.clear();
		automation_.Reset();
		return;
	}

	if (automation_) {
		for (const EVENTID eventId : registeredEvents_) {
			if (!roots_.empty()) {
				automation_->RemoveAutomationEventHandler(eventId, roots_.front().Get(),
					static_cast<IUIAutomationEventHandler*>(counter_));
			}
		}
		for (const ComPtr<IUIAutomationElement>& root : roots_) {
			automation_->RemovePropertyChangedEventHandler(root.Get(),
				static_cast<IUIAutomationPropertyChangedEventHandler*>(counter_));
			automation_->RemoveStructureChangedEventHandler(root.Get(),
				static_cast<IUIAutomationStructureChangedEventHandler*>(counter_));
		}
	}

	// UIA released its own references as part of the removals above; this drops ours. If a removal
	// silently failed, UIA still holds a reference and the object outlives this call rather than being
	// deleted under a live callback.
	counter_->Release();
	counter_ = nullptr;
	registeredEvents_.clear();
	roots_.clear();
	automation_.Reset();
}

uint64_t UiaWatch::Events() const {
	return counter_ != nullptr ? counter_->Events() : 0;
}

uint64_t UiaWatch::LastEventTick() const {
	return counter_ != nullptr ? counter_->LastEventTick() : ::GetTickCount64();
}

} // namespace v3cu
