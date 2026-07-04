param(
  [string]$Mode = 'balanced',

  [string]$Model = '',

  [string]$ReasoningEffort = '',

  [string]$TextVerbosity = '',

  # Kept for backward-compatible old callers. Chat output caps are no longer written by this script.
  [int]$MaxTokens = 0,

  [string]$ModelStatePath = '',

  [string]$BatchDir = ''
)

$ErrorActionPreference = 'Stop'

$profilePath = Join-Path $PSScriptRoot 'IMAGEBOT_MODEL_PROFILES.json'
if (-not (Test-Path -LiteralPath $profilePath)) {
  throw "Missing model profile file: $profilePath"
}

$catalog = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
$repoRoot = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $repoRoot 'config\imagebot\settings.json'
$imageGenerationConfig = @{
  primary = 'openai/gpt-image-2'
  fallbacks = @()
  timeoutMs = 420000
}
$chatModelFallbacks = @(
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro'
)
if (Test-Path -LiteralPath $settingsPath) {
  $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -ne $settings.modelFallbacks) {
    $chatModelFallbacks = @($settings.modelFallbacks | ForEach-Object { [string]$_ } | Where-Object { $_ })
  }
  if ($settings.imageGeneration) {
    if ($settings.imageGeneration.primary) {
      $imageGenerationConfig.primary = [string]$settings.imageGeneration.primary
    }
    if ($null -ne $settings.imageGeneration.fallbacks) {
      $imageGenerationConfig.fallbacks = @($settings.imageGeneration.fallbacks | ForEach-Object { [string]$_ } | Where-Object { $_ })
    }
    if ($settings.imageGeneration.timeoutMs) {
      $imageGenerationConfig.timeoutMs = [int]$settings.imageGeneration.timeoutMs
    }
  }
}
$profile = $null

if ($Mode -ne 'custom') {
  $profile = @($catalog.profiles | Where-Object { $_.id -eq $Mode })[0]
  if (-not $profile) {
    throw "Unknown model profile: $Mode"
  }
} else {
  $profile = [pscustomobject]@{
    id = 'custom'
    label = 'Custom'
    model = ''
    reasoningEffort = 'medium'
    textVerbosity = 'low'
  }
}

$effectiveModel = if ($Model) { $Model.Trim() } else { [string]$profile.model }
$effectiveReasoning = if ($ReasoningEffort) { $ReasoningEffort } else { [string]$profile.reasoningEffort }
$effectiveVerbosity = if ($TextVerbosity) { $TextVerbosity } else { [string]$profile.textVerbosity }

if (-not $effectiveModel) {
  throw 'Model is required.'
}
if ($effectiveModel -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.:-]+$') {
  throw "Invalid model id '$effectiveModel'. Expected provider/model, e.g. openai/gpt-5.5."
}
foreach ($fallbackModel in @($chatModelFallbacks)) {
  if ($fallbackModel -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.:-]+$') {
    throw "Invalid fallback model id '$fallbackModel'. Expected provider/model, e.g. deepseek/deepseek-v4-flash."
  }
}
if (@('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max') -notcontains $effectiveReasoning) {
  throw "Invalid reasoning effort '$effectiveReasoning'."
}
if (@('low', 'medium', 'high') -notcontains $effectiveVerbosity) {
  throw "Invalid text verbosity '$effectiveVerbosity'."
}

$knownModel = @($catalog.models | Where-Object { $_.id -eq $effectiveModel })[0]
if ($knownModel -and $knownModel.enabled -eq $false) {
  throw "Model '$effectiveModel' is disabled in IMAGEBOT_MODEL_PROFILES.json."
}
if (-not $knownModel) {
  Write-Warning "Model '$effectiveModel' is not in IMAGEBOT_MODEL_PROFILES.json. Applying anyway; make sure OpenClaw provider config exists."
}
foreach ($fallbackModel in @($chatModelFallbacks)) {
  $knownFallbackModel = @($catalog.models | Where-Object { $_.id -eq $fallbackModel })[0]
  if ($knownFallbackModel -and $knownFallbackModel.enabled -eq $false) {
    throw "Fallback model '$fallbackModel' is disabled in IMAGEBOT_MODEL_PROFILES.json."
  }
  if (-not $knownFallbackModel) {
    Write-Warning "Fallback model '$fallbackModel' is not in IMAGEBOT_MODEL_PROFILES.json. Applying anyway; make sure OpenClaw provider config exists."
  }
}

