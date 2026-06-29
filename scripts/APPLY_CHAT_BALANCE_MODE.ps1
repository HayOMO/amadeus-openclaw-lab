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

$repoRoot = Split-Path -Parent $PSScriptRoot
$configBatch = Join-Path $PSScriptRoot 'generated\imagebot-config.batch.json'
$promptBatch = Join-Path $PSScriptRoot 'generated\imagebot-prompts.batch.json'

Push-Location $repoRoot
try {
  node .\scripts\BUILD_IMAGEBOT_CONFIG.mjs --write
  if ($LASTEXITCODE -ne 0) {
    throw "imagebot config build failed with exit code $LASTEXITCODE"
  }

  Invoke-OpenClawChecked config set --batch-file $configBatch
  Invoke-OpenClawChecked config set --batch-file $promptBatch
  Invoke-OpenClawChecked config validate
} finally {
  Pop-Location
}

Write-Host 'Applied imagebot config from config/imagebot source files.'
Write-Host 'Generated batches:'
Write-Host "- $configBatch"
Write-Host "- $promptBatch"
