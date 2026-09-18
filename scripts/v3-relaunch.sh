#!/usr/bin/env bash
# V3Code (VSElite) — Mac build + launch. The ONE command an agent runs after a code change.
#
# Why this exists: Daniel always kills the app, and browser/ + common/ + electron-main/ changes
# need a relaunch (main process loads code once; Cmd+R does not reload it). An agent must NEVER
# ask "want me to build?" — it runs THIS, every time, after any change. See
# .cursor/rules/mac-build-launch.mdc.
#
# What it does:
#   1. Make sure `npm run watch` is up (the incremental compiler). Start it if it isn't.
#   2. Rebuild React UI bundles when react/src changed (settings/sidebar live in react/out/, gitignored).
#   3. Wait until the watch reports a clean compile (0 errors) so we never launch stale out/.
#   4. Kill any running V3Code, then relaunch (env fixed so Electron doesn't run as plain Node).
#
# Usage:  ./scripts/v3-relaunch.sh [--detach] [--launch-only] [--remote-debugging-port=PORT] [workspace-folder]
#   --detach       launch in its own session and return immediately. Required for any agent
#                  (Claude Code, Cursor) whose shell is killed when the command finishes —
#                  without it the editor is a child of that shell and dies with it.
#   --launch-only  restart the app using whatever is already in out/. Skips the watch, the
#                  React bundle and beast. Use this when someone else just compiled: starting
#                  the watch cleans out/, and a half-populated out/ launches to a blank window.
#   --remote-debugging-port=PORT
#                  expose Electron's Chromium debugger on localhost for automated dev-build
#                  verification. Optional; normal launches do not open a debugging port.
#   --isolated-profile=/absolute/path
#                  open a separate smoke profile without stopping any running editors.
#   workspace-folder  folder to open. Defaults to a scratch folder (V3_SCRATCH_WORKSPACE, or
#                  ~/dev/v3code-scratch). Opening the source tree is refused on purpose --
#                  see the hot-exit note below.
set -euo pipefail

