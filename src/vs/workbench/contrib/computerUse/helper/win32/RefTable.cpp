/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Ref table implementation. Read the header comment in RefTable.h first — the protocol-2 stability
// rules there are the contract, this file is only the bookkeeping.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - ParseRef against a ref the helper actually minted, including the session component.
//   - That reuse really happens: SnapshotCounters must report a high `reused` for a second walk of an
//     untouched window. A `reused` of zero means GetRuntimeId is not behaving as assumed and the diff
//     engine is silently running on path matching alone.
//   - That pruning frees the stored COM pointers on the worker thread (it does — BeginGeneration runs
//     there) and never on the reader thread.
//
#include "RefTable.h"

#include "Log.h"
#include "UiaActions.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

namespace v3cu {
namespace {

/// Splits a ref of the form "e<session>.<serial>". Returns false when the ref is not in that shape.
bool ParseRef(const std::string& ref, std::string& session, uint64_t& serial) {
	if (ref.size() < 4 || ref[0] != 'e') {
		return false;
	}
	const size_t dot = ref.find('.', 1);
	if (dot == std::string::npos || dot == 1 || dot + 1 >= ref.size()) {
		return false;
	}
	for (size_t index = dot + 1; index < ref.size(); ++index) {
		if (ref[index] < '0' || ref[index] > '9') {
			return false;
		}
	}
	session = ref.substr(1, dot - 1);
	serial = static_cast<uint64_t>(::_strtoui64(ref.c_str() + dot + 1, nullptr, 10));
	return true;
}

} // namespace

RefTable& RefTable::Instance() {
	static RefTable table;
	return table;
}

const std::string& RefTable::SessionId() const {
	if (sessionId_.empty()) {
		// Process id alone is not enough: Windows reuses process ids freely, and a helper restarted a
		// second later could mint the same ref for a different element. The tick count makes the pair
		// unique for any restart the user could perceive as the same session.
		char buffer[64] = {};
		::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "%08lx%016llx",
			static_cast<unsigned long>(::GetCurrentProcessId()),
			static_cast<unsigned long long>(::GetTickCount64()));
		sessionId_ = buffer;
	}
	return sessionId_;
}

uint64_t RefTable::BeginGeneration() {
	std::lock_guard<std::mutex> guard(mutex_);
	const uint64_t generation = generation_.fetch_add(1, std::memory_order_acq_rel) + 1;
	reusedThisGeneration_ = 0;
	mintedThisGeneration_ = 0;

	// Prune first, so the entry cap below is measured against what survives rather than against the
	// backlog. Entries are dropped by age in snapshots, not by wall clock: what matters is how many
	// reads ago the caller last saw the element.
	if (generation > kRetainedGenerations) {
		const uint64_t oldest = generation - kRetainedGenerations;
		for (auto iterator = entries_.begin(); iterator != entries_.end();) {
			if (iterator->second.lastSeenGeneration >= oldest) {
				++iterator;
				continue;
			}
			if (!iterator->second.fingerprint.empty()) {
				const auto byFingerprint = refsByFingerprint_.find(iterator->second.fingerprint);
				// Only erase the index entry when it still points at THIS ref. A fingerprint that has
				// since been re-minted under a new ref must keep its newer mapping.
				if (byFingerprint != refsByFingerprint_.end() &&
					byFingerprint->second == iterator->first) {
					refsByFingerprint_.erase(byFingerprint);
				}
			}
			iterator = entries_.erase(iterator);
		}
	}

	if (entries_.size() > kMaxRefEntries) {
		LogWarn("ref table exceeded " + std::to_string(kMaxRefEntries) +
			" entries; clearing and marking the diff baseline unreliable");
		entries_.clear();
		refsByFingerprint_.clear();
		// Dropping refs the caller may still hold is exactly the situation baselineComparable exists to
		// report. Raise the floor past this generation so the next diff sends a full tree.
		baselineFloor_.store(generation + 1, std::memory_order_release);
	}

	return generation;
}

uint64_t RefTable::CurrentGeneration() const {
	return generation_.load(std::memory_order_acquire);
}

uint64_t RefTable::BaselineFloor() const {
	return baselineFloor_.load(std::memory_order_acquire);
}

