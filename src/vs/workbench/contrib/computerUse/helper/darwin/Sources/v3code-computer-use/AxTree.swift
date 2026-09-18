/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import CoreGraphics
import Foundation

/// Walks an application's accessibility tree into the wire's `ComputerUseAxNode` shape.
struct AxTreeReader {
	/// Depth bound when the caller does not supply one.
	///
	/// Real UI is rarely deeper than this in a way that matters; the extra levels of a deep tree are
	/// mostly layout containers, and each level multiplies both the walk cost and the token cost of the
	/// response.
	static let defaultMaxDepth = 12

	/// Hard ceiling on emitted nodes, independent of depth.
	///
	/// A depth bound alone does not bound width: one table with fifty thousand cells would produce a
	/// response large enough to stall the pipe. Truncation is logged so an unexpectedly clipped tree is
	/// diagnosable rather than mysterious.
	static let maxNodes = 3000

	private let refTable: RefTable
	private let displays: [Geometry.DisplayInfo]
	private let cancellation: Cancellation.Token
	private var emitted = 0
	private var truncated = false

	init(refTable: RefTable, displays: [Geometry.DisplayInfo], cancellation: Cancellation.Token) {
		self.refTable = refTable
		self.displays = displays
		self.cancellation = cancellation
	}

	/// Attributes fetched in a single batched round-trip per node.
	private static let batchedAttributes: [String] = [
		kAXRoleAttribute as String,
		kAXTitleAttribute as String,
		kAXDescriptionAttribute as String,
		kAXValueAttribute as String,
		kAXEnabledAttribute as String,
		kAXFocusedAttribute as String,
		kAXPositionAttribute as String,
		kAXSizeAttribute as String,
	]

	/// Reads the tree for a process, advancing the snapshot sequence number.
	///
	/// Protocol 2: this no longer invalidates refs. Elements the walk sees again keep the ref they
	/// already had, which is what makes a snapshot-to-snapshot diff possible at all.
	static func read(
		pid: pid_t,
		maxDepth: Int?,
		refTable: RefTable,
		cancellation: Cancellation.Token
	) throws -> (nodes: [AxNode], generation: Int) {
		guard Ax.isProcessTrusted() else {
			throw HelperError(
				.accessibilityNotTrusted,
				"Accessibility permission has not been granted to the computer-use helper"
			)
		}
		let application = Ax.application(pid: pid)
		let alive = Ax.checkAlive(application)
		guard alive == .success else {
			throw helperError(from: alive, context: "reading the accessibility tree of pid \(pid)")
		}

		// The sequence number advances before any node is minted, so the generation reported with this
		// snapshot is the one the caller can quote back as `sinceGeneration`.
		let generation = refTable.beginGeneration(pid: pid)
		var reader = AxTreeReader(
			refTable: refTable,
			displays: Geometry.displays(),
			cancellation: cancellation
		)

		let depth = max(1, min(maxDepth ?? defaultMaxDepth, 64))

		// Roots are the application's windows. The application element itself is used only when it
		// reports no windows, so a menu-bar-only app is still readable instead of coming back empty.
		let windows = (Ax.copyAttribute(application, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
		let roots = windows.isEmpty ? [application] : windows

		var nodes: [AxNode] = []
		for window in roots {
			try cancellation.check()
			if let node = try reader.node(for: window, pid: pid, remainingDepth: depth) {
				nodes.append(node)
			}
		}
		if reader.truncated {
			Log.warn("axTree for pid \(pid) truncated at \(maxNodes) nodes")
		}
		Log.debug("axTree pid \(pid) generation \(generation) emitted \(reader.emitted) nodes")
		return (nodes, generation)
	}

	private mutating func node(
		for element: AXUIElement,
		pid: pid_t,
		remainingDepth: Int
	) throws -> AxNode? {
		guard emitted < AxTreeReader.maxNodes else {
			truncated = true
			return nil
		}
		try cancellation.check()

		let attributes = Ax.copyMultiple(element, AxTreeReader.batchedAttributes)
		guard let rawRole = Ax.string(attributes[kAXRoleAttribute as String]) else {
			// No role means the element did not answer at all — a dead or hostile node. Skipping it is
			// correct: minting a ref for something that cannot describe itself would hand the model a
			// handle it can only misuse.
			return nil
		}
		emitted += 1

		let rawActions = Ax.actions(element)
		let rawLabel = Ax.label(from: attributes, role: rawRole)
		// Role and label are handed to the table as the identity fingerprint, so the ref survives to the
		// next snapshot and `resolve` can prove, at dispatch time, that it still means this element.
		let ref = refTable.mint(
			element: element,
			pid: pid,
			role: rawRole,
			label: rawLabel,
			actions: rawActions
		)

		let children: [AxNode]?
		if remainingDepth > 1 {
			var collected: [AxNode] = []
			for child in Ax.children(element) {
				if let node = try node(for: child, pid: pid, remainingDepth: remainingDepth - 1) {
					collected.append(node)
				}
			}
			children = collected.isEmpty ? nil : collected
		} else {
			children = nil
		}

		let frame = Ax.rect(
			position: attributes[kAXPositionAttribute as String],
			size: attributes[kAXSizeAttribute as String]
		)

		return AxNode(
			ref: ref,
			role: Ax.normalizeName(rawRole),
			label: rawLabel,
			value: Ax.string(attributes[kAXValueAttribute as String]),
			// An element that does not report enabledness is treated as enabled: most non-control
			// elements omit the attribute entirely, and defaulting them to disabled would tell the model
			// the whole window is dead.
			enabled: Ax.bool(attributes[kAXEnabledAttribute as String]) ?? true,
			focused: Ax.bool(attributes[kAXFocusedAttribute as String]) ?? false,
			frame: frame.map { Geometry.physicalRect(fromPoints: $0, displays: displays) },
			actions: rawActions.isEmpty ? nil : rawActions.map(Ax.normalizeName),
			children: children
		)
	}

	/// Counts nodes without minting refs, for deciding whether a tree exists at all.
	///
	/// Deliberately not `read`: `forceElectronAccessibility` polls this several times a second while it
	/// waits, and a real walk would advance the snapshot sequence on every poll, hand out refs from a
	/// half-populated tree, and evict the refs of whatever the model was actually looking at.
	static func shallowCount(pid: pid_t, maxDepth: Int, limit: Int) -> (roots: Int, nodes: Int) {
		let application = Ax.application(pid: pid)
		let windows = (Ax.copyAttribute(application, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
		let roots = windows.isEmpty ? [application] : windows

		var nodes = 0
		func walk(_ element: AXUIElement, _ remainingDepth: Int) {
			guard nodes < limit else { return }
			nodes += 1
			guard remainingDepth > 1 else { return }
			for child in Ax.children(element) {
				walk(child, remainingDepth - 1)
			}
		}
		for root in roots {
			walk(root, maxDepth)
		}
		return (windows.count, nodes)
	}
}
