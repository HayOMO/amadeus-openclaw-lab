[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ShortcutName = "Amaduse Imagebot.lnk",
  [switch]$WebApp
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$targetCmd = Join-Path $repoRoot "IMAGEBOT_APP.cmd"
$nativeExe = Join-Path $repoRoot "native\bin\AmaduseImagebot.exe"
$iconPath = Join-Path $repoRoot "native\AmaduseImagebot.ico"

if (-not (Test-Path -LiteralPath $targetCmd -PathType Leaf)) {
  throw "Launcher target not found: $targetCmd"
}

$desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
  throw "Could not resolve the current user's Desktop folder."
}

$cmd = $env:ComSpec
if ([string]::IsNullOrWhiteSpace($cmd) -or -not (Test-Path -LiteralPath $cmd -PathType Leaf)) {
  $cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
}
if (-not (Test-Path -LiteralPath $cmd -PathType Leaf)) {
  throw "Could not resolve cmd.exe for shortcut target."
}

$shortcutPath = Join-Path $desktop $ShortcutName
$iconLocation = if (Test-Path -LiteralPath $iconPath -PathType Leaf) { "$iconPath,0" } else { "$cmd,0" }
$useNative = -not $WebApp -and (Test-Path -LiteralPath $nativeExe -PathType Leaf)

if ($useNative) {
  $target = $nativeExe
  $arguments = ""
}
else {
  $target = $cmd
  $arguments = "/d /c ""$targetCmd"""
}

if ($PSCmdlet.ShouldProcess($shortcutPath, "bind to $target")) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $target
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.IconLocation = $iconLocation
  $shortcut.Description = "Open the Amaduse Imagebot control panel from the current project checkout."
  $shortcut.Save()
}

[pscustomobject]@{
  Shortcut = $shortcutPath
  Target = $target
  Arguments = $arguments
  WorkingDirectory = $repoRoot
  IconLocation = $iconLocation
}
