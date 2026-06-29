param(
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $RuntimeDir "imagebot-gateway.pid"
$LogPathFile = Join-Path $RuntimeDir "imagebot-gateway.logpath"

$StartScript = Join-Path $Root "START_IMAGEBOT_GATEWAY.ps1"
$StopScript = Join-Path $Root "STOP_IMAGEBOT_GATEWAY.ps1"
$RestartScript = Join-Path $Root "RESTART_IMAGEBOT_GATEWAY.ps1"
$StatusScript = Join-Path $Root "STATUS_IMAGEBOT_GATEWAY.ps1"

New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null

function Get-PortOwnerPids {
  try {
    return @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  }
  catch {
    return @()
  }
}

function Test-GatewayReady {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:18789/" -UseBasicParsing -TimeoutSec 1 | Out-Null
    return $true
  }
  catch {
  }

  return ((Get-PortOwnerPids).Count -gt 0)
}

function Get-LogPath {
  if (Test-Path -LiteralPath $LogPathFile) {
    $savedPath = Get-Content -LiteralPath $LogPathFile -ErrorAction SilentlyContinue | Select-Object -First 1
    return [string]$savedPath
  }

  $latest = Get-ChildItem -LiteralPath $LogDir -Filter "imagebot-gateway-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($latest) {
    return $latest.FullName
  }

  return ""
}

function Get-GatewaySnapshot {
  $owners = @(Get-PortOwnerPids)
  $ready = Test-GatewayReady
  $savedPid = ""
  if (Test-Path -LiteralPath $PidFile) {
    $savedPid = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
  }

  $pidText = if ($owners.Count -gt 0) {
    $owners -join ", "
  }
  elseif (-not [string]::IsNullOrWhiteSpace($savedPid)) {
    "$savedPid (saved, not listening)"
  }
  else {
    "none"
  }

  [pscustomobject]@{
    State = if ($ready) { "RUNNING" } else { "STOPPED" }
    Ready = $ready
    Port = "127.0.0.1:18789"
    Pid = $pidText
    Log = Get-LogPath
    Updated = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  }
}

if ($SelfTest) {
  Get-GatewaySnapshot | ConvertTo-Json -Compress
  exit 0
}

$script:ActionJob = $null
$script:ActionName = ""

$form = New-Object System.Windows.Forms.Form
$form.Text = "Amaduse Imagebot Control"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(680, 500)
$form.MinimumSize = New-Object System.Drawing.Size(640, 440)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Amaduse Imagebot Gateway"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(18, 16)
$form.Controls.Add($title)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Status: checking..."
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(22, 60)
$form.Controls.Add($statusLabel)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.Text = ""
$detailLabel.AutoSize = $true
$detailLabel.Location = New-Object System.Drawing.Point(22, 92)
$form.Controls.Add($detailLabel)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Text = "Log: none"
$logLabel.AutoSize = $false
$logLabel.Size = New-Object System.Drawing.Size(620, 40)
$logLabel.Location = New-Object System.Drawing.Point(22, 120)
$form.Controls.Add($logLabel)

$buttonY = 170
$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = "Start"
$startButton.Size = New-Object System.Drawing.Size(120, 42)
$startButton.Location = New-Object System.Drawing.Point(24, $buttonY)
$form.Controls.Add($startButton)

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = "Stop"
$stopButton.Size = New-Object System.Drawing.Size(120, 42)
$stopButton.Location = New-Object System.Drawing.Point(160, $buttonY)
$form.Controls.Add($stopButton)

$restartButton = New-Object System.Windows.Forms.Button
$restartButton.Text = "Restart"
$restartButton.Size = New-Object System.Drawing.Size(120, 42)
$restartButton.Location = New-Object System.Drawing.Point(296, $buttonY)
$form.Controls.Add($restartButton)

$refreshButton = New-Object System.Windows.Forms.Button
$refreshButton.Text = "Refresh"
$refreshButton.Size = New-Object System.Drawing.Size(120, 42)
$refreshButton.Location = New-Object System.Drawing.Point(432, $buttonY)
$form.Controls.Add($refreshButton)

$openLogButton = New-Object System.Windows.Forms.Button
$openLogButton.Text = "Open Log Folder"
$openLogButton.Size = New-Object System.Drawing.Size(150, 34)
$openLogButton.Location = New-Object System.Drawing.Point(24, 224)
$form.Controls.Add($openLogButton)

$outputBox = New-Object System.Windows.Forms.TextBox
$outputBox.Multiline = $true
$outputBox.ScrollBars = "Vertical"
$outputBox.ReadOnly = $true
$outputBox.WordWrap = $false
$outputBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$outputBox.Location = New-Object System.Drawing.Point(22, 270)
$outputBox.Size = New-Object System.Drawing.Size(620, 170)
$outputBox.Anchor = "Top,Bottom,Left,Right"
$form.Controls.Add($outputBox)

