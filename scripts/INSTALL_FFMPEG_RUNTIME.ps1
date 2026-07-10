param(
  [string]$Version = '8.1.2',
  [string]$StateDir = $env:OPENCLAW_STATE_DIR
)

$ErrorActionPreference = 'Stop'

function Resolve-StateDir {
  param([string]$Configured)
  if ($Configured) {
    return [System.IO.Path]::GetFullPath($Configured)
  }
  if ($env:OPENCLAW_HOME) {
    return [System.IO.Path]::GetFullPath((Join-Path $env:OPENCLAW_HOME '.openclaw'))
  }
  return [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.openclaw'))
}

function Assert-ChildPath {
  param([string]$Parent, [string]$Child)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes intended parent: $childFull"
  }
  return $childFull
}

function Move-FileWithRetry {
  param([string]$Source, [string]$Destination)
  $lastError = $null
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
      Move-Item -LiteralPath $Source -Destination $Destination
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 500
    }
  }
  throw $lastError
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

$stateRoot = Resolve-StateDir $StateDir
$runtimeRoot = Join-Path $stateRoot 'runtime\ffmpeg'
$targetDir = Assert-ChildPath $runtimeRoot (Join-Path $runtimeRoot $Version)
$sourceUrl = "https://github.com/GyanD/codexffmpeg/releases/download/$Version/ffmpeg-$Version-essentials_build.zip"
$checksumUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$Version-essentials_build.zip.sha256"
$downloadsDir = Assert-ChildPath $runtimeRoot (Join-Path $runtimeRoot 'downloads')
$archivePath = Assert-ChildPath $downloadsDir (Join-Path $downloadsDir "ffmpeg-$Version-essentials_build.zip")
$partialArchivePath = Assert-ChildPath $downloadsDir "$archivePath.part"
$checksumPath = Assert-ChildPath $downloadsDir "$archivePath.sha256"
$scratchParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$scratchDir = Assert-ChildPath $scratchParent (Join-Path $scratchParent ("amaduse-ffmpeg-" + [guid]::NewGuid().ToString('N')))

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
New-Item -ItemType Directory -Force -Path $downloadsDir | Out-Null

$gitCurlPath = 'C:\Program Files\Git\mingw64\bin\curl.exe'
$curl = if (Test-Path -LiteralPath $gitCurlPath) { Get-Item -LiteralPath $gitCurlPath } else { Get-Command 'curl.exe' -ErrorAction SilentlyContinue }
if ($curl) {
  & $curl.FullName --ssl-no-revoke --fail --location --retry 5 --retry-all-errors --retry-delay 2 --silent --show-error --output $checksumPath $checksumUrl
  if ($LASTEXITCODE -ne 0) {
    Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing
  }
} else {
  Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing
}
$expected = (Get-Content -LiteralPath $checksumPath -Raw).Trim().Split()[0].ToLowerInvariant()

if (-not (Test-Path -LiteralPath $targetDir)) {
  if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Host "Downloading FFmpeg $Version from $sourceUrl"
    if ($curl) {
      & $curl.FullName --ssl-no-revoke --fail --location --retry 8 --retry-all-errors --retry-delay 2 --continue-at - --output $partialArchivePath $sourceUrl
      if ($LASTEXITCODE -ne 0) { throw "Failed to download FFmpeg archive: exit $LASTEXITCODE" }
      Move-FileWithRetry -Source $partialArchivePath -Destination $archivePath
    } else {
      Invoke-WebRequest -Uri $sourceUrl -OutFile $partialArchivePath -UseBasicParsing
      Move-FileWithRetry -Source $partialArchivePath -Destination $archivePath
    }
  }
  $actual = Get-Sha256Hex -Path $archivePath
  if ($actual -ne $expected) {
    throw "FFmpeg SHA-256 mismatch: expected $expected, got $actual"
  }

  New-Item -ItemType Directory -Force -Path $scratchDir | Out-Null
  try {
    $extractDir = Join-Path $scratchDir 'extract'

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
    $ffmpegCandidate = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $ffprobeCandidate = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
    if (-not $ffmpegCandidate -or -not $ffprobeCandidate) {
      throw 'Downloaded archive does not contain ffmpeg.exe and ffprobe.exe'
    }
    $payloadRoot = Split-Path (Split-Path $ffmpegCandidate.FullName -Parent) -Parent
    $payloadRoot = Assert-ChildPath $scratchDir $payloadRoot
    Move-Item -LiteralPath $payloadRoot -Destination $targetDir
  }
  finally {
    $safeScratch = Assert-ChildPath $scratchParent $scratchDir
    if (Test-Path -LiteralPath $safeScratch) {
      Remove-Item -LiteralPath $safeScratch -Recurse -Force
    }
  }
}

$ffmpegPath = Join-Path $targetDir 'bin\ffmpeg.exe'
$ffprobePath = Join-Path $targetDir 'bin\ffprobe.exe'
if (-not (Test-Path -LiteralPath $ffmpegPath) -or -not (Test-Path -LiteralPath $ffprobePath)) {
  throw "Installed FFmpeg runtime is incomplete: $targetDir"
}

$ffmpegVersion = (& $ffmpegPath -version | Select-Object -First 1)
$ffprobeVersion = (& $ffprobePath -version | Select-Object -First 1)
if ($ffmpegVersion -notmatch "ffmpeg version $([regex]::Escape($Version))") {
  throw "Unexpected ffmpeg version: $ffmpegVersion"
}

$manifest = [ordered]@{
  schema = 1
  version = $Version
  installedAt = [DateTimeOffset]::UtcNow.ToString('o')
  sourceUrl = $sourceUrl
  sha256 = $expected
  root = $targetDir
  ffmpegPath = $ffmpegPath
  ffprobePath = $ffprobePath
  ffmpegVersion = $ffmpegVersion
  ffprobeVersion = $ffprobeVersion
}
$manifestPath = Join-Path $runtimeRoot 'current.json'
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host $ffmpegVersion
Write-Host $ffprobeVersion
Write-Host "Media runtime manifest: $manifestPath"
