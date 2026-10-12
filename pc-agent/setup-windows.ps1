<#
  Hearth PC agent: install, repair and update in one script.

  First time, in PowerShell (it asks for administrator rights itself):

    git clone -b claude/eager-ptolemy-skr759 https://github.com/Kuillemaul/TV-FrontEnd.git $env:TEMP\hearth-setup
    & $env:TEMP\hearth-setup\pc-agent\setup-windows.ps1

  What it does:
    - installs Git and Python with winget if they're missing
    - puts Hearth in C:\Hearth (a folder unpacked from a ZIP is turned into a proper copy in place)
    - keeps your agent.json, repairs common mistakes in it, and adds settings from newer versions
    - installs/updates the Playnite extension
    - starts the agent when you log in, and opens its port in the firewall
    - checks for updates every night at 4am (and restarts the agent only when something changed)
    - prints what to put in the TV's config.yaml

  Run it again any time to update or repair. Nightly updates are logged to %LOCALAPPDATA%\Hearth\update.log.
#>
param(
  [string]$InstallDir = 'C:\Hearth',
  [string]$Branch = 'claude/eager-ptolemy-skr759',
  [string]$Repo = 'https://github.com/Kuillemaul/TV-FrontEnd.git',
  # Quiet nightly mode, used by the "Hearth Agent Update" scheduled task.
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Hearth Agent'
$UpdateTaskName = 'Hearth Agent Update'

function Say([string]$Message, [string]$Color = 'Gray') {
  if ($Update) { Write-Output "$(Get-Date -Format s) $Message" } else { Write-Host $Message -ForegroundColor $Color }
}

# ---------------------------------------------------------------- administrator
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($Update) { throw 'The update task must run with highest privileges.' }
  Write-Host 'Asking for administrator rights...'
  $argList = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" -InstallDir `"$InstallDir`" -Branch `"$Branch`" -Repo `"$Repo`""
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  return
}

if ($Update) {
  $logDir = Join-Path $env:LOCALAPPDATA 'Hearth'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Transcript -Path (Join-Path $logDir 'update.log') -Append | Out-Null
}

