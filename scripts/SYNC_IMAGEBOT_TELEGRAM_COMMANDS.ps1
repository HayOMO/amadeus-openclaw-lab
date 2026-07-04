param(
  [string]$ConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json",
  [string]$AccountId = "imagebot",
  [string]$TokenFile = "",
  [switch]$SkipClear,
  [string[]]$LanguageCodesToClear = @("en", "zh")
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Read-Utf8Text([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Get-FallbackCommands {
  $catalogPath = Join-Path $RepoRoot "scripts\IMAGEBOT_COMMANDS.json"
  if (Test-Path -LiteralPath $catalogPath) {
    $catalog = Read-Utf8Text $catalogPath | ConvertFrom-Json
    return @(
      $catalog.commands |
        Where-Object { $_.menu -ne $false } |
        ForEach-Object {
          @{
            command = ([string]$_.command).Trim().ToLowerInvariant()
            description = ([string]$_.description).Trim()
          }
        }
    )
  }

  return @(
    @{ command = "amnew"; description = "Start a clean chat window" },
    @{ command = "amhelp"; description = "Show control commands" },
    @{ command = "amstatus"; description = "Show local bot status" },
    @{ command = "ammodel"; description = "Show or switch chat model" },
    @{ command = "ampersona"; description = "Show or switch speaking persona" },
    @{ command = "amtools"; description = "List safe script controls" }
  )
}

function Invoke-TelegramJson(
  [string]$Token,
  [string]$Method,
  [hashtable]$Body
) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  $response = Invoke-RestMethod `
    -Uri "https://api.telegram.org/bot$Token/$Method" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body $json

  if (-not $response.ok) {
    throw "Telegram API $Method failed."
  }

  return $response
}

function New-CommandList($RawCommands) {
  $fallback = Get-FallbackCommands

  $source = $fallback
  if ($source.Count -eq 0) {
    $source = @($RawCommands)
  }

  $seen = @{}
  $result = @()
  foreach ($entry in $source) {
    $name = [string]$entry.command
    $description = [string]$entry.description
    $name = $name.Trim().ToLowerInvariant()
    $description = $description.Trim()

    if ($name -notmatch "^[a-z0-9_]{1,32}$") {
      Write-Warning "Skipping invalid Telegram command name: $name"
      continue
    }
    if ($seen.ContainsKey($name)) {
      continue
    }
    if ([string]::IsNullOrWhiteSpace($description)) {
      $description = "Run $name"
    }
    if ($description.Length -gt 256) {
      $description = $description.Substring(0, 256)
    }

    $seen[$name] = $true
    $result += @{ command = $name; description = $description }
  }

  if ($result.Count -eq 0) {
    throw "No valid Telegram commands to sync."
  }

  return $result
}

function Copy-ScopeBody($Body) {
  $copy = @{}
  if ($null -eq $Body) {
    return $copy
  }
  foreach ($key in $Body.Keys) {
    $copy[$key] = $Body[$key]
  }
  return $copy
}

function New-ScopeEntry([string]$Name, $Scope) {
  if ($null -eq $Scope) {
    return @{ name = $Name; body = @{} }
  }
  return @{ name = $Name; body = @{ scope = $Scope } }
}

function Get-ConfiguredChatIds($Account) {
  $ids = @()

  if ($null -ne $Account.groups) {
    foreach ($property in $Account.groups.PSObject.Properties) {
      $name = [string]$property.Name
      if ($name -match "^-?\d+$") {
        $ids += $name
      }
    }
  }

  foreach ($field in @("allowedChats", "allowedChatIds", "chatIds", "groupIds")) {
    $value = $Account.$field
    if ($null -eq $value) {
      continue
    }
    foreach ($entry in @($value)) {
      $text = ([string]$entry).Trim()
      if ($text -match "^-?\d+$") {
        $ids += $text
      }
    }
  }

  return @($ids | Select-Object -Unique)
}

function New-CommandScopes($Account) {
  $scopes = @(
    (New-ScopeEntry "default" $null),
    (New-ScopeEntry "all_private_chats" @{ type = "all_private_chats" }),
    (New-ScopeEntry "all_group_chats" @{ type = "all_group_chats" }),
    (New-ScopeEntry "all_chat_administrators" @{ type = "all_chat_administrators" })
  )

  foreach ($chatId in Get-ConfiguredChatIds $Account) {
    $scopes += New-ScopeEntry "chat:$chatId" @{ type = "chat"; chat_id = $chatId }
  }

  return $scopes
}

function Invoke-DeleteCommandsForScope(
  [string]$Token,
  $Scope,
  [string[]]$LanguageCodes
) {
  $languageVariants = @("") + @($LanguageCodes | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  foreach ($languageCode in $languageVariants) {
    $body = Copy-ScopeBody $Scope.body
    if (-not [string]::IsNullOrWhiteSpace($languageCode)) {
      $body["language_code"] = $languageCode
    }
    try {
      Invoke-TelegramJson -Token $Token -Method "deleteMyCommands" -Body $body | Out-Null
    } catch {
      $label = $languageCode
      if ([string]::IsNullOrWhiteSpace($label)) {
        $label = "default-language"
      }
      Write-Warning ("Skipping command-menu clear for scope={0} language={1}: {2}" -f $Scope.name, $label, $_.Exception.Message)
    }
  }
}

Write-Host "Syncing Telegram command menu for OpenClaw account '$AccountId'..."

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "OpenClaw config not found: $ConfigPath"
}

$config = Read-Utf8Text $ConfigPath | ConvertFrom-Json
$account = $config.channels.telegram.accounts.$AccountId
if ($null -eq $account) {
  throw "Telegram account '$AccountId' not found in config."
}

if ([string]::IsNullOrWhiteSpace($TokenFile)) {
  $TokenFile = [string]$account.tokenFile
}
if ([string]::IsNullOrWhiteSpace($TokenFile)) {
  $TokenFile = "$env:USERPROFILE\.openclaw\secrets\telegram-$AccountId.token"
}
if (-not (Test-Path -LiteralPath $TokenFile)) {
  throw "Telegram token file not found: $TokenFile"
}

$token = (Read-Utf8Text $TokenFile).Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "Telegram token file is empty: $TokenFile"
}

$commands = New-CommandList $account.customCommands
$scopes = New-CommandScopes $account

foreach ($scope in $scopes) {
  if (-not $SkipClear) {
    Invoke-DeleteCommandsForScope -Token $token -Scope $scope -LanguageCodes $LanguageCodesToClear
    $clearedLanguages = @("default-language") + @($LanguageCodesToClear | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    Write-Host ("- cleared {0}: {1}" -f $scope.name, ($clearedLanguages -join ", "))
  }
  $body = Copy-ScopeBody $scope.body
  $body["commands"] = $commands
  Invoke-TelegramJson -Token $token -Method "setMyCommands" -Body $body | Out-Null
  Write-Host ("- set {0}: {1}" -f $scope.name, (($commands | ForEach-Object { "/" + $_.command }) -join ", "))
}

Write-Host "Verifying..."
foreach ($scope in $scopes) {
  $body = Copy-ScopeBody $scope.body
  $verify = Invoke-TelegramJson -Token $token -Method "getMyCommands" -Body $body
  $names = @($verify.result | ForEach-Object { "/" + $_.command })
  Write-Host ("- {0}: {1}" -f $scope.name, ($names -join ", "))
}

Write-Host "Done."
