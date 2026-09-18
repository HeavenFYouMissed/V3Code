#!/usr/bin/env bash
# V3Code (VSElite) — build + launch a dev instance ALONGSIDE a running V3Code.
#
# Why this exists: v3-relaunch.sh force-quits every process matching
# "V3Code.app/Contents/MacOS/V3Code". When you are driving an agent from inside the
# installed /Applications/V3Code.app, that pattern matches the editor you are sitting in.
# This script never kills anything it did not itself start.
#
# Whether v3-relaunch.sh actually kills your session depends on WHERE it is run from, which
# is worse than it simply always doing so. pkill excludes the calling process and all of its
# ancestors by default (see the -a flag in `man pgrep`). An agent terminal hosted inside
# V3Code is a descendant of the app:
#
#     /Applications/V3Code.app/Contents/MacOS/V3Code   <- pid 18171
#       -> V3Code Helper
#            -> /bin/zsh                               <- the agent's shell
#
# so pkill run from that shell silently skips the editor, and the osascript fallback never
# fires either because its pgrep guard is filtered the same way. Run the identical command
# from Terminal.app or iTerm and V3Code is no longer an ancestor, so it matches and dies.
# Relying on that is relying on an accident of process ancestry. Hence: pid files.
#
# It is safe to run two instances because the data is genuinely isolated. code.sh exports
# VSCODE_DEV=1, and TWO SEPARATE mechanisms react to it. They do not agree, and the difference
# matters when you go looking for the dev instance's files:
#
#     installed   -> ~/Library/Application Support/V3Code/        (user data: db, logs, state)
#                 -> ~/.v3code                                    (extensions)
#     dev build   -> ~/Library/Application Support/code-oss-dev/  (user data: db, logs, state)
#                 -> ~/.v3code-dev                                (extensions)
#
# The extensions half comes from product.ts:33-40, which appends "-dev" to dataFolderName.
# The user-data half does NOT. userDataPath.ts:44-49 ignores the product name entirely and
# hardcodes 'code-oss-dev' whenever VSCODE_DEV is set — the same string as package.json's
# name field. So "V3Code Dev" is a directory that product.ts's nameShort rewrite implies but
# nothing on disk actually uses.
#
# Either way the two instances get separate memory databases, storage, window state and
# extension folders, which is what makes running them side by side safe.
#
# TWO THINGS ARE STILL SHARED. Neither is namespaced by dataFolderName:
#   * the beast sidecar binary and its database, hardcoded to ~/.v3code/bin/beast and
#     ~/.v3code/beastdb in electron-main/beastChannel.ts. Rebuilding beast swaps the
#     binary underneath the running installed app, so this script does NOT rebuild it
#     unless you pass --build-beast.
#   * ~/.build/electron, which in a worktree is a symlink to the factory checkout. Both
#     apps are therefore literally named V3Code.app, which is exactly why stopping the dev
#     instance here uses a recorded pid rather than a pkill pattern.
#
# Usage:  ./scripts/v3-dev-alongside.sh [flags] [workspace-folder]
#   --seed-memory     clone the installed memory library into the dev user-data dir before
#                     launching, so schema migrations run against real data instead of an
#                     empty database. APFS copy-on-write, so it is near instant and costs
#                     almost no disk until pages diverge. Refuses to overwrite an existing
#                     dev library unless combined with --reseed.
#   --reseed          delete an existing dev memory library first, then seed.
#   --build-beast     rebuild the beast sidecar. Off by default: the binary is shared with
#                     the running installed app.
#   --launch-only     skip the watch, React bundle and freshness gate; launch whatever is
#                     already in out/.
#   --restart         stop the dev instance this script previously started, then launch a
#                     new one. Only ever touches the recorded pid.
#   --stop            stop the dev instance this script previously started and exit.
#   --status          report whether a dev instance from this worktree is running, and exit.
#   --foreground      stay attached. Default is detached, because an agent harness kills its
#                     whole process group when the command returns.
#   --log             detached, but tee stdout/stderr to a log file instead of discarding
#                     them. Use this when a launch died and left no evidence: detached mode
#                     sends both streams to DEVNULL, so a crash on startup vanishes.
#   --remote-debugging-port=PORT
#                     expose Chromium's debugger for automated verification.
#   workspace-folder  folder to open. Defaults to V3_SCRATCH_WORKSPACE or ~/dev/v3code-scratch.
#                     Opening the source tree is refused; see the hot-exit note below.
set -euo pipefail

