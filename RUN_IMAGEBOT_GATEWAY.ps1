param(
  [int]$MaxRestarts = 3,
  [int]$RestartDelaySeconds = 10,
  [int]$StableSeconds = 600,
  [int]$HealthProbeIntervalSeconds = 30,
  [int]$HealthProbeGraceSeconds = 180,
  [int]$HealthProbeFailures = 4
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "imagebot-gateway-$stamp.log"
$LogPathFile = Join-Path $RuntimeDir "imagebot-gateway.logpath"
$PidFile = Join-Path $RuntimeDir "imagebot-gateway.pid"
$WatchdogPidFile = Join-Path $RuntimeDir "imagebot-gateway-watchdog.pid"
$StopFile = Join-Path $RuntimeDir "imagebot-gateway.stop"
$StateFile = Join-Path $RuntimeDir "imagebot-gateway.state.json"
$SessionPruneScript = Join-Path $Root "scripts\PRUNE_IMAGEBOT_SESSION_IMAGES.mjs"
$SessionRepairScript = Join-Path $Root "scripts\REPAIR_IMAGEBOT_SESSIONS.mjs"
$WindowStoreRepairScript = Join-Path $Root "scripts\REPAIR_IMAGEBOT_WINDOW_STORE.mjs"
Set-Content -LiteralPath $LogPathFile -Value $LogFile -NoNewline
Set-Content -LiteralPath $WatchdogPidFile -Value $PID -NoNewline

function Write-LogLine {
  param([string]$Message)
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  $line | Tee-Object -FilePath $LogFile -Append
}

function ConvertTo-GatewayHttpProxyUrl {
  param([string]$ProxyServer)

  if ([string]::IsNullOrWhiteSpace($ProxyServer)) {
    return $null
  }

  $parts = @($ProxyServer -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $candidates = @()

  foreach ($part in $parts) {
    if ($part -match '^(?<name>[A-Za-z]+)=(?<value>.+)$') {
      $name = $Matches.name.ToLowerInvariant()
      $value = $Matches.value.Trim()
      if ($name -eq "https") {
        $candidates = @($value) + $candidates
      }
      elseif ($name -eq "http") {
        $candidates += $value
      }
    }
    elseif ($parts.Count -eq 1) {
      $candidates += $part
    }
  }

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }

    if ($candidate -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
      $candidate = "http://$candidate"
    }

    try {
      $uri = [Uri]$candidate
    }
    catch {
      continue
    }

    if (($uri.Scheme -eq "http" -or $uri.Scheme -eq "https") -and -not [string]::IsNullOrWhiteSpace($uri.Host)) {
      return $uri.AbsoluteUri.TrimEnd("/")
    }
  }

  return $null
}

function Resolve-GatewayHttpProxyUrl {
  try {
    $settings = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
  }
  catch {
    Write-LogLine "Gateway HTTP proxy env: failed to read Windows proxy settings: $($_.Exception.Message)"
    return $null
  }

  $enabled = 0
  if ($settings.PSObject.Properties.Name -contains "ProxyEnable") {
    $enabled = [int]$settings.ProxyEnable
  }

  if ($enabled -ne 1) {
    return $null
  }

  $proxyServer = ""
  if ($settings.PSObject.Properties.Name -contains "ProxyServer") {
    $proxyServer = [string]$settings.ProxyServer
  }

  return ConvertTo-GatewayHttpProxyUrl -ProxyServer $proxyServer
}

function Format-GatewayProxyUrlForLog {
  param([string]$ProxyUrl)

  try {
    $builder = [UriBuilder]([Uri]$ProxyUrl)
    $builder.UserName = ""
    $builder.Password = ""
    return $builder.Uri.AbsoluteUri.TrimEnd("/")
  }
  catch {
    return "<configured>"
  }
}

function New-GatewayEnvSnapshot {
  param([string[]]$Names)

  $snapshot = @{}
  foreach ($name in $Names) {
    $snapshot[$name] = [ordered]@{
      Exists = Test-Path -LiteralPath "Env:\$name"
      Value = [Environment]::GetEnvironmentVariable($name, "Process")
    }
  }
  return $snapshot
}

