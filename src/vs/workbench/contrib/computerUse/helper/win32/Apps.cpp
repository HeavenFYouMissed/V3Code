/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Application identity implementation. See Apps.h.
// NEEDS VERIFICATION ON WINDOWS (full list in Apps.h):
//   - The IsAppWindow filter against a real desktop: no cloaked UWP apps, no tool windows, one
//     entry per process.
//   - GetFileDescription's version-resource walk, including apps with no version resource.
//   - QueryFullProcessImageNameW against a higher-integrity process (expect failure, must degrade).
//
#include "Apps.h"

#include "Cancellation.h"
#include "Log.h"

#include <algorithm>
#include <cstdio>
#include <dwmapi.h>
#include <shellapi.h>
#include <vector>
#include <winver.h>

// ShellExecuteExW lives in shell32.lib, which is not in the link list in
// scripts/build-computer-use-helper-win32.ps1. Declaring it here rather than editing that script
// keeps the dependency next to the only code that needs it, and means the build cannot be broken by
// the two files disagreeing.
#pragma comment(lib, "shell32.lib")

namespace v3cu {
namespace {

/// A top-level window that a user would consider "an app window".
bool IsAppWindow(HWND window) {
	if (!::IsWindowVisible(window)) {
		return false;
	}
	if (::GetWindow(window, GW_OWNER) != nullptr) {
		return false; // Dialogs and palettes belong to their owner.
	}
	const LONG_PTR exStyle = ::GetWindowLongPtrW(window, GWL_EXSTYLE);
	if ((exStyle & WS_EX_TOOLWINDOW) != 0) {
		return false;
	}
	if (::GetWindowTextLengthW(window) == 0) {
		return false;
	}
	// Suspended UWP apps keep a visible, titled window that is cloaked by DWM. Without this check
	// listApps is full of apps the user cannot see.
	int cloaked = 0;
	if (SUCCEEDED(::DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) &&
		cloaked != 0) {
		return false;
	}
	return true;
}

std::string GetWindowTitleUtf8(HWND window) {
	const int length = ::GetWindowTextLengthW(window);
	if (length <= 0) {
		return std::string();
	}
	std::wstring buffer(static_cast<size_t>(length) + 1, L'\0');
	const int copied = ::GetWindowTextW(window, &buffer[0], static_cast<int>(buffer.size()));
	if (copied <= 0) {
		return std::string();
	}
	buffer.resize(static_cast<size_t>(copied));
	return WideToUtf8(buffer);
}

/// Full image path for a pid, or empty on failure.
std::wstring GetExecutablePathForPid(unsigned long pid) {
	const HANDLE process =
		::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
	if (process == nullptr) {
		return std::wstring();
	}
	std::wstring path(MAX_PATH, L'\0');
	DWORD size = static_cast<DWORD>(path.size());
	const BOOL ok = ::QueryFullProcessImageNameW(process, 0, &path[0], &size);
	::CloseHandle(process);
	if (!ok || size == 0) {
		return std::wstring();
	}
	path.resize(size);
	return path;
}

/// FileDescription from a module's version resource, or empty.
std::string GetFileDescription(const std::wstring& path) {
	if (path.empty()) {
		return std::string();
	}
	const DWORD size = ::GetFileVersionInfoSizeW(path.c_str(), nullptr);
	if (size == 0) {
		return std::string();
	}
	std::vector<uint8_t> buffer(size, 0);
	if (!::GetFileVersionInfoW(path.c_str(), 0, size, buffer.data())) {
		return std::string();
	}

	// The translation table gives the language/codepage pairs present in the resource; the first
	// one is the file's primary language.
	struct LangAndCodePage {
		WORD language;
		WORD codePage;
	};
	LangAndCodePage* translations = nullptr;
	UINT translationBytes = 0;
	if (!::VerQueryValueW(buffer.data(), L"\\VarFileInfo\\Translation",
			reinterpret_cast<LPVOID*>(&translations), &translationBytes) ||
		translations == nullptr || translationBytes < sizeof(LangAndCodePage)) {
		return std::string();
	}

	wchar_t subBlock[64] = {};
	::_snwprintf_s(subBlock, _countof(subBlock), _TRUNCATE,
		L"\\StringFileInfo\\%04x%04x\\FileDescription", translations[0].language,
		translations[0].codePage);

	wchar_t* description = nullptr;
	UINT descriptionLength = 0;
	if (!::VerQueryValueW(buffer.data(), subBlock, reinterpret_cast<LPVOID*>(&description),
			&descriptionLength) ||
		description == nullptr || descriptionLength == 0) {
		return std::string();
	}
	return WideToUtf8(description, static_cast<int>(descriptionLength));
}

struct EnumState {
	std::vector<AppInfo>* apps = nullptr;
};

/// State for FindMainWindowForPid's enumeration.
struct FindWindowState {
	unsigned long pid = 0;
	HWND found = nullptr;
};

BOOL CALLBACK FindFirstAppWindowForPid(HWND window, LPARAM userData) {
	auto* search = reinterpret_cast<FindWindowState*>(userData);
	DWORD windowPid = 0;
	::GetWindowThreadProcessId(window, &windowPid);
	if (static_cast<unsigned long>(windowPid) != search->pid) {
		return TRUE;
	}
	if (!IsAppWindow(window)) {
		return TRUE;
	}
	search->found = window;
	return FALSE; // Stop at the first match; EnumWindows walks in z-order.
}

BOOL CALLBACK CollectAppWindow(HWND window, LPARAM userData) {
	auto* state = reinterpret_cast<EnumState*>(userData);
	if (!IsAppWindow(window)) {
		return TRUE;
	}
	DWORD pid = 0;
	::GetWindowThreadProcessId(window, &pid);
	if (pid == 0) {
		return TRUE;
	}

	// One entry per process: the first (topmost, since EnumWindows walks in z-order) window wins.
	for (const AppInfo& existing : *state->apps) {
		if (existing.pid == static_cast<unsigned long>(pid)) {
			return TRUE;
		}
	}

	AppInfo app;
	app.pid = static_cast<unsigned long>(pid);
	app.id = GetExecutableNameForPid(app.pid);
	const std::wstring path = GetExecutablePathForPid(app.pid);
	app.name = GetFileDescription(path);
	if (app.name.empty()) {
		app.name = GetWindowTitleUtf8(window);
	}
	if (app.name.empty()) {
		app.name = app.id;
	}
	state->apps->push_back(std::move(app));
	return TRUE;
}

} // namespace

std::string GetExecutableNameForPid(unsigned long pid) {
	const std::wstring path = GetExecutablePathForPid(pid);
	if (path.empty()) {
		return std::string();
	}
	const size_t slash = path.find_last_of(L"\\/");
	const std::wstring fileName = slash == std::wstring::npos ? path : path.substr(slash + 1);
	// Lower-cased with the extension kept: the tier fragment list matches on things like "cmd.exe".
	return ToLowerAscii(WideToUtf8(fileName));
}

HWND FindMainWindowForPid(unsigned long pid) {
	const HWND foreground = ::GetForegroundWindow();
	if (foreground != nullptr) {
		DWORD foregroundPid = 0;
		::GetWindowThreadProcessId(foreground, &foregroundPid);
		if (static_cast<unsigned long>(foregroundPid) == pid) {
			return foreground;
		}
	}

	FindWindowState state;
	state.pid = pid;
	::EnumWindows(FindFirstAppWindowForPid, reinterpret_cast<LPARAM>(&state));
	return state.found;
}

namespace {

/// State for FindAppWindowsForPid.
struct CollectWindowsState {
	unsigned long pid = 0;
	std::vector<HWND>* windows = nullptr;
};

BOOL CALLBACK CollectAppWindowsForPid(HWND window, LPARAM userData) {
	auto* state = reinterpret_cast<CollectWindowsState*>(userData);
	DWORD windowPid = 0;
	::GetWindowThreadProcessId(window, &windowPid);
	if (static_cast<unsigned long>(windowPid) == state->pid && IsAppWindow(window)) {
		state->windows->push_back(window);
	}
	return TRUE;
}

} // namespace

std::vector<HWND> FindAppWindowsForPid(unsigned long pid) {
	std::vector<HWND> windows;
	CollectWindowsState state;
	state.pid = pid;
	state.windows = &windows;
	::EnumWindows(CollectAppWindowsForPid, reinterpret_cast<LPARAM>(&state));
	return windows;
}

bool GetAppInfoForPid(unsigned long pid, AppInfo& out) {
	AppInfo app;
	app.pid = pid;
	app.id = GetExecutableNameForPid(pid);
	app.name = GetFileDescription(GetExecutablePathForPid(pid));
	if (app.name.empty()) {
		const HWND window = FindMainWindowForPid(pid);
		if (window != nullptr) {
			app.name = GetWindowTitleUtf8(window);
		}
	}
	if (app.name.empty()) {
		app.name = app.id;
	}
	// An empty id means the process could not be opened at all — a higher integrity level, or it
	// exited between enumeration and here. Report the failure rather than an anonymous app.
	if (app.id.empty() && app.name.empty()) {
		return false;
	}
	out = std::move(app);
	return true;
}

bool GetFrontmostApp(AppInfo& out) {
	const HWND foreground = ::GetForegroundWindow();
	if (foreground == nullptr) {
		LogWarn("GetForegroundWindow returned null (locked session or secure desktop)");
		return false;
	}
	DWORD pid = 0;
	::GetWindowThreadProcessId(foreground, &pid);
	if (pid == 0) {
		return false;
	}

	AppInfo app;
	app.pid = static_cast<unsigned long>(pid);
	app.id = GetExecutableNameForPid(app.pid);
	app.name = GetFileDescription(GetExecutablePathForPid(app.pid));
	const std::string title = GetWindowTitleUtf8(foreground);
	if (app.name.empty()) {
		app.name = title;
	}
	if (app.name.empty()) {
		app.name = app.id;
	}
	if (!title.empty()) {
		app.title = title;
		app.hasTitle = true;
	}
	out = std::move(app);
	return true;
}

std::vector<AppInfo> ListApps() {
	std::vector<AppInfo> apps;
	EnumState state;
	state.apps = &apps;
	::EnumWindows(CollectAppWindow, reinterpret_cast<LPARAM>(&state));
	return apps;
}

// ---------------------------------------------------------------------------------------------
// openApplication
//
// NEEDS VERIFICATION ON WINDOWS: everything in this section. See the list in Apps.h — in
// particular the Start Menu walk, the null-hProcess launch, and SetForegroundWindow being refused.
// ---------------------------------------------------------------------------------------------

namespace {

/// How often the foreground and the app list are re-checked while waiting.
constexpr int kOpenPollIntervalMs = 50;

/// Hard ceiling on waitMs. A caller asking for longer has a bug, and this blocks the worker thread.
constexpr int kMaxOpenWaitMs = 60000;

/// Directory depth and entry budget for the Start Menu walk. The Start Menu is nested two or three
/// levels deep in practice; the budget stops a pathological folder from turning a launch into a
/// filesystem crawl.
constexpr int kMaxShortcutDepth = 4;
constexpr int kMaxShortcutEntries = 4000;

/// Shortest key that may match by substring. Without this, "ai" matches half the desktop.
constexpr size_t kMinSubstringKeyLength = 3;

std::string TrimAscii(const std::string& text) {
	size_t begin = 0;
	size_t end = text.size();
	while (begin < end && (text[begin] == ' ' || text[begin] == '\t')) {
		++begin;
	}
	while (end > begin && (text[end - 1] == ' ' || text[end - 1] == '\t')) {
		--end;
	}
	return text.substr(begin, end - begin);
}

bool EndsWith(const std::string& text, const std::string& suffix) {
	return text.size() >= suffix.size() &&
		text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string WithExeSuffix(const std::string& name) {
	return EndsWith(name, ".exe") ? name : name + ".exe";
}

/// The keys a query is matched on, most specific first.
///
/// A bundle-identifier-shaped query contributes its last component as well: "com.microsoft.Edge"
/// has no meaning on Windows, but "edge" does. The whole string is kept as a key too, because a
/// query with a dot in it may equally be "notepad.exe".
std::vector<std::string> BuildMatchKeys(const std::string& query) {
	std::vector<std::string> keys;
	const std::string lowered = ToLowerAscii(query);
	keys.push_back(lowered);

	const size_t dot = lowered.find_last_of('.');
	if (dot != std::string::npos && dot + 1 < lowered.size() && !EndsWith(lowered, ".exe") &&
		lowered.find('\\') == std::string::npos && lowered.find('/') == std::string::npos) {
		const std::string tail = lowered.substr(dot + 1);
		if (!tail.empty() && tail != lowered) {
			keys.push_back(tail);
		}
	}
	return keys;
}

/// How well one running application matches one key. 0 means no match; higher is better.
int ScoreAppAgainstKey(const AppInfo& app, const std::string& key) {
	if (key.empty()) {
		return 0;
	}
	const std::string id = ToLowerAscii(app.id);
	const std::string name = ToLowerAscii(app.name);
	const std::string keyExe = WithExeSuffix(key);

	if (!id.empty() && (id == key || id == keyExe)) {
		return 100;
	}
	if (!name.empty() && name == key) {
		return 90;
	}
	if (!name.empty() && name.rfind(key, 0) == 0) {
		return 70;
	}
	if (key.size() >= kMinSubstringKeyLength) {
		if (!name.empty() && name.find(key) != std::string::npos) {
			return 50;
		}
		if (!id.empty() && id.find(key) != std::string::npos) {
			return 40;
		}
	}
	return 0;
}

/// The best-matching running application, or false when nothing matches.
bool FindRunningApp(const std::vector<std::string>& keys, AppInfo& out) {
	const std::vector<AppInfo> apps = ListApps();
	int bestScore = 0;
	const AppInfo* best = nullptr;
	for (const AppInfo& app : apps) {
		for (size_t index = 0; index < keys.size(); ++index) {
			// Later keys are the fallback interpretations of the query, so they score lower than
			// the same quality of match on the first key.
			const int penalty = static_cast<int>(index);
			const int score = ScoreAppAgainstKey(app, keys[index]);
			if (score > 0 && score - penalty > bestScore) {
				bestScore = score - penalty;
				best = &app;
			}
		}
	}
	if (best == nullptr) {
		return false;
	}
	out = *best;
	return true;
}

/// Asks the window manager to bring a process's main window forward. Returns false when the process
/// has no window yet; a refused foreground change still returns true, because the request was made.
bool RequestForeground(unsigned long pid) {
	const HWND window = FindMainWindowForPid(pid);
	if (window == nullptr) {
		return false;
	}
	if (::IsIconic(window)) {
		::ShowWindow(window, SW_RESTORE);
	}
	// Deliberately unchecked. SetForegroundWindow returns FALSE both when it refused and, on some
	// versions, when the window was already foreground. The only trustworthy answer is to look at
	// GetForegroundWindow afterwards, which is what the caller does.
	::SetForegroundWindow(window);
	return true;
}

bool IsForeground(unsigned long pid) {
	const HWND foreground = ::GetForegroundWindow();
	if (foreground == nullptr) {
		return false;
	}
	DWORD foregroundPid = 0;
	::GetWindowThreadProcessId(foreground, &foregroundPid);
	return static_cast<unsigned long>(foregroundPid) == pid;
}

/// Polls until the process owns the foreground window or the budget runs out.
bool WaitForForeground(unsigned long pid, int budgetMs) {
	const ULONGLONG deadline = ::GetTickCount64() + static_cast<ULONGLONG>(budgetMs < 0 ? 0 : budgetMs);
	for (;;) {
		RequestForeground(pid);
		if (IsForeground(pid)) {
			return true;
		}
		if (Cancellation::IsRequested() || ::GetTickCount64() >= deadline) {
			return false;
		}
		::Sleep(static_cast<DWORD>(kOpenPollIntervalMs));
	}
}

std::wstring EnvironmentVariable(const wchar_t* name) {
	const DWORD needed = ::GetEnvironmentVariableW(name, nullptr, 0);
	if (needed == 0) {
		return std::wstring();
	}
	std::wstring value(needed, L'\0');
	const DWORD written = ::GetEnvironmentVariableW(name, &value[0], needed);
	if (written == 0 || written >= needed) {
		return std::wstring();
	}
	value.resize(written);
	return value;
}

/// Scores a Start Menu shortcut's file name (without ".lnk") against a key.
int ScoreShortcutName(const std::string& stemLower, const std::string& key) {
	if (stemLower.empty() || key.empty()) {
		return 0;
	}
	if (stemLower == key || stemLower == WithExeSuffix(key)) {
		return 100;
	}
	if (stemLower.rfind(key, 0) == 0) {
		return 70;
	}
	if (key.size() >= kMinSubstringKeyLength && stemLower.find(key) != std::string::npos) {
		return 50;
	}
	return 0;
}

/// Walks one Start Menu directory tree looking for the best-matching .lnk.
void SearchShortcutsIn(const std::wstring& directory, const std::vector<std::string>& keys,
	int depth, int& entryBudget, std::wstring& bestPath, int& bestScore) {
	if (depth > kMaxShortcutDepth || entryBudget <= 0 || directory.empty()) {
		return;
	}
	const std::wstring pattern = directory + L"\\*";
	WIN32_FIND_DATAW found = {};
	const HANDLE search = ::FindFirstFileW(pattern.c_str(), &found);
	if (search == INVALID_HANDLE_VALUE) {
		return;
	}
	const auto closeGuard = MakeScopeExit([search]() { ::FindClose(search); });

	do {
		if (--entryBudget <= 0) {
			LogWarn("openApplication: Start Menu walk hit its entry budget; the search was truncated");
			return;
		}
		const std::wstring name = found.cFileName;
		if (name == L"." || name == L"..") {
			continue;
		}
		const std::wstring full = directory + L"\\" + name;
		if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
			SearchShortcutsIn(full, keys, depth + 1, entryBudget, bestPath, bestScore);
			continue;
		}

		const std::string nameUtf8 = ToLowerAscii(WideToUtf8(name));
		if (!EndsWith(nameUtf8, ".lnk")) {
			continue;
		}
		const std::string stem = nameUtf8.substr(0, nameUtf8.size() - 4);
		for (size_t index = 0; index < keys.size(); ++index) {
			const int score = ScoreShortcutName(stem, keys[index]) - static_cast<int>(index);
			if (score > bestScore) {
				bestScore = score;
				bestPath = full;
			}
		}
	} while (::FindNextFileW(search, &found) != FALSE);
}

/// The best-matching Start Menu shortcut across the machine-wide and per-user Start Menus.
std::wstring FindStartMenuShortcut(const std::vector<std::string>& keys) {
	const std::wstring suffix = L"\\Microsoft\\Windows\\Start Menu\\Programs";
	std::vector<std::wstring> roots;
	const std::wstring programData = EnvironmentVariable(L"ProgramData");
	if (!programData.empty()) {
		roots.push_back(programData + suffix);
	}
	const std::wstring appData = EnvironmentVariable(L"APPDATA");
	if (!appData.empty()) {
		roots.push_back(appData + suffix);
	}

	std::wstring bestPath;
	int bestScore = 0;
	int entryBudget = kMaxShortcutEntries;
	for (const std::wstring& root : roots) {
		SearchShortcutsIn(root, keys, 0, entryBudget, bestPath, bestScore);
	}
	return bestPath;
}

/// ShellExecuteExW one file. `pid` is 0 when the shell did not hand back a process, which happens
/// whenever the launch is serviced by an already-running instance.
///
/// NOTE FOR THE SERVICE: this runs the shell's `open` verb on the string it is given, so a query
/// that is a path to a document or a script opens that instead of an application. The helper does
/// not second-guess it — refusing paths would break "open C:\\Tools\\thing.exe" — but
/// openApplication is in COMPUTER_USE_MUTATING_METHODS for exactly this reason and must stay behind
/// the approval gate.
bool ShellLaunch(const std::wstring& file, unsigned long& pid) {
	SHELLEXECUTEINFOW info = {};
	info.cbSize = sizeof(info);
	// NOCLOSEPROCESS to get the pid; NO_UI so a failure is a return value rather than a message box
	// on the user's screen; NOASYNC because this thread does not pump messages and may go on to
	// block, which the shell's async DDE path does not tolerate.
	info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
	info.lpVerb = L"open";
	info.lpFile = file.c_str();
	info.nShow = SW_SHOWNORMAL;

	// Hands this process's foreground privilege to whatever is about to start, so a newly launched
	// application can put itself in front. Without it Windows leaves the new window behind the
	// current one and merely flashes its taskbar button.
	::AllowSetForegroundWindow(ASFW_ANY);

	if (::ShellExecuteExW(&info) == FALSE) {
		return false;
	}
	pid = 0;
	if (info.hProcess != nullptr) {
		pid = static_cast<unsigned long>(::GetProcessId(info.hProcess));
		::CloseHandle(info.hProcess);
	}
	return true;
}

/// Tries every launch form in order. Returns false when none of them started anything.
bool LaunchApplication(const std::string& query, const std::vector<std::string>& keys,
	unsigned long& pid) {
	std::vector<std::wstring> candidates;
	candidates.push_back(Utf8ToWide(query));
	if (!EndsWith(ToLowerAscii(query), ".exe")) {
		candidates.push_back(Utf8ToWide(query + ".exe"));
	}
	// The bundle-identifier tail, e.g. "edge" from "com.microsoft.Edge".
	for (size_t index = 1; index < keys.size(); ++index) {
		candidates.push_back(Utf8ToWide(WithExeSuffix(keys[index])));
	}

	for (const std::wstring& candidate : candidates) {
		if (ShellLaunch(candidate, pid)) {
			LogDebug("openApplication: launched via ShellExecuteExW: " + WideToUtf8(candidate));
			return true;
		}
	}

	// Display names only ever resolve here: "Google Chrome" is not an executable, but there is a
	// "Google Chrome.lnk" in the Start Menu.
	const std::wstring shortcut = FindStartMenuShortcut(keys);
	if (!shortcut.empty() && ShellLaunch(shortcut, pid)) {
		LogDebug("openApplication: launched via Start Menu shortcut: " + WideToUtf8(shortcut));
		return true;
	}
	return false;
}

} // namespace

bool OpenApplication(const std::string& query, int waitMs, OpenApplicationOutcome& out,
	ErrorCode& code, std::string& message) {
	const std::string trimmed = TrimAscii(query);
	if (trimmed.empty()) {
		code = ErrorCode::Internal;
		message = "openApplication requires a non-empty app";
		return false;
	}
	const int budgetMs = Clamp(waitMs, 0, kMaxOpenWaitMs);
	const std::vector<std::string> keys = BuildMatchKeys(trimmed);

	// 1. Already running. Focusing beats launching: a second instance of a single-instance
	//    application is at best a wasted window.
	AppInfo running;
	if (FindRunningApp(keys, running)) {
		out.app = running;
		out.launched = false;
		out.frontmost = WaitForForeground(running.pid, budgetMs);
		if (!out.frontmost) {
			LogWarn("openApplication: '" + trimmed + "' is running as pid " +
				std::to_string(running.pid) +
				" but Windows did not grant the foreground change within the budget");
		}
		return true;
	}

	// 2. Launch it.
	unsigned long pid = 0;
	if (!LaunchApplication(trimmed, keys, pid)) {
		code = ErrorCode::TargetNotFound;
		message = "no running application matches '" + trimmed +
			"', and it could not be launched as an executable name or as a Start Menu shortcut";
		return false;
	}
	out.launched = true;

	// 3. Resolve what actually started. A null pid from the shell is normal — the launch may have
	//    been handed to an already-running instance — so fall back to watching for a matching
	//    application to appear.
	const ULONGLONG deadline = ::GetTickCount64() + static_cast<ULONGLONG>(budgetMs);
	AppInfo launched;
	bool resolved = false;
	for (;;) {
		if (pid != 0 && GetAppInfoForPid(pid, launched)) {
			resolved = true;
			// Keep waiting for a window: a process with no window yet cannot be focused, and
			// returning now would hand the caller a pid whose tree is empty.
			if (FindMainWindowForPid(pid) != nullptr) {
				break;
			}
		} else if (FindRunningApp(keys, launched)) {
			pid = launched.pid;
			resolved = true;
			break;
		}
		if (Cancellation::IsRequested()) {
			code = ErrorCode::Cancelled;
			message = "the action was cancelled";
			return false;
		}
		if (::GetTickCount64() >= deadline) {
			break;
		}
		::Sleep(static_cast<DWORD>(kOpenPollIntervalMs));
	}

	if (!resolved) {
		// Something was started — ShellExecuteExW succeeded — but nothing identifiable ever showed
		// up. Retryable with a longer budget, which is exactly what `timeout` means here.
		code = ErrorCode::Timeout;
		message = "'" + trimmed + "' was launched but produced no window within " +
			std::to_string(budgetMs) + "ms";
		return false;
	}

	out.app = launched;
	const ULONGLONG now = ::GetTickCount64();
	const int remainingMs = now >= deadline ? 0 : static_cast<int>(deadline - now);
	out.frontmost = WaitForForeground(pid, remainingMs);
	return true;
}

} // namespace v3cu
