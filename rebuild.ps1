# =============================================================================
# rebuild.ps1 — V3Code DETERMINISTIC full build + relaunch.
#
# THE GUARANTEE: after this finishes, what runs == what the source says. Every
# time. No "did it pick up my change" guesswork. It is slow on purpose
# because it ALWAYS rebuilds every output instead of trying to be clever.
#
# V3Code has FOUR build outputs — incremental/watch builds skipping any of them is
# the entire reason changes "don't show up":
#   1. Sidebar React   (src/.../void/browser/react)  -> npm run buildreact
#   2. Workbench TS    (src/vs/**)                    -> gulp transpile -> out/
#   3. Mermaid webview (extensions/mermaid-markdown-features/chat-webview-out/)
#   4. Copilot ext     (extensions/copilot)             -> npm run compile -> dist/extension.js
# Plus out/nls.messages.json (wiped by the transpile; renderer black-screens w/o it)
# Plus a FULL process restart (Ctrl+R is not enough for contributions/main process).
#
# USAGE:
#   .\rebuild.ps1                 full build + restart (keeps your profile/settings)
#   .\rebuild.ps1 -Clean          ALSO reset window/layout state — use this whenever
#                                 you changed where a VIEW/TAB/PANEL lives, since view
#                                 positions are saved in the profile, NOT in code.
#   .\rebuild.ps1 -NoLaunch       build only, don't start the app
#   .\rebuild.ps1 -Verify a,b     after build, confirm strings a and b are in out/
#
# RULE OF THUMB:
#   - Changed code/logic?      -> .\rebuild.ps1
#   - Changed a view location, tab, or default layout? -> .\rebuild.ps1 -Clean
# =============================================================================
param(
    [switch]$Clean,
    [switch]$NoLaunch,
    [string[]]$Verify = @()
)

$ErrorActionPreference = 'Continue'
$root = 'c:\Users\heave\Desktop\mcp\vselite'
$env:PATH = 'C:\nvm4w\nodejs;' + $env:PATH
Set-Location $root
$fail = $false

function Step($n, $msg) { Write-Host "`n=== [$n] $msg ===" -ForegroundColor Cyan }
function Die($msg) { Write-Host "  $msg" -ForegroundColor Red; exit 1 }

function Stop-V3CodeElectron {
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like '*vselite*node_modules*electron*' }
    if ($running) {
        $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Host "  killed $((@($running)).Count) running V3Code electron process(es) (unlocks out/)"
        Start-Sleep -Milliseconds 1200
    }
}

function Test-BootCriticalOut {
    param([string]$Root)
    $required = @(
        "$Root\out\nls.messages.json",
        "$Root\out\vs\workbench\workbench.desktop.main.js",
        "$Root\out\vs\workbench\workbench.common.main.js",
        "$Root\out\vs\workbench\electron-browser\desktop.main.js",
        "$Root\out\vs\editor\editor.all.js",
        "$Root\out\vs\workbench\contrib\void\browser\void.contribution.js"
    )
    $missing = @($required | Where-Object { -not (Test-Path $_) })
    if ($missing.Count -gt 0) {
        Write-Host '  BOOT CHECK FAILED — grey screen if you launch now:' -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "    MISSING $_" -ForegroundColor Red }
        return $false
    }
    Write-Host '  boot-critical out/ files present' -ForegroundColor Green
    return $true
}

# Transpile wipes/rebuilds out/. A running dev Electron keeps files open and causes
# ENOENT / partial out/ -> "Failed to fetch workbench.desktop.main.js" grey screen.
Stop-V3CodeElectron

# --- 1. Sidebar React. MUST run before the transpile so its bundles exist when
#        the transpile copies non-TS resources into out/. -----------------------
Step '1/6' 'Sidebar React (npm run buildreact)'
npm run buildreact 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { Die 'buildreact FAILED — fix the .tsx error above.' }

# --- 2. Workbench TypeScript -> out/ (also copies the react bundles). ----------
Step '2/6' 'Workbench TypeScript (gulp transpile-client-esbuild)'
node --experimental-strip-types --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js transpile-client-esbuild 2>&1 |
    Select-String -Pattern "error|ERROR|Cannot find|Finished 'transpile" | Select-Object -Last 6
if ($LASTEXITCODE -ne 0) { Die 'transpile FAILED.' }

# --- 3. NLS boot file (transpile wipes out/). ----------------------------------
Step '3/6' 'Writing out/nls.messages.json'
'[]' | Set-Content -Path "$root\out\nls.messages.json" -NoNewline -Encoding UTF8
Write-Host '  ok'

# --- 4. Mermaid chat webview bundle (esbuild in extension dir). ----------------
Step '4/6' 'Mermaid webview (extensions/mermaid-markdown-features/chat-webview-out)'
$mermaidExt = "$root\extensions\mermaid-markdown-features"
Push-Location $mermaidExt
npm run build-webview 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) {
    Write-Host '  build-webview failed — reinstalling extension deps (npm ci) and retrying...' -ForegroundColor Yellow
    npm ci 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'mermaid extension npm ci FAILED.' }
    npm run build-webview 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'mermaid build-webview FAILED after npm ci.' }
}
Pop-Location
$mermaidJs = "$mermaidExt\chat-webview-out\index.js"
if (-not (Test-Path $mermaidJs) -or (Get-Item $mermaidJs).Length -eq 0) {
    Die 'mermaid chat-webview-out/index.js missing or empty — chat mermaid diagrams will not render.'
}
Write-Host "  ok ($([math]::Round((Get-Item $mermaidJs).Length / 1MB, 1)) MB)" -ForegroundColor Green

