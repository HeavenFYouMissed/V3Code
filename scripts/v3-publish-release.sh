#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — publish a packaged build to R2 for the v3update auto-update worker.
#
# Takes the artifact produced by scripts/v3-package-mac.sh + scripts/
# v3-sign-notarize-mac.sh (a .zip + the machine-readable .build/dist/
# last-build.json) — or, with --platform win32-x64-user, the signed installer
# produced by scripts/v3-package-win32.sh --sign (the .exe is the update
# artifact the win32 client downloads and runs; the portable zip in
# last-build.json's portableZip field is used for the deep bundle check,
# since an Inno exe can't be unzipped) — and:
#
#   1. uploads the .zip to R2 at
#        builds/<quality>/<platform>/V3Code-<platform>-<version>-<commit>-<sha10>.zip
#   2. writes the update manifest to R2 at
#        manifests/<quality>/<platform>/latest.json
#      in the ReleaseManifest shape the worker serves (cloud/v3update/src/env.d.ts):
#        { version, productVersion, timestamp, url, sha256hash, name, supersedes }
#      where `version` is the FULL git commit SHA of the packaged build — it must
#      equal the app bundle's product.commit (that is what the update client
#      compares against), which this script VERIFIES by reading product.json out
#      of the zip before publishing anything.
#
# The manifest is the commit point: the artifact is uploaded FIRST (existence
# confirmed), the manifest LAST, so a half-run never advertises a build whose
# bytes aren't in R2 yet. R2 object PUTs are atomic, so latest.json is always
# either fully-old or fully-new — never torn. Re-running is idempotent.
#
# The artifact filename embeds the short commit AND the first 10 hex of the zip
# sha256 — /download URLs are served with `cache-control: immutable`, so every
# distinct set of bytes (including a re-zip of the same commit after re-signing)
# must get its own URL or client caches pin stale bytes forever.
#
# UPLOAD PATHS (artifact is ~460 MB; `wrangler r2 object put` hard-caps at
# 300 MiB, so wrangler alone CANNOT publish a release):
#   S3 (preferred, required for real artifacts): R2's S3-compatible API via the
#     aws CLI (multipart, no size cap). Needs:
#       brew install awscli
#       R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY  (R2 API token -> S3 credentials)
#   wrangler (fallback for small artifacts/tests only): needs CLOUDFLARE_API_TOKEN
#     and refuses artifacts >= 300 MiB.
#
# SAFETY: dry-run by default (prints the exact plan + manifest + commands).
# --apply performs the upload. Publishing an unsigned build is refused unless
# --allow-unsigned (Squirrel.Mac rejects unsigned bytes fleet-wide).
#
# Usage:
#   scripts/v3-publish-release.sh                     # dry-run: plan + manifest
#   scripts/v3-publish-release.sh --apply             # upload zip + manifest to R2
#   scripts/v3-publish-release.sh --build-json PATH   # use a specific last-build.json
#   scripts/v3-publish-release.sh --web-releases DIR  # regenerate the website
#                                                     #   fallback latest.json
#                                                     #   (dry-run: preview only)
#   scripts/v3-publish-release.sh --allow-unsigned    # explicit unsigned override
#   scripts/v3-publish-release.sh --allow-rollback-from SHA  # deliberate rollback/same-version replacement
#
# Credentials go in the env or a gitignored cloud/v3update/.secrets.env.
# See docs/V3CODE-UPDATE-ROUTE.md for the full architecture, DNS, and rollback.
# ---------------------------------------------------------------------------
set -euo pipefail

QUALITY="stable"
PLATFORM="darwin-arm64"
BUCKET="v3code-releases"
UPDATE_HOST="https://update.v3code.dev"
WRANGLER_PUT_CAP=$((300 * 1024 * 1024))   # wrangler r2 object put hard limit

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/.build/dist"
WRANGLER_DIR="$REPO_ROOT/cloud/v3update"
BUILD_JSON="$DIST_DIR/last-build.json"

APPLY=0
ALLOW_UNSIGNED=0
WEB_RELEASES_DIR=""
ALLOW_ROLLBACK_FROM=""

