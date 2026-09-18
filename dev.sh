#!/usr/bin/env bash

# V3Code macOS fast dev iteration loop.
#
# Usage:
#   ./dev.sh                         -> WATCH mode: rebuild React on save, copy to out, launch once.
#   ./dev.sh --once                  -> one fast React build + copy + launch, then exit.
#   ./dev.sh --full-gulp             -> one full workbench compile + launch.
#   ./dev.sh --transpile             -> esbuild transpile + React copy + launch.
#   ./dev.sh --watch --full-gulp     -> watch mode, but run full compile after changes.
#   ./dev.sh --no-launch --once      -> build/copy only.
#   ./dev.sh --workspace /path       -> pass an extra workspace/folder to the launched app.
#
# Rule of thumb:
#   - Edited React UI under void/browser/react/src/       -> default fast path is enough.
#   - Edited void/browser/media/void.css or chat.css      -> default fast path copies CSS.
#   - Edited .ts under void/browser/common/electron-main  -> use --full-gulp, then relaunch.

set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REACT_DIR="$ROOT/src/vs/workbench/contrib/void/browser/react"
REACT_OUT_DIR="$REACT_DIR/out"
HOST_REACT_OUT_DIR="$ROOT/out/vs/workbench/contrib/void/browser/react/out"
VOID_CSS_SRC="$ROOT/src/vs/workbench/contrib/void/browser/media/void.css"
VOID_CSS_OUT="$ROOT/out/vs/workbench/contrib/void/browser/media/void.css"
CHAT_CSS_SRC="$ROOT/src/vs/workbench/contrib/chat/browser/widget/media/chat.css"
CHAT_CSS_OUT="$ROOT/out/vs/workbench/contrib/chat/browser/widget/media/chat.css"
NLS_FILE="$ROOT/out/nls.messages.json"
TMP_DIR="$ROOT/.tmp"
USER_DATA_DIR="$TMP_DIR/user-data"
EXTENSIONS_DIR="$TMP_DIR/extensions"
SHARED_DATA_DIR="$TMP_DIR/shared-data"
LAUNCH_LOG="$TMP_DIR/dev.sh-code.log"

ONCE=0
FULL_GULP=0
TRANSPILE=0
WATCH=0
LAUNCH=1
KILL_EXISTING=1
WORKSPACE="$ROOT"
EXTRA_ARGS=()

usage() {
	sed -n '3,18p' "$0"
}

log() {
	printf '\033[36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"
}

ok() {
	printf '\033[32m  %s\033[0m\n' "$*"
}

warn() {
	printf '\033[33m  WARN: %s\033[0m\n' "$*"
}

fail() {
	printf '\033[31m  ERROR: %s\033[0m\n' "$*" >&2
	return 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--once|-once|-Once)
			ONCE=1
			shift
			;;
		--full-gulp|-fullgulp|-FullGulp)
			FULL_GULP=1
			shift
			;;
		--transpile|-transpile|-Transpile)
			TRANSPILE=1
			shift
			;;
		--watch|-watch|-Watch)
			WATCH=1
			shift
			;;
		--no-launch)
			LAUNCH=0
			shift
			;;
		--no-kill)
			KILL_EXISTING=0
			shift
			;;
		--workspace)
			if [[ $# -lt 2 ]]; then
				fail "--workspace requires a path"
				exit 2
			fi
			WORKSPACE="$2"
			shift 2
			;;
		--help|-h)
			usage
			exit 0
			;;
		--)
			shift
			EXTRA_ARGS+=("$@")
			break
			;;
		*)
			EXTRA_ARGS+=("$1")
			shift
			;;
	esac
done

if [[ "$WATCH" -eq 0 && "$ONCE" -eq 0 && "$FULL_GULP" -eq 0 && "$TRANSPILE" -eq 0 ]]; then
	WATCH=1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
	fail "dev.sh is the native macOS dev loop. Use dev.ps1 on Windows."
	exit 2
fi

export PATH="/opt/homebrew/bin:$PATH"

cd "$ROOT" || exit 1
mkdir -p "$TMP_DIR" "$USER_DATA_DIR" "$EXTENSIONS_DIR" "$SHARED_DATA_DIR"

ensure_nls_file() {
	if [[ ! -f "$NLS_FILE" && -d "$ROOT/out" ]]; then
		printf '[]' > "$NLS_FILE"
		ok "Wrote out/nls.messages.json"
	fi
}

