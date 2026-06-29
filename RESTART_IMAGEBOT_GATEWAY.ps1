param(
  [switch]$Fast
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Root "STOP_IMAGEBOT_GATEWAY.ps1") -Fast
Start-Sleep -Seconds 2
& (Join-Path $Root "START_IMAGEBOT_GATEWAY.ps1") -Fast:$Fast
