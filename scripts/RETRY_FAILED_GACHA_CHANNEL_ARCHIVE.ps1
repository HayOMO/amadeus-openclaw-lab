param(
  [switch]$Apply,
  [int]$Limit = 50,
  [string]$ConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json"
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Runner = Join-Path $ScriptDir 'RETRY_FAILED_GACHA_CHANNEL_ARCHIVE.mjs'

$nodeArgs = @($Runner, '--limit', [string]$Limit, '--config', $ConfigPath)
if ($Apply) {
  $nodeArgs += '--apply'
}

Push-Location $Root
try {
  & node @nodeArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
