param([Parameter(Mandatory)][string]$Candidate)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'The installer rehearsal requires a disposable GitHub-hosted Windows runner.'
}

$candidateInstaller = (Get-Item -LiteralPath $Candidate).FullName
$qa = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP "j1-upgrade-$env:GITHUB_RUN_ATTEMPT")
$installDir = Join-Path $env:LOCALAPPDATA 'Programs/j1-upgrade-qa'
$installedExe = Join-Path $installDir 'J1 Code.exe'
$j1Data = Join-Path $qa.FullName 'j1'
$userdata = New-Item -ItemType Directory -Path (Join-Path $j1Data 'userdata')
$env:T3CODE_HOME = $j1Data
$env:T3CODE_DISABLE_AUTO_UPDATE = 'true'
$env:T3CODE_TELEMETRY_ENABLED = 'false'

$baselineName = 'J1-Code-1.101.0-windows-x64-setup.exe'
$sumsName = 'SHA256SUMS-1.101.0.txt'
gh release download v1.101.0 --repo $env:GITHUB_REPOSITORY --pattern $baselineName --pattern $sumsName --dir $qa.FullName
if ($LASTEXITCODE -ne 0) { throw 'Could not download the published baseline installer.' }
$baseline = Join-Path $qa.FullName $baselineName
$checksums = Get-Content -LiteralPath (Join-Path $qa.FullName $sumsName)
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