DETACH=0
LAUNCH_ONLY=0
REMOTE_DEBUGGING_PORT=""
ISOLATED_PROFILE=""
WORKSPACE=""
for arg in "$@"; do
	case "$arg" in
		--detach) DETACH=1 ;;
		--launch-only) LAUNCH_ONLY=1 ;;
		--isolated-profile=*) ISOLATED_PROFILE="${arg#*=}"; [[ "$ISOLATED_PROFILE" == /* ]] || { echo 'isolated profile must be an absolute path' >&2; exit 2; } ;;
		--remote-debugging-port=*) REMOTE_DEBUGGING_PORT="${arg#*=}" ;;
		-*) echo "[v3-relaunch] unknown flag: $arg" >&2; exit 2 ;;
		*) WORKSPACE="$arg" ;;
	esac
done

if [[ -n "$REMOTE_DEBUGGING_PORT" && ( ! "$REMOTE_DEBUGGING_PORT" =~ ^[0-9]+$ || "$REMOTE_DEBUGGING_PORT" -lt 1024 || "$REMOTE_DEBUGGING_PORT" -gt 65535 ) ]]; then
	echo "[v3-relaunch] remote debugging port must be an integer from 1024 to 65535" >&2
	exit 2
fi

if [ -n "$WORKSPACE" ]; then
	if [ ! -d "$WORKSPACE" ]; then
		echo "[v3-relaunch] not a folder: $WORKSPACE" >&2
		exit 2
	fi
	# Resolve now: the launch runs from the repo root, so a relative path would break.
	WORKSPACE="$(cd "$WORKSPACE" && pwd)"
fi

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
if [ -d /opt/homebrew/opt/node@22/bin ]; then
	export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
else
	export PATH="/opt/homebrew/bin:$PATH"
fi
PINNED_NODE_MAJOR="$(tr -d 'v[:space:]' < .nvmrc | cut -d. -f1)"
if [ "$(node -p 'process.versions.node.split(".")[0]')" != "$PINNED_NODE_MAJOR" ]; then
	echo "[v3-relaunch] use the Node runtime pinned in .nvmrc before building or launching." >&2
	exit 1
fi
unset ELECTRON_RUN_AS_NODE || true
export VSCODE_SKIP_PRELAUNCH=1   # electron is already downloaded; skip the slow re-download

# Worktrees share the root node_modules directory, but built-in extensions keep their runtime
# dependencies in extension-local node_modules folders. A fresh worktree therefore compiled and
# launched while TypeScript/HTML/CSS/JSON language features crashed on activation with missing
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
	# Missing external_ingest_utils_bg.wasm makes the entire extension fail activation, including
	# plan-model discovery. Reuse the immutable generated assets beside the shared dependencies.
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
		echo "[v3-relaunch] linked $linked built-in dependency directories and $assets Copilot runtime assets."
	fi
}

ensure_shared_extension_dependencies

# The dev build must never open the source tree it was built from. When the app is killed --
# which this script does on every relaunch -- it preserves unsaved editor buffers as hot-exit
# backups and writes them back on the next launch. A tab holding pre-fix content will happily
# overwrite a fix that is already committed, with no git operation and nothing in the reflog;
# the only symptom is the compiler reporting errors in code that is correct on the branch.
# Default to a scratch folder, and refuse the repo outright.
REPO_ROOT="$(pwd)"
if [ -z "$WORKSPACE" ]; then
	WORKSPACE="${V3_SCRATCH_WORKSPACE:-$HOME/dev/v3code-scratch}"
	mkdir -p "$WORKSPACE"
	echo "[v3-relaunch] no workspace given; opening scratch folder $WORKSPACE"
fi
case "$WORKSPACE" in
	"$REPO_ROOT" | "$REPO_ROOT"/*)
		echo "[v3-relaunch] refusing to open the source tree: $WORKSPACE" >&2
		echo "[v3-relaunch] the app restores unsaved tabs on launch and can overwrite committed edits." >&2
		echo "[v3-relaunch] pass a different folder, or set V3_SCRATCH_WORKSPACE." >&2
		exit 2
		;;
esac

WATCH_LOG="$(mktemp -t v3watch.XXXXXX)"
REPO_ROOT="$(pwd -P)"

# The transpile/watch path never emits out/nls.messages.json, but src/main.ts loads it as
# defaultMessagesFile — without it you get the black-window build. dev.sh has always stubbed
# it; this script never did, so a watch-only build was unlaunchable.
ensure_nls_file() {
	if [[ ! -f out/nls.messages.json && -d out ]]; then
		printf '[]' > out/nls.messages.json
		echo "[v3-relaunch] wrote out/nls.messages.json stub"
	fi
}

# Only count a watch that is running IN THIS worktree. The old global pgrep saw a watch in a
# sibling worktree and skipped compiling here -> launched a stale/empty out/ (the exact bug that
# burned us). Match on the process cwd.
is_watch_running_here() {
	local pid cwd
	for pid in $(pgrep -f "gulp watch-client" 2>/dev/null; pgrep -f "npm run watch" 2>/dev/null); do
		cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
		if [[ -n "$cwd" ]]; then
			cwd="$(cd "$cwd" 2>/dev/null && pwd -P || echo "$cwd")"
			if [[ "$cwd" == "$REPO_ROOT" ]]; then
				return 0
			fi
		fi
	done
	return 1
}

# Even when a watch is up, make sure it has caught up: no non-React TS under src/vs is newer than
# its compiled out/ counterpart. Guards against launching mid-compile (stale out/).
wait_for_fresh_out() {
	local stale f rel out i
	echo "[v3-relaunch] ensuring out/ is not stale vs src/..."
	for i in $(seq 1 240); do
		stale=""
		while IFS= read -r -d '' f; do
			rel="${f#src/}"
			out="out/${rel%.ts}.js"
			# Only a compiled output that EXISTS and is OLDER than its source means "mid-compile".
			# A missing output is normal and permanent here: ~209 files under src/vs (web-only and
			# internal entry points like workbench.web.main.internal.ts) are never emitted by the
			# desktop build. Treating those as stale made this gate impossible to satisfy — it
			# waited the full timeout and then refused to launch every single time.
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
			echo "[v3-relaunch] out/ is fresh."
			return 0
		fi
		if (( i == 1 || i % 15 == 0 )); then
			echo "[v3-relaunch] waiting on compile for: $stale"
		fi
		sleep 1
	done
	echo "[v3-relaunch] TIMED OUT waiting for out/ to catch up (still stale: $stale). Not launching."
	exit 1
}

if [ "$LAUNCH_ONLY" = "1" ]; then
	echo "[v3-relaunch] launch-only: not touching the build."
elif is_watch_running_here; then
	echo "[v3-relaunch] watch already running in this worktree."
else
	echo "[v3-relaunch] starting npm run watch (first compile ~3-5 min)..."
	# Detached so it survives this script; logs to a temp file we tail for the ready signal.
	nohup npm run watch >"$WATCH_LOG" 2>&1 &
	echo "[v3-relaunch] watch pid $! -> $WATCH_LOG"
	echo "[v3-relaunch] waiting for first clean compile..."
	# Wait up to ~6 min for the watch to report a finished compile.
	for _ in $(seq 1 360); do
		# Gulp inserts ANSI colour spans between "compilation", the project suffix and "with".
		# Match the stable words in order so a coloured TTY log does not wait the full six minutes
		# after an already-clean compile.
		if grep -qE "Finished.*compilation.*with.*0 errors" "$WATCH_LOG" 2>/dev/null; then break; fi
		if grep -qE "Finished.*compilation.*with.*[1-9][0-9]* errors" "$WATCH_LOG" 2>/dev/null; then
			echo "[v3-relaunch] BUILD ERRORS — not launching. Last lines:"; tail -30 "$WATCH_LOG"; exit 1
		fi
		sleep 1
	done
fi

# Never launch mid-compile, even if a watch was already up in this worktree.
wait_for_fresh_out
ensure_nls_file

# React panels (settings, sidebar, etc.) bundle from react/src → src2 → react/out/.
# react/out/ is gitignored; gulp watch does NOT rebuild it. Ctrl+R only reloads the
# already-loaded bundle — stale out/ is why Indexing UI missed Qwen3/Potion options.
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
# V3Code loads react bundles from out/vs/.../react/out/, NOT src/.../react/out/.
# buildreact writes src copy then copies to host out/ — rebuild if src changed OR host is stale.
if [ "$LAUNCH_ONLY" = "1" ]; then
	echo "[v3-relaunch] launch-only: skipping React rebuild."
elif [[ -z "${REACT_SRC_NEWEST:-}" ]] || [[ "$REACT_SRC_NEWEST" -gt "$REACT_OUT_MTIME" ]] || [[ "$REACT_OUT_MTIME" -gt "$HOST_REACT_OUT_MTIME" ]]; then
	echo "[v3-relaunch] rebuilding React UI (src newer than bundle, or host out/ stale)..."
	npm run buildreact
else
	echo "[v3-relaunch] React UI bundle up to date."
fi

# Beast sidecar: keep ~/.v3code/bin/beast fresh from the vendored source at
# /beast (single-repo story — no V3Index checkout needed). Best-effort: no
# cargo or a failed build never blocks the launch; the editor runs without it.
BEAST_BIN="$HOME/.v3code/bin/beast"
if [ "$LAUNCH_ONLY" = "1" ]; then
	:
elif command -v cargo >/dev/null 2>&1 && [[ -d beast/src ]]; then
	if [[ ! -x "$BEAST_BIN" ]] || [[ -n "$(find beast/src beast/queries beast/Cargo.toml -type f -newer "$BEAST_BIN" 2>/dev/null | head -1)" ]]; then
		echo "[v3-relaunch] beast sidecar stale or missing — rebuilding (first build takes minutes)..."
		./scripts/build-beast.sh || echo "[v3-relaunch] beast build failed — continuing without the sidecar (editor works fine)."
	else
		echo "[v3-relaunch] beast sidecar up to date."
	fi
fi

# Refuse incomplete runtime artifacts BEFORE touching any existing editor.
if [ "$LAUNCH_ONLY" != "1" ]; then
	npm run gulp compile-extensions
	npm run gulp compile-extension-media
	node scripts/v3-build-smoke-preloads.mjs
fi
node scripts/v3-check-smoke.mjs

# Kill any running instance so the main process picks up new code.
# V3Code is branded — the binary is V3Code.app, NOT Electron.app (upstream pattern misses it).
if [[ -z "$ISOLATED_PROFILE" ]]; then
echo "[v3-relaunch] killing any running V3Code instance..."
pkill -f "V3Code.app/Contents/MacOS/V3Code" 2>/dev/null || true
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
pkill -f "scripts/code.sh" 2>/dev/null || true
sleep 2
# Belt-and-suspenders: if a window is still alive, ask macOS to quit the app.
if pgrep -f "V3Code.app/Contents/MacOS/V3Code" >/dev/null 2>&1; then
	echo "[v3-relaunch] V3Code still running — sending quit..."
	osascript -e 'tell application "V3Code" to quit' 2>/dev/null || true
	sleep 2
	pkill -9 -f "V3Code.app/Contents/MacOS/V3Code" 2>/dev/null || true
fi

else
	echo "[v3-relaunch] isolated profile: leaving all existing editors running."
fi

echo "[v3-relaunch] launching${WORKSPACE:+ $WORKSPACE}..."

CODE_ARGS=()
if [[ -n "$ISOLATED_PROFILE" ]]; then
	CODE_ARGS+=("--user-data-dir=$ISOLATED_PROFILE" "--new-window")
fi
if [ -n "$REMOTE_DEBUGGING_PORT" ]; then
	CODE_ARGS+=("--remote-debugging-port=$REMOTE_DEBUGGING_PORT")
fi
if [ -n "$WORKSPACE" ]; then
	CODE_ARGS+=("$WORKSPACE")
fi

if [ "$DETACH" = "1" ]; then
	# start_new_session detaches from this process group. Backgrounding with & is not
	# enough: agent harnesses kill the whole group when the command returns, taking the
	# editor with it. macOS has no setsid, hence python3.
	python3 -c '
import os, subprocess, sys
cmd = ["./scripts/code.sh"] + sys.argv[1:]
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
env["VSCODE_SKIP_PRELAUNCH"] = "1"
p = subprocess.Popen(cmd, env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(f"[v3-relaunch] detached pid {p.pid}")
' "${CODE_ARGS[@]}"
	exit 0
fi

exec ./scripts/code.sh "${CODE_ARGS[@]}"
