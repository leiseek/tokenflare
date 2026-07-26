<#
.SYNOPSIS
  Register Tokenflare lifecycle hooks for Claude Code.

.DESCRIPTION
  Safely merges Tokenflare command hooks into ~/.claude/settings.json.
  Existing settings and user hooks are preserved.
#>
param(
  [string]$ServerUrl = "http://127.0.0.1:7331",
  [switch]$UsePowerShellShim
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
$manager = Join-Path $here "manage-hooks.mjs"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required to update Claude Code hooks safely."
}

if ($UsePowerShellShim) {
  $shimPath = Join-Path $here "hook-forward.ps1"
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$shimPath`" claude `"$ServerUrl`""
} else {
  $shimPath = Join-Path $here "hook-forward.mjs"
  $command = "node `"$shimPath`" claude `"$ServerUrl`""
}

$result = & node $manager register claude $command
if ($LASTEXITCODE -ne 0) { throw "Failed to register Claude Code hooks." }
$info = $result | ConvertFrom-Json

Write-Host "Registered Tokenflare lifecycle hooks for Claude Code." -ForegroundColor Green
Write-Host "  config : $($info.path)"
Write-Host "  events : $($info.events -join ', ')"
Write-Host "To remove: .\scripts\unregister-claude-hook.ps1"
