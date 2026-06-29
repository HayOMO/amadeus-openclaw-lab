param(
  [switch]$Fast
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$PidFile = Join-Path $RuntimeDir "imagebot-gateway.pid"
$WatchdogPidFile = Join-Path $RuntimeDir "imagebot-gateway-watchdog.pid"
$LogPathFile = Join-Path $RuntimeDir "imagebot-gateway.logpath"
$StopFile = Join-Path $RuntimeDir "imagebot-gateway.stop"
$StateFile = Join-Path $RuntimeDir "imagebot-gateway.state.json"

New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
Set-Content -LiteralPath $StopFile -Value (Get-Date).ToString("o") -NoNewline

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

function Write-GatewayState {
  param([string]$State, [string]$Message = "")

  $logPath = Get-LogPath

  $watchdogPidText = ""
  if (Test-Path -LiteralPath $WatchdogPidFile) {
    $watchdogPidText = ([string](Get-Content -LiteralPath $WatchdogPidFile -Raw -ErrorAction SilentlyContinue)).Trim()
  }

  $payload = [ordered]@{
    state = $State
    restartCount = 0
    maxRestarts = 3
    lastExitCode = $null
    message = $Message
    logPath = $logPath
    watchdogPid = $watchdogPidText
    updatedAt = (Get-Date).ToString("o")
    nextRestartAt = $null
  }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $ProcessId })
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }

  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Host "Stopping PID $ProcessId ($($proc.ProcessName))"
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-PortOwnerPids {
  try {
    return @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  }
  catch {
    return @()
  }
}

function Get-LivePid {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }

  $raw = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue)) {
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
      return $pidValue
    }
  }
  return 0
}

$initialPortOwners = @(Get-PortOwnerPids)
$watchdogPid = Get-LivePid -Path $WatchdogPidFile
$stoppedSomething = ($initialPortOwners.Count -gt 0 -or $watchdogPid -gt 0)

if ($initialPortOwners.Count -gt 0) {
  Write-Host "Gateway port was listening. Owner PID(s): $($initialPortOwners -join ', ')"
}

try {
  & openclaw gateway stop *> $null
}
catch {
}

if (Test-Path -LiteralPath $PidFile) {
  $raw = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue)) {
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
      Stop-ProcessTree -ProcessId $pidValue
      $stoppedSomething = $true
    }
  }
  try {
    if (Test-Path -LiteralPath $PidFile) {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction Stop
    }
  }
  catch {
  }
}

foreach ($ownerPid in Get-PortOwnerPids) {
  $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
  $cmd = if ($procInfo) { [string]$procInfo.CommandLine } else { "" }
  if ($cmd -match "openclaw|openclaw\.mjs|gateway") {
    Stop-ProcessTree -ProcessId ([int]$ownerPid)
    $stoppedSomething = $true
  }
  else {
    Write-Warning "Port 18789 is owned by PID $ownerPid, but it does not look like OpenClaw. Left it running."
  }
}

$watchdogPid = Get-LivePid -Path $WatchdogPidFile
if ($watchdogPid -gt 0) {
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline -and (Get-LivePid -Path $WatchdogPidFile) -gt 0) {
    Start-Sleep -Milliseconds 500
  }

  $watchdogPid = Get-LivePid -Path $WatchdogPidFile
  if ($watchdogPid -gt 0) {
    Write-Host "Stopping gateway watchdog PID $watchdogPid"
    Stop-ProcessTree -ProcessId $watchdogPid
  }
}

Start-Sleep -Seconds 1

if ($stoppedSomething -and ((Get-PortOwnerPids).Count -eq 0)) {
  Write-Host "Gateway listener stopped."
}
elseif (-not $stoppedSomething) {
  Write-Host "No running imagebot gateway process was found."
}

try {
  if (Test-Path -LiteralPath $WatchdogPidFile) {
    Remove-Item -LiteralPath $WatchdogPidFile -Force -ErrorAction Stop
  }
}
catch {
}
Write-GatewayState -State "stopped" -Message "Gateway stopped by user request."

if (Test-Path -LiteralPath $LogPathFile) {
  Write-Host "Last log: $(Get-LogPath)"
}

if (-not $Fast) {
  openclaw gateway status
}
