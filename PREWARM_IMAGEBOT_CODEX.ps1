param(
  [switch]$Fast,
  [switch]$SoftFail
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$LogDir = Join-Path $Root "logs"
$StateFile = Join-Path $RuntimeDir "imagebot-prewarm.state.json"
$LogFile = Join-Path $LogDir "imagebot-prewarm.log"

New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null

function Write-PrewarmState {
  param(
    [string]$State,
    [string]$Message = "",
    [object]$DurationMs = $null,
    [object]$Usage = $null
  )

  $payload = [ordered]@{
    state = $State
    message = $Message
    durationMs = $DurationMs
    usage = $Usage
    updatedAt = (Get-Date).ToString("o")
    logPath = $LogFile
  }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Write-PrewarmLog {
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

  $trimmed = $Text.Trim()
  if ($trimmed.StartsWith("{")) {
    try {
      return $trimmed | ConvertFrom-Json
    }
    catch {
    }
  }

  $firstBrace = $Text.IndexOf("{")
  $lastBrace = $Text.LastIndexOf("}")
  if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
    try {
      return $Text.Substring($firstBrace, $lastBrace - $firstBrace + 1) | ConvertFrom-Json
    }
    catch {
    }
  }

  $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") })
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    try {
      return $lines[$i] | ConvertFrom-Json
    }
    catch {
    }
  }
  return $null
}

function Get-UsageFromJsonObject {
  param([object]$Json)

  if (-not $Json) {
    return $null
  }

  $candidates = @(
    $Json.usage,
    $Json.result.meta.agentMeta.usage,
    $Json.result.meta.agentMeta.lastCallUsage,
    $Json.result.usage,
    $Json.data.usage
  )

  foreach ($candidate in $candidates) {
    if ($candidate) {
      return $candidate
    }
  }
  return $null
}

function Remove-OldPrewarmSessions {
  try {
    $sessionsDir = Join-Path $env:USERPROFILE ".openclaw\agents\imagebot\sessions"
    if (-not (Test-Path -LiteralPath $sessionsDir)) {
      return
    }

    Get-ChildItem -LiteralPath $sessionsDir -Filter "imagebot-prewarm-*" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^imagebot-prewarm-\d{14}(\.jsonl|\.trajectory\.jsonl|\.jsonl\.codex-app-server\.json)$" } |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
  catch {
    Write-PrewarmLog "Old prewarm session cleanup skipped: $($_.Exception.Message)"
  }
}

function Test-CodexRuntimeConfigured {
  try {
    $configPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
      return $false
    }

    $nodeScript = @"
const fs = require('fs');
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const codexEnabled = config.plugins?.entries?.codex?.enabled === true;
const defaultRuntime = config.agents?.defaults?.models?.['openai/gpt-5.5']?.agentRuntime?.id;
const imagebot = (config.agents?.list || []).find(agent => agent && agent.id === 'imagebot');
const imagebotRuntime = imagebot?.models?.['openai/gpt-5.5']?.agentRuntime?.id;
process.exit(codexEnabled || defaultRuntime === 'codex' || imagebotRuntime === 'codex' ? 0 : 2);
"@
    & node -e $nodeScript $configPath | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  catch {
    Write-PrewarmLog "Codex runtime detection failed: $($_.Exception.Message)"
    return $true
  }
}

Set-Location -LiteralPath $Root
Remove-OldPrewarmSessions

if (-not (Test-CodexRuntimeConfigured)) {
  Write-PrewarmState -State "skipped" -Message "Codex runtime is disabled; prewarm skipped."
  Write-PrewarmLog "Codex runtime disabled; skipping prewarm."
  exit 0
}

$startedAt = Get-Date
$sessionId = "imagebot-prewarm-$($startedAt.ToString('yyyyMMddHHmmss'))"
$args = @(
  "agent",
  "--agent", "imagebot",
  "--session-id", $sessionId,
  "--message", "Reply exactly OK.",
  "--thinking", "minimal",
  "--timeout", "180",
  "--json"
)

Write-PrewarmState -State "warming" -Message "Warming Codex runtime."
Write-PrewarmLog "Starting Codex prewarm session: $sessionId"

try {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & openclaw @args 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference

  $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
  if ($text.Trim()) {
    Add-Content -LiteralPath $LogFile -Value $text -Encoding UTF8
  }

  if ($null -eq $exitCode) {
    $exitCode = 0
  }

  if ($exitCode -ne 0) {
    throw "openclaw agent prewarm exited with code $exitCode"
  }

  $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  $json = Get-JsonObjectFromOutput -Text $text
  $usage = Get-UsageFromJsonObject -Json $json

  Write-PrewarmState -State "warm" -Message "Codex runtime warmed." -DurationMs $durationMs -Usage $usage
  Write-PrewarmLog "Codex prewarm completed in ${durationMs}ms."
  exit 0
}
catch {
  $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  $message = $_.Exception.Message
  if (-not $message) {
    $message = [string]$_
  }
  Write-PrewarmState -State "failed" -Message $message -DurationMs $durationMs
  Write-PrewarmLog "Codex prewarm failed after ${durationMs}ms: $message"
  if ($SoftFail) {
    exit 0
  }
  exit 1
}