while [ $# -gt 0 ]; do
	case "$1" in
		--apply) APPLY=1 ;;
		--allow-unsigned) ALLOW_UNSIGNED=1 ;;
		--build-json) BUILD_JSON="$2"; shift ;;
		--web-releases) WEB_RELEASES_DIR="$2"; shift ;;
		--allow-rollback-from) ALLOW_ROLLBACK_FROM="$2"; shift ;;
		--quality) QUALITY="$2"; shift ;;
		--platform) PLATFORM="$2"; shift ;;
		-h|--help) sed -n '2,58p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "v3-publish-release: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# --- read + validate the build summary -------------------------------------
[ -f "$BUILD_JSON" ] || {
	err "v3-publish-release: build summary not found: $BUILD_JSON"
	die "Run scripts/v3-package-mac.sh (and v3-sign-notarize-mac.sh) first."
}
# Absolute path — read_field require()s it, and a relative specifier would be
# resolved as a node module instead of a file.
BUILD_JSON="$(cd "$(dirname "$BUILD_JSON")" && pwd)/$(basename "$BUILD_JSON")"
# Keep every generated attestation beside the exact build summary. A global .build/dist was another
# shared mutable pointer and could pair a manifest preview from one candidate with another lane's
# last-build.json.
DIST_DIR="$(dirname "$BUILD_JSON")"

read_field() { node -p 'String(require(process.argv[1])[process.argv[2]] ?? "")' "$BUILD_JSON" "$1"; }
COMMIT=$(read_field commit)
V3_VERSION=$(read_field v3codeVersion)
APP_VERSION=$(read_field appVersion)
ZIP_PATH=$(read_field artifact)
DECLARED_SHA=$(read_field sha256)
DECLARED_SIZE=$(read_field size)
DECLARED_SIGNED=$(read_field signed)
DECLARED_NOTARIZED=$(read_field notarized)
PORTABLE_ZIP=$(read_field portableZip)

# CI-built summaries carry runner paths. When publishing from another machine
# (download the run's artifacts + last-build.json into one dir), fall back to
# the artifact's basename next to the summary file.
resolve_artifact() {
	local p="${1//\\//}"
	if [ -z "$p" ] || [ -f "$p" ]; then printf '%s' "$p"; return; fi
	local cand
	cand="$(dirname "$BUILD_JSON")/$(basename "$p")"
	if [ -f "$cand" ]; then printf '%s' "$cand"; else printf '%s' "$p"; fi
}
ZIP_PATH=$(resolve_artifact "$ZIP_PATH")
PORTABLE_ZIP=$(resolve_artifact "$PORTABLE_ZIP")

# Platform family drives attestation + bundle-verification differences.
case "$PLATFORM" in
	win32-*) IS_WIN32=1 ;;
	*) IS_WIN32=0 ;;
esac

if ! printf '%s' "$COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
	err "v3-publish-release: last-build.json has no valid 40-char commit (got '$COMMIT')."
	die "The manifest version must equal the packaged app's product.commit — refusing to publish."
fi
[ -f "$ZIP_PATH" ] || die "v3-publish-release: artifact not found: $ZIP_PATH"

# macOS: Squirrel.Mac rejects unsigned/un-notarized bytes — publishing them
# bricks the fleet's update attempt (v3-sign-notarize-mac.sh stamps both fields).
# Windows: there is no notarization; signed=true (Azure Artifact Signing, stamped
# by v3-package-win32.sh --sign) is the whole attestation.
if [ "$IS_WIN32" -eq 1 ]; then
	if [ "$DECLARED_SIGNED" != "true" ]; then
		if [ "$ALLOW_UNSIGNED" -eq 1 ]; then
			err "WARNING: publishing an UNSIGNED Windows artifact (--allow-unsigned)."
			err "         SmartScreen will block cold downloads of these bytes."
		else
			err "v3-publish-release: last-build.json does not attest signed (signed='$DECLARED_SIGNED')."
			die "Run scripts/v3-package-win32.sh --sign, or pass --allow-unsigned for a test publish."
		fi
	fi
