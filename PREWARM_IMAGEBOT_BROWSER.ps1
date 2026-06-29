param(
  [switch]$Fast,
  [switch]$SoftFail,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$LogDir = Join-Path $Root "logs"
$StateFile = Join-Path $RuntimeDir "imagebot-browser-prewarm.state.json"
$LogFile = Join-Path $LogDir "imagebot-browser-prewarm.log"
$LockFile = Join-Path $RuntimeDir "imagebot-browser-prewarm.lock"
$Script = Join-Path $Root "scripts\PREWARM_IMAGEBOT_BROWSER.mjs"

New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null

function Write-BrowserPrewarmState {
  param(
    [string]$State,
    [string]$Message = "",
    [object]$DurationMs = $null,
    [object]$Details = $null
  )

  $payload = [ordered]@{
    state = $State
    message = $Message
    durationMs = $DurationMs
    details = $Details
    updatedAt = (Get-Date).ToString("o")
    logPath = $LogFile
  }
  $payload | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Write-BrowserPrewarmLog {
  param([string]$Message)
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  if (-not $Fast) {
    Write-Host $Message
  }
}

function Get-JsonObjectFromOutput {
  param([string]$Text)

  if (-not $Text) {
    return $null
  }
  $firstBrace = $Text.IndexOf("{")
  $lastBrace = $Text.LastIndexOf("}")
  if ($firstBrace -lt 0 -or $lastBrace -le $firstBrace) {
    return $null
  }
  try {
    return $Text.Substring($firstBrace, $lastBrace - $firstBrace + 1) | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

if (-not (Test-Path -LiteralPath $Script)) {
  Write-BrowserPrewarmState -State "failed" -Message "Browser prewarm script missing."
  Write-BrowserPrewarmLog "Browser prewarm script missing: $Script"
  if ($SoftFail) {
    exit 0
  }
  exit 1
}

if ((Test-Path -LiteralPath $LockFile) -and -not $Force) {
  $age = (Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime
  if ($age.TotalMinutes -lt 10) {
    Write-BrowserPrewarmState -State "warming" -Message "Browser prewarm already running."
    Write-BrowserPrewarmLog "Browser prewarm already running; lock age $([int]$age.TotalSeconds)s."
    exit 0
  }
}

Set-Content -LiteralPath $LockFile -Value $PID -NoNewline
$startedAt = Get-Date
Write-BrowserPrewarmState -State "warming" -Message "Warming isolated Playwright browser."
Write-BrowserPrewarmLog "Starting isolated browser prewarm."

try {
  Set-Location -LiteralPath $Root
  $output = & node $Script 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
  if ($text.Trim()) {
    Add-Content -LiteralPath $LogFile -Value $text -Encoding UTF8
  }
  if ($null -eq $exitCode) {
    $exitCode = 0
  }
  if ($exitCode -ne 0) {
    throw "browser prewarm exited with code $exitCode"
  }
  $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  $json = Get-JsonObjectFromOutput -Text $text
  Write-BrowserPrewarmState -State "warm" -Message "Isolated browser warmed." -DurationMs $durationMs -Details $json
  Write-BrowserPrewarmLog "Browser prewarm completed in ${durationMs}ms."
  exit 0
}
catch {
  $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  $message = $_.Exception.Message
  if (-not $message) {
    $message = [string]$_
  }
  Write-BrowserPrewarmState -State "failed" -Message $message -DurationMs $durationMs
  Write-BrowserPrewarmLog "Browser prewarm failed after ${durationMs}ms: $message"
  if ($SoftFail) {
    exit 0
  }
  exit 1
}
finally {
  Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
