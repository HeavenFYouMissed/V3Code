#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — Windows x64 packaging pipeline (user-scope Inno Setup installer)
#
# Windows counterpart of scripts/v3-package-mac.sh, absorbing the steps that
# previously lived inline in .github/workflows/v3-build-windows.yml so CI and
# local/manual runs share one code path. Runs under Git Bash on Windows (the
# GitHub runner's default bash) — packaging needs ISCC.exe, so it cannot run
# on macOS/Linux.
#
#     npm run gulp core-ci-client               # transpile + minified bundle
#     npm run gulp vscode-win32-x64-min-ci      # wrap Electron -> ../VSCode-win32-x64
#     npm run gulp vscode-win32-x64-inno-updater  # inner updater + rcedit icon
#     [--sign] scripts/v3-sign-win32.ps1 -Folder ../VSCode-win32-x64
#     npm run gulp vscode-win32-x64-user-setup [-- --sign]   # ISCC -> installer
#
# Signing (--sign) uses Azure Artifact Signing via scripts/v3-sign-win32.ps1
# and MUST come after inno-updater (rcedit rewrites PE resources, which would
# invalidate signatures). With --sign, ISCC also signs the setup exe + the
# embedded uninstaller through the SignTool=trustedsigning hook in code.iss.
# There is no notarization step on Windows — signing is the whole story.
#
# Output installer: <repo>/.build/dist/V3CodeUserSetup-x64-<version>.exe   (user download + update artifact)
# Output zip:       <repo>/.build/dist/V3Code-win32-x64-<version>.zip      (portable fallback + deep-verifiable)
# Summary:          <repo>/.build/dist/last-build.json  (platform win32-x64-user)
#
# Usage:
#   scripts/v3-package-win32.sh                 # full compile + package (unsigned)
#   scripts/v3-package-win32.sh --sign          # signed tree + installer + uninstaller
#   scripts/v3-package-win32.sh --skip-compile  # re-package only (reuse out-vscode-min)
#   scripts/v3-package-win32.sh --no-zip        # skip the portable zip
# ---------------------------------------------------------------------------
set -euo pipefail

ARCH="x64"
PLATFORM="win32-${ARCH}-user"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$REPO_ROOT")"
TREE_DIR="$BUILD_ROOT/VSCode-win32-$ARCH"
DIST_DIR="$REPO_ROOT/.build/dist"

cd "$REPO_ROOT"

case "$(uname -s)" in
	MINGW*|MSYS*|CYGWIN*) ;;
	*) echo "v3-package-win32: this script needs Windows (ISCC.exe/signtool); host is $(uname -s)." >&2; exit 1 ;;
esac

SKIP_COMPILE=0
DO_ZIP=1
DO_SIGN=0
WANT_COMPUTER_USE=1
for arg in "$@"; do
	case "$arg" in
		--skip-compile) SKIP_COMPILE=1 ;;
		--no-zip) DO_ZIP=0 ;;
		--sign) DO_SIGN=1 ;;
		--no-computer-use) WANT_COMPUTER_USE=0 ;;
		-h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "v3-package-win32: unknown argument: $arg" >&2; exit 2 ;;
	esac
done

DIRTY_SOURCE="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$DIRTY_SOURCE" ]; then
	echo "v3-package-win32: source worktree is dirty; refusing to create a provenance-ambiguous artifact." >&2
	printf '%s\n' "$DIRTY_SOURCE" >&2
	exit 1
fi

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
START_TS=$(date +%s)

# --- version metadata -------------------------------------------------------
APP_VERSION=$(node -p "require('./package.json').version")
V3_VERSION=$(node -p "const p=require('./product.json'); (p.voidVersion||p.version||'')+'-'+(p.voidRelease||'')")
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
SHORT_COMMIT=${COMMIT:0:10}

# Bake the commit deterministically (same rationale as v3-package-mac.sh: gulp's
# getVersion() returns nothing in git worktrees, silently shipping an update-dead
# build). Copilot ext build + packaging need VSCODE_QUALITY.
export VSCODE_QUALITY="$(node -p "require('./product.json').quality || 'stable'")"
if printf '%s' "$COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
	export BUILD_SOURCEVERSION="$COMMIT"
