param(
  [string]$Remote = "origin",
  [string]$Branch = "",
  [string]$Message = "",
  [switch]$DryRun,
  [switch]$NoPush,
  [switch]$SkipMemoryExport
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RuntimeDir = Join-Path $Root ".runtime"
$LogPath = Join-Path $RuntimeDir "github-backup.log"

New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
Set-Location -LiteralPath $Root

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  $line | Tee-Object -FilePath $LogPath -Append
}

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Get-CurrentBranch {
  $current = (& git branch --show-current).Trim()
  if (-not $current) {
    throw "Cannot determine current git branch."
  }
  return $current
}

function Get-StagedFiles {
  return @(& git diff --cached --name-only --diff-filter=ACMRTUXB | Where-Object { $_ })
}

function Test-SecretPatterns {
  param([string[]]$Files)
  if (-not $Files -or $Files.Count -eq 0) {
    return
  }

  $pattern = @(
    "\b\d{6,}:[A-Za-z0-9_-]{20,}\b",
    "(?<![A-Za-z])sk-[A-Za-z0-9_-]{20,}",
    "gh[pousr]_[A-Za-z0-9_]{30,}",
    "xox[baprs]-[A-Za-z0-9-]{20,}",
    "AIza[0-9A-Za-z_-]{35}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "OPENAI_API_KEY\s*=\s*\S+",
    "TELEGRAM_BOT_TOKEN\s*=\s*\S+"
  ) -join "|"

  $matches = & rg -n --pcre2 --no-heading $pattern -- $Files 2>$null
  if ($LASTEXITCODE -eq 0 -and $matches) {
    $matches | ForEach-Object { Write-Log "SECRET-SCAN $_" }
    throw "Secret scan found token-like content in staged files. Nothing was committed."
  }
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) {
    throw "Secret scan failed with exit code $LASTEXITCODE."
  }
}

$allowPaths = @(
  ".gitattributes",
  ".gitignore",
  "package.json",
  "README.md",
  "IMAGEBOT_COMMANDS.md",
  "FINISH_IMAGEBOT_SETUP.ps1",
  "REPAIR_IMAGEBOT_TOKEN.ps1",
  "IMAGEBOT_APP.cmd",
  "IMAGEBOT_CONTROL_PANEL.cmd",
  "IMAGEBOT_CONTROL_PANEL.ps1",
  "BACKUP_IMAGEBOT_MEMORY_TO_DESKTOP.cmd",
  "RESTART_IMAGEBOT_GATEWAY.cmd",
  "RESTART_IMAGEBOT_GATEWAY.ps1",
  "RUN_IMAGEBOT_GATEWAY.ps1",
  "START_IMAGEBOT_GATEWAY.cmd",
  "START_IMAGEBOT_GATEWAY.ps1",
  "STATUS_IMAGEBOT_GATEWAY.cmd",
  "STATUS_IMAGEBOT_GATEWAY.ps1",
  "STOP_IMAGEBOT_GATEWAY.cmd",
  "STOP_IMAGEBOT_GATEWAY.ps1",
  "SET_IMAGEBOT_STATUS_NAME.ps1",
  "WATCH_TELEGRAM_UPDATES.ps1",
  "imagebot-control-server.js",
  "imagebot-launcher.js",
  "app",
  "config",
  "docs",
  "features",
  "native",
  "patches",
  "persona",
  "plugins",
  "prompt_library",
  "scripts",
  "tool_manuals"
)

Write-Log "Starting imagebot GitHub backup."
Invoke-Git rev-parse --is-inside-work-tree *> $null

if (-not $Branch) {
  $Branch = Get-CurrentBranch
}

$remoteUrl = (& git remote get-url $Remote 2>$null).Trim()
if (-not $remoteUrl) {
  throw "Git remote '$Remote' is not configured."
}
Write-Log "Remote: $Remote ($remoteUrl)"
Write-Log "Branch: $Branch"

if (-not $SkipMemoryExport) {
  Write-Log "Memory contents are local-only and are not exported or staged for GitHub."
  Write-Log "For local memory backup, run scripts\\EXPORT_IMAGEBOT_MEMORY_DESKTOP_BACKUP.ps1."
}

if ($DryRun) {
  Write-Log "Dry run only. Candidate status:"
  & git status --short
  Write-Log "Dry run complete."
  exit 0
}

$gitAddArgs = @("add", "--") + $allowPaths
Invoke-Git @gitAddArgs
$staged = Get-StagedFiles
if (-not $staged -or $staged.Count -eq 0) {
  Write-Log "No staged changes to back up."
  exit 0
}

Test-SecretPatterns -Files $staged
$checkOutput = & git diff --cached --check 2>&1
if ($LASTEXITCODE -ne 0) {
  $checkOutput | ForEach-Object { Write-Log "DIFF-CHECK $_" }
  Write-Log "Continuing despite diff whitespace warnings; runtime patch files may intentionally preserve upstream whitespace."
}

if (-not $Message) {
  $Message = "Backup imagebot state $(Get-Date -Format 'yyyy-MM-dd HHmm')"
}

Invoke-Git commit -m $Message
if (-not $NoPush) {
  Invoke-Git push -u $Remote $Branch
}

Write-Log "Backup complete."
