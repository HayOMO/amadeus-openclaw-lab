param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("online", "offline", "custom", "get")]
  [string]$Status,

  [string]$Name,
  [int]$WaitOnRateLimitSeconds = 0,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root ".runtime"
$NameLog = Join-Path $RuntimeDir "imagebot-name.log"
$CooldownFile = Join-Path $RuntimeDir "imagebot-name.cooldown.json"
$PendingFile = Join-Path $RuntimeDir "imagebot-name.pending"
New-Item -ItemType Directory -Force $RuntimeDir | Out-Null

function Write-NameLog {
  param([string]$Message)
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Add-Content -LiteralPath $NameLog -Value $line
}

function Get-TelegramBotTarget {
  $configPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "OpenClaw config not found at $configPath"
  }

  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $telegram = $config.channels.telegram
  $account = $telegram.accounts.imagebot
  if (-not $account) {
    throw "Telegram account imagebot is not configured"
  }

  $tokenFile = [string]$account.tokenFile
  if (-not $tokenFile) {
    throw "Telegram account imagebot has no tokenFile configured"
  }
  if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw "Telegram tokenFile does not exist"
  }

  $proxy = $null
  if ($account.proxy) {
    $proxy = [string]$account.proxy
  }
  elseif ($telegram.proxy) {
    $proxy = [string]$telegram.proxy
  }

  [pscustomobject]@{
    TokenFile = $tokenFile
    Proxy = $proxy
  }
}

function Resolve-DesiredName {
  switch ($Status) {
    "online" { return "Amadeus [ONLINE]" }
    "offline" { return "Amadeus [OFFLINE]" }
    "get" { return $null }
    default {
      if (-not $Name) {
        throw "Custom status requires -Name"
      }
      if ($Name.Length -gt 64) {
        throw "Telegram bot display name must be 64 characters or fewer"
      }
      return $Name
    }
  }
}

function Read-TelegramError {
  param($ErrorRecord)

  $response = $ErrorRecord.Exception.Response
  if (-not $response) {
    return [pscustomobject]@{
      StatusCode = $null
      Body = $null
      RetryAfter = $null
      Description = $ErrorRecord.Exception.Message
    }
  }

  $body = $null
  try {
    $stream = $response.GetResponseStream()
    if ($stream) {
      $reader = New-Object System.IO.StreamReader($stream)
      $body = $reader.ReadToEnd()
    }
  }
  catch {
  }

  $retryAfter = $null
  $description = $ErrorRecord.Exception.Message
  if ($body) {
    try {
      $json = $body | ConvertFrom-Json
      if ($json.description) {
        $description = [string]$json.description
      }
      if ($json.parameters -and $json.parameters.retry_after) {
        $retryAfter = [int]$json.parameters.retry_after
      }
    }
    catch {
    }
  }

  $statusCode = $null
  try {
    $statusCode = [int]$response.StatusCode
  }
  catch {
  }

  [pscustomobject]@{
    StatusCode = $statusCode
    Body = $body
    RetryAfter = $retryAfter
    Description = $description
  }
}

function Save-PendingStatus {
  param(
    [string]$StatusValue,
    [string]$DesiredName
  )

  $payload = [pscustomobject]@{
    status = $StatusValue
    desiredName = $DesiredName
    updatedAt = (Get-Date).ToString("o")
  }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $PendingFile -Encoding UTF8
}

function Save-RateLimitCooldown {
  param(
    [int]$RetryAfterSeconds,
    [string]$StatusValue,
    [string]$DesiredName,
    [string]$Description
  )

  $until = (Get-Date).AddSeconds([Math]::Max(1, $RetryAfterSeconds))
  $payload = [pscustomobject]@{
    until = $until.ToString("o")
    retryAfterSeconds = $RetryAfterSeconds
    status = $StatusValue
    desiredName = $DesiredName
    description = $Description
    updatedAt = (Get-Date).ToString("o")
  }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $CooldownFile -Encoding UTF8
  Save-PendingStatus -StatusValue $StatusValue -DesiredName $DesiredName
  Write-NameLog "rate-limited status=$StatusValue desired=$DesiredName retryAfterSeconds=$RetryAfterSeconds until=$($until.ToString('s')) description=$Description"
}