else
	echo "v3-package-win32: cannot resolve a 40-hex git commit (got '$COMMIT') — refusing to package an update-dead build." >&2
	exit 1
fi

log "V3Code Windows packaging — $PLATFORM"
echo "    app version   : $APP_VERSION"
echo "    v3code version: $V3_VERSION"
echo "    commit        : $SHORT_COMMIT"
echo "    signing       : $([ "$DO_SIGN" -eq 1 ] && echo 'Azure Artifact Signing' || echo 'NONE (unsigned test build)')"

# --- 1. compile core ---------------------------------------------------------
if [ "$SKIP_COMPILE" -eq 0 ]; then
	log "React hosts — npm run buildreact"
	npm run buildreact

	log "Step 1/4 — npm run gulp core-ci-client (transpile + minify client)"
	npm run gulp core-ci-client
	node build/verify/react-bundle-freshness.mjs --record
else
	log "Skipping compile (--skip-compile); reusing out-vscode-min"
	if [ ! -d "$REPO_ROOT/out-vscode-min" ]; then
		echo "v3-package-win32: out-vscode-min missing — run without --skip-compile first." >&2
		exit 1
	fi
	node build/verify/react-bundle-freshness.mjs --check
fi

# V3Code ships WITHOUT the built-in GitHub Copilot extension (license does not
# permit redistribution). Purge any stale compiled copy before packaging globs it.
rm -rf .build/extensions/copilot

# Computer-use helper. gulpfile.vscode.win32.ts already knows how to copy this
# into resources/computerUse/win32/, but when the exe is absent it only WARNS and
# packages anyway — so every Windows build to date shipped without it, and all
# sixteen computer_* tools failed to register. The only symptom users saw was
# "was not contributed", which reads as "this feature does not exist" rather than
# "this build forgot a binary". Nothing else in the release path builds it.
# (The mac packager has built its own helper since 0082; this is the same fix.)
HELPER_EXE=".build/computer-use/win32-$ARCH/v3code-computer-use.exe"
# Rebuild when the exe is missing OR any helper source is newer. The old `[ ! -f ]`
# gate happily shipped an arbitrarily stale leftover — including a debug-config
# build (non-redistributable debug CRT, fails to start on user machines) — as
# long as SOMETHING existed at this path.
HELPER_SRC_DIR="src/vs/workbench/contrib/computerUse/helper/win32"
NEED_HELPER_BUILD=0
if [ ! -f "$HELPER_EXE" ]; then
	NEED_HELPER_BUILD=1
elif [ -n "$(find "$HELPER_SRC_DIR" -type f -newer "$HELPER_EXE" -print -quit 2>/dev/null)" ]; then
	log "Computer-use helper is stale (sources changed since it was built) — rebuilding"
	NEED_HELPER_BUILD=1
fi
if [ "$WANT_COMPUTER_USE" -eq 1 ] && [ "$NEED_HELPER_BUILD" -eq 1 ]; then
	log "Building computer-use helper (win32-$ARCH)"
	if command -v pwsh >/dev/null 2>&1; then
		pwsh -File scripts/build-computer-use-helper-win32.ps1 -Arch "$ARCH"
	elif command -v powershell >/dev/null 2>&1; then
		powershell -File scripts/build-computer-use-helper-win32.ps1 -Arch "$ARCH"
	else
		echo "v3-package-win32: PowerShell not found — cannot build the computer-use helper." >&2
		echo "  Computer use would ship dead. Install PowerShell, or pass --no-computer-use to accept that." >&2
		exit 1
	fi
fi

# Beast sidecar — same story as the helper: shipped by nobody until now, while
# beastEnabled defaults to true. beastChannel looks in resources/beast first.
# Build UNCONDITIONALLY: cargo is incremental (a fresh tree is a no-op) and the
# old `[ ! -f ]` gate would ship an arbitrarily stale exe from months ago.
BEAST_SRC="beast/target/release/beast.exe"
if ! command -v cargo >/dev/null 2>&1; then
	echo "v3-package-win32: cargo not found — cannot build the beast sidecar." >&2
	echo "  Install Rust (https://rustup.rs), or the sidecar ships dark for every user." >&2
	exit 1
