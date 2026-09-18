/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// A helper-side mirror of src/vs/workbench/contrib/computerUse/common/computerUseAppTiers.ts.
//
// This is defence in depth, not the primary gate. The service checks tiers before it ever sends a
// request; this file exists so that a bug, a stale renderer, or anything else that manages to send
// a `type` request while a terminal is focused still gets refused. The cost of a false negative
// here is one wrongly refused action; the cost of not having it is a synthetic Return into a shell.
//
// The two files must not drift. Every list below is copied verbatim from the TypeScript, including
// order, and the normalisation is the same: lower-case, then strip whitespace, underscores and
// hyphens (the TS uses /[\s_-]+/g). Windows apps are matched on the executable name, which is what
// Apps.cpp puts in AppInfo::id.
//
// WHICH METHODS ARE CHECKED, and why not all of them:
//   - click, type, key, scroll: checked against the FRONTMOST app, which is the app that will
//     receive the input. This is the case that matters.
//   - axTree, axTreeDiff, settle: checked against the app being read (params.pid, else frontmost).
//   - forceElectronAccessibility, observeStart: checked against params.pid, which the contract makes
//     required. There is no frontmost fallback — a missing pid is refused rather than guessed.
//   - observeStop, observeStatus: never checked, for the same reason cancel never is. A tier that could
//     refuse observeStop would be a tier that could keep an observation session alive.
//   - capture: NOT checked. A capture is of a display, not of an application, and refusing it
//     because the frontmost window happens to be V3Code's own would break the ordinary
//     read-then-act loop, where V3Code is frontmost at the moment the user starts the task.
//     Self-exclusion for capture is handled by excludePids instead. The channel agent should be
//     aware that the helper does not enforce the `self` tier for capture.
//   - ping, status, listApps, cursorPosition, frontmostApp, cancel: never checked. They observe
//     nothing app-specific, or refusing them would be perverse (cancel).
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That real executable names match the fragments as expected. "WindowsTerminal.exe" normalises
//     to "windowsterminal.exe" and matches the "windowsterminal" fragment; "Code.exe" for VS Code
//     does NOT match "visualstudiocode" and is instead caught by the product display name, which
//     is why both id and name are passed to the classifier here exactly as the TS does.
//
#pragma once

#include "Common.h"

namespace v3cu {

enum class AppTier {
	Read,
	Click,
	Full,
	Self,
};

/// Classifies an application. `name` may be empty.
AppTier ClassifyApp(const std::string& id, const std::string& name);

/// Whether a tier permits a method. `method` is the wire method name.
bool IsActionAllowedForTier(AppTier tier, const std::string& method);

/// A human-readable refusal reason, or an empty string when the action is allowed.
std::string DescribeTierRefusal(AppTier tier, const std::string& method);

/// The tier name, for logs.
const char* AppTierName(AppTier tier);

} // namespace v3cu