SEED_MEMORY=0
RESEED=0
BUILD_BEAST=0
LAUNCH_ONLY=0
DO_RESTART=0
DO_STOP=0
DO_STATUS=0
FOREGROUND=0
LOG_LAUNCH=0
REMOTE_DEBUGGING_PORT=""
WORKSPACE=""

for arg in "$@"; do
	case "$arg" in
		--seed-memory) SEED_MEMORY=1 ;;
		--reseed) RESEED=1; SEED_MEMORY=1 ;;
		--build-beast) BUILD_BEAST=1 ;;
		--launch-only) LAUNCH_ONLY=1 ;;
		--restart) DO_RESTART=1 ;;
		--stop) DO_STOP=1 ;;
		--status) DO_STATUS=1 ;;
		--foreground) FOREGROUND=1 ;;
		--log) LOG_LAUNCH=1 ;;
		--remote-debugging-port=*) REMOTE_DEBUGGING_PORT="${arg#*=}" ;;
		-h|--help) sed -n '1,45p' "$0"; exit 0 ;;
		-*) echo "[v3-alongside] unknown flag: $arg" >&2; exit 2 ;;
		*) WORKSPACE="$arg" ;;
	esac
done

if [[ -n "$REMOTE_DEBUGGING_PORT" && ( ! "$REMOTE_DEBUGGING_PORT" =~ ^[0-9]+$ || "$REMOTE_DEBUGGING_PORT" -lt 1024 || "$REMOTE_DEBUGGING_PORT" -gt 65535 ) ]]; then
	echo "[v3-alongside] remote debugging port must be an integer from 1024 to 65535" >&2
	exit 2
fi

if [ -n "$WORKSPACE" ]; then
	if [ ! -d "$WORKSPACE" ]; then
		echo "[v3-alongside] not a folder: $WORKSPACE" >&2
		exit 2
	fi
	# Resolve now: the launch runs from the repo root, so a relative path would break.
	WORKSPACE="$(cd "$WORKSPACE" && pwd)"
fi

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
export PATH="/opt/homebrew/bin:$PATH"
unset ELECTRON_RUN_AS_NODE || true
export VSCODE_SKIP_PRELAUNCH=1   # electron is already downloaded; skip the slow re-download

# One pid file per worktree, so several worktrees can each hold their own dev instance
# without fighting over the same record.
RUN_DIR="$HOME/.v3code-dev-launch"
WORKTREE_KEY="$(printf '%s' "$REPO_ROOT" | shasum -a 256 | cut -c1-16)"
PID_FILE="$RUN_DIR/$WORKTREE_KEY.pid"
mkdir -p "$RUN_DIR"

# ---------------------------------------------------------------------------
# Process control. Everything here is deliberately pid-based.
#
# v3-relaunch.sh can pkill by name because it assumes it owns the only instance. We cannot:
# .build/electron is a symlink into the factory, so the dev binary and the installed binary
# are both "V3Code.app/Contents/MacOS/V3Code". Any pattern broad enough to catch the dev
# instance also catches /Applications, which is the editor the operator is using. So we only
# ever act on a pid we recorded ourselves, and we re-verify that pid before signalling it.
# ---------------------------------------------------------------------------

# Absolute executable path for a pid, or empty if it is gone. macOS `ps -o comm=` reports the
# full path, which is what lets is_our_dev_instance tell /Applications apart from .build.
pid_exe_path() {
	local pid="$1" out
	# Same SIGPIPE reasoning as installed_app_pid: no `| head` inside a pipefail script.
	out="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
	printf '%s' "${out%%$'\n'*}"
}