fi
log "Building beast sidecar (cargo build --release — incremental, no-op when fresh)"
( cd beast && cargo build --release )
[ -f "$BEAST_SRC" ] || {
	echo "v3-package-win32: cargo build completed but $BEAST_SRC does not exist. Aborting." >&2
	exit 1
}

# --- 2. package the client tree ----------------------------------------------
log "Step 2/4 — npm run gulp vscode-win32-$ARCH-min-ci (package client tree)"
rm -rf "$TREE_DIR"
npm run gulp "vscode-win32-$ARCH-min-ci"

# Inner updater + icon BEFORE signing: rcedit rewrites PE resources and would
# invalidate an existing Authenticode signature.
npm run gulp "vscode-win32-$ARCH-inno-updater"

# --- bundle integrity (the update route lives or dies on this) ----------------
TREE_PRODUCT_JSON="$TREE_DIR/resources/app/product.json"
[ -f "$TREE_PRODUCT_JSON" ] || { echo "v3-package-win32: packaged tree has no $TREE_PRODUCT_JSON" >&2; exit 1; }
# Windows node can't require() a Git Bash POSIX path (/d/a/...). MSYS converts
# path-shaped ARGUMENTS to native exes automatically, but not paths embedded in
# a -p/-e code string — those must be cygpath'd to a mixed (D:/...) path.
TREE_PRODUCT_JSON_NODE="$TREE_PRODUCT_JSON"
if command -v cygpath >/dev/null 2>&1; then
	TREE_PRODUCT_JSON_NODE="$(cygpath -m "$TREE_PRODUCT_JSON")"
