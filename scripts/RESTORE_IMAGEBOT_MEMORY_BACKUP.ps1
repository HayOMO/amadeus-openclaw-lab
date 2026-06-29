param(
  [string]$Agent = "imagebot",
  [string]$Source = "",
  [switch]$Force,
  [switch]$AllowExternalSource
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Source) {
  $Source = Join-Path ([Environment]::GetFolderPath("Desktop")) "Amaduse-Memory-Backup\latest"
}

$Target = Join-Path $HOME ".openclaw\agents\$Agent\sessions\sessions.json.telegram-imagebot-memory"
$ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
$ResolvedSource = [System.IO.Path]::GetFullPath($Source)
$DesktopBackupRoot = Join-Path ([Environment]::GetFolderPath("Desktop")) "Amaduse-Memory-Backup"
$ResolvedDesktopBackupRoot = [System.IO.Path]::GetFullPath($DesktopBackupRoot)

function Test-IsSubPath {
  param(
    [string]$Path,
    [string]$Parent
  )
  $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  return ($resolvedPath.Equals($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase) -or
    $resolvedPath.StartsWith($resolvedParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))
}

if (-not ((Test-IsSubPath $ResolvedSource $ResolvedRoot) -or (Test-IsSubPath $ResolvedSource $ResolvedDesktopBackupRoot) -or $AllowExternalSource)) {
  throw "Source must stay inside the repository or Desktop Amaduse-Memory-Backup. Use -AllowExternalSource for another local disk path: $ResolvedSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $ResolvedSource "manifest.json"))) {
  throw "Memory backup manifest not found under: $ResolvedSource"
}

if (-not $Force) {
  throw "This will replace the active imagebot memory store. Re-run with -Force after stopping the gateway."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (Test-Path -LiteralPath $Target) {
  $backup = "$Target.restore-backup-$stamp"
  Move-Item -LiteralPath $Target -Destination $backup
  Write-Host "Existing memory moved to $backup"
}

New-Item -ItemType Directory -Force $Target | Out-Null
foreach ($name in @("users", "group", "windows", "curated-backups")) {
  $sourceDir = Join-Path $ResolvedSource $name
  if (Test-Path -LiteralPath $sourceDir) {
    Copy-Item -LiteralPath $sourceDir -Destination (Join-Path $Target $name) -Recurse -Force
  }
}

Copy-Item -LiteralPath (Join-Path $ResolvedSource "manifest.json") -Destination (Join-Path $Target "restored-from-manifest.json") -Force
Remove-Item -LiteralPath (Join-Path $Target "semantic-index.json") -Force -ErrorAction SilentlyContinue

Write-Host "Restored imagebot memory from $ResolvedSource"
Write-Host "Restart the gateway so the restored memory is used."
