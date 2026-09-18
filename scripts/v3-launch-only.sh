#!/usr/bin/env bash
# Launch the dev build WITHOUT killing any running V3Code instance.
#
# WHY THIS EXISTS: scripts/v3-relaunch.sh runs
#   pkill -f "V3Code.app/Contents/MacOS/V3Code"
# which is a SUBSTRING match — it also matches
#   /Applications/V3Code.app/Contents/MacOS/V3Code
# and therefore kills the installed editor the user is actively working in
# (including the window hosting an in-progress agent chat). This script starts
# the dev build only; it never signals another process.
#
# The env vars below are mandatory. Without VSCODE_DEV=1 the vscode-file://
# protocol handler serves CSS with the wrong MIME type, every `import './x.css'`
# fails strict module checking, workbench.desktop.main.js never loads, and the
# window renders permanently grey with a spinner — which looks exactly like a
# code crash but is purely an environment problem.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BIN="$ROOT/.build/electron/V3Code.app/Contents/MacOS/V3Code"
LOG="${V3_LAUNCH_LOG:-/tmp/v3-dev-launch.log}"
USER_DATA="${V3_USER_DATA_DIR:-/tmp/v3-dev-smoke}"

if [ ! -x "$BIN" ]; then
	echo "ERROR: Electron binary not found at $BIN" >&2
	exit 1
fi

if [ ! -f "$ROOT/out/main.js" ]; then
	echo "ERROR: out/main.js missing — run the transpile first." >&2
	exit 1
fi

# The transpile's [clean] step deletes this file every time, and only the full
# gulp build regenerates it. src/main.ts hard-requires it at startup; when it is
# missing the window boots grey. Every repo script writes the same `[]` stub.
if [ ! -f "$ROOT/out/nls.messages.json" ]; then
	echo "[]" > "$ROOT/out/nls.messages.json"
	echo "restored out/nls.messages.json stub"
fi

mkdir -p "$USER_DATA"

NODE_ENV=development \
VSCODE_DEV=1 \
VSCODE_CLI=1 \
ELECTRON_ENABLE_LOGGING=1 \
	"$BIN" "$ROOT" \
	--user-data-dir="$USER_DATA" \
	>"$LOG" 2>&1 &

echo "launched pid $! — log: $LOG"