fi
BUNDLE_META=$(node -p "const p=require('$TREE_PRODUCT_JSON_NODE');[p.commit||'',p.quality||'',p.updateUrl||''].join('|')")
BUNDLE_COMMIT=${BUNDLE_META%%|*}
BUNDLE_REST=${BUNDLE_META#*|}
BUNDLE_QUALITY=${BUNDLE_REST%%|*}
BUNDLE_UPDATE_URL=${BUNDLE_REST#*|}
if [ "$BUNDLE_COMMIT" != "$COMMIT" ]; then
	echo "v3-package-win32: bundle product.commit ('$BUNDLE_COMMIT') != repo HEAD ('$COMMIT') — update loop would never converge. Aborting." >&2
	exit 1
fi
# Ship beast INSIDE the install tree, beside resources/app. beastChannel resolves
# process.resourcesPath/beast/beast.exe before falling back to ~/.v3code/bin.
mkdir -p "$TREE_DIR/resources/beast"
cp "$BEAST_SRC" "$TREE_DIR/resources/beast/beast.exe"
[ -f "$TREE_DIR/resources/beast/beast.exe" ] || {
	echo "v3-package-win32: beast is not in the tree — the sidecar would ship dark. Aborting." >&2
	exit 1
}
echo "    bundle beast check OK: resources/beast/beast.exe"

# The computer-use helper is copied in by gulpfile.vscode.win32.ts, which only
# WARNS when the exe is absent — which is exactly how every Windows build so far
# shipped without it and all sixteen computer_* tools failed to register. Assert.
if [ "$WANT_COMPUTER_USE" -eq 1 ]; then
	CU_DEST="$(find "$TREE_DIR" -name 'v3code-computer-use-helper.exe' 2>/dev/null | head -1)"
	[ -n "$CU_DEST" ] || {
		echo "v3-package-win32: computer-use helper is not in the packaged tree — all computer_* tools would ship dead. Aborting." >&2
		exit 1
	}
	echo "    bundle computer-use check OK: ${CU_DEST#$TREE_DIR/}"
fi

if [ -z "$BUNDLE_QUALITY" ] || [ -z "$BUNDLE_UPDATE_URL" ]; then
	echo "v3-package-win32: bundle product.json is missing quality/updateUrl — update service would be permanently Disabled. Aborting." >&2
	exit 1
fi
echo "    bundle update config OK: commit=$SHORT_COMMIT quality=$BUNDLE_QUALITY updateUrl=$BUNDLE_UPDATE_URL"
if [ -d "$TREE_DIR/resources/app/extensions/copilot" ]; then
	echo "v3-package-win32: bundle contains extensions/copilot — Copilot must not ship. Aborting." >&2
	exit 1
fi
if compgen -G "$TREE_DIR/resources/app/node_modules/@github/copilot*" >/dev/null 2>&1; then
	echo "v3-package-win32: bundle contains @github/copilot* node modules — Copilot must not ship. Aborting." >&2
	exit 1
fi
echo "    bundle copilot check OK"

# The repo's own .v3code gets swept into the app payload by the gulp file
# collection, and it is a MIX of two things — stripping the whole directory
# (as this first did) silently removed shipped product content:
#   SHIP   skills/  — skillsService._getBundledSkillsDirs() reads appRoot/.v3code/skills
#   SHIP   rules/   — workspaceRulesService._getBundledRulesDirs() reads appRoot/.v3code/rules
#   SHIP   mcp/     — v3codeMcpServerChannel launches the stable stdio bridge here
#   STRIP  everything else — workspace-id, PROJECT_STATUS.md, active-plan.json,
#          theme-preview.html, scripts/, agents/ (nothing resolves that at appRoot),
#          and any browser-sessions/ or .context-bridge/ that ever reappears.
# Remove the leak, keep the product. Deleting a named allowlist would silently
# ship anything new that lands in .v3code, so invert it: delete everything EXCEPT
# the three directories the running code actually resolves.
V3CODE_BUNDLED="$TREE_DIR/resources/app/.v3code"
if [ -d "$V3CODE_BUNDLED" ]; then
	find "$V3CODE_BUNDLED" -mindepth 1 -maxdepth 1 ! -name skills ! -name rules ! -name mcp -exec rm -rf {} +
	[ -d "$V3CODE_BUNDLED/skills" ] || {
		echo "v3-package-win32: bundled .v3code/skills is missing — the shipped skill library would be empty. Aborting." >&2
		exit 1
	}
	[ -d "$V3CODE_BUNDLED/rules" ] || {
		echo "v3-package-win32: bundled .v3code/rules is missing — the shipped agent rules would be empty. Aborting." >&2
		exit 1
	}
	echo "    bundle .v3code check OK: kept skills ($(find "$V3CODE_BUNDLED/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') skills) + rules + MCP bridge, stripped dev state"
fi

# Manifest-driven artifact gate: every required binary/module present and sane,
# every forbidden path absent — or this build never reaches signing. The manifest
# paths come from walked real packages, not memory (build/verify/artifact-manifest.json).
node build/verify/verify-package.mjs --platform win32-$ARCH --root "$TREE_DIR" || {
	echo "v3-package-win32: package verify gate FAILED — this tree must not ship. See [FAIL] rows above." >&2
	exit 1
}

# --- 3. sign the tree ----------------------------------------------------------
if [ "$DO_SIGN" -eq 1 ]; then
	log "Step 3/4 — signing client tree (Azure Artifact Signing)"
	pwsh -NoProfile -ExecutionPolicy Bypass -File "$REPO_ROOT/scripts/v3-sign-win32.ps1" -Folder "$TREE_DIR"
else
	log "Step 3/4 — skipped (unsigned build; do NOT distribute)"
fi

# The runtime installer REFUSES any helper whose Authenticode status is not
# 'Valid' with a cert subject containing 'V3Code' (computerUseHelperInstaller
# _verifyWindows). Packaging used to assert existence only, so a signed build
# with the WRONG cert subject — never actually verified against the Azure
# profile — would pass every guard and ship computer-use dead. Check the exact
# thing the runtime checks, right after signing.
if [ "$WANT_COMPUTER_USE" -eq 1 ]; then
	CU_TREE_EXE="$(find "$TREE_DIR" -name 'v3code-computer-use-helper.exe' -print -quit 2>/dev/null)"
	if [ "$DO_SIGN" -eq 1 ]; then
		CU_WIN_PATH="$(cygpath -w "$CU_TREE_EXE" 2>/dev/null || echo "$CU_TREE_EXE")"
		CU_SIG="$(powershell.exe -NoProfile -NonInteractive -Command "\$s = Get-AuthenticodeSignature -LiteralPath '$CU_WIN_PATH'; Write-Output \$s.Status; if (\$s.SignerCertificate) { Write-Output \$s.SignerCertificate.Subject }" | tr -d '\r')"
		CU_STATUS="$(printf '%s\n' "$CU_SIG" | head -n 1)"
		CU_SUBJECT="$(printf '%s\n' "$CU_SIG" | tail -n +2)"
		if [ "$CU_STATUS" != "Valid" ]; then
			echo "v3-package-win32: helper is NOT validly signed (status: ${CU_STATUS:-none}) — the runtime verifier will refuse it and computer use ships dead. Aborting." >&2
			exit 1
		fi
		# Accepted publishers come from the runtime source itself, so this assert and the check it
		# mirrors can never drift apart. Reissuing the certificate means editing that ONE list.
		CU_INSTALLER="src/vs/workbench/contrib/computerUse/electron-main/computerUseHelperInstaller.ts"
		CU_PUBLISHERS=$(node -e '
			const fs = require("fs");
			const src = fs.readFileSync(process.argv[1], "utf8");
			const m = src.match(/COMPUTER_USE_HELPER_WINDOWS_PUBLISHERS\s*=\s*\[([\s\S]*?)\]/);
			if (!m) { process.exit(3); }
			const list = m[1].split(",").map(s => s.trim().replace(/^["\x27]|["\x27]$/g, "")).filter(Boolean);
			if (!list.length) { process.exit(3); }
			process.stdout.write(list.join("\n"));
		' "$CU_INSTALLER") || {
			echo "v3-package-win32: could not read COMPUTER_USE_HELPER_WINDOWS_PUBLISHERS from $CU_INSTALLER — refusing to ship an unverifiable helper. Aborting." >&2
			exit 1
		}
		CU_PUB_OK=0
		while IFS= read -r publisher; do
			[ -n "$publisher" ] || continue
			if printf '%s' "$CU_SUBJECT" | grep -qiF "$publisher"; then CU_PUB_OK=1; break; fi
		done <<< "$CU_PUBLISHERS"
		if [ "$CU_PUB_OK" -ne 1 ]; then
			echo "v3-package-win32: helper cert subject matches no accepted publisher — the runtime check will refuse it and computer use ships dead." >&2
			echo "  Subject : $CU_SUBJECT" >&2
			echo "  Accepted: $(printf '%s' "$CU_PUBLISHERS" | tr '\n' '|')" >&2
			echo "  If the certificate was reissued, add its subject to COMPUTER_USE_HELPER_WINDOWS_PUBLISHERS in $CU_INSTALLER." >&2
			echo "  Never weaken this check to make a build pass. Aborting." >&2
			exit 1
		fi
		echo "    helper signature check OK: $CU_STATUS / $CU_SUBJECT"
	else
		echo "    NOTE: UNSIGNED build — the runtime Authenticode check will refuse the helper."
		echo "    Computer use is dead in THIS build BY DESIGN; test it on a CI-signed build."
	fi
fi

log "Packaged MCP bridge round trip (isolated, no GUI launch)"
node build/verify/mcp-bridge-smoke.mjs --root "$TREE_DIR"

# --- 4. double-click installer (Inno Setup, user-scope) ------------------------
log "Step 4/4 — Inno Setup user installer$([ "$DO_SIGN" -eq 1 ] && echo ' (+ signed setup/uninstaller)')"
# VSCODE_SKIP_WIN32_APPX: the Explorer right-click .appx isn't produced by the
# client-only min-ci build; skipping it keeps ISCC from failing on a missing source.
if [ "$DO_SIGN" -eq 1 ]; then
	VSCODE_SKIP_WIN32_APPX=1 npm run gulp "vscode-win32-$ARCH-user-setup" -- --sign
else
	VSCODE_SKIP_WIN32_APPX=1 npm run gulp "vscode-win32-$ARCH-user-setup"
fi

SETUP_SRC="$REPO_ROOT/.build/win32-$ARCH/user-setup/VSCodeSetup.exe"
[ -f "$SETUP_SRC" ] || { echo "v3-package-win32: installer not produced at $SETUP_SRC" >&2; ls -R "$REPO_ROOT/.build/win32-$ARCH" >&2 || true; exit 1; }

mkdir -p "$DIST_DIR"
SETUP_PATH="$DIST_DIR/V3CodeUserSetup-$ARCH-$V3_VERSION.exe"
rm -f "$SETUP_PATH"
cp "$SETUP_SRC" "$SETUP_PATH"

sha256() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" | cut -d' ' -f1; }
fsize() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

SETUP_SHA=$(sha256 "$SETUP_PATH")
SETUP_SIZE=$(fsize "$SETUP_PATH")

# --- portable zip (fallback download + deep-verifiable artifact) ---------------
ZIP_PATH=""
ZIP_SHA=""
ZIP_SIZE=""
if [ "$DO_ZIP" -eq 1 ]; then
	ZIP_PATH="$DIST_DIR/V3Code-win32-$ARCH-$V3_VERSION.zip"
	rm -f "$ZIP_PATH"
	log "Zipping portable tree -> $ZIP_PATH"
	if command -v 7z >/dev/null 2>&1; then
		( cd "$BUILD_ROOT" && 7z a "$ZIP_PATH" "VSCode-win32-$ARCH" > /dev/null )
	else
		( cd "$BUILD_ROOT" && zip -Xry -q "$ZIP_PATH" "VSCode-win32-$ARCH" )
	fi
	ZIP_SHA=$(sha256 "$ZIP_PATH")
	ZIP_SIZE=$(fsize "$ZIP_PATH")
fi

# --- summary -------------------------------------------------------------------
END_TS=$(date +%s)
ELAPSED=$(( END_TS - START_TS ))
log "BUILD COMPLETE ($(( ELAPSED / 60 ))m $(( ELAPSED % 60 ))s)"
echo "    installer     : $SETUP_PATH"
echo "    installer sha : $SETUP_SHA ($SETUP_SIZE bytes)"
if [ "$DO_ZIP" -eq 1 ]; then
	echo "    portable zip  : $ZIP_PATH"
	echo "    zip sha256    : $ZIP_SHA ($ZIP_SIZE bytes)"
fi

# Machine-readable summary for scripts/v3-publish-release.sh. `artifact` is the
# INSTALLER (what the win32 update client downloads and runs silently);
# `portableZip` is the deep-verifiable artifact publish uses to inspect the
# embedded product.json (an Inno exe can't be unzipped).
SUMMARY_JSON="$DIST_DIR/last-build.json"
node -e "const fs=require('fs');const[o,av,vv,c,a,s,h,signed,z,zs,zh]=process.argv.slice(1);fs.writeFileSync(o,JSON.stringify({appVersion:av,v3codeVersion:vv,commit:c,arch:'x64',platform:'$PLATFORM',artifact:a,size:Number(s),sha256:h,signed:signed==='1',portableZip:z||undefined,portableSize:zs?Number(zs):undefined,portableSha256:zh||undefined},null,2)+'\n');" \
	"$SUMMARY_JSON" "$APP_VERSION" "$V3_VERSION" "$COMMIT" "$SETUP_PATH" "$SETUP_SIZE" "$SETUP_SHA" "$DO_SIGN" "$ZIP_PATH" "$ZIP_SIZE" "$ZIP_SHA"
echo "    summary json  : $SUMMARY_JSON"
if [ "$DO_SIGN" -eq 0 ]; then
	echo
	echo "    UNSIGNED build — for testing only. SmartScreen will block cold downloads."
fi
