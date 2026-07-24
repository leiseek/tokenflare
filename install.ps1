<#
.SYNOPSIS
  Install tokenflare: check prerequisites, install deps, build the server.

.DESCRIPTION
  One-command installer for tokenflare. Verifies Node.js 20+, runs npm install,
  builds the server, and (optionally) installs the Playwright browser for e2e
  tests. Prints clear next steps. Safe to re-run.

.PARAMETER SkipBuild
  Skip `npm run build` (use the tsx source runner instead).

.PARAMETER InstallTestBrowser
  Also install the Chromium browser for Playwright e2e tests.

.PARAMETER Force
  Reinstall even if node_modules already exists.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -InstallTestBrowser
  .\install.ps1 -SkipBuild
#>
param(
  [switch]$SkipBuild,
  [switch]$InstallTestBrowser,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    ERROR: $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  tokenflare installer" -ForegroundColor White
Write-Host "  ----------------------" -ForegroundColor White
Write-Host ""

# ---- 1. Check Node.js 20+ ----
Write-Step "Checking Node.js..."
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExe) {
  Write-Err "Node.js is not installed or not on PATH."
  Write-Host ""
  Write-Host "    tokenflare requires Node.js 20 or later." -ForegroundColor White
  Write-Host "    Install it from https://nodejs.org/ and re-run this script." -ForegroundColor White
  Write-Host ""
  exit 1
}
$nodeVersionRaw = (& node --version) 2>$null  # e.g. "v24.14.1"
$nodeMajor = 0
if ($nodeVersionRaw -match "v(\d+)") { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
  Write-Err "Node.js $nodeVersionRaw is too old (need 20+)."
  Write-Host "    Upgrade at https://nodejs.org/" -ForegroundColor White
  exit 1
}
Write-Ok "Node.js $nodeVersionRaw found."

# ---- 2. npm install ----
$hasNodeModules = Test-Path (Join-Path $root "node_modules")
if ($hasNodeModules -and -not $Force) {
  Write-Step "Dependencies already installed (node_modules exists). Use -Force to reinstall."
} else {
  Write-Step "Installing dependencies (npm install)..."
  Push-Location $root
  try {
    & npm install --no-fund --no-audit 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
  } finally { Pop-Location }
  Write-Ok "Dependencies installed."
}

# ---- 3. build ----
if ($SkipBuild) {
  Write-Step "Skipping build (-SkipBuild). Server will run from source via tsx."
} else {
  Write-Step "Building the server (npm run build)..."
  Push-Location $root
  try {
    & npm run build 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { Write-Err "Build failed."; exit 1 }
  } finally { Pop-Location }
  Write-Ok "Server built -> server/dist/"
}

# ---- 4. optional: test browser ----
if ($InstallTestBrowser) {
  Write-Step "Installing Playwright Chromium (for e2e tests)..."
  Push-Location $root
  try {
    & npx playwright install chromium 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  } finally { Pop-Location }
  Write-Ok "Playwright browser installed."
}

# ---- 5. summary ----
Write-Host ""
Write-Host "  Done!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next:" -ForegroundColor White
Write-Host "    1. Start the server:  npm start" -ForegroundColor White
Write-Host "       (it prints the phone URL in a banner)" -ForegroundColor DarkGray
Write-Host "    2. Open that URL on your phone's browser, add to home screen." -ForegroundColor White
Write-Host "    3. (optional) Wire real agent hooks:" -ForegroundColor White
Write-Host "         .\scripts\register-codex-hook.ps1" -ForegroundColor White
Write-Host "         .\scripts\register-claude-hook.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  Docs: README.md | Uninstall: .\uninstall.ps1" -ForegroundColor DarkGray
Write-Host ""
