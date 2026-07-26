<#
.SYNOPSIS
  Register Tokenflare lifecycle hooks for Codex.

.DESCRIPTION
  Safely merges Tokenflare command hooks into ~/.codex/hooks.json using the
  current Codex matcher-group schema. Existing user hooks are preserved.

.PARAMETER ServerUrl
  Base URL of the Tokenflare server. Default: http://127.0.0.1:7331

.PARAMETER UsePowerShellShim
  Use the pure-PowerShell forwarder instead of the default Node forwarder.
#>
param(
  [string]$ServerUrl = "http://127.0.0.1:7331",
  [switch]$UsePowerShellShim
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
$manager = Join-Path $here "manage-hooks.mjs"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is required to update Codex hooks safely." }

if ($UsePowerShellShim) {
  $shimPath = Join-Path $here "hook-forward.ps1"
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$shimPath`" codex `"$ServerUrl`""
} else {
  $shimPath = Join-Path $here "hook-forward.mjs"
  $command = "node `"$shimPath`" codex `"$ServerUrl`""
}

$result = & node $manager register codex $command
if ($LASTEXITCODE -ne 0) { throw "Failed to register Codex hooks." }
$info = $result | ConvertFrom-Json

Write-Host "Registered Tokenflare lifecycle hooks for Codex." -ForegroundColor Green
Write-Host "  config : $($info.path)"
Write-Host "  events : $($info.events -join ', ')"
Write-Host ""
Write-Host "Codex may ask you to trust these local command hooks the first time they run." -ForegroundColor Yellow
Write-Host "To remove: .\scripts\unregister-codex-hook.ps1"
