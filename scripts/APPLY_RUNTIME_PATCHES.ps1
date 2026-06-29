param(
  [string]$OpenClawPackageDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node_modules\openclaw",
  [string]$PatchDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "patches\openclaw-2026.6.10-runtime")
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required to apply runtime patches."
}

if (-not (Test-Path -LiteralPath $OpenClawPackageDir)) {
  throw "OpenClaw package directory not found: $OpenClawPackageDir"
}

if (-not (Test-Path -LiteralPath $PatchDir)) {
  throw "Patch directory not found: $PatchDir"
}

$patches = Get-ChildItem -LiteralPath $PatchDir -Filter "*.patch" -File | Sort-Object Name
if ($patches.Count -eq 0) {
  throw "No patch files found in $PatchDir"
}

$backupDir = Join-Path $OpenClawPackageDir ("codex-patch-backups-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

foreach ($patch in $patches) {
  $text = Get-Content -Raw -LiteralPath $patch.FullName
  $matches = [regex]::Matches($text, '^\+\+\+ b/(dist/[^\r\n\t]+)', [System.Text.RegularExpressions.RegexOptions]::Multiline)
  foreach ($match in $matches) {
    $relativePath = $match.Groups[1].Value -replace '/', '\'
    $sourcePath = Join-Path $OpenClawPackageDir $relativePath
    if (Test-Path -LiteralPath $sourcePath) {
      $destPath = Join-Path $backupDir $relativePath
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destPath) | Out-Null
      Copy-Item -LiteralPath $sourcePath -Destination $destPath -Force
    }
  }
}

foreach ($patch in $patches) {
  Write-Host "Checking $($patch.Name)"
  & git -c core.autocrlf=false -C $OpenClawPackageDir apply --check --unsafe-paths --whitespace=nowarn $patch.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Patch check failed: $($patch.FullName)"
  }
}

foreach ($patch in $patches) {
  Write-Host "Applying $($patch.Name)"
  & git -c core.autocrlf=false -C $OpenClawPackageDir apply --unsafe-paths --whitespace=nowarn $patch.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Patch apply failed: $($patch.FullName)"
  }
}

Write-Host "Runtime patches applied. Backups: $backupDir"
