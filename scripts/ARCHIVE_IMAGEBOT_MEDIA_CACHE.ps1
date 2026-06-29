param(
  [string]$MediaRoot = (Join-Path $env:USERPROFILE ".openclaw\media"),
  [string]$ArchiveRoot = (Join-Path $env:USERPROFILE ".openclaw\media\archive"),
  [int64]$MaxBytes = 107374182400,
  [switch]$IncludeInbound
)

$ErrorActionPreference = "Stop"

$allowedExts = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
@(
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  ".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv",
  ".mp3", ".wav", ".ogg", ".m4a",
  ".pdf"
) | ForEach-Object { [void]$allowedExts.Add($_) }

$allowedDirs = @(
  "tool-image-generation",
  "downloaded",
  "video-keyframes",
  "outbound",
  "browser"
)
if ($IncludeInbound) {
  $allowedDirs += "inbound"
}

function Get-SafeBaseName {
  param([string]$Name, [string]$Fallback = "media")
  $base = [IO.Path]::GetFileNameWithoutExtension($Name)
  if ([string]::IsNullOrWhiteSpace($base)) { $base = $Fallback }
  $base = $base -replace '[<>:"/\\|?*\x00-\x1f]', '-'
  $base = $base -replace '\s+', '-'
  $base = $base -replace '-+', '-'
  $base = $base.Trim(".-")
  if ($base.Length -gt 80) { $base = $base.Substring(0, 80) }
  if ([string]::IsNullOrWhiteSpace($base)) { return $Fallback }
  return $base
}

function Add-ManifestLine {
  param(
    [string]$ManifestPath,
    [object]$Record
  )
  $line = $Record | ConvertTo-Json -Compress -Depth 5
  Add-Content -LiteralPath $ManifestPath -Value $line -Encoding UTF8
}

function Get-ArchiveRelativePath {
  param(
    [string]$BasePath,
    [string]$TargetPath
  )
  $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $targetFull = [IO.Path]::GetFullPath($TargetPath)
  $baseUri = New-Object System.Uri($baseFull)
  $targetUri = New-Object System.Uri($targetFull)
  return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', [IO.Path]::DirectorySeparatorChar)
}

$mediaRootResolved = [IO.Path]::GetFullPath($MediaRoot)
$archiveRootResolved = [IO.Path]::GetFullPath($ArchiveRoot)
$manifestPath = Join-Path $archiveRootResolved "manifest.jsonl"

New-Item -ItemType Directory -Force -Path $archiveRootResolved | Out-Null

$knownArchived = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
if (Test-Path -LiteralPath $manifestPath) {
  Get-Content -LiteralPath $manifestPath -ErrorAction SilentlyContinue | ForEach-Object {
    if ([string]::IsNullOrWhiteSpace($_)) { return }
    try {
      $record = $_ | ConvertFrom-Json
      if ($record.archivedRelativePath) {
        [void]$knownArchived.Add([string]$record.archivedRelativePath)
      }
    } catch {
      # Ignore malformed historical lines; this script should be salvage-friendly.
    }
  }
}

$scanned = 0
$archived = 0
$existing = 0
$skipped = 0

foreach ($dirName in $allowedDirs) {
  $sourceDir = Join-Path $mediaRootResolved $dirName
  if (!(Test-Path -LiteralPath $sourceDir)) { continue }
  $files = @(Get-ChildItem -LiteralPath $sourceDir -Recurse -File -ErrorAction SilentlyContinue)
  foreach ($file in $files) {
    $scanned += 1
    if (!$allowedExts.Contains($file.Extension)) { $skipped += 1; continue }
    if ($file.Length -le 0 -or $file.Length -gt $MaxBytes) { $skipped += 1; continue }

    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $month = $file.LastWriteTime.ToString("yyyy-MM")
    $destDir = Join-Path $archiveRootResolved $month
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null

    $base = Get-SafeBaseName -Name $file.Name
    $toolPart = Get-SafeBaseName -Name $dirName
    $destName = "$($hash.Substring(0, 16))-$toolPart-$base$($file.Extension.ToLowerInvariant())"
    $destPath = Join-Path $destDir $destName
    $relativePath = Get-ArchiveRelativePath -BasePath $archiveRootResolved -TargetPath $destPath

    if ($knownArchived.Contains($relativePath)) {
      $existing += 1
      continue
    }

    $copied = $false
    if (!(Test-Path -LiteralPath $destPath)) {
      Copy-Item -LiteralPath $file.FullName -Destination $destPath -ErrorAction Stop
      $copied = $true
      $archived += 1
    } else {
      $existing += 1
    }

    Add-ManifestLine -ManifestPath $manifestPath -Record ([ordered]@{
      t = (Get-Date).ToUniversalTime().ToString("o")
      tool = "cache-backfill"
      sourceKind = $dirName
      sourceName = $file.Name
      sizeBytes = $file.Length
      sha256 = $hash
      archivedRelativePath = $relativePath
      copied = $copied
    })
    [void]$knownArchived.Add($relativePath)
  }
}

Write-Host "Imagebot media cache archive complete."
Write-Host "Media root: $mediaRootResolved"
Write-Host "Archive root: $archiveRootResolved"
Write-Host "Scanned: $scanned"
Write-Host "Archived: $archived"
Write-Host "Existing: $existing"
Write-Host "Skipped: $skipped"
