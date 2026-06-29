param(
  [string]$TokenFile = "$env:USERPROFILE\.openclaw\secrets\pixiv-refresh.token"
)

$ErrorActionPreference = 'Stop'

Write-Host 'Store Pixiv refresh token'
Write-Host 'This stores the token in ~/.openclaw/secrets/pixiv-refresh.token.'
Write-Host 'It is not written to this repo and should not be committed.'
Write-Host ''

$secure = Read-Host 'Paste Pixiv refresh_token (input hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Empty refresh token.'
  }
  $token = $token.Trim()

  $secretDir = Split-Path -Parent $TokenFile
  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($TokenFile, $token, $utf8NoBom)

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
  Write-Host 'Next: run the Pixiv resource connector test or restart the gateway after config is applied.'
}
finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