if ([string]::IsNullOrWhiteSpace($ModelStatePath)) {
  $ModelStatePath = Join-Path $env:USERPROFILE '.openclaw\imagebot\model-state.json'
}
$modelStatePath = [System.IO.Path]::GetFullPath($ModelStatePath)
$modelStateDir = Split-Path -Parent $modelStatePath
if (-not (Test-Path -LiteralPath $modelStateDir)) {
  New-Item -ItemType Directory -Path $modelStateDir -Force | Out-Null
}
$modelState = [ordered]@{
  schema = 1
  profile = $Mode
  model = $effectiveModel
  reasoningEffort = $effectiveReasoning
  textVerbosity = $effectiveVerbosity
  updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  source = 'SET_IMAGEBOT_MODEL_MODE.ps1'
}
$modelStateJson = $modelState | ConvertTo-Json -Depth 6
$modelStateUtf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($modelStatePath, $modelStateJson + [Environment]::NewLine, $modelStateUtf8NoBom)

$effectiveFallbacks = @($chatModelFallbacks | Where-Object { $_ -and $_ -ne $effectiveModel })
$chatModelConfig = @{
  primary = $effectiveModel
  fallbacks = $effectiveFallbacks
}
$ops = @(
  @{ path = 'agents.defaults.model'; value = $chatModelConfig },
  @{ path = 'agents.list[0].model'; value = $chatModelConfig },
  @{ path = 'agents.list[0].params.reasoningEffort'; value = $effectiveReasoning },
  @{ path = 'agents.list[0].params.textVerbosity'; value = $effectiveVerbosity },
  @{ path = ('agents.defaults.models["' + $effectiveModel + '"]'); value = @{} },
  @{ path = ('agents.list[0].models["' + $effectiveModel + '"]'); value = @{} },
  @{ path = 'agents.defaults.imageModel'; value = @{ primary = 'openai/gpt-5.5' } },
  @{ path = 'agents.defaults.imageGenerationModel'; value = $imageGenerationConfig }
)

$profilesByModel = @{}
foreach ($item in @($catalog.profiles)) {
  $profileModel = [string]$item.model
  if (-not $profileModel) { continue }
  $profileModelEntry = @($catalog.models | Where-Object { $_.id -eq $profileModel })[0]
  if ($profileModelEntry -and $profileModelEntry.enabled -eq $false) { continue }
  if (-not $profilesByModel.ContainsKey($profileModel)) {
    $profilesByModel[$profileModel] = @()
  }
  $profilesByModel[$profileModel] += $item
}

foreach ($modelId in $profilesByModel.Keys) {
  $profilesForModel = @($profilesByModel[$modelId])
  if ($profilesForModel.Count -ne 1) { continue }
  $alias = [string]$profilesForModel[0].id
  if (-not $alias -or $alias -eq 'custom') { continue }
  $aliasValue = @{ alias = $alias }
  $ops += @{ path = ('agents.defaults.models["' + $modelId + '"]'); value = $aliasValue }
  $ops += @{ path = ('agents.list[0].models["' + $modelId + '"]'); value = $aliasValue }
}

if ([string]::IsNullOrWhiteSpace($BatchDir)) {
  $BatchDir = Join-Path $repoRoot '.runtime\generated'
}
$batchDirResolved = [System.IO.Path]::GetFullPath($BatchDir)
if (-not (Test-Path -LiteralPath $batchDirResolved)) {
  New-Item -ItemType Directory -Path $batchDirResolved -Force | Out-Null
}
$safeMode = $Mode -replace '[^A-Za-z0-9_.-]', '_'
$batchPath = Join-Path $batchDirResolved "SET_IMAGEBOT_MODEL_MODE.$safeMode.batch.generated.json"
$json = $ops | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($batchPath, $json, $utf8NoBom)

openclaw config set --batch-file $batchPath
foreach ($item in @($catalog.models)) {
  if ($item.enabled -ne $false) { continue }
  $disabledModelId = [string]$item.id
  if ([string]::IsNullOrWhiteSpace($disabledModelId)) { continue }
  foreach ($disabledPath in @(
    ('agents.defaults.models["' + $disabledModelId + '"]'),
    ('agents.list[0].models["' + $disabledModelId + '"]')
  )) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $unsetOutput = & openclaw config unset $disabledPath 2>&1
      $unsetExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $unsetText = ($unsetOutput | Out-String).Trim()
    if ($unsetExitCode -ne 0 -and $unsetText -notmatch 'Config path not found') {
      throw "openclaw config unset $disabledPath failed with exit code $unsetExitCode`n$unsetText"
    }
  }
}
openclaw config validate

$result = [ordered]@{
  ok = $true
  mode = $Mode
  label = [string]$profile.label
  model = $effectiveModel
  reasoningEffort = $effectiveReasoning
  textVerbosity = $effectiveVerbosity
  configWritten = $true
  modelStatePath = $modelStatePath
  batchPath = $batchPath
  restartRecommended = $true
  note = 'OpenClaw config was updated. New windows may pick it up after config reload, but restart the gateway for deterministic model/provider changes.'
}

Write-Host ($result | ConvertTo-Json -Depth 4)
