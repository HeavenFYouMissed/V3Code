# ---------------------------------------------------------------------------
# V3Code — build the Windows computer-use helper (v3code-computer-use.exe)
#
# Compiles src/vs/workbench/contrib/computerUse/helper/win32 into a single
# standalone console executable. No third-party dependencies: the only inputs
# are the C++ sources and the Windows SDK.
#
# Usage:
#   pwsh -File scripts/build-computer-use-helper-win32.ps1
#   pwsh -File scripts/build-computer-use-helper-win32.ps1 -Arch arm64
#   pwsh -File scripts/build-computer-use-helper-win32.ps1 -Configuration debug
#   pwsh -File scripts/build-computer-use-helper-win32.ps1 -OutDir C:\out
#
# Output:
#   .build/computer-use/win32-<arch>/v3code-computer-use.exe
#
# THIS SCRIPT DOES NOT SIGN. Signing is the existing Azure Artifact Signing
# pipeline's job: scripts/v3-sign-win32.ps1 already globs *.exe, so the helper
# is picked up automatically once it lands in the packaged output. Do not add a
# signtool call here — a second signature is not additive and a locally signed
# binary would be re-signed in CI anyway.
#
# ORDER MATTERS IN THE PIPELINE: if rcedit is run over this binary to stamp
# icon or version metadata, it MUST run BEFORE signing. Writing PE resources
# invalidates an Authenticode signature, so rcedit-after-signtool silently
# produces an unsigned-looking binary that fails SmartScreen.
#
# The version block and the PerMonitorV2 manifest are already embedded by
# v3code-computer-use.rc, so rcedit is not required for correctness — only if
# the pipeline wants to override those values centrally.
#
# NEEDS VERIFICATION ON WINDOWS: this script has never been run. It was written
# on macOS. Everything below — the vswhere query, the vcvarsall invocation, the
# exact library list, and whether rc.exe and cl.exe accept these arguments — is
# unverified. Expect to iterate on the library list first: a missing GUID
# definition shows up as an unresolved external symbol naming a CLSID.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
	# x64 is what ships today. See the arm64 notes further down.
	[ValidateSet('x64', 'arm64')]
	[string] $Arch = 'x64',

	[ValidateSet('release', 'debug')]
	[string] $Configuration = 'release',

	# Defaults to .build/computer-use/win32-<arch> under the repository root.
	[string] $OutDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Fail loudly and unambiguously. Every failure path in this script ends here, so
# a broken build prints one clear reason rather than a wall of compiler noise
# followed by a zero exit code.
function Fail([string] $message) {
	Write-Host ''
	Write-Host "BUILD FAILED: $message" -ForegroundColor Red
	exit 1
}

function Assert-LastExitCode([string] $what) {
	if ($LASTEXITCODE -ne 0) {
		Fail "$what exited with code $LASTEXITCODE"
	}
}

if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
	Fail 'this script builds a Windows binary and must run on Windows'
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourceDir = Join-Path $repoRoot 'src/vs/workbench/contrib/computerUse/helper/win32'
if (-not (Test-Path $sourceDir)) {
	Fail "helper sources not found at $sourceDir"
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
	$OutDir = Join-Path $repoRoot ".build/computer-use/win32-$Arch"
	# Debug builds get their own directory: a debug exe needs the non-redistributable
	# debug CRT and fails to start on user machines, so it must never be able to sit
	# at the path the release packager picks up.
	if ($Configuration -ne 'release') {
		$OutDir = "$OutDir-$Configuration"
	}
}
$objDir = Join-Path $OutDir 'obj'
New-Item -ItemType Directory -Force -Path $objDir | Out-Null

# ---------------------------------------------------------------------------
# Locate the MSVC toolchain.
# ---------------------------------------------------------------------------
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
	Fail "vswhere.exe not found at $vswhere — install Visual Studio 2022 with the 'Desktop development with C++' workload"
}

$vsInstall = & $vswhere -latest -products '*' `
	-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
	-property installationPath
Assert-LastExitCode 'vswhere'
if ([string]::IsNullOrWhiteSpace($vsInstall)) {
	Fail 'no Visual Studio installation with the MSVC C++ toolchain was found'
}
$vsInstall = $vsInstall.Trim()

$vcvarsall = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvarsall.bat'
if (-not (Test-Path $vcvarsall)) {
	Fail "vcvarsall.bat not found at $vcvarsall"
}

# ARM64:
#   -Arch arm64 selects the cross toolchain ("x64_arm64" below), which is the
#   supported way to build an arm64 binary from an x64 build agent. It requires
#   the "MSVC v143 - VS 2022 C++ ARM64 build tools" component, which is NOT
#   installed by the C++ workload by default; without it vcvarsall fails with
#   "The specified configuration type is missing".
#
#   Every API this helper uses — UI Automation, WIC, D3D11/DXGI desktop
#   duplication, SetWindowDisplayAffinity, the per-monitor DPI entry points — is
#   present natively on arm64 Windows, so no source change is needed.
#
#   The helper MUST be shipped as a native arm64 binary on arm64 machines rather
#   than relying on x64 emulation. An emulated process still reports physical
#   pixels, but every UIA cross-process call pays the emulation cost twice, and
#   an axTree walk of a large window is already the slowest thing here.
$vcvarsArch = if ($Arch -eq 'arm64') { 'x64_arm64' } else { 'x64' }

# ---------------------------------------------------------------------------
# Compiler and linker flags.
# ---------------------------------------------------------------------------
$sources = @(
	'Apps.cpp',
	'AppTiers.cpp',
	'AxCache.cpp',
	'AxTree.cpp',
	'AxWatch.cpp',
	'Base64.cpp',
	'Cancellation.cpp',
	'Capture.cpp',
	'CaptureExclusion.cpp',
	'Common.cpp',
	'DesktopDuplication.cpp',
	'Dispatcher.cpp',
	'Dpi.cpp',
	'GdiCapture.cpp',
	'Handlers.cpp',
	'Json.cpp',
	'Log.cpp',
	'Main.cpp',
	'Monitors.cpp',
	'Observation.cpp',
	'PngEncoder.cpp',
	'Protocol.cpp',
	'RefTable.cpp',
	'Settle.cpp',
	'SynthesizedInput.cpp',
	'Targets.cpp',
	'UiaActions.cpp',
	'UiaClient.cpp',
	'UiaEvents.cpp',
	'UiaRoles.cpp'
)

foreach ($source in $sources) {
	$path = Join-Path $sourceDir $source
	if (-not (Test-Path $path)) {
		Fail "source file missing: $path (update the `$sources list in this script)"
	}
}

