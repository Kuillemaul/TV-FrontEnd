# Registers the Hearth agent to start when you log in (it must run in your desktop
# session, not as a service, or launched games won't appear on screen for Sunshine).
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
#
param(
  [string]$Python = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Python) { throw 'Python 3.9+ not found. Install it from python.org (tick "Add to PATH").' }
if (-not (Test-Path "$here\agent.json")) {
  Copy-Item "$here\agent.example.json" "$here\agent.json"
  $token = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  (Get-Content "$here\agent.json") -replace '"change-me"', "`"$token`"" | Set-Content "$here\agent.json"
  Write-Host "Created agent.json with token: $token  (put this in the TV's config.yaml)"
}

$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$here\hearth_agent.py`" --config `"$here\agent.json`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Hearth Agent' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

New-NetFirewallRule -DisplayName 'Hearth Agent' -Direction Inbound -Protocol TCP -LocalPort 47800 -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null
Start-ScheduledTask -TaskName 'Hearth Agent'
Write-Host 'Hearth agent installed and started on port 47800.'