function Restore-GatewayEnvironment {
  param([hashtable]$Snapshot)

  if ($null -eq $Snapshot) {
    return
  }

  foreach ($name in $Snapshot.Keys) {
    $entry = $Snapshot[$name]
    if ($entry.Exists) {
      [Environment]::SetEnvironmentVariable($name, $entry.Value, "Process")
    }
    else {
      [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
  }
}

function Set-GatewayProxyEnvironment {
  $proxyUrl = Resolve-GatewayHttpProxyUrl
  if ([string]::IsNullOrWhiteSpace($proxyUrl)) {
    Write-LogLine "Gateway HTTP proxy env: no Windows HTTP proxy detected; keeping inherited environment."
    return $null
  }

  $names = @("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")
  $snapshot = New-GatewayEnvSnapshot -Names $names
  foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, $proxyUrl, "Process")
  }

  $safeProxyUrl = Format-GatewayProxyUrlForLog -ProxyUrl $proxyUrl
  Write-LogLine "Gateway HTTP proxy env: using Windows system proxy $safeProxyUrl for OpenClaw gateway process."
  return $snapshot
}

function Write-GatewayState {
  param(
    [string]$State,
    [int]$RestartCount = 0,
    [object]$LastExitCode = $null,
    [string]$Message = "",
    [object]$NextRestartAt = $null
  )

  try {
    $nextRestartValue = $null
    if ($NextRestartAt -is [datetime]) {
      $nextRestartValue = $NextRestartAt.ToString("o")
    }

    $payload = [ordered]@{
      state = $State
      restartCount = $RestartCount
      maxRestarts = $MaxRestarts
      lastExitCode = $LastExitCode
      message = $Message
      logPath = $LogFile
      watchdogPid = $PID
      updatedAt = (Get-Date).ToString("o")
      nextRestartAt = $nextRestartValue
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  }
  catch {
    Write-LogLine "Watchdog state write failed: $($_.Exception.Message)"
  }
}

function Wait-OrStop {
  param([int]$Seconds)

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $StopFile) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return (Test-Path -LiteralPath $StopFile)
}

function Get-PortOwnerPids {
  try {
    return @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  }
  catch {
    return @()
  }
}

function Stop-HealthJob {
  param([object]$Job)

  if ($null -eq $Job) {
    return
  }

  try {
    Stop-Job -Job $Job -ErrorAction SilentlyContinue | Out-Null
  }
  catch {
  }

  try {
    Receive-Job -Job $Job -ErrorAction SilentlyContinue | Out-Null
  }
  catch {
  }

  try {
    Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue | Out-Null
  }
  catch {
  }
}