# /MT statically links the CRT so the shipped helper has no VC++ redistributable
# dependency. A helper that fails to start because a redist is missing looks
# exactly like a helper that is broken.
$commonFlags = @(
	'/nologo',
	'/std:c++17',
	'/EHsc',      # C++ exceptions only; SEH is deliberately not caught (see Main.cpp)
	'/W4',
	'/permissive-',
	'/Zc:__cplusplus',
	'/DUNICODE',
	'/D_UNICODE',
	'/DWIN32_LEAN_AND_MEAN',
	'/DNOMINMAX'
)

if ($Configuration -eq 'release') {
	$configFlags = @('/O2', '/MT', '/DNDEBUG', '/GL')
	$linkConfigFlags = @('/LTCG', '/OPT:REF', '/OPT:ICF')
} else {
	$configFlags = @('/Od', '/MTd', '/Zi', '/D_DEBUG')
	$linkConfigFlags = @('/DEBUG')
}

# Library notes, because an unresolved-symbol error here is otherwise opaque:
#   uuid.lib            CLSID_CUIAutomation / CLSID_CUIAutomation8 definitions
#   windowscodecs.lib   WIC factory CLSID and the pixel-format / container GUIDs
#   shlwapi.lib         SHCreateMemStream
#   shcore.lib          GetDpiForMonitor (also resolved dynamically at runtime)
#   dwmapi.lib          DwmGetWindowAttribute, for the cloaked-window filter
#   version.lib         GetFileVersionInfo, for an app's display name
$libraries = @(
	'user32.lib',
	'gdi32.lib',
	'ole32.lib',
	'oleaut32.lib',
	'uuid.lib',
	'shlwapi.lib',
	'shcore.lib',
	'windowscodecs.lib',
	'd3d11.lib',
	'dxgi.lib',
	'dwmapi.lib',
	'version.lib'
)

$exeName = 'v3code-computer-use.exe'
$exePath = Join-Path $OutDir $exeName
$resPath = Join-Path $objDir 'v3code-computer-use.res'

# ---------------------------------------------------------------------------
# Build, inside a Developer Command Prompt environment.
#
# vcvarsall.bat only sets environment variables for the cmd.exe process it runs
# in, so the compile has to happen in that same process. Hence one cmd /c that
# chains vcvarsall, rc and cl. `if errorlevel 1 exit /b 1` after each step is
# what makes a failure propagate instead of being swallowed by the chain.
# ---------------------------------------------------------------------------
$sourceArgs = ($sources | ForEach-Object { '"' + (Join-Path $sourceDir $_) + '"' }) -join ' '
$flagArgs = ($commonFlags + $configFlags) -join ' '
$libArgs = $libraries -join ' '
$linkArgs = ($linkConfigFlags + @('/SUBSYSTEM:CONSOLE')) -join ' '

$script = @"
@echo off
call "$vcvarsall" $vcvarsArch
if errorlevel 1 exit /b 1

echo === rc: compiling resources ===
rc.exe /nologo /fo "$resPath" "$(Join-Path $sourceDir 'v3code-computer-use.rc')"
if errorlevel 1 exit /b 1

echo === cl: compiling and linking ===
cl.exe $flagArgs /Fo"$objDir\\" /Fd"$objDir\\" $sourceArgs "$resPath" /link $linkArgs $libArgs /OUT:"$exePath"
if errorlevel 1 exit /b 1
"@

$scriptPath = Join-Path $objDir 'build.cmd'
Set-Content -Path $scriptPath -Value $script -Encoding ASCII

Write-Host "building $exeName for win32-$Arch ($Configuration)" -ForegroundColor Cyan
Write-Host "  sources: $sourceDir"
Write-Host "  output:  $exePath"

# rc.exe needs the manifest to resolve relative to the .rc file's directory.
Push-Location $sourceDir
try {
	& cmd.exe /c "`"$scriptPath`""
	Assert-LastExitCode 'cl.exe'
} finally {
	Pop-Location
}

if (-not (Test-Path $exePath)) {
	Fail "the compiler reported success but $exePath does not exist"
}

$size = [math]::Round((Get-Item $exePath).Length / 1KB, 1)
Write-Host ''
Write-Host "built $exePath ($size KB)" -ForegroundColor Green
Write-Host 'not signed by design — scripts/v3-sign-win32.ps1 handles that in the release pipeline'
Write-Host 'if rcedit stamps this binary, it must run BEFORE signing'
Write-Host ''
Write-Host 'smoke test:' -ForegroundColor Cyan
Write-Host "  echo {""id"":1,""method"":""ping"",""params"":null,""protocolVersion"":2} | `"$exePath`""
Write-Host '  expect exactly one line of JSON on stdout, with platform "win32"'
