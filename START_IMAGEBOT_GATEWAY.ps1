param(
  [switch]$Fast,
  [switch]$SkipPrewarm
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $RuntimeDir "imagebot-gateway.pid"
$WatchdogPidFile = Join-Path $RuntimeDir "imagebot-gateway-watchdog.pid"
$LogPathFile = Join-Path $RuntimeDir "imagebot-gateway.logpath"
$StopFile = Join-Path $RuntimeDir "imagebot-gateway.stop"
$StateFile = Join-Path $RuntimeDir "imagebot-gateway.state.json"
$Runner = Join-Path $Root "RUN_IMAGEBOT_GATEWAY.ps1"
$PrewarmScript = Join-Path $Root "PREWARM_IMAGEBOT_CODEX.ps1"
$MemoryPrewarmScript = Join-Path $Root "PREWARM_IMAGEBOT_MEMORY.ps1"
$BrowserPrewarmScript = Join-Path $Root "PREWARM_IMAGEBOT_BROWSER.ps1"

New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null

function Get-LatestGatewayLogPath {
  $candidates = @()

  function Test-UsableLogPath {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate) -or -not (Test-Path -LiteralPath $Candidate)) {
      return $false
    }

    try {
      $resolved = (Resolve-Path -LiteralPath $Candidate).Path
      $rootResolved = (Resolve-Path -LiteralPath $Root).Path
      $tempLogDir = Join-Path $env:LOCALAPPDATA "Temp\openclaw"
      $tempResolved = if (Test-Path -LiteralPath $tempLogDir) { (Resolve-Path -LiteralPath $tempLogDir).Path } else { "" }
      return $resolved.StartsWith($rootResolved, [System.StringComparison]::OrdinalIgnoreCase) -or
        ($tempResolved -and $resolved.StartsWith($tempResolved, [System.StringComparison]::OrdinalIgnoreCase))
    }
    catch {
      return $false
    }
  }

  try {
    if (Test-Path -LiteralPath $LogPathFile) {
      $saved = [string](Get-Content -LiteralPath $LogPathFile -Raw -ErrorAction SilentlyContinue)
      $saved = $saved.Trim()
      if (Test-UsableLogPath -Candidate $saved) {
        $item = Get-Item -LiteralPath $saved -ErrorAction SilentlyContinue
        if ($item) {
          $candidates += $item
        }
      }
    }
  }
  catch {
  }

  try {
    $candidates += @(Get-ChildItem -LiteralPath $LogDir -Filter "imagebot-gateway-*.log" -ErrorAction SilentlyContinue)
  }
  catch {
  }

  try {
    $tempLogDir = Join-Path $env:LOCALAPPDATA "Temp\openclaw"
    $candidates += @(Get-ChildItem -LiteralPath $tempLogDir -Filter "openclaw-*.log" -ErrorAction SilentlyContinue)
  }
  catch {
  }

  $latest = @($candidates | Where-Object { $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  if ($latest.Count -gt 0) {
    return [string]$latest[0].FullName
  }

  if (Test-Path -LiteralPath $LogPathFile) {
    return ([string](Get-Content -LiteralPath $LogPathFile -Raw -ErrorAction SilentlyContinue)).Trim()
  }

  return ""
}

function Write-GatewayState {
  param(
    [string]$State,
    [string]$Message = "",
    [string]$GatewayPid = ""
  )

  try {
    $logPath = Get-LatestGatewayLogPath
    if ($logPath) {
      Set-Content -LiteralPath $LogPathFile -Value $logPath -NoNewline
    }

    $payload = [ordered]@{
      state = $State
      restartCount = 0
      maxRestarts = 3
      lastExitCode = $null
      message = $Message
      logPath = $logPath
      watchdogPid = ""
      updatedAt = (Get-Date).ToString("o")
      nextRestartAt = $null
      pid = $GatewayPid
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  }
  catch {
  }
}

function Test-GatewayReady {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:18789/" -UseBasicParsing -TimeoutSec 1 | Out-Null
    return $true
  }
  catch {
    return $false
  }
}

function Test-GatewayPortListening {
  try {
    $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue)
    return ($listeners.Count -gt 0)
  }
  catch {
    return $false
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

function Wait-ForGatewayReady {
  param([int]$Seconds)

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-GatewayReady) {
      return $true
    }
  }
  return $false
}

function Invoke-ImagebotPrewarm {
  if ($SkipPrewarm) {
    Write-Host "Skipping Codex prewarm."
    return
  }

  if (-not (Test-Path -LiteralPath $PrewarmScript)) {
    Write-Warning "Prewarm script missing: $PrewarmScript"
    return
  }

  Write-Host "Warming Codex runtime..."
  & $PrewarmScript -Fast:$Fast -SoftFail
}