# pid of the installed app, or empty. Deliberately NOT pgrep: when this script runs from a
# terminal inside V3Code, the app is an ancestor of the shell and pgrep filters it out, so a
# pgrep-based check reports "not running" about the very app the user is looking at. ps has no
# such exclusion. This is only ever used for reporting and for warning before a seed; nothing
# in this script signals the pid it returns.
#
# No `exit` inside awk and no `| head`: closing the pipe early makes ps die of SIGPIPE, the
# pipeline returns 141, and under `set -o pipefail` that aborts the script inside a command
# substitution. The first line is taken with bash parameter expansion instead, after the
# pipeline has been allowed to finish.
installed_app_pid() {
	local out
	out="$(ps -Ao pid=,comm= 2>/dev/null \
		| awk '$2 == "/Applications/V3Code.app/Contents/MacOS/V3Code" { print $1 }' || true)"
	printf '%s' "${out%%$'\n'*}"
}

# True when the pid is alive AND is not the installed app. The second half is the guard that
# makes an accidental match harmless: a stale pid file whose number has been recycled by an
# unrelated process must never be killed, and /Applications must never be touched at all.
is_our_dev_instance() {
	local pid="$1" exe
	[[ -n "$pid" ]] || return 1
	kill -0 "$pid" 2>/dev/null || return 1
	exe="$(pid_exe_path "$pid")"
	[[ -n "$exe" ]] || return 1
	case "$exe" in
		/Applications/*) return 1 ;;
	esac
	case "$exe" in
		*/V3Code|*/V3Code\ Dev|*/Electron) return 0 ;;
		*) return 1 ;;
	esac
}

read_pid_file() {
	[[ -f "$PID_FILE" ]] || return 1
	local pid
	pid="$(cat "$PID_FILE" 2>/dev/null || true)"
	[[ "$pid" =~ ^[0-9]+$ ]] || return 1
	printf '%s' "$pid"
}

stop_dev_instance() {
	local pid
	if ! pid="$(read_pid_file)"; then
		echo "[v3-alongside] no recorded dev instance for this worktree."
		return 0
	fi
	if ! is_our_dev_instance "$pid"; then
		echo "[v3-alongside] recorded pid $pid is not a live dev instance; clearing stale record."
		rm -f "$PID_FILE"
		return 0
	fi
	echo "[v3-alongside] stopping dev instance pid $pid ($(pid_exe_path "$pid"))..."
	kill "$pid" 2>/dev/null || true
	for _ in $(seq 1 20); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.5
	done
	if kill -0 "$pid" 2>/dev/null; then
		echo "[v3-alongside] still alive after 10s; sending SIGKILL."
		kill -9 "$pid" 2>/dev/null || true
		sleep 1
	fi
	rm -f "$PID_FILE"
	echo "[v3-alongside] dev instance stopped. The installed app was not touched."
}

