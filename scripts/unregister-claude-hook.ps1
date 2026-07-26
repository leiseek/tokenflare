<# Remove only Tokenflare's handlers from Claude Code settings.json. #>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
$manager = Join-Path $here "manage-hooks.mjs"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required to update Claude Code hooks safely."
}

$result = & node $manager unregister claude
if ($LASTEXITCODE -ne 0) { throw "Failed to remove Claude Code hooks." }
$info = $result | ConvertFrom-Json
Write-Host "Removed Tokenflare hooks from $($info.path)" -ForegroundColor Green
