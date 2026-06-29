param(
  [int]$Seconds = 60
)

$ErrorActionPreference = "Stop"
$tokenFile = Join-Path $env:USERPROFILE ".openclaw\secrets\telegram-imagebot.token"

if (-not (Test-Path -LiteralPath $tokenFile)) {
  throw "Token file not found: $tokenFile"
}

$token = Get-Content -Raw -LiteralPath $tokenFile
$deadline = (Get-Date).AddSeconds($Seconds)
$offset = $null

Write-Host "Watching Telegram Bot API updates for $Seconds seconds."
Write-Host "IMPORTANT: stop OpenClaw gateway first, then send /draw@YOUR_BOT_USERNAME ping in the group."
Write-Host "Token will not be printed."
Write-Host ""

while ((Get-Date) -lt $deadline) {
  $url = "https://api.telegram.org/bot$token/getUpdates?timeout=5&limit=10"
  if ($offset -ne $null) {
    $url += "&offset=$offset"
  }

  $res = Invoke-RestMethod -Uri $url -TimeoutSec 15
  foreach ($update in $res.result) {
    $offset = [int64]$update.update_id + 1
    $msg = $update.message
    if (-not $msg) {
      $msg = $update.edited_message
    }

    if ($msg) {
      $chat = $msg.chat
      $from = $msg.from
      $text = $msg.text
      Write-Host "UPDATE"
      Write-Host "  update_id: $($update.update_id)"
      Write-Host "  chat.id: $($chat.id)"
      Write-Host "  chat.type: $($chat.type)"
      Write-Host "  chat.title: $($chat.title)"
      Write-Host "  from.id: $($from.id)"
      Write-Host "  from.username: $($from.username)"
      Write-Host "  text: $text"
      Write-Host ""
    }
    else {
      Write-Host "UPDATE $($update.update_id): non-message update"
    }
  }
}

Write-Host "Done."
