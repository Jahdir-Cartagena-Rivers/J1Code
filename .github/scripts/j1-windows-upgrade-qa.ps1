param(
  [Parameter(Mandatory)][string]$Candidate,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedCandidateSha256,
  [string]$BaselineDirectory,
  [switch]$VerifyCandidateOnly
)

$ErrorActionPreference = 'Stop'
$candidateFile = Get-Item -LiteralPath $Candidate
if ($candidateFile.PSIsContainer -or $candidateFile.Extension -ne '.exe') {
  throw 'The candidate must be a Windows installer executable.'
}
$candidateInstaller = $candidateFile.FullName
$candidateSha256 = (Get-FileHash -LiteralPath $candidateInstaller -Algorithm SHA256).Hash
if ($candidateSha256 -ne $ExpectedCandidateSha256) {
  throw 'Candidate installer SHA-256 did not match the build receipt.'
}
Write-Host "Verified candidate installer SHA-256: $candidateSha256"
if ($VerifyCandidateOnly) { return }

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'The installer rehearsal requires a disposable GitHub-hosted Windows runner.'
}

$qa = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP "j1-upgrade-$env:GITHUB_RUN_ATTEMPT")
$installDir = Join-Path $env:LOCALAPPDATA 'Programs/j1-upgrade-qa'
$installedExe = Join-Path $installDir 'J1 Code.exe'
$j1Data = Join-Path $qa.FullName 'j1'
$userdata = New-Item -ItemType Directory -Path (Join-Path $j1Data 'userdata')
$env:T3CODE_HOME = $j1Data
$env:T3CODE_DISABLE_AUTO_UPDATE = 'true'
$env:T3CODE_TELEMETRY_ENABLED = 'false'

$highlights = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../release-highlights.json') -Raw | ConvertFrom-Json
$baselineTag = $highlights.since
if ($baselineTag -notmatch '^v1[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$') {
  throw 'The release highlights must identify a published Windows upgrade baseline.'
}
$baselineVersion = $baselineTag.Substring(1)
$baselineName = "J1-Code-$baselineVersion-windows-x64-setup.exe"
$sumsName = "SHA256SUMS-$baselineVersion.txt"
Write-Host "Upgrade baseline: $baselineTag"
if (!$BaselineDirectory) {
  $BaselineDirectory = $qa.FullName
  gh release download $baselineTag --repo $env:GITHUB_REPOSITORY --pattern $baselineName --pattern $sumsName --dir $BaselineDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Could not download the published baseline installer.' }
}
$baseline = Join-Path $BaselineDirectory $baselineName
$checksums = Get-Content -LiteralPath (Join-Path $BaselineDirectory $sumsName)
$expectedLine = $checksums | Where-Object { ($_ -split '\s+', 2)[-1].TrimStart('*') -eq $baselineName }
if (@($expectedLine).Count -ne 1 -or (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash -ne ($expectedLine -split '\s+')[0]) {
  throw 'Baseline installer SHA-256 did not match the published checksum.'
}

function Install-J1([string]$Installer) {
  $process = Start-Process -FilePath $Installer -ArgumentList "/S /currentuser /D=$installDir" -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $installedExe -PathType Leaf)) {
    throw "J1 setup did not install the expected executable. Exit: $($process.ExitCode)."
  }
}

Install-J1 $baseline
$before = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
Copy-Item -LiteralPath 'scripts/fixtures/desktop-launch/statev2.sqlite' -Destination $userdata.FullName
$settings = Join-Path $userdata.FullName 'client-settings.json'
Set-Content -LiteralPath $settings -Value '{"onboardingCompletedAt":"2026-01-01T00:00:00.000Z","wordWrap":false}'
$snapshot = Join-Path $userdata.FullName 'statev2.sqlite'
$settingsHash = (Get-FileHash -LiteralPath $settings -Algorithm SHA256).Hash
$chatHash = (Get-FileHash -LiteralPath $snapshot -Algorithm SHA256).Hash

Install-J1 $candidateInstaller
if ((Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash -eq $before) {
  throw 'Setup did not replace the baseline executable.'
}
if ((Get-FileHash -LiteralPath $settings -Algorithm SHA256).Hash -ne $settingsHash -or
    (Get-FileHash -LiteralPath $snapshot -Algorithm SHA256).Hash -ne $chatHash) {
  throw 'The installer changed the saved database or client settings.'
}
Write-Host 'Both NSIS installers ran against the same installation. Chat and settings bytes survived.'
node scripts/smoke-desktop-app.ts --executable $installedExe --existing-data-dir $j1Data --artifacts-dir (Join-Path $qa.FullName 'smoke')
if ($LASTEXITCODE -ne 0) { throw 'The installed candidate did not reopen the saved profile.' }
