/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Mirror of computerUseAppTiers.ts. Read AppTiers.h for which methods are checked and why.
//
// The fragment lists are copied verbatim from the TypeScript. If you edit one, edit both.
// NEEDS VERIFICATION ON WINDOWS:
//   - That this file classifies the same apps the TypeScript does. Worth a table test comparing
//     both against the same id/name pairs, since drift here fails open.
//   - Real executable names: "WindowsTerminal.exe", "Code.exe", "msedge.exe", "wt.exe".
//
#include "AppTiers.h"

#include <vector>

namespace v3cu {
namespace {

const char* const kSelfIdentifiers[] = {
	"dev.v3code.code",
	"v3code",
	"code-oss-dev",
};

const char* const kBrowserFragments[] = {
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
};

const char* const kTerminalAndIdeFragments[] = {
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
};

/// Lower-cases and strips whitespace, underscores and hyphens. Mirrors normalizeIdentifier in the
/// TypeScript, whose regex is /[\s_-]+/g.
std::string NormalizeIdentifier(const std::string& identifier) {
	std::string out = ToLowerAscii(identifier);
	std::string stripped;
	stripped.reserve(out.size());
	for (const char ch : out) {
		if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v' ||
			ch == '_' || ch == '-') {
			continue;
		}
		stripped.push_back(ch);
	}
	return stripped;
}

template <size_t Count>
bool MatchesAnyFragment(const std::string& identifier, const char* const (&fragments)[Count]) {
	const std::string normalized = NormalizeIdentifier(identifier);
	if (normalized.empty()) {
		return false;
	}
	for (size_t index = 0; index < Count; ++index) {
		const std::string fragment = NormalizeIdentifier(fragments[index]);
		if (!fragment.empty() && normalized.find(fragment) != std::string::npos) {
			return true;
		}
	}
	return false;
}

} // namespace

AppTier ClassifyApp(const std::string& id, const std::string& name) {
	std::vector<std::string> candidates;
	if (!id.empty()) {
		candidates.push_back(id);
	}
	if (!name.empty()) {
		candidates.push_back(name);
	}

	for (const std::string& candidate : candidates) {
		if (MatchesAnyFragment(candidate, kSelfIdentifiers)) {
			return AppTier::Self;
		}
	}
	for (const std::string& candidate : candidates) {
		if (MatchesAnyFragment(candidate, kBrowserFragments)) {
			return AppTier::Read;
		}
	}
	for (const std::string& candidate : candidates) {
		if (MatchesAnyFragment(candidate, kTerminalAndIdeFragments)) {
			return AppTier::Click;
		}
	}
	// Unknown applications are Full, matching the TypeScript. The gate on unknown applications is
	// per-app user approval, which the service enforces; the tiers exist to redirect the model to a
	// better tool, not as an allowlist.
	return AppTier::Full;
}

bool IsActionAllowedForTier(AppTier tier, const std::string& method) {
	// Never refused for any tier. `observeStop` and `observeStatus` are here for the same reason `cancel`
	// is: a mechanism for STOPPING observation, and for finding out what is running, must not be
	// refusable — a tier that could block observeStop would be a tier that could keep a session alive.
	if (method == "cancel" || method == "ping" || method == "status" || method == "listApps" ||
		method == "observeStop" || method == "observeStatus") {
		return true;
	}
	if (tier == AppTier::Self) {
		return false;
	}
	// Read-only methods, permitted for read, click and full alike. `settle` mutates nothing — it waits —
	// and `forceElectronAccessibility` changes only whether the application will describe itself, which is
	// a precondition for reading rather than an action on the machine.
	if (method == "capture" || method == "axTree" || method == "axTreeDiff" ||
		method == "cursorPosition" || method == "frontmostApp" || method == "settle" ||
		method == "forceElectronAccessibility") {
		return true;
	}
	// Ambient observation is a read, so it is permitted at the same tiers as one — but never for `self`,
	// which the check above already handled and which Observation.cpp refuses a second time. The gate that
	// actually decides whether an observation may start is the policy decision in
	// common/computerUseObservation.ts; this only says which tiers could ever be eligible.
	if (method == "observeStart") {
		return true;
	}
	// Not targeted at an application at all. The clipboard belongs to the desktop, and
	// openApplication's whole job is to act on something that is NOT the frontmost application, so
	// classifying them by the frontmost app's tier would be classifying the wrong thing. The
	// dispatcher does not resolve an app for these three, so this branch is belt-and-braces against
	// the deny-by-default at the end of the function.
	if (method == "clipboardRead" || method == "clipboardWrite" || method == "openApplication") {
		return true;
	}
	// Presses nothing and changes no application state, so it sits with the read-only methods.
	if (method == "mouseMove") {
		return true;
	}
	if (method == "click") {
		return tier == AppTier::Click || tier == AppTier::Full;
	}
	// `drag` is deliberately NOT grouped with `click`. A click in an editor at the `click` tier is a
	// caret move; a drag is a reorder, a file move, or a text selection replaced by a drop, which is
	// the class of thing that tier exists to keep the model away from.
	if (method == "type" || method == "key" || method == "scroll" || method == "drag") {
		return tier == AppTier::Full;
	}
	// Deny by default so a newly added method cannot silently become permitted everywhere.
	return false;
}

std::string DescribeTierRefusal(AppTier tier, const std::string& method) {
	if (IsActionAllowedForTier(tier, method)) {
		return std::string();
	}
	switch (tier) {
		case AppTier::Self:
			return "V3Code cannot act on its own window.";
		case AppTier::Read:
			return "This application is read-only for computer use, so '" + method +
				"' is not permitted. Use V3Code's browser tools to drive a browser.";
		case AppTier::Click:
			return "This application allows clicking only, so '" + method +
				"' is not permitted. Use the terminal tools to run commands.";
		default:
			return "'" + method + "' is not permitted for this application.";
	}
}

const char* AppTierName(AppTier tier) {
	switch (tier) {
		case AppTier::Read: return "read";
		case AppTier::Click: return "click";
		case AppTier::Full: return "full";
		case AppTier::Self: return "self";
	}
	return "full";
}

} // namespace v3cu
