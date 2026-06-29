param(
  [string]$OpenClawPackageDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node_modules\openclaw",
  [string]$OpenClawVersion = "2026.6.10",
  [string]$PatchDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "patches\openclaw-2026.6.10-runtime")
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required to download the original OpenClaw package."
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required to export diffs."
}

if (-not (Test-Path -LiteralPath $OpenClawPackageDir)) {
  throw "OpenClaw package directory not found: $OpenClawPackageDir"
}

$distDir = Join-Path $OpenClawPackageDir "dist"
if (-not (Test-Path -LiteralPath $distDir)) {
  throw "OpenClaw dist directory not found: $distDir"
}

$workDir = Join-Path $env:TEMP ("openclaw-original-" + $OpenClawVersion)
Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

Push-Location $workDir
try {
  $packName = (& npm pack "openclaw@$OpenClawVersion" --silent).Trim()
  if (-not $packName) {
    throw "npm pack did not return a tarball name."
  }
  & tar -xf $packName
}
finally {
  Pop-Location
}

$originalDist = Join-Path $workDir "package\dist"
if (-not (Test-Path -LiteralPath $originalDist)) {
  throw "Original dist directory not found after npm pack: $originalDist"
}

New-Item -ItemType Directory -Force -Path $PatchDir | Out-Null
Get-ChildItem -LiteralPath $PatchDir -Filter "*.patch" -File | Remove-Item -Force

$scratch = Join-Path $env:TEMP ("openclaw-patch-export-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path (Join-Path $scratch "original\dist"), (Join-Path $scratch "patched\dist") | Out-Null

$changed = @()
foreach ($original in Get-ChildItem -LiteralPath $originalDist -File) {
  $currentPath = Join-Path $distDir $original.Name
  if (-not (Test-Path -LiteralPath $currentPath)) {
    continue
  }
  $originalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $original.FullName).Hash
  $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $currentPath).Hash
  if ($originalHash -ne $currentHash) {
    $changed += $original.Name
  }
}

$index = 1
foreach ($fileName in ($changed | Sort-Object)) {
  $originalCopy = Join-Path $scratch ("original\dist\" + $fileName)
  $patchedCopy = Join-Path $scratch ("patched\dist\" + $fileName)
  Copy-Item -LiteralPath (Join-Path $originalDist $fileName) -Destination $originalCopy -Force
  Copy-Item -LiteralPath (Join-Path $distDir $fileName) -Destination $patchedCopy -Force

  $rawDiff = & git -C $scratch diff --no-index --src-prefix=a/ --dst-prefix=b/ ("original/dist/" + $fileName) ("patched/dist/" + $fileName)
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) {
    throw "git diff failed for $fileName"
  }

  $patchText = ($rawDiff -join "`n")
  $patchText = $patchText.Replace("a/original/dist/", "a/dist/").Replace("b/patched/dist/", "b/dist/")
  $safeName = $fileName -replace '[^A-Za-z0-9_.-]', '-'
  $patchPath = Join-Path $PatchDir ("{0:D2}-{1}.patch" -f $index, $safeName)
  [System.IO.File]::WriteAllText($patchPath, $patchText + "`n", [System.Text.UTF8Encoding]::new($false))
  $index++
}

Write-Host "Exported $($changed.Count) patch file(s) to $PatchDir"