try {
  # ---------------------------------------------------------------- tools
  function Update-PathFromSystem {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }

  function Install-WithWinget([string]$Id, [string]$Name) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw "$Name isn't installed and winget isn't available. Install $Name yourself, then run this again."
    }
    Say "Installing $Name..." 'Cyan'
    winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Update-PathFromSystem
  }

  # Runs git without PowerShell turning its progress messages (stderr) into errors.
  function Invoke-Git {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & git @args 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    if ($code -ne 0) { throw "git $($args -join ' ') failed:`n$($out -join "`n")" }
    return $out
  }

  # The real python.exe (not the Microsoft Store shortcut that only opens the Store).
  function Find-Python {
    foreach ($candidate in @(@('py', '-3'), @('python'))) {
      $exe = $candidate[0]
      if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
      try {
        $rest = @($candidate | Select-Object -Skip 1)
        $path = & $exe @rest -c 'import sys; print(sys.executable)' 2>$null
        if ($LASTEXITCODE -eq 0 -and $path -and (Test-Path $path) -and $path -notmatch 'WindowsApps') { return "$path".Trim() }
      } catch { }
    }
    return $null
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-WithWinget 'Git.Git' 'Git' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git still not found. Close this window, open a new PowerShell and run the script again.' }
  $python = Find-Python
  if (-not $python) {
    Install-WithWinget 'Python.Python.3.12' 'Python'
    $python = Find-Python
  }
  if (-not $python) { throw 'Python still not found. Close this window, open a new PowerShell and run the script again.' }
  $pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
  if (-not (Test-Path $pythonw)) { $pythonw = $python }

  # ---------------------------------------------------------------- stop the running agent
  function Stop-Agent {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" |
      Where-Object { $_.CommandLine -like '*hearth_agent.py*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }

  # ---------------------------------------------------------------- get / update the code
  $changed = $false
  if (Test-Path (Join-Path $InstallDir '.git')) {
    $before = (Invoke-Git -C $InstallDir rev-parse HEAD | Select-Object -Last 1)
    Invoke-Git -C $InstallDir fetch origin $Branch | Out-Null
    $after = (Invoke-Git -C $InstallDir rev-parse "origin/$Branch" | Select-Object -Last 1)
    if ($before -ne $after) {
      Say 'Updating Hearth...' 'Cyan'
      Stop-Agent
      # Only Hearth's own files change; agent.json and other files you added are left alone.
      Invoke-Git -C $InstallDir checkout -f -B $Branch "origin/$Branch" | Out-Null
      $changed = $true
    } else {
      Say 'Hearth is up to date.'
    }
  } elseif (Test-Path $InstallDir) {
    # A folder from a ZIP download: turn it into a git copy where it is (no renaming needed).
    Say "Converting $InstallDir to an updatable copy..." 'Cyan'
    Stop-Agent
    Invoke-Git -C $InstallDir init | Out-Null
    $remotes = @(Invoke-Git -C $InstallDir remote)
    if ($remotes -contains 'origin') { Invoke-Git -C $InstallDir remote set-url origin $Repo | Out-Null }
    else { Invoke-Git -C $InstallDir remote add origin $Repo | Out-Null }
    Invoke-Git -C $InstallDir fetch origin $Branch | Out-Null
    Invoke-Git -C $InstallDir checkout -f -B $Branch "origin/$Branch" | Out-Null
    Invoke-Git -C $InstallDir branch -u "origin/$Branch" | Out-Null
    $changed = $true
  } else {
    Say "Downloading Hearth to $InstallDir..." 'Cyan'
    Invoke-Git clone -b $Branch $Repo $InstallDir | Out-Null
    $changed = $true
  }

  $agentDir = Join-Path $InstallDir 'pc-agent'
  $agentPy = Join-Path $agentDir 'hearth_agent.py'
  $agentJson = Join-Path $agentDir 'agent.json'

  # ---------------------------------------------------------------- agent.json
  $notes = & $python $agentPy --config $agentJson --upgrade-config 2>&1 | ForEach-Object { "$_" }
  $configOk = ($LASTEXITCODE -eq 0)
  $token = ($notes | Where-Object { $_ -like 'TOKEN=*' } | Select-Object -First 1) -replace '^TOKEN=', ''
  foreach ($line in $notes) { if ($line -notlike 'TOKEN=*') { Say "agent.json: $line" $(if ($configOk) { 'Gray' } else { 'Red' }) } }
  if ($notes -match 'Created agent.json|Made a new token') { $changed = $true }

  # ---------------------------------------------------------------- Playnite extension
  $playnite = Join-Path $env:APPDATA 'Playnite'
  if (Test-Path $playnite) {
    $target = Join-Path $playnite 'Extensions\HearthExporter'
    $source = Join-Path $agentDir 'playnite\HearthExporter'
    $fresh = -not (Test-Path $target)
    if ($fresh -or $changed) {
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      try {
        Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
        Say $(if ($fresh) { 'Installed the Playnite extension (restart Playnite to load it).' } else { 'Updated the Playnite extension.' })
      } catch {
        Say "Couldn't update the Playnite extension while Playnite is open: $($_.Exception.Message)" 'Yellow'
      }
    }
  }

  # ---------------------------------------------------------------- scheduled tasks & firewall
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$agentPy`" --config `"$agentJson`"" -WorkingDirectory $agentDir
  # Must run in your desktop session (not as a service), or games won't appear on screen for Apollo.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $user -RunLevel Highest -Force | Out-Null

  $updAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agentDir\setup-windows.ps1`" -Update -InstallDir `"$InstallDir`" -Branch `"$Branch`""
  $updTrigger = New-ScheduledTaskTrigger -Daily -At 4am
  $updSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $UpdateTaskName -Action $updAction -Trigger $updTrigger -Settings $updSettings -User $user -RunLevel Highest -Force | Out-Null

  if (-not (Get-NetFirewallRule -DisplayName 'Hearth Agent' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Hearth Agent' -Direction Inbound -Protocol TCP -LocalPort 47800 -Action Allow -Profile Private, Domain | Out-Null
  }

  # ---------------------------------------------------------------- (re)start and check
  $running = Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" | Where-Object { $_.CommandLine -like '*hearth_agent.py*' }
  if ($changed -or -not $running) {
    Stop-Agent
    Start-ScheduledTask -TaskName $TaskName
  }
  if (-not $configOk) {
    Say 'Fix agent.json (see above) and run this script again.' 'Red'
    return
  }

  $port = 47800
  try { $port = [int]((Get-Content $agentJson -Raw | ConvertFrom-Json).port) } catch { }
  if (-not $port) { $port = 47800 }
  $health = $null
  foreach ($i in 1..10) {
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
  }
  if ($health) { Say "Hearth agent is running on port $port." 'Green' }
  else { Say "The agent didn't answer. Run this to see why:  & '$python' '$agentPy' --config '$agentJson'" 'Yellow' }

  if (-not $Update) {
    $net = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    $ip = if ($net) { $net.IPv4Address.IPAddress } else { 'THIS-PC-IP' }
    $mac = if ($net) { ($net.NetAdapter.MacAddress -replace '-', ':') } else { 'AA:BB:CC:DD:EE:FF' }
    $id = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9]+', '-')
    Write-Host ''
    Write-Host 'Done. On the TV, this PC goes under gaming: hosts: in config.yaml:' -ForegroundColor Green
    Write-Host ''
    Write-Host "    - id: $id"
    Write-Host "      name: $env:COMPUTERNAME"
    Write-Host "      agent: http://${ip}:$port"
    Write-Host "      token: `"$token`""
    Write-Host "      moonlightHost: $ip"
    Write-Host '      moonlightApp: Desktop'
    Write-Host "      mac: `"$mac`""
    Write-Host '      virtualDisplay: true'
    Write-Host ''
    Write-Host 'Updates install by themselves every night. Run this script again any time to update now.'
    Write-Host "Check your games:  cd $agentDir; python hearth_agent.py --config agent.json --list"
  }
} catch {
  Say "Setup failed: $($_.Exception.Message)" 'Red'
  if ($Update) { exit 1 }
} finally {
  if ($Update) { Stop-Transcript | Out-Null }
}
