<#
.SYNOPSIS
  Uninstall vibe-display: remove build artifacts and (optionally) hooks.

.DESCRIPTION
  Reverses what install.ps1 did and what the hook-registration scripts did.
  By default it removes node_modules, dist, and the e2e test artifacts.
  Use -RemoveHooks to also unregister the Codex/Claude agent hooks
  (with confirmation). Never deletes the source, config, or docs.

.PARAMETER RemoveHooks
  Also run the hook unregister scripts (prompts for confirmation).

.PARAMETER Force
  Skip all confirmations.

.EXAMPLE
  .\uninstall.ps1
  .\uninstall.ps1 -RemoveHooks
  .\uninstall.ps1 -RemoveHooks -Force
#>
param(
  [switch]$RemoveHooks,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Confirm($prompt) {
  if ($Force) { return $true }
  $a = Read-Host "$prompt [y/N]"
  return ($a -eq "y" -or $a -eq "Y")
}

Write-Host ""
Write-Host "  vibe-display uninstaller" -ForegroundColor White
Write-Host "  ------------------------" -ForegroundColor White
Write-Host ""

# ---- 1. hooks (optional, with confirmation) ----
if ($RemoveHooks) {
  if (Confirm "Unregister Codex and Claude agent hooks?") {
    $regCodex = Join-Path $root "scripts\unregister-codex-hook.ps1"
    $regClaude = Join-Path $root "scripts\unregister-claude-hook.ps1"
    if (Test-Path $regCodex) { & $regCodex } else { Write-Warn "unregister-codex-hook.ps1 not found." }
    if (Test-Path $regClaude) { & $regClaude } else { Write-Warn "unregister-claude-hook.ps1 not found." }
  } else {
    Write-Warn "Skipping hook removal."
  }
} else {
  Write-Warn "Leaving agent hooks in place. Re-run with -RemoveHooks to remove them."
}

# ---- 2. build artifacts ----
$targets = @(
  (Join-Path $root "node_modules"),
  (Join-Path $root "server\node_modules"),
  (Join-Path $root "e2e\node_modules"),
  (Join-Path $root "server\dist"),
  (Join-Path $root "e2e\test-results"),
  (Join-Path $root "e2e\playwright-report")
)
foreach ($t in $targets) {
  if (Test-Path $t) {
    Write-Step "Removing $(Resolve-Path $t | Split-Path -Leaf)..."
    Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue
    Write-Ok "removed."
  }
}

# ---- 3. done ----
Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host ""
Write-Host "  Source files, config, and docs were left untouched." -ForegroundColor DarkGray
Write-Host "  To reinstall: .\install.ps1" -ForegroundColor DarkGray
Write-Host ""
