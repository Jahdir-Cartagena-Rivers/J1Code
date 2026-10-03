param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Prepare', 'Verify')]
  [string]$Action,
  [string]$ReleaseDirectory = 'release'
)

$ErrorActionPreference = 'Stop'

if ($Action -eq 'Prepare') {
  $required = @(
    'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
    'AZURE_TRUSTED_SIGNING_ENDPOINT', 'AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
    'AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME', 'AZURE_TRUSTED_SIGNING_PUBLISHER_NAME'
  )
  $missing = @($required | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
  })
  if ($missing.Count) {
    throw "Signing is enabled but repository secrets are missing: $($missing -join ', ')"
  }
  Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -AllowClobber -Repository PSGallery -Scope CurrentUser
  Import-Module TrustedSigning -MinimumVersion 0.5.0 -Force
  Get-Command Invoke-TrustedSigning -ErrorAction Stop | Out-Null
  # electron-builder starts Windows PowerShell, whose default module path differs from pwsh.
  $moduleRoots = @(
    [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'PowerShell', 'Modules'),
    [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'WindowsPowerShell', 'Modules')
  )
  $modulePaths = @($moduleRoots + ($env:PSModulePath -split ';')) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  "PSModulePath=$($modulePaths -join ';')" >> $env:GITHUB_ENV
  exit 0
}

$installers = @(Get-ChildItem -LiteralPath $ReleaseDirectory -Filter 'J1-Code-*.exe' -File)
$applications = @(Get-ChildItem -LiteralPath (Join-Path $ReleaseDirectory 'win-unpacked') -Filter 'J1 Code*.exe' -File)
if ($installers.Count -ne 1 -or $applications.Count -ne 1) {
  throw 'Expected exactly one J1 installer and one unpacked J1 application for signature verification.'
}
foreach ($file in @($installers + $applications)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or !$signature.TimeStamperCertificate) {
    throw "Missing valid timestamped Authenticode signature: $($file.Name) ($($signature.Status))"
  }
  Write-Host "Verified timestamped Authenticode signature: $($file.Name)"
}
