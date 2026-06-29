param(
  [string]$Agent = "imagebot",
  [string]$DestinationRoot = "",
  [switch]$IncludeCuratedBackups,
  [switch]$LatestOnly,
  [switch]$AllowExternalDestination
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Desktop = [Environment]::GetFolderPath("Desktop")
if (-not $DestinationRoot) {
  $DestinationRoot = Join-Path $Desktop "Amaduse-Memory-Backup"
}

$Destination = Join-Path $DestinationRoot "latest"
$ArchiveRoot = ""
if (-not $LatestOnly) {
  $ArchiveRoot = Join-Path $DestinationRoot "snapshots"
}

$ExportScript = Join-Path $Root "scripts\EXPORT_IMAGEBOT_MEMORY_BACKUP.ps1"
if (-not (Test-Path -LiteralPath $ExportScript)) {
  throw "Base export script not found: $ExportScript"
}

$argsList = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $ExportScript,
  "-Agent",
  $Agent,
  "-Destination",
  $Destination
)

if ($ArchiveRoot) {
  $argsList += @("-ArchiveRoot", $ArchiveRoot)
}
if ($AllowExternalDestination) {
  $argsList += "-AllowExternalDestination"
}
if ($IncludeCuratedBackups) {
  $argsList += "-IncludeCuratedBackups"
}

& powershell.exe @argsList
exit $LASTEXITCODE