function Get-ActiveCooldown {
  if (-not (Test-Path -LiteralPath $CooldownFile)) {
    return $null
  }

  try {
    $cooldown = Get-Content -Raw -LiteralPath $CooldownFile | ConvertFrom-Json
    $until = [datetime]::Parse([string]$cooldown.until)
    if ($until -gt (Get-Date)) {
      return [pscustomobject]@{
        Until = $until
        SecondsLeft = [int][Math]::Ceiling(($until - (Get-Date)).TotalSeconds)
        Raw = $cooldown
      }
    }
  }
  catch {
  }

  Remove-Item -LiteralPath $CooldownFile -Force -ErrorAction SilentlyContinue
  return $null
}

function Invoke-TelegramBotApi {
  param(
    [string]$Token,
    [string]$Method,
    [hashtable]$Body,
    [string]$Proxy
  )

  $requestParams = @{
    Method = "Post"
    Uri = "https://api.telegram.org/bot$Token/$Method"
    TimeoutSec = 8
  }
  if ($Body) {
    $requestParams.Body = $Body
    $requestParams.ContentType = "application/x-www-form-urlencoded"
  }
  if ($Proxy) {
    $requestParams.Proxy = $Proxy
  }

  Invoke-RestMethod @requestParams
}

try {
  $target = Get-TelegramBotTarget
  $desiredName = Resolve-DesiredName

  if ($DryRun) {
    Write-NameLog "dry-run status=$Status desired=$desiredName proxy=$($target.Proxy)"
    Write-Host "Dry run OK: status=$Status desired=$desiredName"
    return
  }

  $token = (Get-Content -Raw -LiteralPath $target.TokenFile).Trim()
  if (-not $token) {
    throw "Telegram tokenFile is empty"
  }

  if ($Status -eq "get") {
    $current = Invoke-TelegramBotApi -Token $token -Method "getMyName" -Proxy $target.Proxy
    $currentName = [string]$current.result.name
    Write-NameLog "current name=$currentName"
    Write-Host $currentName
    return
  }

  if (-not $Force) {
    $activeCooldown = Get-ActiveCooldown
    if ($activeCooldown) {
      Save-PendingStatus -StatusValue $Status -DesiredName $desiredName
      $message = "Telegram name change is rate-limited for about $($activeCooldown.SecondsLeft)s; pending status=$Status desired=$desiredName"
      Write-NameLog "skipped-rate-limit status=$Status desired=$desiredName secondsLeft=$($activeCooldown.SecondsLeft)"
      Write-Warning $message
      return
    }
  }

  $currentName = $null
  try {
    $current = Invoke-TelegramBotApi -Token $token -Method "getMyName" -Proxy $target.Proxy
    $currentName = [string]$current.result.name
  }
  catch {
  }

  if ($currentName -eq $desiredName) {
    Remove-Item -LiteralPath $CooldownFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PendingFile -Force -ErrorAction SilentlyContinue
    Write-NameLog "unchanged status=$Status name=$desiredName"
    Write-Host "Name already set: $desiredName"
    return
  }

  try {
    Invoke-TelegramBotApi -Token $token -Method "setMyName" -Body @{ name = $desiredName } -Proxy $target.Proxy | Out-Null
  }
  catch {
    $telegramError = Read-TelegramError -ErrorRecord $_
    if ($telegramError.StatusCode -eq 429) {
      $retryAfter = if ($telegramError.RetryAfter) { [int]$telegramError.RetryAfter } else { 21600 }
      if ($WaitOnRateLimitSeconds -gt 0 -and $retryAfter -le $WaitOnRateLimitSeconds) {
        Write-NameLog "waiting-rate-limit status=$Status retryAfterSeconds=$retryAfter"
        Start-Sleep -Seconds $retryAfter
        Invoke-TelegramBotApi -Token $token -Method "setMyName" -Body @{ name = $desiredName } -Proxy $target.Proxy | Out-Null
      }
      else {
        Save-RateLimitCooldown -RetryAfterSeconds $retryAfter -StatusValue $Status -DesiredName $desiredName -Description $telegramError.Description
        Write-Warning "Telegram rejected setMyName with 429 Too Many Requests; retry after about ${retryAfter}s. Pending status saved: $Status -> $desiredName"
        return
      }
    }
    else {
      throw
    }
  }

  Remove-Item -LiteralPath $CooldownFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PendingFile -Force -ErrorAction SilentlyContinue
  Write-NameLog "set status=$Status name=$desiredName previous=$currentName"
  Write-Host "Name set: $desiredName"
}
catch {
  $msg = $_.Exception.Message
  Write-NameLog "failed status=$Status error=$msg"
  Write-Warning $msg
}
