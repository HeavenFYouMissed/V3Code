/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Opaque element refs, content-bound, stable across snapshots. PROTOCOL 2.
//
// THIS IS STILL THE MOST IMPORTANT CORRECTNESS PROPERTY IN THE HELPER — a ref that silently resolves
// to a different element than the caller saw is how an agent clicks the wrong button — but protocol 2
// gets there a different way than protocol 1 did, and the difference matters enough to spell out.
//
// PROTOCOL 1 (what this file used to do): every axTree bumped a generation, cleared the table, and
// Resolve rejected any ref whose embedded generation was not the current one. Safe, and unusable for
// diffing: no ref ever appeared in two snapshots, so a diff of consecutive snapshots reports the
// whole tree as replaced, every turn, while looking like it works. See the version-2 note in
// computerUseTypes.ts.
//
// PROTOCOL 2: a ref is bound to the element's IDENTITY AND CONTENT — its UIA runtime id, its role and
// its label — and it survives for as long as those hold:
//
//   - Mint reuses the existing ref when an element with the same fingerprint was seen in a recent
//     snapshot, and refreshes the stored interface pointer. So a button that did not change keeps its
//     ref, which is exactly what makes `matchedByRef` in the diff engine possible.
//   - Resolve re-reads the fingerprint from the LIVE element immediately before dispatch and refuses
//     with `refStale` if it no longer matches. This, not the generation counter, is now what stops an
//     action landing on the wrong element: a recycled list row whose label changed under a stable
//     runtime id is refused, and so is a runtime id reused by the provider for something else.
//   - `generation` is now a SNAPSHOT SEQUENCE NUMBER, not a kill switch. It is what the caller passes
//     back as `sinceGeneration`, and it no longer invalidates anything by advancing.
//   - Every ref carries a per-PROCESS session id. A helper restart mints a fresh one, so a ref that
//     survived a restart is refused rather than resolving against a re-used serial number. This is
//     what the old "generation 0 means no snapshot" rule protected against, kept intact.
//   - A cancel no longer invalidates refs. It marks the BASELINE unreliable instead (see
//     MarkBaselineUnreliable), which makes the next axTreeDiff answer `baselineComparable: false` and
//     send a full tree. The old behaviour — invalidate everything — was correct for protocol 1 and is
//     wrong for protocol 2, where it would make every cancel cost a full re-read AND break refs the
//     fingerprint check would have caught anyway.
//
// Entries are retained for kRetainedGenerations snapshots and then dropped, so the table cannot grow
// without bound in a long session. A ref the table has dropped resolves as `refStale`, which tells the
// caller to re-read — the same instruction, for a different reason.
//
// Threading: the map is only ever touched by the worker thread. MarkBaselineUnreliable is called from
// the reader thread and deliberately touches nothing but atomics — it must not release a COM interface
// pointer on a thread that never initialized COM.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - THE HIGHEST-VALUE TEST ON THE FIRST WINDOWS MACHINE: walk a window twice without touching it and
//     confirm the SAME refs come back both times. If they do not, every diff degrades to path matching
//     and the whole tier-4 feature silently does nothing useful. `axTree: N nodes, M refs reused` is
//     logged by AxTree.cpp for exactly this.
//   - That IUIAutomationElement::GetRuntimeId returns a stable array for an unchanged element and a
//     different one after the element is destroyed and recreated. Everything above rests on this.
//   - That a provider which supplies no runtime id (empty array, or a failure) degrades as described
//     rather than producing colliding fingerprints. Chromium and WPF are the ones to check.
//   - That Resolve's live fingerprint read on a destroyed element surfaces as
//     UIA_E_ELEMENTNOTAVAILABLE rather than a crash, and therefore as `targetNotFound`.
//   - That the retention window is long enough for a real read-act-read loop. Too short and refs go
//     stale mid-turn; the symptom is refStale on a ref the model just read.
//
#pragma once

#include "Common.h"

#include <atomic>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// How many snapshots a ref outlives its last sighting. Four is two full read-act-read loops, which
/// covers a caller that reads, acts, reads again, and only then uses a ref from the first read.
inline constexpr uint64_t kRetainedGenerations = 4;

/// Hard ceiling on live entries. Reaching it means something is walking pathologically large trees; the
/// table is cleared and the baseline marked unreliable rather than growing until the helper is killed.
inline constexpr size_t kMaxRefEntries = 40000;

/// Why a ref failed to resolve.
enum class RefResolveStatus {
	/// Resolved to a live element whose fingerprint still matches.
	Ok,
	/// The ref belongs to another helper process, has been dropped from the table, or the element
	/// behind it no longer matches the fingerprint it was minted with. Maps to `refStale`.
	Stale,
	/// The ref is known but its element is gone. Maps to `targetNotFound`.
	NotFound,
	/// The ref is not a ref this helper ever mints. Maps to `refStale`, on the reasoning that a caller
	/// holding an unparseable ref is out of sync with the helper.
	Malformed,
};

class RefTable {
public:
	static RefTable& Instance();

	/// Starts a new snapshot. Increments the generation and prunes entries older than
	/// kRetainedGenerations. Does NOT clear the table — that is the protocol-2 change. Returns the new
	/// generation.
	uint64_t BeginGeneration();

	/// The current snapshot number, as reported in ComputerUseAxTreeResult.generation.
	uint64_t CurrentGeneration() const;

	/// The oldest generation whose refs the helper still vouches for. A caller's `sinceGeneration`
	/// below this must be answered with `baselineComparable: false`.
	uint64_t BaselineFloor() const;

	/// Declares that refs minted up to now can no longer be vouched for as a diff baseline, without
	/// invalidating them for dispatch. Raised by a cancel, and by anything else that leaves the
	/// caller's picture of the screen unreliable. Touches only atomics, so it is safe to call from the
	/// reader thread.
	void MarkBaselineUnreliable();

	/// Mints — or reuses — a ref for `element`. `fingerprint` comes from MakeElementFingerprint; an
	/// empty one means the element cannot be identified, in which case a fresh ref is minted every
	/// snapshot and the diff engine falls back to structural path matching for it.
	std::string Mint(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
		const std::string& fingerprint);

	/// Resolves a ref and re-verifies that the element behind it still matches the fingerprint the ref
	/// was minted with.
	RefResolveStatus Resolve(const std::string& ref,
		Microsoft::WRL::ComPtr<IUIAutomationElement>& out) const;

	/// Refs reused from an earlier snapshot during the current generation, and refs minted fresh. Logged
	/// by the walk; this ratio is the health metric for protocol-2 ref stability.
	void SnapshotCounters(uint64_t& reused, uint64_t& minted) const;

private:
	RefTable() = default;

	/// Lazily built, once per process. Format is hex and contains no '.', which is the ref delimiter.
	const std::string& SessionId() const;

	struct Entry {
		Microsoft::WRL::ComPtr<IUIAutomationElement> element;
		std::string fingerprint;
		uint64_t lastSeenGeneration = 0;
	};

	mutable std::mutex mutex_;
	std::atomic<uint64_t> generation_{0};
	std::atomic<uint64_t> baselineFloor_{1};
	uint64_t nextSerial_ = 1;
	uint64_t reusedThisGeneration_ = 0;
	uint64_t mintedThisGeneration_ = 0;
	mutable std::string sessionId_;
	std::map<std::string, Entry> entries_;
	std::map<std::string, std::string> refsByFingerprint_;
};

} // namespace v3cu
