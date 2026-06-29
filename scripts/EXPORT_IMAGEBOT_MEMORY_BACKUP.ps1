param(
  [string]$Agent = "imagebot",
  [string]$Destination = "",
  [string]$ArchiveRoot = "",
  [switch]$IncludeCuratedBackups,
  [switch]$AllowExternalDestination
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Destination) {
  $Desktop = [Environment]::GetFolderPath("Desktop")
  $Destination = Join-Path $Desktop "Amaduse-Memory-Backup\latest"
}

$Source = Join-Path $HOME ".openclaw\agents\$Agent\sessions\sessions.json.telegram-imagebot-memory"
$ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
$ResolvedDestination = [System.IO.Path]::GetFullPath($Destination)
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

function Assert-NotFilesystemRoot {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
  if ($full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a filesystem root as a memory backup path: $full"
  }
}

function Assert-SafeDestination {
  param(
    [string]$Path,
    [string]$Purpose
  )
  Assert-NotFilesystemRoot $Path
  if ((Test-IsSubPath $Path $ResolvedRoot) -or (Test-IsSubPath $Path $ResolvedDesktopBackupRoot) -or $AllowExternalDestination) {
    return
  }
  throw "$Purpose must stay inside the repository or Desktop Amaduse-Memory-Backup. Use -AllowExternalDestination for another local disk path: $Path"
}

Assert-SafeDestination $ResolvedDestination "Destination"

function ConvertTo-SanitizedText {
  param([string]$Text)
  return [string]$Text `
    -replace '\b\d{6,}:[A-Za-z0-9_-]{20,}\b', '[telegram-token-redacted]' `
    -replace '[A-Za-z]:\\[^\s<>"'']+', '[local-path-redacted]' `
    -replace '\b(?:\d{1,3}\.){3}\d{1,3}\b', '[ip-redacted]' `
    -replace '[A-Za-z0-9_-]{48,}', '[long-token-redacted]'
}

function Write-SanitizedFile {
  param(
    [string]$SourcePath,
    [string]$TargetPath
  )
  New-Item -ItemType Directory -Force (Split-Path -Parent $TargetPath) | Out-Null
  $text = Get-Content -LiteralPath $SourcePath -Raw -ErrorAction Stop
  $sanitized = (ConvertTo-SanitizedText $text).TrimEnd() + "`n"
  Set-Content -LiteralPath $TargetPath -Encoding UTF8 -NoNewline -Value $sanitized
}

function Copy-MemoryDir {
  param(
    [string]$Name,
    [string]$Filter = "*.md"
  )
  $dir = Join-Path $Source $Name
  if (-not (Test-Path -LiteralPath $dir)) {
    return 0
  }
  $count = 0
  $base = [System.IO.Path]::GetFullPath($dir).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  foreach ($file in Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $Filter) {
    $filePath = [System.IO.Path]::GetFullPath($file.FullName)
    if (-not $filePath.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $relative = $filePath.Substring($base.Length)
    $target = Join-Path (Join-Path $ResolvedDestination $Name) $relative
    Write-SanitizedFile -SourcePath $file.FullName -TargetPath $target
    $count++
  }
  return $count
}

if (-not (Test-Path -LiteralPath $Source)) {
  throw "Imagebot memory source not found: $Source"
}

if (Test-Path -LiteralPath $ResolvedDestination) {
  $resolvedExisting = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ResolvedDestination).Path)
  Assert-SafeDestination $resolvedExisting "Existing destination"
  Remove-Item -LiteralPath $resolvedExisting -Recurse -Force
}
New-Item -ItemType Directory -Force $ResolvedDestination | Out-Null

$counts = [ordered]@{
  users = Copy-MemoryDir -Name "users"
  group = Copy-MemoryDir -Name "group"
  windows = Copy-MemoryDir -Name "windows"
  curatedBackups = 0
}

if ($IncludeCuratedBackups) {
  $counts.curatedBackups = Copy-MemoryDir -Name "curated-backups"
}

$manifest = [ordered]@{
  version = 1
  agent = $Agent
  source = "sanitized:$Agent.telegram-imagebot-memory"
  included = @(
    "users/*.md",
    "group/*.md",
    "windows/*.md"
  )
  excluded = @(
    "semantic-index.json",
    "raw sessions.json/jsonl",
    "tokens/secrets",
    "logs",
    "generated media",
    "OpenClaw runtime state"
  )
  counts = $counts
}

if ($IncludeCuratedBackups) {
  $manifest.included += "curated-backups/*.md"
}
else {
  $manifest.excluded += "curated-backups"
}

($manifest | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $ResolvedDestination "manifest.json") -Encoding UTF8

if ($ArchiveRoot) {
  $resolvedArchiveRoot = [System.IO.Path]::GetFullPath($ArchiveRoot)
  Assert-SafeDestination $resolvedArchiveRoot "Archive root"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $archiveDestination = Join-Path $resolvedArchiveRoot $stamp
  Assert-SafeDestination $archiveDestination "Archive destination"
  New-Item -ItemType Directory -Force (Split-Path -Parent $archiveDestination) | Out-Null
  Copy-Item -LiteralPath $ResolvedDestination -Destination $archiveDestination -Recurse -Force
  Write-Host "Archived imagebot memory backup to $archiveDestination"
}

Write-Host "Exported sanitized imagebot memory backup to $ResolvedDestination"
Write-Host (($counts | ConvertTo-Json -Compress))
