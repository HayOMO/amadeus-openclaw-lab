param(
  [string]$Agent = "imagebot",
  [string]$CuratorProfile = "deep",
  [string]$CuratorModel = "",
  [string]$CuratorThinking = "",
  [string]$Thinking = "",
  [int]$TimeoutSeconds = 420,
  [int]$MinTurns = 1,
  [int]$MaxPromptChars = 12000,
  [int]$MaxTranscriptChars = 8000,
  [int]$MaxExistingChars = 3000,
  [int]$FallbackPromptChars = 7000,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$CloseWindows,
  [switch]$RestartGatewayAfterClose
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root "scripts\CONSOLIDATE_IMAGEBOT_MEMORY.mjs"

$nodeArgs = @(
  $Script,
  "--agent", $Agent,
  "--curator-profile", $CuratorProfile,
  "--timeout", [string]$TimeoutSeconds,
  "--min-turns", [string]$MinTurns,
  "--max-prompt-chars", [string]$MaxPromptChars,
  "--max-transcript-chars", [string]$MaxTranscriptChars,
  "--max-existing-chars", [string]$MaxExistingChars,
  "--fallback-prompt-chars", [string]$FallbackPromptChars
)

if ($CuratorModel) { $nodeArgs += @("--curator-model", $CuratorModel) }
if ($CuratorThinking) { $nodeArgs += @("--curator-thinking", $CuratorThinking) }
if ($Thinking) { $nodeArgs += @("--thinking", $Thinking) }
if ($DryRun) { $nodeArgs += "--dry-run" }
if ($Force) { $nodeArgs += "--force" }
if ($CloseWindows) { $nodeArgs += "--close-windows" }

Set-Location -LiteralPath $Root

$openclawCommand = Get-Command openclaw.cmd -ErrorAction SilentlyContinue
if ($openclawCommand) {
  $env:OPENCLAW_CMD = $openclawCommand.Source
}
else {
  $openclawScript = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($openclawScript) {
    $candidate = Join-Path (Split-Path -Parent $openclawScript.Source) "openclaw.cmd"
    if (Test-Path -LiteralPath $candidate) {
      $env:OPENCLAW_CMD = $candidate
    }
  }
}

& node @nodeArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  exit $exitCode
}

if ($RestartGatewayAfterClose -and -not $DryRun) {
  $reportPath = Join-Path $env:USERPROFILE ".openclaw\agents\$Agent\sessions\sessions.json.telegram-imagebot-memory\curator-last-run.json"
  if (Test-Path -LiteralPath $reportPath) {
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ([int]$report.closedWindows -gt 0) {
      Write-Host "Memory curator closed $($report.closedWindows) window(s); restarting gateway so runtime state reloads."
      & (Join-Path $Root "RESTART_IMAGEBOT_GATEWAY.ps1") -Fast
    }
  }
}