function Start-GatewayHealthJob {
  param(
    [string]$LogFilePath,
    [string]$PidFilePath,
    [string]$StopFilePath,
    [string]$StateFilePath,
    [int]$IntervalSeconds,
    [int]$GraceSeconds,
    [int]$FailureThreshold,
    [int]$MaxRestartsValue
  )

  Start-Job -ArgumentList @(
    $LogFilePath,
    $PidFilePath,
    $StopFilePath,
    $StateFilePath,
    $IntervalSeconds,
    $GraceSeconds,
    $FailureThreshold,
    $MaxRestartsValue
  ) -ScriptBlock {
    param(
      [string]$LogFilePath,
      [string]$PidFilePath,
      [string]$StopFilePath,
      [string]$StateFilePath,
      [int]$IntervalSeconds,
      [int]$GraceSeconds,
      [int]$FailureThreshold,
      [int]$MaxRestartsValue
    )

    function Write-MonitorLog {
      param([string]$Message)
      try {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" | Add-Content -LiteralPath $LogFilePath
      }
      catch {
      }
    }

    function Write-MonitorState {
      param([string]$Message)
      try {
        $payload = [ordered]@{
          state = "unresponsive"
          restartCount = 0
          maxRestarts = $MaxRestartsValue
          lastExitCode = $null
          message = $Message
          logPath = $LogFilePath
          watchdogPid = $PID
          updatedAt = (Get-Date).ToString("o")
          nextRestartAt = $null
        }
        $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFilePath -Encoding UTF8
      }
      catch {
      }
    }

    function Get-LiveGatewayPid {
      if (-not (Test-Path -LiteralPath $PidFilePath)) {
        return 0
      }

      $raw = Get-Content -LiteralPath $PidFilePath -Raw -ErrorAction SilentlyContinue
      $pidValue = 0
      if ([int]::TryParse(([string]$raw).Trim(), [ref]$pidValue)) {
        if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
          return $pidValue
        }
      }
      return 0
    }

    function Test-GatewayHttp {
      try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:18789/" -UseBasicParsing -TimeoutSec 5
        return ([int]$res.StatusCode -ge 200 -and [int]$res.StatusCode -lt 500)
      }
      catch {
        return $false
      }
    }

    Write-MonitorLog "Health monitor enabled: grace=${GraceSeconds}s interval=${IntervalSeconds}s failures=$FailureThreshold"

    while (-not (Test-Path -LiteralPath $StopFilePath)) {
      $gatewayPid = Get-LiveGatewayPid
      if ($gatewayPid -gt 0) {
        break
      }
      Start-Sleep -Seconds 2
    }

    if (Test-Path -LiteralPath $StopFilePath) {
      return
    }

    Start-Sleep -Seconds $GraceSeconds
    $failures = 0

    while (-not (Test-Path -LiteralPath $StopFilePath)) {
      $gatewayPid = Get-LiveGatewayPid
      if ($gatewayPid -le 0) {
        return
      }

      if (Test-GatewayHttp) {
        if ($failures -gt 0) {
          Write-MonitorLog "Health probe recovered after $failures failed probe(s)."
        }
        $failures = 0
      }
      else {
        $failures++
        Write-MonitorLog "Health probe failed $failures/$FailureThreshold for gateway PID $gatewayPid."
        if ($failures -ge $FailureThreshold) {
          $message = "Gateway health probe failed $failures consecutive times; killing PID $gatewayPid so watchdog can restart."
          Write-MonitorState $message
          Write-MonitorLog $message
          Stop-Process -Id $gatewayPid -Force -ErrorAction SilentlyContinue
          return
        }
      }

      Start-Sleep -Seconds $IntervalSeconds
    }
  }
}

function Start-SessionPruneJob {
  param(
    [string]$RootPath,
    [string]$ScriptPath,
    [string]$RepairScriptPath,
    [string]$WindowStoreRepairScriptPath,
    [string]$LogFilePath,
    [string]$StopFilePath,
    [int]$IntervalSeconds = 90,
    [int]$GraceSeconds = 180
  )

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    Write-LogLine "Session image prune script missing: $ScriptPath"
    return $null
  }

  Start-Job -ArgumentList @(
    $RootPath,
    $ScriptPath,
    $RepairScriptPath,
    $WindowStoreRepairScriptPath,
    $LogFilePath,
    $StopFilePath,
    $IntervalSeconds,
    $GraceSeconds
  ) -ScriptBlock {
    param(
      [string]$RootPath,
      [string]$ScriptPath,
      [string]$RepairScriptPath,
      [string]$WindowStoreRepairScriptPath,
      [string]$LogFilePath,
      [string]$StopFilePath,
      [int]$IntervalSeconds,
      [int]$GraceSeconds
    )

    function Write-PruneLog {
      param([string]$Message)
      try {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" | Add-Content -LiteralPath $LogFilePath
      }
      catch {
      }
    }

    Write-PruneLog "Session image prune monitor enabled: grace=${GraceSeconds}s interval=${IntervalSeconds}s"
    Start-Sleep -Seconds $GraceSeconds
    while (-not (Test-Path -LiteralPath $StopFilePath)) {
      try {
        Set-Location -LiteralPath $RootPath
        if (Test-Path -LiteralPath $RepairScriptPath) {
          $repairOutput = & node $RepairScriptPath --quiet --lock-stale-seconds 900 2>&1
          if ($LASTEXITCODE -ne 0) {
            Write-PruneLog "Session repair failed: $repairOutput"
          }
          elseif ($repairOutput) {
            foreach ($line in @($repairOutput)) {
              if ($line) {
                Write-PruneLog "Session repair: $line"
              }
            }
          }
        }
        if (Test-Path -LiteralPath $WindowStoreRepairScriptPath) {
          $windowStoreRepairOutput = & node $WindowStoreRepairScriptPath --quiet 2>&1
          if ($LASTEXITCODE -ne 0) {
            Write-PruneLog "Window store repair failed: $windowStoreRepairOutput"
          }
          elseif ($windowStoreRepairOutput) {
            foreach ($line in @($windowStoreRepairOutput)) {
              if ($line) {
                Write-PruneLog "Window store repair: $line"
              }
            }
          }
        }
        $output = & node $ScriptPath --quiet --lock-stale-seconds 900 --max-files 80 2>&1
        if ($LASTEXITCODE -ne 0) {
          Write-PruneLog "Session image prune failed: $output"
        }
        elseif ($output) {
          foreach ($line in @($output)) {
            if ($line) {
              Write-PruneLog "Session image prune: $line"
            }
          }
        }
      }
      catch {
        Write-PruneLog "Session image prune error: $($_.Exception.Message)"
      }

      $deadline = (Get-Date).AddSeconds($IntervalSeconds)
      while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $StopFilePath) {
          return
        }
        Start-Sleep -Milliseconds 500
      }
    }
  }
}

