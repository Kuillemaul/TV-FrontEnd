# Older name for the installer: everything now lives in setup-windows.ps1 (install, repair, nightly updates).
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
#
& (Join-Path $PSScriptRoot 'setup-windows.ps1') -InstallDir (Split-Path $PSScriptRoot -Parent) @args
