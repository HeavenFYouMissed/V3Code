/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Application identity, for frontmostApp and listApps.
//
// ComputerUseApp.id is "the executable name on Windows", and the tier classifier in
// computerUseAppTiers.ts matches Windows apps on exactly that. It is lower-cased and keeps its
// extension — "msedge.exe", "windowsterminal.exe" — because the fragment lists in the tier module
// include entries like "cmd.exe" and "devenv.exe" that only match if the extension is present.
//
// ComputerUseApp.name is a human display name: the executable's FileDescription from its version
// resource when it has one (that is what Task Manager shows and what users recognise), falling back
// to the window title and then to the executable name.
//
// listApps reports one entry per process that owns at least one visible, non-cloaked, titled,
// unowned top-level window. That is the standard "what would appear in Alt+Tab" filter. Processes
// with no visible window are not applications for computer-use purposes.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - QueryFullProcessImageNameW with PROCESS_QUERY_LIMITED_INFORMATION against a process running
//     at a higher integrity level: expect failure, which must degrade to an empty id rather than
//     dropping the app silently in a confusing way.
//   - DWMWA_CLOAKED filtering, which is what keeps suspended UWP apps out of the list.
//   - FileDescription extraction: the version-resource walk below is the documented pattern but
//     has never been run. Apps with no version resource (most Electron dev builds) must fall
//     through cleanly.
//   - Whether UWP/packaged apps report a useful executable name (they report the real exe, e.g.
//     "applicationframehost.exe" for some windows, which is a known Windows wrinkle and may make
//     the tier classifier see the wrong identity). Flagged for the lead.
//
// NEEDS VERIFICATION ON WINDOWS — OpenApplication (protocol 3):
//   - Each resolution step, separately: a running app by display name; a not-running app by bare
//     executable name ("notepad"); a not-running app by display name via its Start Menu shortcut
//     ("Google Chrome"); a bundle-identifier-shaped string.
//   - That SetForegroundWindow is refused in the common case (V3Code, not the user, is driving) and
//     that `frontmost: false` is what comes back rather than a hang or a false success.
//   - ShellExecuteExW's hProcess being null for an application that hands off to an already-running
//     instance (Explorer windows, Office, most browsers). The pid then comes from the post-launch
//     poll, and that poll is the part most likely to be wrong.
//   - Whether the Start Menu walk is fast enough. It is bounded by depth and by file count, but it
//     is still a synchronous directory walk on the request thread.
//   - UWP/packaged applications, which have no Start Menu .lnk and no plain executable. They are
//     expected to FAIL to launch here; confirm the failure is a clean targetNotFound. The fix, if
//     one is wanted, is `shell:AppsFolder\<AUMID>`, which needs the AUMID and is not attempted.
//
// OPENING AN APPLICATION (protocol 3). ComputerUseOpenApplicationParams.app is "bundle identifier,
// executable name, or display name", because the model only knows the name a human would say. On
// Windows there is no bundle identifier, so the resolution order below is what makes "open Notepad",
// "open notepad.exe" and "open com.microsoft.notepad" all land on the same program:
//
//   1. An ALREADY-RUNNING application, matched against ListApps() on executable name then display
//      name. Focusing what is already open is preferred over launching: a second instance of a
//      single-instance application is at best a wasted window and at worst a second copy of the
//      user's document.
//   2. ShellExecuteExW on the string itself, then on the string with ".exe" appended. This resolves
//      bare executable names through the App Paths registry key and PATH, which is what makes
//      "notepad", "msedge" and "winword" work without a full path.
//   3. A Start Menu shortcut whose file name matches. This is the display-name path: "Google Chrome"
//      is not an executable name and never resolves through step 2, but there is a
//      "Google Chrome.lnk" in the Start Menu, and ShellExecuteExW launches a .lnk directly.
//
// A bundle identifier ("com.microsoft.Edge") is handled by also trying its last dot-separated
// component against every step, which is the closest thing Windows has to that identity.
//
// FOREGROUND. Windows refuses SetForegroundWindow from a process that does not own the foreground
// and has no recent input — the documented behaviour is that the taskbar button flashes instead.
// That refusal is reported honestly as `frontmost: false` rather than papered over with the
// AttachThreadInput trick, which works by lying to the window manager about input ownership and
// fails differently across Windows versions.
//
#pragma once

#include "Common.h"
#include "Protocol.h"

#include <vector>

namespace v3cu {

struct AppInfo {
	/// Lower-cased executable name including extension, e.g. "notepad.exe".
	std::string id;
	/// Display name.
	std::string name;
	unsigned long pid = 0;
	/// Focused window title. Only set for the frontmost app, and only when non-empty.
	std::string title;
	bool hasTitle = false;
};

/// The foreground window's application. Returns false when there is no foreground window (a locked
/// session, or the secure desktop).
bool GetFrontmostApp(AppInfo& out);

/// Every application with a visible top-level window, one entry per process.
std::vector<AppInfo> ListApps();

/// Lower-cased executable name for a pid, or an empty string when it cannot be read.
std::string GetExecutableNameForPid(unsigned long pid);

/// A representative top-level window for a pid, preferring the foreground window when it belongs to
/// that process. Returns nullptr when the process has no suitable window.
HWND FindMainWindowForPid(unsigned long pid);

/// Every visible top-level window belonging to a pid, in z-order. axTree walks all of them, because
/// an application's menus and dialogs are separate top-level windows and the model needs to see them.
std::vector<HWND> FindAppWindowsForPid(unsigned long pid);

/// Identity for an arbitrary pid, without needing one of its windows. `title` is left unset.
bool GetAppInfoForPid(unsigned long pid, AppInfo& out);

/// The result of `openApplication`. Mirrors ComputerUseOpenApplicationResult.
struct OpenApplicationOutcome {
	AppInfo app;
	/// True only when THIS call started the process. Focusing something already running is false.
	bool launched = false;
	/// True only when the application actually reached the foreground within the budget.
	bool frontmost = false;
};

/// Launches `query`, or focuses it when it is already running. See the resolution order at the top
/// of this header. On failure sets `code` (targetNotFound when nothing resolved, timeout when
/// something was launched but never produced a window) and `message`.
bool OpenApplication(const std::string& query, int waitMs, OpenApplicationOutcome& out,
	ErrorCode& code, std::string& message);

} // namespace v3cu