function Invoke-SessionRepairOnce {
  param(
    [string]$RootPath,
    [string]$RepairScriptPath,
    [string]$WindowStoreRepairScriptPath = ""
  )

  if (-not (Test-Path -LiteralPath $RepairScriptPath)) {
    Write-LogLine "Session repair script missing: $RepairScriptPath"
    return
  }

  try {
    Set-Location -LiteralPath $RootPath
    $repairOutput = & node $RepairScriptPath --quiet --lock-stale-seconds 900 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-LogLine "Session repair failed: $repairOutput"
    }
    elseif ($repairOutput) {
      foreach ($line in @($repairOutput)) {
        if ($line) {
          Write-LogLine "Session repair: $line"
        }
      }
    }
  }
  catch {
    Write-LogLine "Session repair error: $($_.Exception.Message)"
  }

  if (-not $WindowStoreRepairScriptPath) {
    return
  }
  if (-not (Test-Path -LiteralPath $WindowStoreRepairScriptPath)) {
    Write-LogLine "Window store repair script missing: $WindowStoreRepairScriptPath"
    return
  }

  try {
    Set-Location -LiteralPath $RootPath
    $windowStoreRepairOutput = & node $WindowStoreRepairScriptPath --quiet 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-LogLine "Window store repair failed: $windowStoreRepairOutput"
    }
    elseif ($windowStoreRepairOutput) {
      foreach ($line in @($windowStoreRepairOutput)) {
        if ($line) {
          Write-LogLine "Window store repair: $line"
        }
      }
    }
  }
  catch {
    Write-LogLine "Window store repair error: $($_.Exception.Message)"
  }
}

Set-Location -LiteralPath $Root
Write-LogLine "Starting OpenClaw imagebot gateway from $Root"
Write-LogLine "Command: openclaw gateway run --bind loopback"
Write-LogLine "Watchdog enabled: maxRestarts=$MaxRestarts restartDelaySeconds=$RestartDelaySeconds stableSeconds=$StableSeconds healthGraceSeconds=$HealthProbeGraceSeconds healthIntervalSeconds=$HealthProbeIntervalSeconds healthFailures=$HealthProbeFailures"
Invoke-SessionRepairOnce -RootPath $Root -RepairScriptPath $SessionRepairScript -WindowStoreRepairScriptPath $WindowStoreRepairScript

$restartCount = 0
$lastExitCode = 0