elif [ "$DECLARED_SIGNED" != "true" ] || [ "$DECLARED_NOTARIZED" != "true" ]; then
	if [ "$ALLOW_UNSIGNED" -eq 1 ]; then
		err "WARNING: publishing an UNSIGNED/UN-NOTARIZED artifact (--allow-unsigned)."
		err "         electron.autoUpdater will not install these bytes on user machines."
	else
		err "v3-publish-release: last-build.json does not attest signed+notarized"
		err "(signed='$DECLARED_SIGNED', notarized='$DECLARED_NOTARIZED')."
		die "Run scripts/v3-sign-notarize-mac.sh first, or pass --allow-unsigned for a test publish."
	fi
fi

# --- verify the ARTIFACT, not just the summary ------------------------------
# The zip's embedded product.json is what the shipped app actually runs with.
# A stale artifact (built before update config landed, or from a different
# commit) must never be published: commit mismatch = infinite update loop,
# missing quality/updateUrl = update service permanently Disabled.
log "Verifying the artifact's embedded product.json"
if [ "$IS_WIN32" -eq 1 ]; then
	# The published artifact is an Inno Setup exe (opaque archive) — inspect the
	# portable zip built from the SAME tree instead (v3-package-win32.sh emits both).
	[ -n "$PORTABLE_ZIP" ] || die "v3-publish-release: win32 last-build.json has no portableZip — cannot deep-verify the bundle. Re-run v3-package-win32.sh without --no-zip."
	[ -f "$PORTABLE_ZIP" ] || die "v3-publish-release: portable zip not found: $PORTABLE_ZIP"
	VERIFY_SRC="$PORTABLE_ZIP"
	VERIFY_GLOB='*/resources/app/product.json'
else
	VERIFY_SRC="$ZIP_PATH"
	VERIFY_GLOB='*/Contents/Resources/app/product.json'
fi
BUNDLE_PRODUCT_JSON=$(unzip -p "$VERIFY_SRC" "$VERIFY_GLOB" 2>/dev/null || true)
[ -n "$BUNDLE_PRODUCT_JSON" ] || die "v3-publish-release: could not read $VERIFY_GLOB from $VERIFY_SRC"
BUNDLE_CHECK=$(printf '%s' "$BUNDLE_PRODUCT_JSON" | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
	const p = JSON.parse(s);
	console.log([p.commit || "", p.quality || "", p.updateUrl || ""].join("|"));
});')
BUNDLE_COMMIT=$(printf '%s' "$BUNDLE_CHECK" | cut -d'|' -f1)
BUNDLE_QUALITY=$(printf '%s' "$BUNDLE_CHECK" | cut -d'|' -f2)
BUNDLE_UPDATE_URL=$(printf '%s' "$BUNDLE_CHECK" | cut -d'|' -f3)
[ "$BUNDLE_COMMIT" = "$COMMIT" ] || die "v3-publish-release: artifact product.commit ('$BUNDLE_COMMIT') != last-build.json commit ('$COMMIT'). Stale or mismatched artifact — refusing to publish."
[ "$BUNDLE_QUALITY" = "$QUALITY" ] || die "v3-publish-release: artifact product.quality ('$BUNDLE_QUALITY') != '$QUALITY'. This build's update service would be Disabled — refusing to publish."
[ "$BUNDLE_UPDATE_URL" = "$UPDATE_HOST" ] || die "v3-publish-release: artifact product.updateUrl ('$BUNDLE_UPDATE_URL') != '$UPDATE_HOST' — refusing to publish."
echo "    bundle OK: commit matches, quality=$BUNDLE_QUALITY, updateUrl=$BUNDLE_UPDATE_URL"

# The sha256 in the manifest MUST match the ACTUAL uploaded bytes (the client
# verifies the download), so recompute from the artifact; last-build's values
# are cross-checks only.
log "Hashing artifact (authoritative sha256)"
# Portable sha256 so this runs on the Windows CI runner too (git-bash has no
# `shasum`): shasum (macOS) -> sha256sum (Linux/git-bash) -> node (anywhere).
_v3_sha256() {
	if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	else node -e 'const c=require("crypto"),fs=require("fs");const h=c.createHash("sha256");fs.createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>console.log(h.digest("hex")))' "$1"; fi
}
ZIP_SHA=$(_v3_sha256 "$ZIP_PATH")
ZIP_SIZE=$(stat -f%z "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH")
if [ -n "$DECLARED_SHA" ] && [ "$DECLARED_SHA" != "$ZIP_SHA" ]; then
	die "v3-publish-release: last-build.json sha256 ($DECLARED_SHA) != recomputed ($ZIP_SHA). The evidence summary is stale — refusing to publish different bytes."
