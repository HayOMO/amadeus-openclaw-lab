param(
  [string]$TaskName = "Amaduse Imagebot Memory Curator",
  [string]$DailyTime = "04:30",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Curator = Join-Path $Root "scripts\CONSOLIDATE_IMAGEBOT_MEMORY.ps1"

if ($Remove) {
  schtasks /Delete /TN $TaskName /F | Out-Host
  exit $LASTEXITCODE
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Curator`" -CloseWindows -RestartGatewayAfterClose"

schtasks /Create /SC DAILY /TN $TaskName /TR $taskCommand /ST $DailyTime /F | Out-Host
if ($LASTEXITCODE -eq 0) {
  Write-Host "Installed daily imagebot memory curator task: $TaskName at $DailyTime"
  Write-Host "Command: $taskCommand"
}
exit $LASTEXITCODE
