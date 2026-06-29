$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$PidFile = Join-Path $RuntimeDir "imagebot-gateway.pid"
$WatchdogPidFile = Join-Path $RuntimeDir "imagebot-gateway-watchdog.pid"
$LogPathFile = Join-Path $RuntimeDir "imagebot-gateway.logpath"
$StateFile = Join-Path $RuntimeDir "imagebot-gateway.state.json"

function Get-LogPath {
  $saved = ""
  if (Test-Path -LiteralPath $LogPathFile) {
    $saved = ([string](Get-Content -LiteralPath $LogPathFile -Raw -ErrorAction SilentlyContinue)).Trim()
  }

  if ($saved -and (Test-Path -LiteralPath $saved)) {
    try {
      $resolved = (Resolve-Path -LiteralPath $saved).Path
      $rootResolved = (Resolve-Path -LiteralPath $Root).Path
      $tempLogDir = Join-Path $env:LOCALAPPDATA "Temp\openclaw"
      $tempResolved = if (Test-Path -LiteralPath $tempLogDir) { (Resolve-Path -LiteralPath $tempLogDir).Path } else { "" }
      if ($resolved.StartsWith($rootResolved, [System.StringComparison]::OrdinalIgnoreCase) -or
        ($tempResolved -and $resolved.StartsWith($tempResolved, [System.StringComparison]::OrdinalIgnoreCase))) {
        return $resolved
      }
    }
    catch {
    }
  }

  $latest = @(Get-ChildItem -LiteralPath (Join-Path $Root "logs") -Filter "imagebot-gateway-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1)
  if ($latest.Count -gt 0) {
    return [string]$latest[0].FullName
  }
  return ""
}

if (Test-Path -LiteralPath $StateFile) {
  try {
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    Write-Host "Watchdog state: $($state.state)"
    if ($null -ne $state.lastExitCode) {
      Write-Host "Last exit code: $($state.lastExitCode)"
    }
    if ($state.message) {
      Write-Host "Watchdog message: $($state.message)"
    }
    if ($state.restartCount) {
      Write-Host "Restart count: $($state.restartCount)/$($state.maxRestarts)"
    }
  }
  catch {
    Write-Host "Watchdog state: unreadable"
  }
}
else {
  Write-Host "Watchdog state: none"
}

if (Test-Path -LiteralPath $WatchdogPidFile) {
  $watchdogPid = Get-Content -LiteralPath $WatchdogPidFile -ErrorAction SilentlyContinue
  Write-Host "Saved watchdog PID: $watchdogPid"
  if ($watchdogPid -match "^\d+$") {
    $watchdogProc = Get-Process -Id ([int]$watchdogPid) -ErrorAction SilentlyContinue
    if ($watchdogProc) {
      Write-Host "Watchdog process: running ($($watchdogProc.ProcessName))"
    }
    else {
      Write-Host "Watchdog process: not running"
    }
  }
}
else {
  Write-Host "Saved watchdog PID: none"
}

if (Test-Path -LiteralPath $PidFile) {
  $pidValue = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
  Write-Host "Saved gateway PID: $pidValue"
  if ($pidValue -match "^\d+$") {
    $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "Gateway process: running ($($proc.ProcessName))"
    }
    else {
      Write-Host "Gateway process: not running"
    }
  }
}
else {
  Write-Host "Saved gateway PID: none"
}

$logPath = Get-LogPath
if ($logPath) {
  Write-Host "Current/last log: $logPath"
}
else {
  Write-Host "Current/last log: none"
}

Write-Host ""
Write-Host "OpenClaw CLI gateway status follows. Note: an upstream 'Runtime: stopped' line can refer to the optional OpenClaw service/runtime state, not this launcher-managed gateway. Trust the saved gateway PID, listener, and connectivity probe above for this desktop launcher."
openclaw gateway status
