$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'j1-windows-signing.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$unpacked = Join-Path $fixture 'win-unpacked'
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
$installer = Join-Path $fixture 'J1-Code-example-windows-x64-setup.exe'
$application = Join-Path $unpacked 'J1 Code.exe'

function Expect-Rejection([scriptblock]$Operation, [string]$Expected) {
  try { & $Operation } catch {
    if ($_.Exception.Message -notlike "*$Expected*") { throw }
    return
  }
  throw "Expected rejection: $Expected"
}

# Exercise the verification gate with synthetic signature results; no certificate or signing service is used.
function Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  return $global:j1SigningTestFixture
}

try {
  $savedClientSecret = $env:AZURE_CLIENT_SECRET
  try {
    $env:AZURE_CLIENT_SECRET = ''
    Expect-Rejection { & $scriptPath -Action Prepare } 'repository secrets are missing'
  } finally { $env:AZURE_CLIENT_SECRET = $savedClientSecret }
  Expect-Rejection { & $scriptPath -Action Verify -ReleaseDirectory $fixture } 'exactly one'
  [IO.File]::WriteAllText($installer, 'synthetic installer')
  [IO.File]::WriteAllText($application, 'synthetic application')
  $global:j1SigningTestFixture = @{ Status = 'NotSigned'; SignerCertificate = $null; TimeStamperCertificate = $null }
  Expect-Rejection { & $scriptPath -Action Verify -ReleaseDirectory $fixture } 'NotSigned'
  $global:j1SigningTestFixture = @{ Status = 'Valid'; SignerCertificate = @{ Subject = 'Example' }; TimeStamperCertificate = $null }
  Expect-Rejection { & $scriptPath -Action Verify -ReleaseDirectory $fixture } 'timestamped'
  $global:j1SigningTestFixture.TimeStamperCertificate = @{ Subject = 'Example timestamp' }
  & $scriptPath -Action Verify -ReleaseDirectory $fixture
  $portable = Join-Path $fixture 'J1-Code-example-windows-x64-portable.exe'
  [IO.File]::WriteAllText($portable, 'synthetic portable')
  Remove-Item -LiteralPath $installer
  & $scriptPath -Action Verify -ReleaseDirectory $fixture
  Remove-Item -LiteralPath $portable
  [IO.File]::WriteAllText($installer, 'synthetic installer')
  $duplicate = Join-Path $fixture 'J1-Code-duplicate-setup.exe'
  [IO.File]::WriteAllText($duplicate, 'synthetic duplicate')
  Expect-Rejection { & $scriptPath -Action Verify -ReleaseDirectory $fixture } 'exactly one'
  Write-Host 'Windows signing gate: 7 scenarios passed (synthetic fixtures).'
} finally {
  Remove-Variable -Name j1SigningTestFixture -Scope Global -ErrorAction SilentlyContinue
  # Delete only the exact disposable files created above, without recursive deletion.
  foreach ($file in @($installer, $application, $duplicate, $portable)) {
    if ($file -and (Test-Path -LiteralPath $file)) { Remove-Item -LiteralPath $file }
  }
  Remove-Item -LiteralPath $unpacked
  Remove-Item -LiteralPath $fixture
}