# --- 5. Copilot extension (Claude SDK sessions + v3code MCP contributor). -------
Step '5/6' 'Copilot extension (extensions/copilot -> dist/extension.js)'
Push-Location "$root\extensions\copilot"
npm run compile 2>&1 | Select-String -Pattern "error|ERROR|dist\\extension|Done in" | Select-Object -Last 8
if ($LASTEXITCODE -ne 0) {
    Write-Host '  compile failed — reinstalling copilot deps (npm ci) and retrying...' -ForegroundColor Yellow
    npm ci 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'copilot extension npm ci FAILED.' }
    npm run compile 2>&1 | Select-String -Pattern "error|ERROR|dist\\extension|Done in" | Select-Object -Last 8
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'copilot compile FAILED after npm ci.' }
}
Pop-Location
$copilotMain = "$root\extensions\copilot\dist\extension.js"
if (-not (Test-Path $copilotMain) -or (Get-Item $copilotMain).Length -lt 1MB) {
    Die 'extensions/copilot/dist/extension.js missing or too small — Claude SDK + mcp__v3code__ tools will not load.'
}
Write-Host "  ok ($([math]::Round((Get-Item $copilotMain).Length / 1MB, 1)) MB)" -ForegroundColor Green

if (-not (Test-BootCriticalOut -Root $root)) {
    Die 'transpile incomplete: missing boot-critical files in out/ (grey screen). Close V3Code and re-run .\rebuild.ps1.'
}

# --- Optional verification: prove the change physically reached out/. ----------
# Accept both -Verify a,b (array) and -Verify "a,b" (single string via -File).
$Verify = @($Verify | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Verify.Count -gt 0) {
    Step 'verify' 'Confirming strings are present in compiled out/'
    $jsFiles = Get-ChildItem "$root\out\vs\workbench\contrib\void" -Recurse -Filter *.js -ErrorAction SilentlyContinue
    foreach ($s in $Verify) {
        $hit = $jsFiles | Select-String -SimpleMatch -Pattern $s -List -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { Write-Host "  FOUND   '$s'  -> $($hit.Filename)" -ForegroundColor Green }
        else { Write-Host "  MISSING '$s'  (NOT in out/ — change did not land!)" -ForegroundColor Red; $fail = $true }
    }
}

# --- 4. Restart V3Code (only the vselite electron — never Cursor). -------------
Step '6/6' 'Restarting V3Code'
Stop-V3CodeElectron
if (-not (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like '*vselite*node_modules*electron*' })) {
    Write-Host '  none running'
}

# Layout/view positions live in the profile, not in code. Reset them (but KEEP
# settings.json) so the UI reflects exactly what the code registers.
$userDir = "$root\.tmp\user-data\User"
if ($Clean) {
    Write-Host '  -Clean: resetting layout/view state (settings.json preserved)' -ForegroundColor Yellow
    $settings = "$userDir\settings.json"
    $backup = $null
    if (Test-Path $settings) { $backup = Get-Content $settings -Raw }
    Remove-Item -Recurse -Force "$root\.tmp\user-data" -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $userDir | Out-Null
    if ($backup) { Set-Content -Path $settings -Value $backup -Encoding UTF8 }
}

# Ensure the V3Code default settings exist in the dev profile (deterministic dev UI;
# customers get these baked into the build separately).
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
$devSettingsPath = "$userDir\settings.json"
$devSettingsBody = @'
{
    "window.titleBarStyle": "custom",
    "window.menuBarVisibility": "compact",
    "window.commandCenter": true,
    "workbench.colorTheme": "V3Code Dark Classic",
    "terminal.integrated.shellIntegration.enabled": true,
    "terminal.integrated.enablePersistentSessions": true,
    "terminal.integrated.defaultProfile.windows": "PowerShell",
    "chat.agent.thinking.collapsedTools": "off",
    "chat.agent.thinking.terminalTools": false,
    "chat.tools.terminal.simpleCollapsible": false
}
'@
if (-not (Test-Path $devSettingsPath)) {
    Set-Content -Path $devSettingsPath -Value $devSettingsBody -Encoding UTF8
    Write-Host '  wrote default dev settings.json'
} else {
    $raw = Get-Content $devSettingsPath -Raw
    if ($raw -notmatch 'terminal\.integrated\.shellIntegration\.enabled') {
        Write-Host '  hint: add terminal.integrated.shellIntegration.enabled to settings.json for agent terminal tools' -ForegroundColor Yellow
    }
    if ($raw -notmatch 'chat\.agent\.thinking\.collapsedTools') {
        Write-Host '  hint: add chat.agent.thinking.collapsedTools=off to settings.json for visible tool cards' -ForegroundColor Yellow
    }
}

if ($fail) { Write-Host "`nBUILD VERIFY FAILED — see MISSING lines above. NOT a clean state." -ForegroundColor Red }

if (-not $NoLaunch) {
    # Match scripts/code.bat: product electron + dev flags (same binary VS Code dev uses).
    $env:VSCODE_DEV = '1'; $env:NODE_ENV = 'development'; $env:VSCODE_CLI = '1'
    $electron = "$root\.build\electron\V3Code.exe"
    if (-not (Test-Path $electron)) { $electron = "$root\node_modules\electron\dist\electron.exe" }
    Start-Process -FilePath $electron `
        -ArgumentList @('.', '--user-data-dir', "$root\.tmp\user-data", '--extensions-dir', "$root\.tmp\extensions") `
        -WorkingDirectory $root
    Start-Sleep -Seconds 3
    Write-Host "`nDONE. out/ + copilot dist/ == source. V3Code relaunched." -ForegroundColor Green
} else {
    Write-Host "`nDONE (no launch)." -ForegroundColor Green
}
