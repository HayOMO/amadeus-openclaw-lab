$ErrorActionPreference = 'Stop'

Write-Host 'Store Zhihu Open Platform Access Secret'
Write-Host 'This stores the secret in ~/.openclaw/secrets/zhihu-access-secret.token.'
Write-Host 'It is not written to this repo and should not be committed.'
Write-Host ''

$secure = Read-Host 'Paste Zhihu developer Access Secret (input hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($secret)) {
    throw 'Empty Access Secret.'
  }
  $secret = $secret.Trim()

  $secretDir = Join-Path $env:USERPROFILE '.openclaw\secrets'
  $secretFile = Join-Path $secretDir 'zhihu-access-secret.token'
  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
  Set-Content -LiteralPath $secretFile -Value $secret -NoNewline -Encoding UTF8

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

  Write-Host "Stored: $secretFile"
  Write-Host ''
  Write-Host 'Optional quick check:'
  Write-Host '  /ask 知乎热榜前五'
  Write-Host '  /search 知乎 RAG'
}
finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
