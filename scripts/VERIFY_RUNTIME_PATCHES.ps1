param(
  [string]$RuntimeRoot = "",
  [string]$Manifest = "",
  [switch]$Strict,
  [switch]$Json
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root "scripts\VERIFY_RUNTIME_PATCHES.mjs"

if (-not (Test-Path -LiteralPath $Script)) {
  throw "Verifier script not found: $Script"
}

$argsList = @($Script)
if ($RuntimeRoot) {
  $argsList += @("--runtime-root", $RuntimeRoot)
}
if ($Manifest) {
  $argsList += @("--manifest", $Manifest)
}
if ($Strict) {
  $argsList += "--strict"
}
if ($Json) {
  $argsList += "--json"
}

& node @argsList
exit $LASTEXITCODE
