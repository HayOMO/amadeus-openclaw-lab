param(
  [switch]$SkipProviderInstall,
  [switch]$SkipProbe
)

$ErrorActionPreference = 'Stop'

function Invoke-OpenClawChecked {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$OpenClawArgs
  )

  & openclaw @OpenClawArgs
  if ($LASTEXITCODE -ne 0) {
    throw "openclaw $($OpenClawArgs -join ' ') failed with exit code $LASTEXITCODE"
  }
}

Write-Host 'Store DeepSeek API key for OpenClaw'
Write-Host 'This stores the key in ~/.openclaw/secrets/deepseek-api-key.token.'
Write-Host 'It registers DeepSeek as a model provider without switching the bot default model.'
Write-Host ''

$secure = Read-Host 'Paste DeepSeek API key (input hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'Empty DeepSeek API key.'
  }
  $apiKey = $apiKey.Trim()

  $secretDir = Join-Path $env:USERPROFILE '.openclaw\secrets'
  $secretFile = Join-Path $secretDir 'deepseek-api-key.token'
  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($secretFile, $apiKey, $utf8NoBom)

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

  if (-not $SkipProviderInstall) {
    Write-Host ''
    Write-Host 'Installing/updating OpenClaw DeepSeek provider plugin...'
    try {
      Invoke-OpenClawChecked plugins install --force '@openclaw/deepseek-provider'
    }
    catch {
      Write-Warning "Provider plugin install failed: $($_.Exception.Message)"
      Write-Warning "The key will still be stored and config will still be written. Retry later with: openclaw plugins install --force @openclaw/deepseek-provider"
    }
  }

  $batchPath = Join-Path $env:TEMP 'openclaw-deepseek-imagebot.batch.json'
  $deepseekModels = @(
    @{
      id = 'deepseek-v4-flash'
      name = 'DeepSeek V4 Flash'
      reasoning = $true
      input = @('text')
      contextWindow = 1000000
      maxTokens = 384000
      cost = @{
        input = 0.14
        output = 0.28
        cacheRead = 0.028
        cacheWrite = 0
      }
      compat = @{
        supportsUsageInStreaming = $true
        supportsReasoningEffort = $true
        maxTokensField = 'max_tokens'
      }
    },
    @{
      id = 'deepseek-v4-pro'
      name = 'DeepSeek V4 Pro'
      reasoning = $true
      input = @('text')
      contextWindow = 1000000
      maxTokens = 384000
      cost = @{
        input = 1.74
        output = 3.48
        cacheRead = 0.145
        cacheWrite = 0
      }
      compat = @{
        supportsUsageInStreaming = $true
        supportsReasoningEffort = $true
        maxTokensField = 'max_tokens'
      }
    },
    @{
      id = 'deepseek-chat'
      name = 'DeepSeek Chat'
      input = @('text')
      contextWindow = 131072
      maxTokens = 8192
      cost = @{
        input = 0.28
        output = 0.42
        cacheRead = 0.028
        cacheWrite = 0
      }
      compat = @{
        supportsUsageInStreaming = $true
        maxTokensField = 'max_tokens'
      }
    },
    @{
      id = 'deepseek-reasoner'
      name = 'DeepSeek Reasoner'
      reasoning = $true
      input = @('text')
      contextWindow = 131072
      maxTokens = 65536
      cost = @{
        input = 0.28
        output = 0.42
        cacheRead = 0.028
        cacheWrite = 0
      }
      compat = @{
        supportsUsageInStreaming = $true
        supportsReasoningEffort = $false
        maxTokensField = 'max_tokens'
      }
    }
  )
  $ops = @(
    @{
      path = 'secrets.providers.deepseek-imagebot'
      value = @{
        source = 'file'
        path = $secretFile
        mode = 'singleValue'
        allowInsecurePath = $true
      }
    },
    @{
      path = 'models.providers.deepseek.apiKey'
      value = @{
        source = 'file'
        provider = 'deepseek-imagebot'
        id = 'value'
      }
    },
    @{ path = 'models.providers.deepseek.baseUrl'; value = 'https://api.deepseek.com' },
    @{ path = 'models.providers.deepseek.api'; value = 'openai-completions' },
    @{ path = 'models.providers.deepseek.models'; value = $deepseekModels },
    @{ path = 'plugins.entries.deepseek.enabled'; value = $true },
    @{ path = 'agents.defaults.models["deepseek/deepseek-v4-flash"]'; value = @{ alias = 'ds-fast' } },
    @{ path = 'agents.defaults.models["deepseek/deepseek-v4-pro"]'; value = @{ alias = 'ds-pro' } },
    @{ path = 'agents.list[0].models["deepseek/deepseek-v4-flash"]'; value = @{ alias = 'ds-fast' } },
    @{ path = 'agents.list[0].models["deepseek/deepseek-v4-pro"]'; value = @{ alias = 'ds-pro' } }
  )
  $ops | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $batchPath -Encoding UTF8

  Write-Host ''
  Write-Host 'Applying DeepSeek provider config...'
  Invoke-OpenClawChecked config set --batch-file $batchPath
  Invoke-OpenClawChecked config validate
  Remove-Item -LiteralPath $batchPath -Force -ErrorAction SilentlyContinue

  if (-not $SkipProbe) {
    Write-Host ''
    Write-Host 'Checking DeepSeek model catalog...'
    & openclaw models list --provider deepseek
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'DeepSeek model probe failed. The key is stored and config is valid; restart the gateway or check provider plugin availability, then run: openclaw models list --provider deepseek'
    }
  }

  Write-Host ''
  Write-Host "Stored: $secretFile"
  Write-Host 'Available local profiles after provider is reachable:'
  Write-Host '  /ammodel'
  Write-Host '  /ammodel model deepseek/deepseek-v4-flash'
  Write-Host '  /ammodel model deepseek/deepseek-v4-flash think high'
  Write-Host '  /ammodel model deepseek/deepseek-v4-pro think max'
  Write-Host ''
  Write-Host 'The bot default model was not switched.'
}
finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