report_status() {
	local pid
	if pid="$(read_pid_file)" && is_our_dev_instance "$pid"; then
		echo "[v3-alongside] dev instance RUNNING — pid $pid"
		echo "[v3-alongside]   exe:        $(pid_exe_path "$pid")"
		echo "[v3-alongside]   worktree:   $REPO_ROOT"
		echo "[v3-alongside]   user data:  $DEV_USER_DATA"
	else
		echo "[v3-alongside] no dev instance running for $REPO_ROOT"
	fi
	local installed
	installed="$(installed_app_pid)"
	if [[ -n "$installed" ]]; then
		echo "[v3-alongside] installed V3Code is running (pid $installed) and will not be touched."
	else
		echo "[v3-alongside] installed V3Code does not appear to be running."
	fi
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

APP_SUPPORT="$HOME/Library/Application Support"
# VERIFIED, and not what product.ts would lead you to believe. product.ts:33-40 does rewrite
# nameShort to "V3Code Dev" under VSCODE_DEV, but the user-data directory does not come from
# nameShort at all: userDataPath.ts:47-48 hardcodes it.
#
#     // 0. Running out of sources has a fixed productName
#     if (process.env['VSCODE_DEV']) {
#             productName = 'code-oss-dev';
#     }
#
# So a dev build stores everything under code-oss-dev, which also happens to be package.json's
# name. Seeding "V3Code Dev" writes a directory nothing ever reads, and the migration you were
# trying to exercise then runs against whatever is really in code-oss-dev instead. Confirmed by
# launching and finding logs/sockets in code-oss-dev while "V3Code Dev" held only the seed.
INSTALLED_USER_DATA="$APP_SUPPORT/V3Code"
DEV_USER_DATA="$APP_SUPPORT/code-oss-dev"
INSTALLED_MEMORY="$INSTALLED_USER_DATA/User/v3code-memory"
DEV_MEMORY="$DEV_USER_DATA/User/v3code-memory"

if [ "$DO_STATUS" = "1" ]; then
	report_status
	exit 0
fi

if [ "$DO_STOP" = "1" ]; then
	stop_dev_instance
	exit 0
fi

if [ "$DO_RESTART" = "1" ]; then
	stop_dev_instance
fi

# Refuse to start a second dev instance from the same worktree. Two Electron mains sharing
# one user-data dir race over storage and window state.
if EXISTING_PID="$(read_pid_file)" && is_our_dev_instance "$EXISTING_PID"; then
	echo "[v3-alongside] a dev instance from this worktree is already running (pid $EXISTING_PID)." >&2
	echo "[v3-alongside] use --restart to rebuild and replace it, or --stop to shut it down." >&2
	exit 2
fi
rm -f "$PID_FILE"

# The dev build must never open the source tree it was built from. On exit the app preserves
# unsaved editor buffers as hot-exit backups and writes them back on the next launch, so a tab
# holding pre-fix content can overwrite a fix that is already committed — no git operation,
# nothing in the reflog, and the only symptom is the compiler reporting errors in code that is
# correct on the branch. Default to a scratch folder, and refuse the repo outright.
if [ -z "$WORKSPACE" ]; then
	WORKSPACE="${V3_SCRATCH_WORKSPACE:-$HOME/dev/v3code-scratch}"
	mkdir -p "$WORKSPACE"
	echo "[v3-alongside] no workspace given; opening scratch folder $WORKSPACE"
fi
case "$WORKSPACE" in
	"$REPO_ROOT" | "$REPO_ROOT"/*)
		echo "[v3-alongside] refusing to open the source tree: $WORKSPACE" >&2
		echo "[v3-alongside] the app restores unsaved tabs on launch and can overwrite committed edits." >&2
		echo "[v3-alongside] pass a different folder, or set V3_SCRATCH_WORKSPACE." >&2
		exit 2
		;;
esac

# ---------------------------------------------------------------------------
# Optional memory seeding
#
# A dev build gets its own code-oss-dev user-data dir, so any schema migration runs
# against an EMPTY database — which proves the fresh-install path and nothing else. The
# interesting case is the real library with years of events in it. Cloning gives the migration
# genuine data to chew on while leaving the original untouched: if it corrupts the copy, that
# happens in a sandbox instead of after a merge.
#
# APFS clonefile (cp -c) makes this near instant and near free; blocks are shared until one
# side writes, so a migration only pays for the pages it actually dirties.
# ---------------------------------------------------------------------------

seed_memory_library() {
	if [[ ! -d "$INSTALLED_MEMORY" ]]; then
		echo "[v3-alongside] no installed memory library at $INSTALLED_MEMORY — skipping seed."
		return 0
	fi

	if [[ -e "$DEV_MEMORY" ]]; then
		if [ "$RESEED" != "1" ]; then
			echo "[v3-alongside] dev memory library already exists at:" >&2
			echo "[v3-alongside]   $DEV_MEMORY" >&2
			echo "[v3-alongside] refusing to overwrite it. Pass --reseed to replace it." >&2
			exit 2
		fi
		echo "[v3-alongside] --reseed: removing existing dev memory library..."
		rm -rf "$DEV_MEMORY"
	fi

	# Never seed while the source is being written to. A mid-write SQLite copy can carry a hot
	# WAL and look corrupt on open, which would read as a migration bug that does not exist.
	if [[ -n "$(installed_app_pid)" ]]; then
		echo "[v3-alongside] NOTE: the installed app is running, so its SQLite files are live."
		echo "[v3-alongside] The clone includes -wal/-shm sidecars, which is what makes an active"
		echo "[v3-alongside] database recoverable on open. If the seeded copy looks damaged, quit"
		echo "[v3-alongside] the installed app and re-run with --reseed for a quiescent copy."
	fi

	local size
	size="$(du -sh "$INSTALLED_MEMORY" 2>/dev/null | cut -f1 || echo '?')"
	echo "[v3-alongside] cloning memory library ($size) into the dev user-data dir..."
	mkdir -p "$(dirname "$DEV_MEMORY")"

	# -c asks for APFS clonefile; fall back to a plain recursive copy on any other filesystem.
	if ! cp -c -R "$INSTALLED_MEMORY" "$DEV_MEMORY" 2>/dev/null; then
		echo "[v3-alongside] clonefile unavailable; falling back to a full copy (slower)..."
		rm -rf "$DEV_MEMORY"
		cp -R "$INSTALLED_MEMORY" "$DEV_MEMORY"
	fi

	echo "[v3-alongside] seeded $DEV_MEMORY"
	echo "[v3-alongside] the installed library at $INSTALLED_MEMORY was not modified."
}

if [ "$SEED_MEMORY" = "1" ]; then
	seed_memory_library
fi

# ---------------------------------------------------------------------------
# Build. Identical intent to v3-relaunch.sh, minus every kill.
# ---------------------------------------------------------------------------

WATCH_LOG="$(mktemp -t v3alongside.XXXXXX)"

# Worktrees share the root node_modules directory, but built-in extensions keep their runtime
# dependencies in extension-local node_modules folders. A fresh worktree otherwise compiles and
# launches while the TypeScript/HTML/CSS/JSON language features crash on activation with missing
# @vscode/extension-telemetry / vscode-languageclient. Mirror the already-installed extension
# dependency directories from the repository that owns the shared root node_modules symlink.
# This performs no install and never replaces an existing directory.
ensure_shared_extension_dependencies() {
	if [[ ! -L node_modules ]]; then
		return
	fi

	local shared_modules shared_repo shared_extensions source_modules source_asset rel destination linked=0 assets=0
	shared_modules="$(readlink node_modules)"
	if [[ "$shared_modules" != /* ]]; then
		shared_modules="$REPO_ROOT/$shared_modules"
	fi
	shared_repo="$(cd "$(dirname "$shared_modules")" 2>/dev/null && pwd -P || true)"
	shared_extensions="$shared_repo/extensions"
	if [[ -z "$shared_repo" || "$shared_repo" == "$REPO_ROOT" || ! -d "$shared_extensions" ]]; then
		return
	fi

	while IFS= read -r -d '' source_modules; do
		rel="${source_modules#"$shared_repo"/}"
		destination="$REPO_ROOT/$rel"
		if [[ -e "$destination" || -L "$destination" ]]; then
			continue
		fi
		mkdir -p "$(dirname "$destination")"
		ln -s "$source_modules" "$destination"
		linked=$((linked + 1))
	done < <(find "$shared_extensions" -maxdepth 3 -type d -name node_modules -print0 2>/dev/null)

	# Copilot's watcher rebuilds JavaScript but does not copy its WASM/tokenizer runtime assets.
	# Missing external_ingest_utils_bg.wasm makes the entire extension fail activation.
	if [[ -d "$shared_repo/extensions/copilot/dist" ]]; then
		while IFS= read -r -d '' source_asset; do
			destination="$REPO_ROOT/extensions/copilot/dist/$(basename "$source_asset")"
			if [[ -e "$destination" || -L "$destination" ]]; then
				continue
			fi
			mkdir -p "$(dirname "$destination")"
			ln -s "$source_asset" "$destination"
			assets=$((assets + 1))
		done < <(find "$shared_repo/extensions/copilot/dist" -maxdepth 1 -type f \( -name '*.wasm' -o -name '*.tiktoken' \) -print0 2>/dev/null)
	fi

	if (( linked > 0 || assets > 0 )); then
		echo "[v3-alongside] linked $linked built-in dependency directories and $assets Copilot runtime assets."
	fi
}

ensure_shared_extension_dependencies

# The transpile/watch path never emits out/nls.messages.json, but src/main.ts loads it as
# defaultMessagesFile — without it you get the black-window build.
ensure_nls_file() {
	if [[ ! -f out/nls.messages.json && -d out ]]; then
		printf '[]' > out/nls.messages.json
		echo "[v3-alongside] wrote out/nls.messages.json stub"
	fi
}

# Only count a watch running IN THIS worktree. A global pgrep sees a watch in a sibling
# worktree, skips compiling here, and launches a stale or empty out/.
is_watch_running_here() {
	local pid cwd
	for pid in $(pgrep -f "gulp watch-client" 2>/dev/null; pgrep -f "npm run watch" 2>/dev/null); do
			# `|| true` for the same SIGPIPE reason as pid_exe_path: `head -1` closes the pipe as
			# soon as it has its line, and under pipefail that 141 would abort the script.
			cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
		if [[ -n "$cwd" ]]; then
			cwd="$(cd "$cwd" 2>/dev/null && pwd -P || echo "$cwd")"
			if [[ "$cwd" == "$REPO_ROOT" ]]; then
				return 0
			fi
		fi
	done
	return 1
}

# Even when a watch is up, make sure it has caught up: no non-React TS under src/vs is newer
# than its compiled out/ counterpart. Guards against launching mid-compile.
wait_for_fresh_out() {
	local stale f rel out i
	echo "[v3-alongside] ensuring out/ is not stale vs src/..."
	for i in $(seq 1 240); do
		stale=""
		while IFS= read -r -d '' f; do
			rel="${f#src/}"
			out="out/${rel%.ts}.js"
			# Only an output that EXISTS and is OLDER than its source means "mid-compile". A
			# missing output is normal and permanent: ~209 files under src/vs (web-only and
			# internal entry points) are never emitted by the desktop build.
			if [[ -f "$out" ]] && [[ "$f" -nt "$out" ]]; then
				stale="$f"
				break
			fi
		done < <(find src/vs -type f -name '*.ts' \
			! -path '*/node_modules/*' \
			! -path '*/react/src/*' \
			! -path '*/react/src2/*' \
			! -name '*.d.ts' \
			! -name '*.test.ts' \
			-print0 2>/dev/null)
		if [[ -z "$stale" ]]; then
			echo "[v3-alongside] out/ is fresh."
			return 0
		fi
		if (( i == 1 || i % 15 == 0 )); then
			echo "[v3-alongside] waiting on compile for: $stale"
		fi
		sleep 1
	done
	echo "[v3-alongside] TIMED OUT waiting for out/ to catch up (still stale: $stale). Not launching."
	exit 1
}

if [ "$LAUNCH_ONLY" = "1" ]; then
	echo "[v3-alongside] launch-only: not touching the build."
elif is_watch_running_here; then
	echo "[v3-alongside] watch already running in this worktree."
else
	echo "[v3-alongside] starting npm run watch (first compile ~3-5 min)..."
	nohup npm run watch >"$WATCH_LOG" 2>&1 &
	echo "[v3-alongside] watch pid $! -> $WATCH_LOG"
	echo "[v3-alongside] waiting for first clean compile..."
	for _ in $(seq 1 360); do
		# Gulp inserts ANSI colour spans between "compilation", the project suffix and "with",
		# so match the stable words in order rather than a contiguous string.
		if grep -qE "Finished.*compilation.*with.*0 errors" "$WATCH_LOG" 2>/dev/null; then break; fi
		if grep -qE "Finished.*compilation.*with.*[1-9][0-9]* errors" "$WATCH_LOG" 2>/dev/null; then
			echo "[v3-alongside] BUILD ERRORS — not launching. Last lines:"; tail -30 "$WATCH_LOG"; exit 1
		fi
		sleep 1
	done
fi

if [ "$LAUNCH_ONLY" != "1" ]; then
	wait_for_fresh_out
fi
ensure_nls_file

# React panels bundle from react/src -> src2 -> react/out/. react/out/ is gitignored and gulp
# watch does NOT rebuild it. V3Code loads the bundles from out/vs/.../react/out/, not from
# src/.../react/out/, so rebuild when src changed OR when the host copy is behind.
REACT_DIR="src/vs/workbench/contrib/void/browser/react"
REACT_OUT="$REACT_DIR/out/void-settings-tsx/index.js"
HOST_REACT_OUT="out/vs/workbench/contrib/void/browser/react/out/void-settings-tsx/index.js"
REACT_SRC_NEWEST="$(find "$REACT_DIR/src" -type f \( -name '*.tsx' -o -name '*.ts' -o -name '*.css' \) -print0 2>/dev/null | xargs -0 stat -f '%m' 2>/dev/null | sort -n | tail -1)"
REACT_OUT_MTIME="0"
HOST_REACT_OUT_MTIME="0"
if [[ -f "$REACT_OUT" ]]; then
	REACT_OUT_MTIME="$(stat -f '%m' "$REACT_OUT" 2>/dev/null || echo 0)"
fi
if [[ -f "$HOST_REACT_OUT" ]]; then
	HOST_REACT_OUT_MTIME="$(stat -f '%m' "$HOST_REACT_OUT" 2>/dev/null || echo 0)"
fi
if [ "$LAUNCH_ONLY" = "1" ]; then
	echo "[v3-alongside] launch-only: skipping React rebuild."
elif [[ -z "${REACT_SRC_NEWEST:-}" ]] || [[ "$REACT_SRC_NEWEST" -gt "$REACT_OUT_MTIME" ]] || [[ "$REACT_OUT_MTIME" -gt "$HOST_REACT_OUT_MTIME" ]]; then
	echo "[v3-alongside] rebuilding React UI (src newer than bundle, or host out/ stale)..."
	npm run buildreact
else
	echo "[v3-alongside] React UI bundle up to date."
fi

# Beast is OFF by default here, unlike v3-relaunch.sh. beastChannel.ts hardcodes
# ~/.v3code/bin/beast and ~/.v3code/beastdb via homedir() rather than deriving them from
# dataFolderName, so the sidecar is NOT namespaced by VSCODE_DEV. Rebuilding it would replace
# the binary underneath the installed app that is currently running.
BEAST_BIN="$HOME/.v3code/bin/beast"
if [ "$BUILD_BEAST" = "1" ]; then
	if command -v cargo >/dev/null 2>&1 && [[ -d beast/src ]]; then
		echo "[v3-alongside] WARNING: ~/.v3code/bin/beast is shared with the installed app."
		echo "[v3-alongside] Rebuilding replaces the binary the running instance also uses."
		# The `|| true` matters here more than it looks: when the beast binary is old, `find`
		# has hundreds of matches, `head -1` closes the pipe after the first, and find dies of
		# SIGPIPE for 141 -> pipefail aborts the whole script. Verified reproducible.
		if [[ ! -x "$BEAST_BIN" ]] || [[ -n "$(find beast/src beast/queries beast/Cargo.toml -type f -newer "$BEAST_BIN" 2>/dev/null | head -1 || true)" ]]; then
			./scripts/build-beast.sh || echo "[v3-alongside] beast build failed — continuing without it."
		else
			echo "[v3-alongside] beast sidecar up to date."
		fi
	else
		echo "[v3-alongside] --build-beast requested but cargo or beast/src is missing; skipping."
	fi
elif [[ -x "$BEAST_BIN" ]]; then
	echo "[v3-alongside] using existing beast sidecar (shared with the installed app; --build-beast to rebuild)."
fi

# ---------------------------------------------------------------------------
# Electron preflight
# ---------------------------------------------------------------------------
#
# The bundle a dev build actually launches is .build/electron/V3Code.app, which in a worktree
# is a symlink into the factory checkout. It is a downloaded Electron renamed to V3Code.app
# and signed "adhoc, linker-signed" — it is NOT the notarised /Applications release. If it
# ever carries com.apple.quarantine (downloaded by a browser, restored from a backup, copied
# off another volume) macOS shows the malware dialog on launch.
#
# That dialog is dangerous here for a reason that has nothing to do with security: its default
# action is "Move to Trash", and the bundle is SHARED BY EVERY WORKTREE through that symlink.
# Trashing it breaks the factory and every lane at once, and the next build has to redownload
# Electron. So clear quarantine up front and say plainly what to do if a dialog appears anyway.
electron_preflight() {
	local link=".build/electron"
	local resolved app binary

	if [[ ! -e "$link" ]]; then
		echo "[v3-alongside] ERROR: $link is missing. Run the normal build once to fetch Electron." >&2
		return 1
	fi

	resolved="$(cd "$link" 2>/dev/null && pwd -P)" || {
		echo "[v3-alongside] ERROR: $link exists but could not be resolved (broken symlink?)." >&2
		return 1
	}

	app="$resolved/V3Code.app"
	binary="$app/Contents/MacOS/V3Code"

	if [[ ! -x "$binary" ]]; then
		echo "[v3-alongside] ERROR: no executable Electron at $binary" >&2
		return 1
	fi

	if [[ "$resolved" != "$REPO_ROOT/.build/electron" ]]; then
		echo "[v3-alongside] Electron bundle is shared: $resolved"
		echo "[v3-alongside] (symlinked from this worktree; do NOT delete it — other lanes use it too)"
	fi

	# -r so nested helpers are covered too; a single quarantined framework is enough to trip it.
	local flagged
	flagged="$(xattr -r -p com.apple.quarantine "$app" 2>/dev/null | wc -l | tr -d ' ')"
	if [[ "${flagged:-0}" != "0" ]]; then
		echo "[v3-alongside] Electron bundle is quarantined ($flagged paths); clearing before launch."
		if xattr -r -d com.apple.quarantine "$app" 2>/dev/null; then
			echo "[v3-alongside] quarantine cleared."
		else
			echo "[v3-alongside] WARNING: could not clear quarantine. If macOS shows a malware"
			echo "[v3-alongside]          dialog, click CANCEL — never 'Move to Trash'."
		fi
	fi

	# Informational only. An adhoc/linker-signed Electron is normal and expected for a dev
	# build, and `codesign --verify` complains about missing sealed resources on it, so a
	# failure here must not block the launch.
	if ! codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
		echo "[v3-alongside] note: dev Electron is adhoc-signed (expected; not the signed release)."
	fi

	return 0
}

if ! electron_preflight; then
	echo "[v3-alongside] aborting before launch; the installed V3Code was never signalled." >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

echo "[v3-alongside] launching dev instance -> $WORKSPACE"
echo "[v3-alongside] dev user data: $DEV_USER_DATA"

CODE_ARGS=()
if [ -n "$REMOTE_DEBUGGING_PORT" ]; then
	CODE_ARGS+=("--remote-debugging-port=$REMOTE_DEBUGGING_PORT")
fi
CODE_ARGS+=("$WORKSPACE")

if [ "$FOREGROUND" = "1" ]; then
	echo "[v3-alongside] foreground mode: no pid recorded, Ctrl-C stops it."
	exec ./scripts/code.sh "${CODE_ARGS[@]}"
fi

# start_new_session detaches from this process group. Backgrounding with & is not enough:
# agent harnesses kill the whole group when the command returns, taking the editor with it.
# macOS has no setsid, hence python3. The pid is recorded so --stop/--restart can target this
# exact process instead of pattern-matching a binary name shared with /Applications.
# With --log both streams go to a file instead of DEVNULL. Without it a startup crash leaves
# no evidence at all, which is exactly the hole that made an earlier disappearance unexplainable.
LAUNCH_LOG=""
if [ "$LOG_LAUNCH" = "1" ]; then
	LAUNCH_LOG="${TMPDIR:-/tmp}/v3-dev-alongside-$(date +%Y%m%d-%H%M%S).log"
fi

LAUNCHED_PID="$(V3_LAUNCH_LOG="$LAUNCH_LOG" python3 -c '
import os, subprocess, sys
cmd = ["./scripts/code.sh"] + sys.argv[1:]
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
env.pop("V3_LAUNCH_LOG", None)
env["VSCODE_SKIP_PRELAUNCH"] = "1"
logpath = os.environ.get("V3_LAUNCH_LOG") or ""
if logpath:
	sink = open(logpath, "ab", buffering=0)
	out, err = sink, subprocess.STDOUT
else:
	out, err = subprocess.DEVNULL, subprocess.DEVNULL
p = subprocess.Popen(cmd, env=env, start_new_session=True, stdout=out, stderr=err)
print(p.pid)
' "${CODE_ARGS[@]}")"

# code.sh execs the Electron binary in place, so this pid stays valid across the handoff.
printf '%s' "$LAUNCHED_PID" > "$PID_FILE"

echo "[v3-alongside] detached pid $LAUNCHED_PID (recorded in $PID_FILE)"
if [ -n "$LAUNCH_LOG" ]; then
	echo "[v3-alongside] launch log: $LAUNCH_LOG"
fi
echo "[v3-alongside] stop it with: ./scripts/v3-dev-alongside.sh --stop"
echo "[v3-alongside] the installed V3Code was never signalled."