fi
if [ -n "$DECLARED_SIZE" ] && [ "$DECLARED_SIZE" != "$ZIP_SIZE" ]; then
	die "v3-publish-release: last-build.json size ($DECLARED_SIZE) != actual ($ZIP_SIZE). The evidence summary is stale — refusing to publish different bytes."
fi

# --- derive keys, url, manifest ---------------------------------------------
SHORT_COMMIT=${COMMIT:0:10}
SHORT_SHA=${ZIP_SHA:0:10}
# Content-addressed: commit pins the build, sha10 pins the exact bytes (a
# re-signed re-zip of the same commit gets a fresh immutable URL). Keep the
# charset URL-unreserved ([A-Za-z0-9.-]) — the worker serves the raw key.
# Extension follows the artifact: .zip on mac (Squirrel), .exe on win32 (the
# update client downloads and silently runs the Inno installer).
ARTIFACT_EXT="${ZIP_PATH##*.}"
if [ "$ARTIFACT_EXT" = "exe" ]; then
	CONTENT_TYPE="application/octet-stream"
else
	CONTENT_TYPE="application/zip"
fi
FILENAME="V3Code-${PLATFORM}-${V3_VERSION}-${SHORT_COMMIT}-${SHORT_SHA}.${ARTIFACT_EXT}"
BUILD_KEY="builds/${QUALITY}/${PLATFORM}/${FILENAME}"
MANIFEST_KEY="manifests/${QUALITY}/${PLATFORM}/latest.json"
DOWNLOAD_URL="${UPDATE_HOST}/download/${QUALITY}/${PLATFORM}/${FILENAME}"
TIMESTAMP=$(node -p "Date.now()")

# Git SHAs are opaque, so the update worker must never interpret "different" as "older". Build an
# explicit predecessor set from release-bearing product.json history, then preserve the live
# manifest's existing chain. This covers every normal V3Code release without making the worker call
# GitHub or embedding a mutable version table in deployed code.
git cat-file -e "$COMMIT^{commit}" 2>/dev/null \
	|| die "v3-publish-release: artifact commit $COMMIT is not present in this checkout; cannot prove its release ancestry."
PRODUCT_HISTORY=$(git log --format='%H' "$COMMIT" -- product.json)

CURRENT_MANIFEST_URL="$UPDATE_HOST/api/latest/$PLATFORM/$QUALITY"
CURRENT_MANIFEST_JSON=""
if CURRENT_MANIFEST_JSON=$(curl -fsS "$CURRENT_MANIFEST_URL" 2>/dev/null); then
	CURRENT_MANIFEST_OK=1
else
	CURRENT_MANIFEST_OK=0
	[ "$APPLY" -eq 0 ] || die "v3-publish-release: could not read the current live manifest at $CURRENT_MANIFEST_URL. Refusing to change a feed whose ordering cannot be attested."
	err "WARNING: current live manifest unavailable; dry-run predecessor set uses local product history only."
fi

