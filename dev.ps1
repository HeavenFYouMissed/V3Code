# V3Code fast dev iteration loop.
#
# The pain this solves: the full `gulp compile-client` step takes ~3 minutes. For
# React/visual edits you DON'T need it -- the React bundle can be copied straight into
# the host output tree, and a window reload (Ctrl+R) picks it up in seconds.
#
# Usage:
#   .\dev.ps1                -> WATCH mode (fast): on save, rebuild React + copy to host.
#                               Launches V3Code once; press Ctrl+R IN V3Code to see changes.
#   .\dev.ps1 -Once          -> one fast build + launch, then exit.
#   .\dev.ps1 -FullGulp      -> one FULL build + launch. Tries gulp compile-client first;
#                               on OOM (exit 134) falls back to transpile-client-esbuild (~22s).
#   .\dev.ps1 -Transpile     -> esbuild transpile only (fast .ts rebuild) + launch.
#                               Use after editing .ts under browser/ or common/.
#   .\dev.ps1 -Watch -FullGulp -> watch mode but run full gulp each change (slow; rarely needed).
#
# RULE OF THUMB:
#   - Edited a .tsx/.css file under react/src/  -> fast path (default) is enough.
#   - Edited chat.css under contrib/chat/        -> fast path copies it (see Copy-ChatCss).
#   - Edited a .ts file in browser/ or common/  -> run `.\dev.ps1 -Transpile` or `-FullGulp` once.
param(
    [switch]$Once,
    [switch]$FullGulp,
    [switch]$Transpile,
    [switch]$Watch
)

# NOTE: deliberately NOT "Stop" -- npx writes harmless warnings (e.g. Browserslist) to
# stderr, which "Stop" would treat as fatal. We gate on $LASTEXITCODE explicitly instead.
$ErrorActionPreference = "Continue"
$env:PATH = "C:\nvm4w\nodejs;" + $env:PATH
$root = "c:\Users\heave\Desktop\mcp\vselite"
Set-Location $root

$reactDir    = "$root\src\vs\workbench\contrib\void\browser\react"
$reactOut    = "$reactDir\out\sidebar-tsx\index.js"
$reactOutDir = "$reactDir\out"
$hostOutDir  = "$root\out\vs\workbench\contrib\void\browser\react\out"
$electronExe = "$root\node_modules\electron\dist\electron.exe"
$nlsFile     = "$root\out\nls.messages.json"

# CRITICAL: gulp compile-client wipes out/ and compiles with build=false, which does NOT
# generate out/nls.messages.json. The workbench bootstrap (src/main.ts) hard-requires that
# file or the renderer crashes to a BLACK SCREEN. In dev (build=false) all UI text comes
# from inline English, so the NLS array is unused -- an empty [] satisfies the bootstrap.
# This single missing file is the root cause of the chronic "won't open" builds.
function Ensure-NlsFile {
    if (-not (Test-Path $nlsFile)) {
        if (Test-Path "$root\out") {
            '[]' | Set-Content -Path $nlsFile -NoNewline -Encoding UTF8
            Write-Host "  Wrote out/nls.messages.json (required for the renderer to boot)." -ForegroundColor Green
        }
    }
}

function Build-React {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Building React (scope-tailwind + tsup)..." -ForegroundColor Cyan
    Push-Location $reactDir
    try {
        npx scope-tailwind ./src -o src2/ -s void-scope -c styles.css -p "void-" *> $null
        if ($LASTEXITCODE -ne 0) { Write-Host "  scope-tailwind FAILED" -ForegroundColor Red; return $false }
        npx tsup *> $null
        if ($LASTEXITCODE -ne 0) { Write-Host "  tsup FAILED (TypeScript error in a .tsx file)" -ForegroundColor Red; return $false }
    } finally { Pop-Location }
    if (Test-Path $reactOut) {
        Write-Host "  React bundle built ($([math]::Round((Get-Item $reactOut).Length / 1KB)) KB)" -ForegroundColor Green
    }
    return $true
}

# FAST path: copy the freshly-built react/out straight into the host output tree.
# This bypasses the ~3-min gulp. Valid for React/CSS edits (not .ts service edits).
function Copy-VoidCss {
    $voidCssSrc = "$root\src\vs\workbench\contrib\void\browser\media\void.css"
    $voidCssOut = "$root\out\vs\workbench\contrib\void\browser\media\void.css"
    if (-not (Test-Path $voidCssOut)) {
        Write-Host "  void.css not in out/ — run .\dev.ps1 -FullGulp once, or create out via gulp." -ForegroundColor Yellow
        return $false
    }
    Copy-Item -Path $voidCssSrc -Destination $voidCssOut -Force
    return $true
}

function Copy-ChatCss {
    $chatCssSrc = "$root\src\vs\workbench\contrib\chat\browser\widget\media\chat.css"
    $chatCssOut = "$root\out\vs\workbench\contrib\chat\browser\widget\media\chat.css"
    if (-not (Test-Path $chatCssSrc)) { return $false }
    if (-not (Test-Path (Split-Path $chatCssOut -Parent))) {
        Write-Host "  chat.css out dir missing — run .\dev.ps1 -Transpile or -FullGulp once first." -ForegroundColor Yellow
        return $false
    }
    Copy-Item -Path $chatCssSrc -Destination $chatCssOut -Force
    return $true
}

