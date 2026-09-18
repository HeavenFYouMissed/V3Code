/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import Foundation

/// A port of computerUseAppTiers.ts, enforced helper-side as defence in depth.
///
/// The service already gates on tier before it writes a request, so this layer should never fire. It
/// exists because the helper is the last thing standing between a model and a synthetic keystroke into
/// a shell: a bug in the service, a stale renderer, or anything that learns to speak this protocol
/// must still be refused. The fragment lists are duplicated deliberately — a shared generated file
/// would be one more thing that can silently fail to regenerate.
enum AppTier: String {
	case read
	case click
	case full
	case selfApp = "self"
}

enum AppTiers {
	private static let selfIdentifiers = [
		"dev.v3code.code",
		"v3code",
		"code-oss-dev",
	]

	private static let browserFragments = [
		"chrome",
		"chromium",
		"safari",
		"firefox",
		"msedge",
		"microsoft-edge",
		"microsoftedge",
		"com.microsoft.edgemac",
		"brave",
		"opera",
		"vivaldi",
		"arc",
		"company.thebrowser",
		"orion",
		"duckduckgo",
	]

	private static let terminalAndIdeFragments = [
		// Terminals
		"terminal",
		"iterm",
		"warp",
		"ghostty",
		"alacritty",
		"kitty",
		"wezterm",
		"hyper",
		"tabby",
		"powershell",
		"windowsterminal",
		"conemu",
		"cmd.exe",
		"wt.exe",
		// Editors and IDEs
		"visualstudiocode",
		"vscodium",
		"cursor",
		"windsurf",
		"sublime",
		"zed",
		"xcode",
		"androidstudio",
		"jetbrains",
		"intellij",
		"pycharm",
		"webstorm",
		"goland",
		"clion",
		"rider",
		"rubymine",
		"phpstorm",
		"datagrip",
		"devenv.exe",
		"emacs",
		"macvim",
		"neovide",
		"nvim",
		"vim",
	]

	/// Lower-cases and strips whitespace, underscores and hyphens, matching `normalizeIdentifier`.
	private static func normalize(_ identifier: String) -> String {
		identifier.lowercased().filter { character in
			!(character.isWhitespace || character == "_" || character == "-")
		}
	}

	private static func matchesAny(_ identifier: String, _ fragments: [String]) -> Bool {
		let normalized = normalize(identifier)
		return fragments.contains { normalized.contains(normalize($0)) }
	}

	/// Classifies an app by bundle identifier and display name. Unknown apps are `full`, as on the TS
	/// side: the restrictive tiers redirect the model to a better tool, they are not the consent gate.
	static func classify(id: String, name: String?) -> AppTier {
		let candidates = [id, name ?? ""].filter { !$0.isEmpty }
		if candidates.contains(where: { matchesAny($0, selfIdentifiers) }) {
			return .selfApp
		}
		if candidates.contains(where: { matchesAny($0, browserFragments) }) {
			return .read
		}
		if candidates.contains(where: { matchesAny($0, terminalAndIdeFragments) }) {
			return .click
		}
		return .full
	}

	/// Whether a tier permits a method. Mirrors `isActionAllowedForTier` exactly, including the
	/// deny-by-default arm, so a method added on one side cannot become permitted on the other.
	static func isAllowed(tier: AppTier, method: String) -> Bool {
		// Unconditionally allowed, because refusing them cannot protect anything. `observeStop` and
		// `observeStatus` are here for a sharper reason than the others: they *end* and *report* ambient
		// observation. A revocation that a tier could refuse would be a revocation that does not work,
		// and a reconciliation loop that cannot read the session list cannot stop what it must not see.
		if method == "cancel" || method == "ping" || method == "status" || method == "listApps"
			|| method == "observeStop" || method == "observeStatus" {
			return true
		}
		if tier == .selfApp {
			return false
		}
		switch method {
		case "capture", "axTree", "cursorPosition", "frontmostApp":
			return true
		// Protocol 2 reads. Grouped with `axTree` because that is exactly what they are: `axTreeDiff` is a
		// tree read, `settle` observes notifications and window frames, and `forceElectronAccessibility`
		// asks an application to describe itself. None of them delivers input, so the `read` tier — which
		// exists to redirect the model to a better tool for driving browsers, not to hide their contents —
		// permits them, and `self` continues to permit nothing.
		case "axTreeDiff", "settle", "forceElectronAccessibility":
			return true
		// Ambient observation is gated on a policy decision from common/computerUseObservation.ts in
		// addition to this, never instead of it. The tier answer here is only "this application is not
		// V3Code itself".
		case "observeStart":
			return true
		case "click":
			return tier == .click || tier == .full
		case "type", "key", "scroll":
			return tier == .full
		default:
			return false
		}
	}

	/// Mirrors `describeTierRefusal`. Returns nil when the action is allowed.
	static func describeRefusal(tier: AppTier, method: String) -> String? {
		if isAllowed(tier: tier, method: method) {
			return nil
		}
		switch tier {
		case .selfApp:
			if method == "observeStart" {
				return "V3Code never observes itself."
			}
			if method == "forceElectronAccessibility" {
				// Worth its own sentence: the flag is a property of the target process, so setting it on
				// V3Code would make V3Code's own window readable by every accessibility client on the
				// machine, not just by the agent that asked.
				return "V3Code will not expose its own accessibility tree."
			}
			return "V3Code cannot act on its own window."
		case .read:
			return "This application is read-only for computer use, so '\(method)' is not permitted. Use V3Code's browser tools to drive a browser."
		case .click:
			return "This application allows clicking only, so '\(method)' is not permitted. Use the terminal tools to run commands."
		case .full:
			return "'\(method)' is not permitted for this application."
		}
	}
}