build_react() {
	log "Building React sidebar bundle..."
	npm run buildreact
	local code=$?
	if [[ $code -ne 0 ]]; then
		fail "React build failed with exit $code"
		return $code
	fi
	ok "React bundle built"
}

copy_if_present() {
	local src="$1"
	local dest="$2"
	local label="$3"

	if [[ ! -f "$src" ]]; then
		warn "$label source missing: $src"
		return 1
	fi

	local dest_dir
	dest_dir="$(dirname "$dest")"
	if [[ ! -d "$dest_dir" ]]; then
		warn "$label output dir missing; run ./dev.sh --full-gulp once first"
		return 1
	fi

	cp "$src" "$dest"
	return 0
}

copy_to_host() {
	if [[ ! -d "$HOST_REACT_OUT_DIR" ]]; then
		fail "Host React output dir missing; run ./dev.sh --full-gulp once first"
		return 1
	fi
	if [[ ! -d "$REACT_OUT_DIR" ]]; then
		fail "React output dir missing; run npm run buildreact first"
		return 1
	fi

	mkdir -p "$HOST_REACT_OUT_DIR"
	cp -R "$REACT_OUT_DIR"/. "$HOST_REACT_OUT_DIR"/
	copy_if_present "$VOID_CSS_SRC" "$VOID_CSS_OUT" "void.css" >/dev/null || true
	copy_if_present "$CHAT_CSS_SRC" "$CHAT_CSS_OUT" "chat.css" >/dev/null || true
	ensure_nls_file
	ok "Copied React bundle + CSS to out/. Reload V3Code with Cmd+R for renderer-only changes."
}

build_transpile() {
	log "Running esbuild transpile-client-esbuild..."
	node --experimental-strip-types --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js transpile-client-esbuild
	local code=$?
	if [[ $code -ne 0 ]]; then
		fail "transpile-client-esbuild failed with exit $code"
		return $code
	fi
	ensure_nls_file
	copy_to_host
	ok "Transpile complete"
}

build_gulp() {
	log "Running full workbench compile (npm run compile-client)..."
	npm run compile-client
	local code=$?
	if [[ $code -ne 0 ]]; then
		warn "Full compile failed with exit $code; trying esbuild transpile fallback"
		build_transpile
		return $?
	fi
	ensure_nls_file
	copy_if_present "$VOID_CSS_SRC" "$VOID_CSS_OUT" "void.css" >/dev/null || true
	copy_if_present "$CHAT_CSS_SRC" "$CHAT_CSS_OUT" "chat.css" >/dev/null || true
	ok "Full compile complete"
}

build_once() {
	build_react || return $?
	if [[ "$TRANSPILE" -eq 1 ]]; then
		build_transpile
	elif [[ "$FULL_GULP" -eq 1 ]]; then
		build_gulp
	else
		copy_to_host
	fi
}

electron_binary() {
	local name
	local short_name
	name="$(node -p "require('./product.json').nameLong")"
	short_name="$(node -p "require('./product.json').nameShort")"
	printf '%s/.build/electron/%s.app/Contents/MacOS/%s' "$ROOT" "$name" "$short_name"
}

stop_v3code() {
	if [[ "$KILL_EXISTING" -ne 1 ]]; then
		return 0
	fi

	local electron
	electron="$(electron_binary)"
	local pids
	pids="$(
		{
			pgrep -f "$electron" 2>/dev/null || true
			pgrep -f '(^|/| )\.?/?\.build/electron/V3Code\.app/Contents/MacOS/V3Code( |$)' 2>/dev/null || true
			pgrep -f 'V3Code\.app/Contents/MacOS/V3Code( |$)' 2>/dev/null || true
		} | sort -u
	)"
	if [[ -n "$pids" ]]; then
		# shellcheck disable=SC2086
		kill $pids 2>/dev/null || true
		ok "Killed existing V3Code dev process(es): ${pids//$'\n'/ }"
		sleep 0.4
	fi
}