function Copy-ToHost {
    if (-not (Test-Path $hostOutDir)) {
        Write-Host "  Host output dir missing -- you must run a full gulp build at least once first (.\dev.ps1 -FullGulp)." -ForegroundColor Yellow
        return $false
    }
    Copy-Item -Path "$reactOutDir\*" -Destination $hostOutDir -Recurse -Force
    Copy-VoidCss | Out-Null
    Copy-ChatCss | Out-Null
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Copied React bundle + void.css + chat.css to out/. Press Ctrl+R in V3Code to reload." -ForegroundColor Green
    return $true
}

# FAST .ts path: esbuild transpile (~22s). Use when compile-client OOMs (exit 134).
function Build-Transpile {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Running gulp transpile-client-esbuild (~22s)..." -ForegroundColor Cyan
    node --experimental-strip-types --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js transpile-client-esbuild 2>&1 | ForEach-Object {
        if ($_ -match "error TS\d|cannot find module|errored") {
            Write-Host "  $_" -ForegroundColor Red
        }
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "  transpile-client-esbuild FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; return $false }
    Ensure-NlsFile
    # Transpile wipes out/ — re-copy React bundles + void.css (resources copy is not reliable for react/out).
    Copy-ToHost | Out-Null
    Write-Host "  Esbuild transpile complete." -ForegroundColor Green
    return $true
}

# FULL path: gulp recompiles the whole workbench (needed for .ts changes). Slow.
function Build-Gulp {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Running gulp compile-client (full, ~3 min)..." -ForegroundColor Cyan
    npx gulp compile-client 2>&1 | ForEach-Object {
        if ($_ -match "error TS\d|compilation with [1-9]\d* error|'compile-client' errored|cannot find module") {
            Write-Host "  $_" -ForegroundColor Red
        }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  gulp compile-client FAILED (exit $LASTEXITCODE) — falling back to esbuild transpile..." -ForegroundColor Yellow
        return (Build-Transpile)
    }
    Ensure-NlsFile
    Copy-VoidCss | Out-Null
    Copy-ChatCss | Out-Null
    Write-Host "  Gulp complete." -ForegroundColor Green
    return $true
}

function Start-VoidPanelDev {
    $voidPanelDir = "$root\void-panel"
    # Optional "V buddy" UI dev server. The editor build does NOT depend on it, so
    # skip cleanly (don't error out before launch) when the folder isn't present.
    if (-not (Test-Path $voidPanelDir)) {
        Write-Host "  void-panel folder not found — skipping optional Vite dev server." -ForegroundColor Gray
        return
    }
    $portInUse = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
    if ($portInUse) {
        Write-Host "  void-panel Vite dev server already running on :5173" -ForegroundColor Gray
        return
    }
    Write-Host "  Starting void-panel Vite dev server (V buddy UI)..." -ForegroundColor Cyan
    Start-Process -FilePath "npx" -ArgumentList "vite","--host" -WorkingDirectory $voidPanelDir -WindowStyle Hidden
    Start-Sleep -Milliseconds 1500
    $check = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
    if ($check) { Write-Host "  void-panel dev server live on http://localhost:5173" -ForegroundColor Green }
    else { Write-Host "  void-panel dev server may still be starting..." -ForegroundColor Yellow }
}

function Stop-V3CodeElectron {
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like '*vselite*node_modules*electron*' }
    if ($running) {
        $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Host "  killed $((@($running)).Count) running V3Code electron process(es)"
        Start-Sleep -Milliseconds 400
    }
}

function Install-ClaudeExtensionIfMissing {
    $extDir = "$root\.tmp\extensions"
    $dest = Join-Path $extDir "anthropic.claude-code-2.1.165-win32-x64"
    if ((Test-Path $dest) -and (Test-Path (Join-Path $dest "package.json"))) {
        Write-Host "  anthropic.claude-code present." -ForegroundColor Gray
        return
    }
    $vsixUrl = "https://open-vsx.org/api/Anthropic/claude-code/win32-x64/2.1.165/file/Anthropic.claude-code-2.1.165@win32-x64.vsix"
    $vsixPath = "$root\.tmp\anthropic.claude-code.vsix"
    Write-Host "  Downloading anthropic.claude-code from Open VSX..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $vsixUrl -OutFile $vsixPath -UseBasicParsing
    } catch {
        Write-Host "  WARN: download failed — install 'Claude Code' from Extensions (Ctrl+Shift+X)." -ForegroundColor Yellow
        return
    }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Expand-Archive -Path $vsixPath -DestinationPath $dest -Force
    if (Test-Path (Join-Path $dest "extension")) {
        Move-Item (Join-Path $dest "extension\*") $dest -Force
        Remove-Item (Join-Path $dest "extension") -Recurse -Force
    }
    Remove-Item (Join-Path $dest "extension.vsixmanifest") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $dest "[Content_Types].xml") -Force -ErrorAction SilentlyContinue
    Remove-Item $vsixPath -Force -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $dest "package.json")) {
        Write-Host "  anthropic.claude-code installed." -ForegroundColor Green
    } else {
        Write-Host "  WARN: VSIX extract failed — install manually from Extensions." -ForegroundColor Yellow
    }
}

