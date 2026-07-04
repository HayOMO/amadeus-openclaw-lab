param(
  [string]$BaseUrl = 'https://danbooru.donmai.us'
)

$ErrorActionPreference = 'Stop'

Write-Host 'Store Danbooru API credentials'
Write-Host 'This stores credentials in ~/.openclaw/secrets/danbooru-imagebot.json.'
Write-Host 'It is not written to this repo and should not be committed.'
Write-Host ''

$login = Read-Host 'Danbooru login name'
if ([string]::IsNullOrWhiteSpace($login)) {
  throw 'Empty login name.'
}
$login = $login.Trim()

$secure = Read-Host 'Paste Danbooru API key (input hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'Empty API key.'
  }
  $apiKey = $apiKey.Trim()

  $baseUri = [Uri]$BaseUrl
  if ($baseUri.Scheme -ne 'https') {
    throw 'BaseUrl must be an https URL.'
  }

  $secretDir = Join-Path $env:USERPROFILE '.openclaw\secrets'
  $secretFile = Join-Path $secretDir 'danbooru-imagebot.json'
  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null

  $payload = [ordered]@{
    login = $login
    apiKey = $apiKey
    baseUrl = $baseUri.GetLeftPart([System.UriPartial]::Authority)
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }

  $json = $payload | ConvertTo-Json -Depth 4
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($secretFile, $json, $utf8NoBom)

  try {
    $acl = Get-Acl -LiteralPath $secretFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $env:USERNAME,
      'FullControl',
      'Allow'
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $secretFile -AclObject $acl
  }
  catch {
    Write-Warning "Could not tighten secret-file ACL automatically: $($_.Exception.Message)"
  }

  Write-Host ''
  Write-Host "Stored: $secretFile"
  Write-Host "Base URL: $($payload.baseUrl)"
  Write-Host ''
  Write-Host 'Next: tell Codex the credentials are stored, then I can wire the Danbooru resource connector.'
}
finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