launch_v3code() {
	if [[ "$LAUNCH" -ne 1 ]]; then
		return 0
	fi

	ensure_nls_file
	stop_v3code

	local electron
	electron="$(electron_binary)"
	local skip_prelaunch="${VSCODE_SKIP_PRELAUNCH:-}"
	if [[ -x "$electron" && -z "$skip_prelaunch" ]]; then
		skip_prelaunch=1
	fi

	local launch_args=(
		"--user-data-dir=$USER_DATA_DIR"
		"--extensions-dir=$EXTENSIONS_DIR"
		"--shared-data-dir=$SHARED_DATA_DIR"
	)
	if [[ -n "$WORKSPACE" ]]; then
		launch_args+=("$WORKSPACE")
	fi
	if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
		launch_args+=("${EXTRA_ARGS[@]}")
	fi

	log "Launching V3Code..."

	# Prefer launching the built .app via `open`, which reparents the process to launchd.
	# This is the only way the app survives being spawned from a sandboxed/agent shell (a
	# plain `nohup ... &` gets reaped the instant the calling process exits). We replicate
	# what scripts/code.sh does: pass the repo root as the app-code location ("$ROOT") plus
	# VSCODE_DEV=1 so Electron loads from out/ instead of trying to run as a packaged app.
	local app_bundle
	app_bundle="$ROOT/.build/electron/$(node -p "require('./product.json').nameLong").app"
	if [[ -d "$app_bundle" ]]; then
		: > "$LAUNCH_LOG"
		open -n "$app_bundle" \
			--env NODE_ENV=development --env VSCODE_DEV=1 --env VSCODE_CLI=1 \
			--env VSCODE_SKIP_PRELAUNCH="${skip_prelaunch:-1}" --env ELECTRON_ENABLE_LOGGING=1 \
			--env ELECTRON_RUN_AS_NODE= \
			--stdout "$LAUNCH_LOG" --stderr "$LAUNCH_LOG" \
			--args "$ROOT" --disable-extension=vscode.vscode-api-tests "${launch_args[@]}"
		ok "V3Code launching (detached via launchd). Log: $LAUNCH_LOG"
		return 0
	fi

	# Fallback: no built bundle yet — run code.sh directly (survives in a normal terminal,
	# but will be reaped if invoked from an agent/sandboxed shell).
	(
		cd "$ROOT" || exit 1
		unset ELECTRON_RUN_AS_NODE
		export NODE_ENV=development
		export VSCODE_DEV=1
		export VSCODE_CLI=1
		if [[ -n "$skip_prelaunch" ]]; then
			export VSCODE_SKIP_PRELAUNCH="$skip_prelaunch"
		fi
		nohup ./scripts/code.sh "${launch_args[@]}" > "$LAUNCH_LOG" 2>&1 < /dev/null &
		echo $! > "$TMP_DIR/dev.sh-code.pid"
	)
	ok "V3Code launching. Log: $LAUNCH_LOG"
}

snapshot_react_inputs() {
	if command -v fswatch >/dev/null 2>&1; then
		return 0
	fi
	(
		cd "$REACT_DIR" || exit 1
		find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.js' -o -name '*.jsx' \) -print0 |
			xargs -0 stat -f '%m %N' 2>/dev/null |
			shasum
	)
}

watch_fast_loop() {
	log "Watching React sources in $REACT_DIR/src"
	if command -v fswatch >/dev/null 2>&1; then
		fswatch -0 "$REACT_DIR/src" | while IFS= read -r -d '' changed; do
			case "$changed" in
				*.ts|*.tsx|*.css|*.js|*.jsx)
					log "Changed: ${changed#$ROOT/}"
					build_react && { [[ "$FULL_GULP" -eq 1 ]] && build_gulp || copy_to_host; }
					;;
			esac
		done
	else
		warn "fswatch not found; using polling fallback"
		local last
		last="$(snapshot_react_inputs)"
		while true; do
			sleep 1.2
			local current
			current="$(snapshot_react_inputs)"
			if [[ "$current" != "$last" ]]; then
				last="$current"
				log "React source change detected"
				build_react && { [[ "$FULL_GULP" -eq 1 ]] && build_gulp || copy_to_host; }
			fi
		done
	fi
}

if [[ "$ONCE" -eq 1 || "$TRANSPILE" -eq 1 || "$FULL_GULP" -eq 1 ]]; then
	build_once || exit $?
	launch_v3code
	exit 0
fi

log "=== V3Code macOS Dev Watch ($( [[ "$FULL_GULP" -eq 1 ]] && echo "FULL gulp" || echo "FAST copy" ) mode) ==="
build_once || exit $?
launch_v3code
watch_fast_loop