function Launch-V3Code {
    if (-not (Test-Path $electronExe)) {
        Write-Host "  V3Code.exe not found at $electronExe (run a full build first)." -ForegroundColor Yellow
        return
    }
    Ensure-NlsFile  # belt-and-suspenders for the NLS file

    # Harness scripts set ELECTRON_RUN_AS_NODE=1; if that leaks into launch, electron runs as
    # plain Node and main.js crashes (Menu export missing). Always clear before start.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    Stop-V3CodeElectron

    Install-ClaudeExtensionIfMissing

    Start-VoidPanelDev

    # CRITICAL: a compile-client build is a DEV build. It MUST be launched with VSCODE_DEV=1
    # so the window loads workbench-dev.html + the dev module loader. Without these env vars
    # the app runs in PRODUCTION mode, expects bundled output that a dev build lacks, and the
    # renderer crashes to a BLACK SCREEN (MonacoBootstrapWindow undefined). This mirrors
    # scripts/code.bat and is the true fix for the chronic "won't open" builds.
    $env:VSCODE_DEV = "1"
    $env:NODE_ENV = "development"
    $env:VSCODE_CLI = "1"
    Start-Process -FilePath $electronExe -ArgumentList @(
        ".",
        "--user-data-dir", "$root\.tmp\user-data",
        "--extensions-dir", "$root\.tmp\extensions"
    ) -WorkingDirectory $root
    Write-Host "  V3Code launched (VSCODE_DEV=1)." -ForegroundColor Green
}

# A single iteration: react build, then either fast-copy or full gulp.
function Build-Once {
    param([bool]$useGulp, [bool]$useTranspile)
    if (-not (Build-React)) { return $false }
    if ($useTranspile) { return (Build-Transpile) }
    if ($useGulp) { return (Build-Gulp) }
    return (Copy-ToHost)
}

# ---- -Once: fast single build + launch ----
if ($Once) {
    if (Build-Once -useGulp:$FullGulp -useTranspile:$Transpile) { Launch-V3Code }
    exit 0
}

# ---- -Transpile (no -Watch): esbuild + launch ----
if ($Transpile -and -not $Watch) {
    if (Build-Once -useGulp:$false -useTranspile:$true) { Launch-V3Code }
    exit 0
}

# ---- -FullGulp (no -Watch): one full build + launch ----
if ($FullGulp -and -not $Watch) {
    if (Build-Once -useGulp:$true -useTranspile:$false) { Launch-V3Code }
    exit 0
}

# ---- WATCH mode (default) ----
$useGulpInWatch = $FullGulp.IsPresent
Write-Host "=== V3Code Dev Watch ($(if ($useGulpInWatch) { 'FULL gulp' } else { 'FAST copy' }) mode) ===" -ForegroundColor Magenta
Write-Host "Watching: $reactDir\src\" -ForegroundColor Gray
if (-not $useGulpInWatch) {
    Write-Host "FAST mode: after each rebuild, press Ctrl+R inside V3Code to see changes." -ForegroundColor Gray
    Write-Host "If you edit a .ts service file (not .tsx), stop and run: .\dev.ps1 -FullGulp" -ForegroundColor Gray
}
Write-Host "Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

Build-Once -useGulp:$useGulpInWatch | Out-Null
Launch-V3Code

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = "$reactDir\src"
$watcher.IncludeSubdirectories = $true
$watcher.Filter = "*.*"
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName

$script:lastBuild = [DateTime]::MinValue
$script:useGulp = $useGulpInWatch
$debounceMs = 1200

$handler = {
    $now = [DateTime]::Now
    if (($now - $script:lastBuild).TotalMilliseconds -lt $debounceMs) { return }
    $ext = [System.IO.Path]::GetExtension($Event.SourceEventArgs.FullPath)
    if ($ext -notmatch '\.(tsx?|css|js)$') { return }
    $script:lastBuild = $now
    Write-Host ""
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Changed: $($Event.SourceEventArgs.Name)" -ForegroundColor Yellow
    if (-not (Build-React)) { return }
    if ($script:useGulp) { Build-Gulp | Out-Null } else { Copy-ToHost | Out-Null }
}

Register-ObjectEvent $watcher Changed -Action $handler | Out-Null
Register-ObjectEvent $watcher Created -Action $handler | Out-Null
Register-ObjectEvent $watcher Renamed -Action $handler | Out-Null
$watcher.EnableRaisingEvents = $true

try {
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Get-EventSubscriber | Unregister-Event
    Write-Host "Watch stopped." -ForegroundColor Gray
}
