# V3Code desktop launcher — build + relaunch (dev mode, VSCODE_DEV=1).
# Usage:
#   .\launch-v3code-dev.ps1           -> React + esbuild transpile + launch (~2 min)
#   .\launch-v3code-dev.ps1 -Full     -> try full gulp compile, fall back to transpile
#   .\launch-v3code-dev.ps1 -Quick    -> React + copy only (no .ts recompile)
param(
    [switch]$Full,
    [switch]$Quick,
    [switch]$NoLaunch
)

$root = "c:\Users\heave\Desktop\mcp\vselite"
Set-Location $root
$env:PATH = "C:\nvm4w\nodejs;" + $env:PATH

$devArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$root\dev.ps1")
if ($Full) {
    $devArgs += "-FullGulp"
} elseif ($Quick) {
    $devArgs += "-Once"
} else {
    $devArgs += "-Transpile"
}

Write-Host ""
Write-Host "=== V3Code Dev Launcher ===" -ForegroundColor Magenta
Write-Host "  Mode: $(if ($Full) { 'FullGulp (compile or transpile fallback)' } elseif ($Quick) { 'Quick (React only)' } else { 'Transpile (React + all .ts)' })" -ForegroundColor Gray
Write-Host "  Root: $root" -ForegroundColor Gray
Write-Host ""

& powershell @devArgs
$exit = $LASTEXITCODE
if ($exit -ne 0) {
    Write-Host ""
    Write-Host "Build failed (exit $exit). See output above." -ForegroundColor Red
    if (-not $NoLaunch) { Read-Host "Press Enter to close" }
    exit $exit
}

Write-Host ""
Write-Host "Done. V3Code should be running." -ForegroundColor Green
Write-Host "  CSS / chat / void .ts  -> this launcher (-Transpile) is enough" -ForegroundColor Gray
Write-Host "  product.json           -> quit V3Code fully, run this again" -ForegroundColor Gray
Write-Host "  electron-main/         -> use -Full, then quit + relaunch (Ctrl+R not enough)" -ForegroundColor Gray
if (-not $NoLaunch) {
    Start-Sleep -Seconds 2
}