void RefTable::MarkBaselineUnreliable() {
	// Deliberately does not lock and does not touch the map: this may run on the reader thread, which
	// has no COM apartment and must not release the stored interface pointers. Only snapshots taken
	// from here on may be used as a diff baseline; the refs themselves stay dispatchable, because what
	// protects a dispatch is the fingerprint re-check in Resolve, not the generation number.
	const uint64_t generation = generation_.load(std::memory_order_acquire);
	baselineFloor_.store(generation + 1, std::memory_order_release);
}

std::string RefTable::Mint(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	const std::string& fingerprint) {
	std::lock_guard<std::mutex> guard(mutex_);
	const uint64_t generation = generation_.load(std::memory_order_acquire);

	if (!fingerprint.empty()) {
		const auto found = refsByFingerprint_.find(fingerprint);
		if (found != refsByFingerprint_.end()) {
			const auto entry = entries_.find(found->second);
			if (entry != entries_.end()) {
				// Same element, same role, same label: the caller's existing ref is still correct. The
				// interface pointer is refreshed because the one from the previous snapshot may be a
				// different proxy for the same element.
				entry->second.element = element;
				entry->second.lastSeenGeneration = generation;
				++reusedThisGeneration_;
				return entry->first;
			}
			// The index outlived its entry. Drop the dangling mapping and fall through to a fresh mint.
			refsByFingerprint_.erase(found);
		}
	}

	char buffer[96] = {};
	::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "e%s.%llu", SessionId().c_str(),
		static_cast<unsigned long long>(nextSerial_));
	++nextSerial_;

	std::string ref(buffer);
	Entry entry;
	entry.element = element;
	entry.fingerprint = fingerprint;
	entry.lastSeenGeneration = generation;
	entries_[ref] = entry;
	if (!fingerprint.empty()) {
		refsByFingerprint_[fingerprint] = ref;
	}
	++mintedThisGeneration_;
	return ref;
}

RefResolveStatus RefTable::Resolve(const std::string& ref,
	Microsoft::WRL::ComPtr<IUIAutomationElement>& out) const {
	std::string session;
	uint64_t serial = 0;
	if (!ParseRef(ref, session, serial)) {
		LogWarn("ref '" + ref + "' is not a ref this helper mints");
		return RefResolveStatus::Malformed;
	}

	std::lock_guard<std::mutex> guard(mutex_);
	if (generation_.load(std::memory_order_acquire) == 0) {
		// Nothing has been read yet, so there is no ref this helper could have minted.
		return RefResolveStatus::Stale;
	}
	if (session != SessionId()) {
		// A ref from a previous helper process. Serial numbers restart at 1, so resolving it would mean
		// acting on whatever element happens to hold that serial now.
		LogWarn("ref '" + ref + "' was minted by a different helper process");
		return RefResolveStatus::Stale;
	}

	const auto found = entries_.find(ref);
	if (found == entries_.end()) {
		// Either never minted, or pruned after kRetainedGenerations. Both mean "re-read the screen".
		return RefResolveStatus::Stale;
	}
	if (!found->second.element) {
		return RefResolveStatus::NotFound;
	}

	const std::string live = ReadElementFingerprint(found->second.element);
	if (live.empty()) {
		if (!IsElementAlive(found->second.element)) {
			return RefResolveStatus::NotFound;
		}
		// Alive but unfingerprintable — the provider supplies no runtime id. Accepted, because refusing
		// would make the element permanently unactionable, but it is the one path where a ref is trusted
		// without re-verification. The node was minted with an empty fingerprint too, so the diff engine
		// already treats it as path-matched only.
		out = found->second.element;
		return RefResolveStatus::Ok;
	}
	if (!found->second.fingerprint.empty() && live != found->second.fingerprint) {
		// The element behind this ref is no longer the thing the caller was shown. This is the check the
		// whole scheme exists for; it must stay ahead of the assignment to `out`.
		LogWarn("ref '" + ref + "' no longer matches the element it was minted for");
		return RefResolveStatus::Stale;
	}

	out = found->second.element;
	return RefResolveStatus::Ok;
}

void RefTable::SnapshotCounters(uint64_t& reused, uint64_t& minted) const {
	std::lock_guard<std::mutex> guard(mutex_);
	reused = reusedThisGeneration_;
	minted = mintedThisGeneration_;
}

} // namespace v3cu
