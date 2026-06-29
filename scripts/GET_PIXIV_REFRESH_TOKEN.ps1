param(
  [string]$TokenFile = "$env:USERPROFILE\.openclaw\secrets\pixiv-refresh.token"
)

$ErrorActionPreference = 'Stop'

$UserAgent = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)'
$RedirectUri = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback'
$LoginUrl = 'https://app-api.pixiv.net/web/v1/login'
$AuthTokenUrl = 'https://oauth.secure.pixiv.net/auth/token'
$ClientId = 'MOBrBDS8blbauoSck0ZfDbtuzpyT'
$ClientSecret = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj'

try {
  Add-Type -AssemblyName System.Web -ErrorAction Stop
}
catch {
  Write-Warning 'System.Web is not available; callback URL parsing will fall back to simple code extraction.'
}

function New-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-CodeVerifier {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return New-Base64Url $bytes
}

function Get-CodeFromInput([string]$InputValue) {
  $raw = $InputValue.Trim()
  if ($raw -match '^https?://' -and ('System.Web.HttpUtility' -as [type])) {
    $uri = [Uri]$raw
    $query = [System.Web.HttpUtility]::ParseQueryString($uri.Query)
    return $query.Get('code')
  }
  if ($raw -match '[?&]code=([^&\s]+)') {
    return [Uri]::UnescapeDataString($Matches[1])
  }
  if ($raw -match '^https?://') {
    return $null
  }
  return $raw
}

function Get-ReturnToFromInput([string]$InputValue) {
  $raw = $InputValue.Trim()
  if ($raw -match '^https?://' -and ('System.Web.HttpUtility' -as [type])) {
    $uri = [Uri]$raw
    $query = [System.Web.HttpUtility]::ParseQueryString($uri.Query)
    $returnTo = $query.Get('return_to')
    if (-not [string]::IsNullOrWhiteSpace($returnTo)) {
      return $returnTo
    }
  }
  if ($raw -match '[?&]return_to=([^&\s]+)') {
    return [Uri]::UnescapeDataString($Matches[1])
  }
  return $null
}

Write-Host 'Get Pixiv refresh token'
Write-Host 'A Pixiv login page will open.'
Write-Host 'Open DevTools (F12) -> Network before logging in, then copy the final callback?state=... request URL or only its code= value.'
Write-Host 'The visible page may show "endpoint does not exist"; ignore the page and use the Network request.'
Write-Host 'The code expires quickly; paste it immediately.'
Write-Host ''

$codeVerifier = New-CodeVerifier
$sha256 = [Security.Cryptography.SHA256]::Create()
$challenge = New-Base64Url ($sha256.ComputeHash([Text.Encoding]::ASCII.GetBytes($codeVerifier)))

$loginUriBuilder = [UriBuilder]$LoginUrl
$loginQuery = [System.Web.HttpUtility]::ParseQueryString('')
$loginQuery['code_challenge'] = $challenge
$loginQuery['code_challenge_method'] = 'S256'
$loginQuery['client'] = 'pixiv-android'
$loginUriBuilder.Query = $loginQuery.ToString()
$loginUri = $loginUriBuilder.Uri.AbsoluteUri

Write-Host "Opening: $loginUri"
Start-Process $loginUri
Write-Host ''

for ($attempt = 1; $attempt -le 3; $attempt++) {
  $inputValue = Read-Host 'Paste callback URL or code'
  $code = Get-CodeFromInput $inputValue
  if (-not [string]::IsNullOrWhiteSpace($code)) {
    break
  }

  $returnTo = Get-ReturnToFromInput $inputValue
  if (-not [string]::IsNullOrWhiteSpace($returnTo)) {
    Write-Host ''
    Write-Host 'Detected Pixiv post-redirect without OAuth code.'
    Write-Host 'This is only an intermediate URL. Do not paste/open this as the final OAuth code.'
    Write-Host 'In the browser DevTools Network tab, find the request named callback?state=... and copy its Request URL or code= value.'
    Write-Host "Intermediate return_to was: $returnTo"
    Write-Host ''
  }
}

if ([string]::IsNullOrWhiteSpace($code)) {
  throw 'No OAuth code found.'
}

$body = @{
  client_id = $ClientId
  client_secret = $ClientSecret
  code = $code.Trim()
  code_verifier = $codeVerifier
  grant_type = 'authorization_code'
  include_policy = 'true'
  redirect_uri = $RedirectUri
}

$response = Invoke-RestMethod `
  -Method Post `
  -Uri $AuthTokenUrl `
  -Headers @{ 'User-Agent' = $UserAgent } `
  -Body $body `
  -ContentType 'application/x-www-form-urlencoded' `
  -TimeoutSec 30

if (-not $response.refresh_token) {
  throw "Pixiv did not return a refresh_token. Response: $($response | ConvertTo-Json -Depth 6)"
}

$secretDir = Split-Path -Parent $TokenFile
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($TokenFile, [string]$response.refresh_token, $utf8NoBom)

try {
  $acl = Get-Acl -LiteralPath $TokenFile
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME,
    'FullControl',
    'Allow'
  )
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $TokenFile -AclObject $acl
}
catch {
  Write-Warning "Could not tighten token-file ACL automatically: $($_.Exception.Message)"
}

Write-Host ''
Write-Host "Stored: $TokenFile"
Write-Host "expires_in: $($response.expires_in)"
Write-Host 'Pixiv refresh token is ready.'
