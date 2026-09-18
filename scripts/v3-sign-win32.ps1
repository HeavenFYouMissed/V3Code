# ---------------------------------------------------------------------------
# V3Code — Windows Authenticode signing via Azure Artifact Signing
# (the service formerly named "Azure Trusted Signing"; renamed Jan 2026).
#
# Signs PE files (exe/dll/node) with the v3codesigning account's Public Trust
# certificate profile. The private key lives in Azure HSMs and never touches
# the build machine; signtool talks to the service through Microsoft's dlib
# (NuGet: Microsoft.Trusted.Signing.Client — package kept its pre-rename name).
#
# This is the Windows counterpart of scripts/v3-sign-notarize-mac.sh, and the
# replacement for build/azure-pipelines/common/sign-win32.ts (Microsoft's
# internal ESRP pipeline — dead end outside their tenant, kept only as shape
# reference). There is no notarization step on Windows: signing is the whole
# story, synchronous per file.
#
# Auth (in DefaultAzureCredential order, first match wins):
#   - AZURE_CLIENT_ID/AZURE_TENANT_ID/AZURE_CLIENT_SECRET env (EnvironmentCredential)
#   - GitHub Actions OIDC via a prior azure/login step (AzureCliCredential) —
#     this is the CI path; no stored secret exists anywhere.
#   - a local `az login` session (AzureCliCredential) for one-off manual runs.
#
# Usage:
#   pwsh -File scripts/v3-sign-win32.ps1 <file> [<file> ...]
#   pwsh -File scripts/v3-sign-win32.ps1 -Folder <dir>     # all *.exe,*.dll,*.node under dir
#
# Config (env, defaults = production values):
#   V3_SIGN_ENDPOINT        default https://eus.codesigning.azure.net/
#   V3_SIGN_ACCOUNT         default v3codesigning
#   V3_SIGN_PROFILE         default v3code-public
#   V3_SIGN_CLIENT_VERSION  pin the Microsoft.Trusted.Signing.Client version
#                           (default: latest stable from nuget.org)
#
# Requires: Windows, signtool >= 10.0.2261.755 (x64 — 32-bit fails silently),
# .NET 8 runtime (present on GitHub windows-2022 runners).
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
	# Prefer -Files/-Folder explicitly (the Inno hook passes -Files): positional
	# binding of remaining args proved unreliable under `pwsh -File` from ISCC.
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$Files,
	[string]$Folder = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($null -eq $Files) { $Files = @() }

$Endpoint = if ($env:V3_SIGN_ENDPOINT) { $env:V3_SIGN_ENDPOINT } else { 'https://eus.codesigning.azure.net/' }
$Account  = if ($env:V3_SIGN_ACCOUNT)  { $env:V3_SIGN_ACCOUNT }  else { 'v3codesigning' }
$Profile  = if ($env:V3_SIGN_PROFILE)  { $env:V3_SIGN_PROFILE }  else { 'v3code-public' }
$TimestampUrl = 'http://timestamp.acs.microsoft.com'
$MinSigntool = [version]'10.0.2261.755'
$ClientPackage = 'microsoft.trusted.signing.client'

function Log([string]$msg) { Write-Host "==> $msg" }

# --- collect the file list ---------------------------------------------------
Log "invoked with $($Files.Count) file arg(s), Folder='$Folder'"
$targets = @()
foreach ($f in $Files) {
	if (-not (Test-Path $f)) { throw "v3-sign-win32: file not found: $f" }
	$targets += (Resolve-Path $f).Path
}
if ($Folder) {
	if (-not (Test-Path $Folder)) { throw "v3-sign-win32: folder not found: $Folder" }
	$targets += Get-ChildItem -Path $Folder -Recurse -File -Include '*.exe', '*.dll', '*.node' | ForEach-Object { $_.FullName }
}
if ($targets.Count -eq 0) { throw 'v3-sign-win32: nothing to sign (pass files or -Folder).' }

