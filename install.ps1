<#
.SYNOPSIS
  Install tokenflare: check prerequisites, install deps, build the server.

.DESCRIPTION
  One-command installer for tokenflare. Verifies Node.js 20+, runs npm install,
  interactively configures the outbound proxy, builds the server, and
  (optionally) installs the Playwright browser for e2e tests. Safe to re-run.

.PARAMETER SkipBuild
  Skip `npm run build` (use the tsx source runner instead).

.PARAMETER InstallTestBrowser
  Also install the Chromium browser for Playwright e2e tests.

.PARAMETER Force
  Reinstall even if node_modules already exists.

.PARAMETER NoPrompt
  Keep the existing proxy setting without asking interactive questions.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -InstallTestBrowser
  .\install.ps1 -SkipBuild
#>
param(
  [switch]$SkipBuild,
  [switch]$InstallTestBrowser,
  [switch]$Force,
  [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    ERROR: $msg" -ForegroundColor Red }

function Read-YesNo([string]$Prompt, [bool]$Default) {
  $hint = if ($Default) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $answer = (Read-Host "$Prompt $hint").Trim().ToLowerInvariant()
    if (-not $answer) { return $Default }
    if ($answer -in @("y", "yes")) { return $true }
    if ($answer -in @("n", "no")) { return $false }
    Write-Warn "Please enter y or n."
  }
}

function Set-ProxyConfig([string]$ConfigPath, [AllowNull()][string]$ProxyUrl) {
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  } catch {
    throw "Could not read $ConfigPath as JSON: $($_.Exception.Message)"
  }

  if ($config.PSObject.Properties.Name -contains "proxy") {
    $config.proxy = if ($ProxyUrl) { [pscustomobject]@{ url = $ProxyUrl } } else { $null }
  } else {
    $value = if ($ProxyUrl) { [pscustomobject]@{ url = $ProxyUrl } } else { $null }
    $config | Add-Member -NotePropertyName proxy -NotePropertyValue $value
  }

  $json = $config | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($ConfigPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Configure-Proxy {
  $configPath = Join-Path $root "config\tokenflare.config.json"
  $examplePath = Join-Path $root "config\tokenflare.config.example.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    # The real config is gitignored (it holds machine-specific values), so a
    # fresh clone starts from the checked-in template.
    if (Test-Path -LiteralPath $examplePath) {
      Copy-Item -LiteralPath $examplePath -Destination $configPath
      Write-Ok "Created config\tokenflare.config.json from the example."
    } else {
      Write-Warn "Config file not found: $configPath (skipping proxy setup)."
      return
    }
  }

  $currentUrl = $null
  try {
    $current = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($current.proxy -and $current.proxy.url) { $currentUrl = [string]$current.proxy.url }
  } catch {
    Write-Warn "Could not inspect the current proxy config; it will be validated when saved."
  }

  Write-Step "Configuring the network proxy for Codex quota requests..."
  if ($currentUrl) {
    Write-Ok "Current proxy: $currentUrl"
    if (Read-YesNo "Keep this proxy?" $true) { return }
  }

  if (-not (Read-YesNo "Use a proxy?" $false)) {
    Set-ProxyConfig $configPath $null
    Write-Ok "Proxy disabled; Tokenflare will connect directly."
    return
  }

  Write-Host "    1) HTTP" -ForegroundColor White
  Write-Host "    2) SOCKS5 (DNS also goes through the proxy)" -ForegroundColor White
  while ($true) {
    $proxyType = (Read-Host "    Proxy type [1/2]").Trim().ToLowerInvariant()
    if ($proxyType -in @("1", "http")) { $scheme = "http"; break }
    if ($proxyType -in @("2", "sock", "socks", "socks5")) { $scheme = "socks5h"; break }
    Write-Warn "Choose 1 for HTTP or 2 for SOCKS5."
  }

  $proxyHost = (Read-Host "    Proxy IP or hostname [127.0.0.1]").Trim()
  if (-not $proxyHost) { $proxyHost = "127.0.0.1" }
  if ($proxyHost.Contains(":") -and -not $proxyHost.StartsWith("[")) {
    $proxyHost = "[$proxyHost]"
  }

  while ($true) {
    $portText = (Read-Host "    Proxy port").Trim()
    $port = 0
    if ([int]::TryParse($portText, [ref]$port) -and $port -ge 1 -and $port -le 65535) { break }
    Write-Warn "Enter a port from 1 to 65535."
  }

  $proxyUrl = "${scheme}://${proxyHost}:$port"
  Set-ProxyConfig $configPath $proxyUrl
  Write-Ok "Proxy saved: $proxyUrl"
}

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

# ---- 2. proxy configuration ----
if ($NoPrompt) {
  Write-Step "Keeping the existing proxy config (-NoPrompt)."
} else {
  Configure-Proxy
}

# ---- 3. npm install ----
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

# ---- 4. build ----
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

# ---- 5. optional: test browser ----
if ($InstallTestBrowser) {
  Write-Step "Installing Playwright Chromium (for e2e tests)..."
  Push-Location $root
  try {
    & npx playwright install chromium 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  } finally { Pop-Location }
  Write-Ok "Playwright browser installed."
}

# ---- 6. connect coding-agent hooks ----
if ($NoPrompt) {
  Write-Step "Skipping interactive Codex/Claude Code hook setup (-NoPrompt)."
} else {
  Write-Step "Connecting coding agents for live task status..."
  $codexFound = [bool](Get-Command codex -ErrorAction SilentlyContinue)
  $codexPrompt = if ($codexFound) { "Connect Codex now?" } else { "Codex was not detected. Register its hooks anyway?" }
  if (Read-YesNo $codexPrompt $codexFound) {
    & (Join-Path $root "scripts\register-codex-hook.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Codex hook registration failed." }
  }

  $claudeFound = [bool](Get-Command claude -ErrorAction SilentlyContinue)
  $claudePrompt = if ($claudeFound) { "Connect Claude Code now?" } else { "Claude Code was not detected. Register its hooks anyway?" }
  if (Read-YesNo $claudePrompt $claudeFound) {
    & (Join-Path $root "scripts\register-claude-hook.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Claude Code hook registration failed." }
  }
}

# ---- 7. summary ----
Write-Host ""
Write-Host "  Done!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next:" -ForegroundColor White
Write-Host "    1. Start the server:  npm start" -ForegroundColor White
Write-Host "       (it prints the phone URL in a banner)" -ForegroundColor DarkGray
Write-Host "    2. Open that URL on your phone's browser, add to home screen." -ForegroundColor White
Write-Host "    3. Codex/Claude Code hooks can be changed anytime:" -ForegroundColor White
Write-Host "         .\scripts\register-*-hook.ps1 / unregister-*-hook.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  Docs: README.md | Uninstall: .\uninstall.ps1" -ForegroundColor DarkGray
Write-Host ""