function Start-ImagebotMemoryPrewarm {
  if ($SkipPrewarm) {
    Write-Host "Skipping memory prewarm."
    return
  }

  if (-not (Test-Path -LiteralPath $MemoryPrewarmScript)) {
    Write-Warning "Memory prewarm script missing: $MemoryPrewarmScript"
    return
  }

  Write-Host "Warming memory semantic index in background..."
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $MemoryPrewarmScript, "-Fast", "-SoftFail") `
    -WindowStyle Hidden | Out-Null
}

function Start-ImagebotBrowserPrewarm {
  if ($SkipPrewarm) {
    Write-Host "Skipping browser prewarm."
    return
  }

  if (-not (Test-Path -LiteralPath $BrowserPrewarmScript)) {
    Write-Warning "Browser prewarm script missing: $BrowserPrewarmScript"
    return
  }

  Write-Host "Warming isolated browser in background..."
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BrowserPrewarmScript, "-Fast", "-SoftFail") `
    -WindowStyle Hidden | Out-Null
}

if (Test-GatewayReady) {
  Write-Host "OpenClaw gateway already appears to be running on 127.0.0.1:18789."
  Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
  $owners = @(Get-PortOwnerPids)
  if ($owners.Count -gt 0) {
    Set-Content -LiteralPath $PidFile -Value $owners[0] -NoNewline
    Write-GatewayState -State "running" -Message "Existing gateway online; state synchronized." -GatewayPid ([string]$owners[0])
    Write-Host "Saved gateway PID: $($owners[0])"
  }
  else {
    Write-GatewayState -State "running" -Message "Existing gateway online; state synchronized."
  }
  if (Test-Path -LiteralPath $LogPathFile) {
    Write-Host "Log: $(Get-Content -LiteralPath $LogPathFile)"
  }
  if (-not $Fast) {
    openclaw gateway status
  }
  Invoke-ImagebotPrewarm
  Start-ImagebotMemoryPrewarm
  Start-ImagebotBrowserPrewarm
  exit 0
}

if (Test-GatewayPortListening) {
  $owners = @(Get-PortOwnerPids)
  Write-Warning "Port 18789 is occupied, but the gateway HTTP health check is not responding."
  if ($owners.Count -gt 0) {
    Write-Host "Port owner PID(s): $($owners -join ', ')"
  }
  Write-Host "Run .\STOP_IMAGEBOT_GATEWAY.ps1 -Fast, then start again."
  exit 1
}

$watchdogPid = Get-LivePid -Path $WatchdogPidFile
if ($watchdogPid -gt 0) {
  Write-Host "Gateway watchdog is already running. Watchdog PID: $watchdogPid"
  if (Test-Path -LiteralPath $StopFile) {
    Write-Host "Waiting for previous stop request to finish..."
    $stopDeadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $stopDeadline -and (Get-LivePid -Path $WatchdogPidFile) -gt 0) {
      Start-Sleep -Milliseconds 500
    }
    $watchdogPid = Get-LivePid -Path $WatchdogPidFile
  }

  if ($watchdogPid -gt 0) {
    $ready = Wait-ForGatewayReady -Seconds 45
    if ($ready) {
      $owners = @(Get-PortOwnerPids)
      if ($owners.Count -gt 0) {
        Set-Content -LiteralPath $PidFile -Value $owners[0] -NoNewline
        Write-Host "Gateway is listening on 127.0.0.1:18789. PID: $($owners[0])"
      }
      Invoke-ImagebotPrewarm
      Start-ImagebotMemoryPrewarm
      Start-ImagebotBrowserPrewarm
      exit 0
    }

    Write-Warning "Gateway watchdog is alive but the gateway did not become ready within 45 seconds."
    if (Test-Path -LiteralPath $LogPathFile) {
      Write-Host "Log: $(Get-Content -LiteralPath $LogPathFile)"
    }
    exit 1
  }
}

Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $WatchdogPidFile -Force -ErrorAction SilentlyContinue
Set-Location -LiteralPath $Root
openclaw config validate

$gatewayWindow = Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Runner) `
  -WindowStyle Hidden `
  -PassThru

Write-Host "Starting imagebot gateway in a hidden window. Window PID: $($gatewayWindow.Id)"

$ready = Wait-ForGatewayReady -Seconds 45

if ($ready) {
  $owners = @(Get-PortOwnerPids)
  if ($owners.Count -gt 0) {
    Set-Content -LiteralPath $PidFile -Value $owners[0] -NoNewline
    Write-Host "Gateway is listening on 127.0.0.1:18789. PID: $($owners[0])"
  }
  else {
    Write-Host "Gateway is listening on 127.0.0.1:18789."
  }
}
else {
  Write-Warning "Gateway was not ready within 45 seconds. Check the log file below."
}

if (Test-Path -LiteralPath $LogPathFile) {
  Write-Host "Log: $(Get-Content -LiteralPath $LogPathFile)"
}

if ($ready) {
  Invoke-ImagebotPrewarm
  Start-ImagebotMemoryPrewarm
  Start-ImagebotBrowserPrewarm
}

if (-not $Fast) {
  openclaw gateway status
}
