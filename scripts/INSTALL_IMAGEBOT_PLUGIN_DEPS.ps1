param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginRoot = Join-Path $RepoRoot "plugins"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm was not found on PATH. Install Node.js LTS and OpenClaw first, then rerun this script."
}

if (-not (Test-Path -LiteralPath $PluginRoot)) {
  throw "Plugin directory not found: $PluginRoot"
}

function Test-HasDependencies {
  param([object]$PackageJson)

  foreach ($field in @("dependencies", "optionalDependencies", "peerDependencies")) {
    $value = $PackageJson.$field
    if ($value -and $value.PSObject.Properties.Count -gt 0) {
      return $true
    }
  }
  return $false
}

$packageFiles = @(Get-ChildItem -LiteralPath $PluginRoot -Directory |
  ForEach-Object { Join-Path $_.FullName "package.json" } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Sort-Object)

$installed = 0
$skipped = 0

foreach ($packageFile in $packageFiles) {
  $pluginDir = Split-Path -Parent $packageFile
  $packageJson = Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not (Test-HasDependencies -PackageJson $packageJson)) {
    $skipped++
    continue
  }

  $nodeModules = Join-Path $pluginDir "node_modules"
  if ((Test-Path -LiteralPath $nodeModules) -and -not $Force) {
    Write-Host "Skipping $($packageJson.name): node_modules already exists. Use -Force to refresh."
    $skipped++
    continue
  }

  Write-Host "Installing plugin dependencies: $($packageJson.name)"
  Push-Location $pluginDir
  try {
    $lockFile = Join-Path $pluginDir "package-lock.json"
    if (Test-Path -LiteralPath $lockFile) {
      npm ci --omit=dev
    }
    else {
      npm install --omit=dev
    }
    if ($LASTEXITCODE -ne 0) {
      throw "npm dependency install failed in $pluginDir with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
  $installed++
}

Write-Host "Plugin dependency setup complete. Installed: $installed; skipped: $skipped."