CURRENT_COMMIT=""
CURRENT_PRODUCT_VERSION=""
CURRENT_SUPERSEDES='[]'
if [ "$CURRENT_MANIFEST_OK" -eq 1 ]; then
	CURRENT_FIELDS=$(printf '%s' "$CURRENT_MANIFEST_JSON" | node -e '
		let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
			const m=JSON.parse(s);
			process.stdout.write([m.version||"",m.productVersion||"",JSON.stringify(Array.isArray(m.supersedes)?m.supersedes:[])].join("\n"));
		});') || die "v3-publish-release: current live manifest is not valid JSON."
	CURRENT_COMMIT=$(printf '%s\n' "$CURRENT_FIELDS" | sed -n '1p')
	CURRENT_PRODUCT_VERSION=$(printf '%s\n' "$CURRENT_FIELDS" | sed -n '2p')
	CURRENT_SUPERSEDES=$(printf '%s\n' "$CURRENT_FIELDS" | sed -n '3p')
	printf '%s' "$CURRENT_COMMIT" | grep -qE '^[0-9a-f]{40}$' \
		|| die "v3-publish-release: live manifest has an invalid commit ('$CURRENT_COMMIT')."

	if [ "$CURRENT_COMMIT" = "$COMMIT" ]; then
		die "v3-publish-release: candidate commit $COMMIT is already live. Repackaging the same commit cannot update those clients; cut a new release commit."
	else
		ORDER=$(node -e '
			const parse=v=>{const m=/^(\d+)\.(\d+)\.(\d+)-(\d+)$/.exec(v);return m&&m.slice(1).map(Number)};
			const a=parse(process.argv[1]),b=parse(process.argv[2]);
			if(!a||!b){process.stdout.write("unknown");process.exit(0)}
			let order="equal";
			for(let i=0;i<a.length;i++){if(a[i]!==b[i]){order=a[i]>b[i]?"newer":"older";break}}
			process.stdout.write(order);' "$V3_VERSION" "$CURRENT_PRODUCT_VERSION")
		if [ "$ORDER" != "newer" ]; then
			[ "$ALLOW_ROLLBACK_FROM" = "$CURRENT_COMMIT" ] \
				|| die "v3-publish-release: candidate $V3_VERSION ($COMMIT) is not newer than live $CURRENT_PRODUCT_VERSION ($CURRENT_COMMIT). For a deliberate rollback/same-version replacement, pass --allow-rollback-from $CURRENT_COMMIT."
		fi
	fi
fi

SUPERSEDES_JSON=$(printf '%s\n' "$PRODUCT_HISTORY" | node -e '
	let history=""; process.stdin.on("data",d=>history+=d).on("end",()=>{
		const candidate=process.argv[1], current=process.argv[2], inherited=JSON.parse(process.argv[3]||"[]");
		const ordered=[current,...inherited,...history.split(/\s+/)];
		const seen=new Set();
		const result=ordered.filter(v=>/^[0-9a-f]{40}$/.test(v)&&v!==candidate&&!seen.has(v)&&(seen.add(v),true));
		process.stdout.write(JSON.stringify(result));
	});' "$COMMIT" "$CURRENT_COMMIT" "$CURRENT_SUPERSEDES")

MANIFEST_LOCAL="$DIST_DIR/manifest-${QUALITY}-${PLATFORM}.json"
mkdir -p "$DIST_DIR"
# `name` is Squirrel.Mac's releaseName — the darwin service surfaces it as
# productVersion, so it must be the bare version string, not prose.
node -e "const fs=require('fs');const[o,v,pv,ts,u,h,s]=process.argv.slice(1);fs.writeFileSync(o,JSON.stringify({version:v,productVersion:pv,timestamp:Number(ts),url:u,sha256hash:h,name:pv,supersedes:JSON.parse(s)},null,2)+'\n');" \
	"$MANIFEST_LOCAL" "$COMMIT" "$V3_VERSION" "$TIMESTAMP" "$DOWNLOAD_URL" "$ZIP_SHA" "$SUPERSEDES_JSON"

# --- choose the upload path --------------------------------------------------
# Load creds from a gitignored secrets file if present.
if [ -f "$WRANGLER_DIR/.secrets.env" ]; then
	# shellcheck disable=SC1091
	set -a; . "$WRANGLER_DIR/.secrets.env"; set +a
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
	CLOUDFLARE_ACCOUNT_ID=$(node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const m=s.match(/\"account_id\"\s*:\s*\"([0-9a-f]+)\"/);process.stdout.write(m?m[1]:'')" "$WRANGLER_DIR/wrangler.jsonc")
fi
export CLOUDFLARE_ACCOUNT_ID
S3_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

UPLOADER=""
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && command -v aws >/dev/null 2>&1; then
	UPLOADER="s3"
elif [ "$ZIP_SIZE" -lt "$WRANGLER_PUT_CAP" ]; then
	UPLOADER="wrangler"
else
	UPLOADER="s3-missing"
fi

log "Release plan — $QUALITY / $PLATFORM"
echo "    commit (version) : $COMMIT"
echo "    productVersion   : $V3_VERSION   (app $APP_VERSION)"
echo "    signed/notarized : ${DECLARED_SIGNED:-false} / ${DECLARED_NOTARIZED:-false}"
echo "    artifact         : $ZIP_PATH"
echo "    size             : $ZIP_SIZE bytes"
echo "    sha256           : $ZIP_SHA"
echo "    R2 artifact key  : $BUCKET/$BUILD_KEY"
echo "    R2 manifest key  : $BUCKET/$MANIFEST_KEY"
echo "    download url     : $DOWNLOAD_URL"
echo "    upload path      : $UPLOADER"
echo
echo "    manifest ($MANIFEST_LOCAL):"
sed 's/^/      /' "$MANIFEST_LOCAL"

# --- website latest.json fallback (disaster fallback for the editor) ---------
# voidUpdateMainService fetches v3code.dev/releases/latest.json when the update
# service is Disabled. `commit` is the field it compares (appVersion `version`
# kept for shape compatibility — it does NOT change across V3Code releases).
gen_web_json() {
	local out="$1"
	local iso_date
	iso_date=$(node -p "new Date($TIMESTAMP).toISOString()")
	node -e "const fs=require('fs');const[o,v,vv,c,d,u]=process.argv.slice(1);fs.writeFileSync(o,JSON.stringify({'\$comment':'GENERATED — do not hand-edit. Written by VSElite scripts/v3-publish-release.sh --web-releases at publish time. Disaster fallback for the editor (voidUpdateMainService) when the update service is Disabled; live source of truth is https://update.v3code.dev/api/latest/darwin-arm64/stable. The editor compares the commit field (fallback: version = appVersion).',version:v,v3codeVersion:vv,commit:c,name:'V3Code '+vv,pub_date:d,notes:'Visit https://app.v3code.dev/download for the latest V3Code release.',url:'https://app.v3code.dev/download',platforms:{'darwin-arm64':{url:u,signature:''}}},null,2)+'\n');" \
		"$out" "$APP_VERSION" "$V3_VERSION" "$COMMIT" "$iso_date" "$DOWNLOAD_URL"
}
if [ -n "$WEB_RELEASES_DIR" ] && [ "$IS_WIN32" -eq 1 ]; then
	# The website fallback json is the mac editor's disaster path (its platforms
	# map is darwin-arm64) — a win32 publish must not overwrite it.
	err "NOTE: --web-releases is darwin-only — skipping website fallback for $PLATFORM."
	WEB_RELEASES_DIR=""
fi
if [ -n "$WEB_RELEASES_DIR" ] && [ ! -d "$WEB_RELEASES_DIR" ]; then
	die "v3-publish-release: --web-releases dir not found: $WEB_RELEASES_DIR"
fi

# --- dry-run gate ------------------------------------------------------------
if [ "$APPLY" -eq 0 ]; then
	if [ -n "$WEB_RELEASES_DIR" ]; then
		gen_web_json "$DIST_DIR/web-latest-preview.json"
		echo
		echo "    website fallback : PREVIEW at $DIST_DIR/web-latest-preview.json"
		echo "                       (--apply writes $WEB_RELEASES_DIR/latest.json)"
	fi
	log "DRY RUN — nothing uploaded. Re-run with --apply to publish."
	case "$UPLOADER" in
		s3)
			echo "    Exact commands --apply will run (aws CLI, R2 S3 API):"
			echo "      aws s3 cp '$ZIP_PATH' 's3://$BUCKET/$BUILD_KEY' \\"
			echo "        --endpoint-url '$S3_ENDPOINT' --content-type $CONTENT_TYPE"
			echo "      aws s3api head-object --bucket '$BUCKET' --key '$BUILD_KEY' --endpoint-url '$S3_ENDPOINT'   # readback gate"
			echo "      aws s3 cp '$MANIFEST_LOCAL' 's3://$BUCKET/$MANIFEST_KEY' \\"
			echo "        --endpoint-url '$S3_ENDPOINT' --content-type application/json"
			;;
		wrangler)
			echo "    Exact commands --apply will run (wrangler; artifact under the 300 MiB cap):"
			echo "      npx wrangler r2 object put '$BUCKET/$BUILD_KEY' --file='$ZIP_PATH' --content-type=$CONTENT_TYPE --remote"
			echo "      npx wrangler r2 object get '$BUCKET/$BUILD_KEY' --remote --pipe >/dev/null   # readback gate (full download)"
			echo "      npx wrangler r2 object put '$BUCKET/$MANIFEST_KEY' --file='$MANIFEST_LOCAL' --content-type=application/json --remote"
			;;
		s3-missing)
			err "    NOTE: artifact is $ZIP_SIZE bytes (>= 300 MiB wrangler cap) and the aws CLI"
			err "    path is not available. --apply will fail until you:"
			err "      brew install awscli"
			err "      export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...   # R2 -> Manage API Tokens"
			;;
	esac
	exit 0