function Append-Output {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) {
    return
  }
  $outputBox.AppendText($Text.TrimEnd() + [Environment]::NewLine)
}

function Set-ButtonsEnabled {
  param([bool]$Enabled)
  $startButton.Enabled = $Enabled
  $stopButton.Enabled = $Enabled
  $restartButton.Enabled = $Enabled
  $refreshButton.Enabled = $Enabled
  $openLogButton.Enabled = $Enabled
}

function Refresh-PanelStatus {
  $snapshot = Get-GatewaySnapshot
  if ($snapshot.Ready) {
    $statusLabel.Text = "Status: RUNNING"
    $statusLabel.ForeColor = [System.Drawing.Color]::ForestGreen
  }
  else {
    $statusLabel.Text = "Status: STOPPED"
    $statusLabel.ForeColor = [System.Drawing.Color]::Firebrick
  }

  $detailLabel.Text = "Port: $($snapshot.Port)    PID: $($snapshot.Pid)    Updated: $($snapshot.Updated)"
  if ([string]::IsNullOrWhiteSpace($snapshot.Log)) {
    $logLabel.Text = "Log: none"
  }
  else {
    $logLabel.Text = "Log: $($snapshot.Log)"
  }

  if (-not [string]::IsNullOrWhiteSpace($snapshot.Log) -and (Test-Path -LiteralPath $snapshot.Log)) {
    $tail = Get-Content -LiteralPath $snapshot.Log -Tail 40 -ErrorAction SilentlyContinue
    $outputBox.Text = ($tail -join [Environment]::NewLine)
    if ($outputBox.Text.Length -gt 0) {
      $outputBox.AppendText([Environment]::NewLine)
    }
  }
}

function Start-PanelAction {
  param(
    [string]$Name,
    [string]$ScriptPath
  )

  if ($script:ActionJob) {
    return
  }

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    [System.Windows.Forms.MessageBox]::Show("Missing script: $ScriptPath", "Imagebot Control", "OK", "Error") | Out-Null
    return
  }

  Set-ButtonsEnabled $false
  $script:ActionName = $Name
  Append-Output "[$(Get-Date -Format 'HH:mm:ss')] $Name requested."
  $script:ActionJob = Start-Job -ScriptBlock {
    param([string]$TargetScript)
    $result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $TargetScript 2>&1
    $exitCode = $LASTEXITCODE
    $result | ForEach-Object { $_.ToString() }
    "ExitCode=$exitCode"
    exit $exitCode
  } -ArgumentList $ScriptPath
}

$jobTimer = New-Object System.Windows.Forms.Timer
$jobTimer.Interval = 1000
$jobTimer.Add_Tick({
  if (-not $script:ActionJob) {
    return
  }

  $newOutput = Receive-Job -Job $script:ActionJob -ErrorAction SilentlyContinue
  foreach ($line in $newOutput) {
    Append-Output ([string]$line)
  }

  if ($script:ActionJob.State -ne "Running") {
    $remaining = Receive-Job -Job $script:ActionJob -ErrorAction SilentlyContinue
    foreach ($line in $remaining) {
      Append-Output ([string]$line)
    }
    Append-Output "[$(Get-Date -Format 'HH:mm:ss')] $($script:ActionName) finished: $($script:ActionJob.State)."
    Remove-Job -Job $script:ActionJob -Force -ErrorAction SilentlyContinue
    $script:ActionJob = $null
    $script:ActionName = ""
    Set-ButtonsEnabled $true
    Refresh-PanelStatus
  }
})
$jobTimer.Start()

$autoRefreshTimer = New-Object System.Windows.Forms.Timer
$autoRefreshTimer.Interval = 5000
$autoRefreshTimer.Add_Tick({
  if (-not $script:ActionJob) {
    Refresh-PanelStatus
  }
})
$autoRefreshTimer.Start()

$startButton.Add_Click({ Start-PanelAction -Name "Start" -ScriptPath $StartScript })
$stopButton.Add_Click({ Start-PanelAction -Name "Stop" -ScriptPath $StopScript })
$restartButton.Add_Click({ Start-PanelAction -Name "Restart" -ScriptPath $RestartScript })
$refreshButton.Add_Click({ Refresh-PanelStatus })
$openLogButton.Add_Click({ Start-Process explorer.exe $LogDir })

$form.Add_Shown({ Refresh-PanelStatus })
$form.Add_FormClosing({
  if ($script:ActionJob) {
    Remove-Job -Job $script:ActionJob -Force -ErrorAction SilentlyContinue
  }
})

[void]$form.ShowDialog()
