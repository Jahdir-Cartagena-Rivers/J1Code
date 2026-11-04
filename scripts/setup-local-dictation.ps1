param([string]$Destination = "$env:LOCALAPPDATA/J1Code/voice")
$ErrorActionPreference = 'Stop'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw 'Install uv from https://docs.astral.sh/uv/getting-started/installation/ then rerun this script.'
}
$python = Join-Path $Destination 'venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  uv venv --python 3.12 "$Destination/venv"
  if ($LASTEXITCODE -ne 0) { throw 'Could not create dictation environment.' }
}
uv pip install --python $python faster-whisper==1.2.1 sounddevice==0.5.3 av==16.1.0
if ($LASTEXITCODE -ne 0) { throw 'Could not install dictation dependencies.' }
@'
from huggingface_hub import snapshot_download
import sys
snapshot_download("Systran/faster-whisper-small.en", revision="d1d751a5f8271d482d14ca55d9e2deeebbae577f", local_dir=sys.argv[1])
'@ | & $python - "$Destination/model"
if ($LASTEXITCODE -ne 0) { throw 'Could not download dictation model.' }
Write-Output "Local dictation is ready in $Destination. Restart J1 Code to use it."