# The packaged tree carries foreign-platform prebuilts (e.g. onnxruntime-node
# ships darwin/linux .node binaries) that signtool rejects as unrecognizable.
# Only PE files (MZ magic) are Authenticode-signable — filter on content, not
# extension, so any layout of foreign binaries is skipped.
function Test-IsPEFile([string]$path) {
	try {
		$fs = [System.IO.File]::OpenRead($path)
		try {
			if ($fs.Length -lt 2) { return $false }
			return ($fs.ReadByte() -eq 0x4D -and $fs.ReadByte() -eq 0x5A)
		} finally { $fs.Dispose() }
	} catch { return $false }
}
$pe = New-Object System.Collections.Generic.List[string]
$skipped = 0
foreach ($t in $targets) {
	if (Test-IsPEFile $t) { $pe.Add($t) } else { $skipped++ }
}
if ($skipped -gt 0) { Log "Skipping $skipped non-PE file(s) (foreign-platform binaries etc.)" }
$targets = @($pe)
if ($targets.Count -eq 0) { throw 'v3-sign-win32: no PE files left to sign after filtering.' }
Log "Signing $($targets.Count) file(s) with $Account/$Profile via $Endpoint"

# --- bootstrap the Trusted Signing dlib (cached across invocations) ----------
$cacheRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$cacheDir = Join-Path $cacheRoot 'v3-azsign'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

$clientVersion = $env:V3_SIGN_CLIENT_VERSION
if (-not $clientVersion) {
	$index = Invoke-RestMethod "https://api.nuget.org/v3-flatcontainer/$ClientPackage/index.json"
	# newest stable (skip -preview/-beta suffixed versions)
	$clientVersion = @($index.versions | Where-Object { $_ -notmatch '-' })[-1]
}
$pkgDir = Join-Path $cacheDir "client-$clientVersion"
$dlib = Join-Path $pkgDir 'bin\x64\Azure.CodeSigning.Dlib.dll'
if (-not (Test-Path $dlib)) {
	Log "Fetching $ClientPackage $clientVersion from nuget.org"
	$nupkg = Join-Path $cacheDir "client-$clientVersion.zip"
	Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/$ClientPackage/$clientVersion/$ClientPackage.$clientVersion.nupkg" -OutFile $nupkg
	Expand-Archive -Path $nupkg -DestinationPath $pkgDir -Force
	Remove-Item $nupkg
	if (-not (Test-Path $dlib)) { throw "v3-sign-win32: dlib not found at $dlib after extracting $ClientPackage $clientVersion" }
}

# Metadata handed to the dlib; ExcludeCredentials trims DefaultAzureCredential's
# probe chain to the two paths we actually use (env secret / az cli+OIDC) so a
# missing IMDS endpoint can't stall CI for minutes.
$metadata = Join-Path $cacheDir 'metadata.json'
@{
	Endpoint                 = $Endpoint
	CodeSigningAccountName   = $Account
	CertificateProfileName   = $Profile
	ExcludeCredentials       = @(
		'ManagedIdentityCredential', 'WorkloadIdentityCredential', 'SharedTokenCacheCredential',
		'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzurePowerShellCredential',
		'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
	)
} | ConvertTo-Json | Set-Content -Path $metadata -Encoding utf8

# --- locate a new-enough x64 signtool ----------------------------------------
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
	Sort-Object { [version]($_.Directory.Parent.Name) } | Select-Object -Last 1
if (-not $signtool) { throw 'v3-sign-win32: signtool.exe not found under Windows Kits (install a Windows 10/11 SDK).' }
$sdkVersion = [version]$signtool.Directory.Parent.Name
if ($sdkVersion -lt $MinSigntool) {
	throw "v3-sign-win32: signtool $sdkVersion is older than $MinSigntool — the Artifact Signing dlib requires a newer SDK."
}
Log "signtool: $($signtool.FullName) (SDK $sdkVersion)"

# --- sign in batches ----------------------------------------------------------
$batchSize = 20
for ($i = 0; $i -lt $targets.Count; $i += $batchSize) {
	$batch = $targets[$i..([Math]::Min($i + $batchSize, $targets.Count) - 1)]
	Log "Batch $([int]($i / $batchSize) + 1): signing $($batch.Count) file(s)"
	& $signtool.FullName sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 /dlib $dlib /dmdf $metadata @batch
	if ($LASTEXITCODE -ne 0) { throw "v3-sign-win32: signtool sign failed (exit $LASTEXITCODE) on batch starting at index $i" }
}

# --- verify every signature ----------------------------------------------------
Log 'Verifying signatures (signtool verify /pa)'
foreach ($t in $targets) {
	& $signtool.FullName verify /pa /q $t
	if ($LASTEXITCODE -ne 0) { throw "v3-sign-win32: signature verification FAILED for $t" }
}
Log "DONE — $($targets.Count) file(s) signed and verified."