try {
  while ($true) {
    if (Test-Path -LiteralPath $StopFile) {
      Write-GatewayState -State "stopped" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Stop requested before gateway start."
      Write-LogLine "Stop requested before gateway start; watchdog exiting."
      exit 0
    }

    Write-GatewayState -State "starting" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Starting OpenClaw gateway."
    $startedAt = Get-Date
    $healthJob = $null
    $sessionPruneJob = $null
    $gatewayEnvSnapshot = $null

    try {
      $healthJob = Start-GatewayHealthJob `
        -LogFilePath $LogFile `
        -PidFilePath $PidFile `
        -StopFilePath $StopFile `
        -StateFilePath $StateFile `
        -IntervalSeconds $HealthProbeIntervalSeconds `
        -GraceSeconds $HealthProbeGraceSeconds `
        -FailureThreshold $HealthProbeFailures `
        -MaxRestartsValue $MaxRestarts
      $sessionPruneJob = Start-SessionPruneJob `
        -RootPath $Root `
        -ScriptPath $SessionPruneScript `
        -RepairScriptPath $SessionRepairScript `
        -WindowStoreRepairScriptPath $WindowStoreRepairScript `
        -LogFilePath $LogFile `
        -StopFilePath $StopFile

      $gatewayEnvSnapshot = Set-GatewayProxyEnvironment
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      & openclaw gateway run --bind loopback 2>&1 |
        ForEach-Object {
          if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $line = $_.ToString()
          }
          else {
            $line = [string]$_
          }

          if ($line -match "\[gateway\] ready") {
            $owners = @(Get-PortOwnerPids)
            if ($owners.Count -gt 0) {
              Set-Content -LiteralPath $PidFile -Value $owners[0] -NoNewline
            }
            Write-GatewayState -State "running" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Gateway online; watchdog armed."
          }

          $line
        } |
        Tee-Object -FilePath $LogFile -Append
      $lastExitCode = $LASTEXITCODE
      $ErrorActionPreference = $previousErrorActionPreference
      if ($null -eq $lastExitCode) {
        $lastExitCode = 0
      }
      Write-LogLine "OpenClaw gateway exited with code $lastExitCode"
    }
    catch {
      $ErrorActionPreference = "Continue"
      $lastExitCode = 1
      Write-LogLine "OpenClaw gateway failed: $($_.Exception.Message)"
    }
    finally {
      Restore-GatewayEnvironment -Snapshot $gatewayEnvSnapshot
      Stop-HealthJob -Job $healthJob
      Stop-HealthJob -Job $sessionPruneJob
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $StopFile) {
      Write-GatewayState -State "stopped" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Gateway stopped by request."
      Write-LogLine "Stop request observed; watchdog exiting."
      exit 0
    }

    $uptimeSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
    if ($uptimeSeconds -ge $StableSeconds) {
      $restartCount = 0
    }

    if ($lastExitCode -eq 0) {
      Write-GatewayState -State "stopped" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Gateway exited normally."
      Write-LogLine "Gateway exited normally; watchdog exiting."
      exit 0
    }

    $restartCount++
    if ($restartCount -gt $MaxRestarts) {
      Write-GatewayState -State "crashed" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Restart limit reached after an unexpected gateway exit."
      Write-LogLine "Gateway restart limit reached ($MaxRestarts). Leaving gateway stopped."
      exit $lastExitCode
    }

    $nextRestartAt = (Get-Date).AddSeconds($RestartDelaySeconds)
    Write-GatewayState -State "restarting" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Unexpected gateway exit; watchdog restart $restartCount/$MaxRestarts pending." -NextRestartAt $nextRestartAt
    Write-LogLine "Unexpected gateway exit; watchdog restart $restartCount/$MaxRestarts in $RestartDelaySeconds second(s)."

    if (Wait-OrStop -Seconds $RestartDelaySeconds) {
      Write-GatewayState -State "stopped" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Stop requested during restart delay."
      Write-LogLine "Stop requested during restart delay; watchdog exiting."
      exit 0
    }
  }
}
catch {
  Write-LogLine "Watchdog failed: $($_.Exception.Message)"
  Write-GatewayState -State "crashed" -RestartCount $restartCount -LastExitCode $lastExitCode -Message "Watchdog failed: $($_.Exception.Message)"
  exit 1
}
finally {
  Remove-Item -LiteralPath $WatchdogPidFile -Force -ErrorAction SilentlyContinue
}
