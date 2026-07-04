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

function Invoke-OpenClawUnsetIfPresent {
  param(
    [string]$Path
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & openclaw config unset $Path 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $text = ($output | Out-String).Trim()
  if ($exitCode -ne 0) {
    if ($text -match 'Config path not found') {
      Write-Host "Config path already absent: $Path"
      return
    }
    throw "openclaw config unset $Path failed with exit code $exitCode`n$text"
  }
  if ($text) {
    Write-Host $text
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$configBatch = Join-Path $PSScriptRoot 'generated\imagebot-config.batch.json'
$promptBatch = Join-Path $PSScriptRoot 'generated\imagebot-prompts.batch.json'
$modelProfilesPath = Join-Path $PSScriptRoot 'IMAGEBOT_MODEL_PROFILES.json'

Push-Location $repoRoot
try {
  node .\scripts\BUILD_IMAGEBOT_CONFIG.mjs --write
  if ($LASTEXITCODE -ne 0) {
    throw "imagebot config build failed with exit code $LASTEXITCODE"
  }

  Invoke-OpenClawChecked config set --batch-file $configBatch
  Invoke-OpenClawChecked config set --batch-file $promptBatch
  if (Test-Path -LiteralPath $modelProfilesPath) {
    $modelCatalog = Get-Content -LiteralPath $modelProfilesPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($model in @($modelCatalog.models)) {
      if ($model.enabled -ne $false) { continue }
      $modelId = [string]$model.id
      if ([string]::IsNullOrWhiteSpace($modelId)) { continue }
      Invoke-OpenClawUnsetIfPresent ('agents.defaults.models["' + $modelId + '"]')
      Invoke-OpenClawUnsetIfPresent ('agents.list[0].models["' + $modelId + '"]')
    }
  }
  '{"plugins":{"entries":{"deepseek":null}}}' | openclaw config patch --stdin
  if ($LASTEXITCODE -ne 0) {
    throw "openclaw config patch --stdin failed with exit code $LASTEXITCODE"
  }
  Invoke-OpenClawChecked config validate
} finally {
  Pop-Location
}

Write-Host 'Applied imagebot config from config/imagebot source files.'
Write-Host 'Generated batches:'
Write-Host "- $configBatch"
Write-Host "- $promptBatch"
