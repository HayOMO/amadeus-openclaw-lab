[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$source = Join-Path $repoRoot "native\AmaduseImagebot.cs"
$icon = Join-Path $repoRoot "native\AmaduseImagebot.ico"
$outputDir = Join-Path $repoRoot "native\bin"
$output = Join-Path $outputDir "AmaduseImagebot.exe"

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Native launcher source not found: $source"
}

$cscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) {
  $pathCsc = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($pathCsc) {
    $csc = $pathCsc.Source
  }
}
if (-not $csc) {
  throw "Could not find csc.exe. Install .NET Framework build tools or run from a machine that has csc.exe."
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$arguments = @(
  "/nologo",
  "/target:winexe",
  "/platform:anycpu",
  "/out:$output",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  $source
)
if (Test-Path -LiteralPath $icon -PathType Leaf) {
  $arguments = @("/win32icon:$icon") + $arguments
}

& $csc @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Native launcher build failed with exit code $LASTEXITCODE."
}

[pscustomobject]@{
  Source = $source
  Output = $output
  Compiler = $csc
}
