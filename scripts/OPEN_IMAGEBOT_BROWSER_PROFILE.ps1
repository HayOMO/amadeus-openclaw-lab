param(
  [ValidateSet("weibo", "bilibili", "baidu_tieba", "xiaohongshu", "zhihu", "pixiv", "lofter", "image-download", "legacy-web-snapshot")]
  [string]$Profile = "weibo",
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
if ($Profile -eq "image-download") {
  $profileDir = Join-Path $homeDir ".openclaw\browser-profiles\image-download-pool"
} elseif ($Profile -eq "legacy-web-snapshot") {
  $profileDir = Join-Path $homeDir ".openclaw\practical-tools\browser-profiles\web-snapshot-pool"
} else {
  $profileDir = Join-Path $homeDir ".openclaw\practical-tools\browser-profiles\account\$Profile"
}
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$browserCandidates = @(
  (Join-Path $env:LOCALAPPDATA "ms-playwright\chromium-1223\chrome-win64\chrome.exe"),
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browserCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) {
  throw "No Chromium/Chrome/Edge executable found."
}

$args = @(
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--no-default-browser-check",
  "--new-window",
  $Url
)

Write-Host "Opening visible browser profile: $Profile"
Write-Host "Profile dir: $profileDir"
Write-Host "Browser: $browser"
if ($Profile -eq "legacy-web-snapshot") {
  Write-Host "legacy-web-snapshot is kept only for old-session inspection; public web_snapshot no longer uses a persistent profile."
}
if ($StopGateway) {
  Write-Host "Gateway was stopped so the profile is not locked. Close this browser before restarting the gateway."
}

Start-Process -FilePath $browser -ArgumentList $args
