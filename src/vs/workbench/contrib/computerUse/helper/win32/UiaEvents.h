/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// "Did anything change?", answered by UIA notifications rather than by re-reading the tree.
//
// Two callers need this and neither can be built without it:
//   - `settle` needs to know when notifications go QUIET, which is the definition of a settled UI.
//   - `axTreeDiff` needs to know whether anything changed since a snapshot, which is what lets the
//     common case answer `unchanged` with an empty node list instead of re-walking and re-sending a
//     tree the caller already has.
//
// WHAT IS WATCHED, and why this particular set: structure changes (a node appeared or vanished), the
// handful of properties whose change is visible to a model — name, value, toggle state, enabled,
// selection, expand/collapse, bounding rectangle — and the window/menu/layout events. Bounding
// rectangle is in the set specifically because it is the one that fires continuously during an
// animation, which is exactly what settle needs to see.
//
// WHAT IS NOT WATCHED, deliberately: everything, via the desktop root element. Registering on the root
// with TreeScope_Subtree delivers every event from every process on the machine, and is documented as a
// performance hazard for the whole session, not just for this helper. So handlers are registered on the
// target application's own top-level windows.
//
// THE COST OF THAT CHOICE, stated plainly because it is a real gap: a menu or dropdown that opens in a
// NEW top-level window is not under any window that was registered, so its events are missed. For
// settle that is covered — frame comparison sees the pixels change even when notifications do not, and
// that is the stated reason frame comparison exists. For axTreeDiff it would be a correctness bug
// (reporting `unchanged` when a menu just opened), so AxWatch.cpp additionally compares the SET of
// top-level windows and treats any change to it as a change. Neither mechanism relies on this one.
//
// NEEDS VERIFICATION ON WINDOWS — THE WHOLE FILE, and specifically:
//   - That UIA event handlers can be registered from the MTA worker thread at all, and that callbacks
//     arrive. UiaClient.h already flags MTA-with-no-event-handlers as untested; this is the file that
//     makes event handlers happen, so it inherits that risk in full.
//   - THE DEADLOCK. Removing a UIA event handler while a callback for it is in flight is a documented
//     hang. Stop() is called from the worker thread while callbacks arrive on UIA's threads, so this is
//     a real exposure, not a theoretical one. If the helper is ever seen wedged in `settle`, this is the
//     first place to look. The counters are plain atomics and take no lock precisely so that a callback
//     can never be blocked by the thread trying to unregister it.
//   - Event volume against a chronically noisy application (Teams, Slack, any Electron app with a
//     spinner). If notifications never go quiet, settle will report `frameStable` or `budgetExceeded`
//     rather than `quiescent`, which is correct but worth measuring — a helper that always burns the
//     full budget is a helper that adds 1.5 s to every action.
//   - That RemoveStructureChangedEventHandler / RemovePropertyChangedEventHandler /
//     RemoveAutomationEventHandler with the same (element, handler) pair really do unregister. If they
//     do not, handlers accumulate across calls and the target application slows down over a session.
//
#pragma once

#include "Common.h"

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// Counts UIA change notifications and remembers when the last one arrived. Refcounted because UIA
/// holds a reference for as long as a handler is registered.
class UiaChangeCounter final : public IUIAutomationStructureChangedEventHandler,
							   public IUIAutomationPropertyChangedEventHandler,
							   public IUIAutomationEventHandler {
public:
	UiaChangeCounter();

	// IUnknown. One declaration overrides the slot in all three bases.
	ULONG STDMETHODCALLTYPE AddRef() override;
	ULONG STDMETHODCALLTYPE Release() override;
	HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppInterface) override;

	HRESULT STDMETHODCALLTYPE HandleStructureChangedEvent(IUIAutomationElement* sender,
		StructureChangeType changeType, SAFEARRAY* runtimeId) override;
	HRESULT STDMETHODCALLTYPE HandlePropertyChangedEvent(IUIAutomationElement* sender,
		PROPERTYID propertyId, VARIANT newValue) override;
	HRESULT STDMETHODCALLTYPE HandleAutomationEvent(IUIAutomationElement* sender,
		EVENTID eventId) override;

	/// Total notifications seen since construction. Monotonic; never reset, so a caller can compare two
	/// readings without racing a reset.
	uint64_t Events() const;

	/// GetTickCount64 value of the most recent notification, or of the moment the counter was created
	/// when none has arrived.
	uint64_t LastEventTick() const;

	/// Records a notification: bumps the count and the tick.
	void MarkActivity();

	/// Moves the quiet-period origin to now WITHOUT counting an event. Used when a watch starts, so the
	/// first quiet period is measured from registration rather than from object construction, and so the
	/// event count reported to the caller is the number of real notifications and not that plus one.
	void MarkQuiet();

private:
	~UiaChangeCounter() = default;

	std::atomic<ULONG> references_{1};
	std::atomic<uint64_t> events_{0};
	std::atomic<uint64_t> lastEventTick_{0};
};

/// Registers a UiaChangeCounter on an application's windows and unregisters it on destruction.
class UiaWatch {
public:
	UiaWatch() = default;
	~UiaWatch();

	UiaWatch(const UiaWatch&) = delete;
	UiaWatch& operator=(const UiaWatch&) = delete;

	/// Registers handlers on every element in `roots` (each an application top-level window). Returns
	/// false with `error` set when nothing could be registered, which the caller must report as
	/// `notificationsUnavailable` rather than as quiescence.
	bool Start(IUIAutomation* automation,
		const std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>>& roots, std::string& error);

	/// Unregisters everything. Idempotent. See the deadlock note in the file header.
	void Stop();

	bool Active() const { return counter_ != nullptr; }
	uint64_t Events() const;
	uint64_t LastEventTick() const;

private:
	Microsoft::WRL::ComPtr<IUIAutomation> automation_;
	std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>> roots_;
	std::vector<EVENTID> registeredEvents_;
	UiaChangeCounter* counter_ = nullptr;
};

} // namespace v3cu
