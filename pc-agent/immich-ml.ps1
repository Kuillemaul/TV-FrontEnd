# Run Immich's machine learning (face recognition, smart search, OCR) on this PC's NVIDIA GPU, for an
# Immich running somewhere else (e.g. on the Hearth TV). Then in Hearth: Settings → Connections →
# Immich → "Face recognition runs on" → this PC.
#
#   Needs: Docker Desktop (WSL 2 backend, the default) and a current NVIDIA driver. Docker Desktop
#   passes the GPU through to Linux containers on its own; no extra toolkit is needed on Windows.
#
#   powershell -ExecutionPolicy Bypass -File C:\Hearth\pc-agent\immich-ml.ps1
#   powershell -ExecutionPolicy Bypass -File C:\Hearth\pc-agent\immich-ml.ps1 -Remove
#
# It starts with Docker Desktop (restart: unless-stopped), unloads its models after 5 idle minutes
# (so the GPU's memory is free for games), and Hearth pauses Immich's jobs while you play on this PC.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'immich-ml'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker Desktop isn''t installed. Get it from https://www.docker.com/products/docker-desktop/, start it once, then run this again.' -ForegroundColor Yellow
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker Desktop isn''t running. Start it (and tick "Start Docker Desktop when you sign in"), then run this again.' -ForegroundColor Yellow
  exit 1
}

docker rm -f $name *> $null
if ($Remove) {
  Remove-NetFirewallRule -DisplayName 'Immich machine learning' -ErrorAction SilentlyContinue
  Write-Host 'Removed.'
  exit 0
}

Write-Host 'Downloading Immich machine learning (CUDA, a few GB the first time)...'
docker pull ghcr.io/immich-app/immich-machine-learning:release-cuda
docker run -d --name $name --restart unless-stopped --gpus all -p 3003:3003 `
  -e MACHINE_LEARNING_MODEL_TTL=300 `
  -v immich-ml-cache:/cache `
  ghcr.io/immich-app/immich-machine-learning:release-cuda | Out-Null

# Let the TV reach it on the home network.
if (-not (Get-NetFirewallRule -DisplayName 'Immich machine learning' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Immich machine learning' -Direction Inbound -Protocol TCP -LocalPort 3003 -Profile Private -Action Allow | Out-Null
}

# Wait for it to answer.
for ($i = 0; $i -lt 60; $i++) {
  try {
    if ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3003/ping' -TimeoutSec 2).Content -match 'pong') {
      $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
      Write-Host "Ready: http://${ip}:3003" -ForegroundColor Green
      Write-Host 'In Hearth: Settings → Connections → Immich → Face recognition runs on → this PC.'
      exit 0
    }
  } catch { }
  Start-Sleep -Seconds 2
}
Write-Host 'Started, but it isn''t answering yet. Check: docker logs immich-ml' -ForegroundColor Yellow
