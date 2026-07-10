param(
  [ValidateSet("bot", "isolated")]
  [string]$Profile = "bot",
  [string]$Url = "https://www.baidu.com/",
  [switch]$StopGateway
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent

if ($StopGateway) {
  $stopScript = Join-Path $repoRoot "STOP_IMAGEBOT_GATEWAY.ps1"
  if (Test-Path $stopScript) {
    & $stopScript
  }
}

$homeDir = [Environment]::GetFolderPath("UserProfile")
$profileDir = Join-Path $homeDir ".openclaw\browser\$Profile\user-data"

$browserCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  (Join-Path $env:LOCALAPPDATA "ms-playwright\chromium-1223\chrome-win64\chrome.exe")
)
$browser = $browserCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) {
  throw "No Chromium/Chrome/Edge executable found."
}

$args = @("--no-first-run", "--no-default-browser-check", "--new-window")
$args += "--user-data-dir=$profileDir"
$args += $Url

Write-Host "Opening visible browser profile: $Profile"
Write-Host "Profile dir: $profileDir"
Write-Host "Browser: $browser"
if ($StopGateway) {
  Write-Host "Gateway was stopped so the profile is not locked. Close this browser before restarting the gateway."
}

Start-Process -FilePath $browser -ArgumentList $args