fi

# --- apply: upload to R2 ------------------------------------------------------
case "$UPLOADER" in
	s3)
		export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
		export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

		log "Uploading artifact -> $BUCKET/$BUILD_KEY (S3 multipart)"
		aws s3 cp "$ZIP_PATH" "s3://$BUCKET/$BUILD_KEY" --endpoint-url "$S3_ENDPOINT" --content-type $CONTENT_TYPE

		log "Confirming artifact in R2 (head-object)"
		aws s3api head-object --bucket "$BUCKET" --key "$BUILD_KEY" --endpoint-url "$S3_ENDPOINT" >/dev/null \
			|| die "v3-publish-release: artifact not readable back from R2 — NOT writing manifest."

		log "Publishing manifest -> $BUCKET/$MANIFEST_KEY (commit point)"
		aws s3 cp "$MANIFEST_LOCAL" "s3://$BUCKET/$MANIFEST_KEY" --endpoint-url "$S3_ENDPOINT" --content-type application/json
		;;
	wrangler)
		[ -x "$WRANGLER_DIR/node_modules/.bin/wrangler" ] || die "v3-publish-release: wrangler not installed — run: cd cloud/v3update && SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install"
		[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "v3-publish-release: wrangler path needs CLOUDFLARE_API_TOKEN in the env or cloud/v3update/.secrets.env."
		cd "$WRANGLER_DIR"

		log "Uploading artifact -> $BUCKET/$BUILD_KEY (wrangler)"
		npx wrangler r2 object put "$BUCKET/$BUILD_KEY" --file="$ZIP_PATH" --content-type=$CONTENT_TYPE --remote

		log "Confirming artifact in R2"
		npx wrangler r2 object get "$BUCKET/$BUILD_KEY" --remote --pipe >/dev/null 2>&1 \
			|| die "v3-publish-release: artifact not readable back from R2 — NOT writing manifest."

		log "Publishing manifest -> $BUCKET/$MANIFEST_KEY (commit point)"
		npx wrangler r2 object put "$BUCKET/$MANIFEST_KEY" --file="$MANIFEST_LOCAL" --content-type=application/json --remote
		;;
	s3-missing)
		err "v3-publish-release: artifact is $ZIP_SIZE bytes — over wrangler's 300 MiB r2-put cap."
		err "Install the S3 path:  brew install awscli"
		err "Credentials:          R2 dashboard -> Manage API Tokens -> S3 auth keys, then"
		err "                      export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=..."
		die "Aborting before any upload."
		;;
esac

if [ -n "$WEB_RELEASES_DIR" ]; then
	gen_web_json "$WEB_RELEASES_DIR/latest.json"
	echo "    website fallback : $WEB_RELEASES_DIR/latest.json (regenerated — commit it in superclaw)"
fi

log "PUBLISHED"
echo "    Verify (once the worker is deployed + DNS resolves):"
echo "      curl -s $UPDATE_HOST/api/latest/$PLATFORM/$QUALITY | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const m=JSON.parse(s);console.log(m.version===\"$COMMIT\"?\"OK version matches commit\":\"MISMATCH \"+m.version)})'"
echo "      curl -sI $DOWNLOAD_URL   # 200 + content-type: $CONTENT_TYPE"
