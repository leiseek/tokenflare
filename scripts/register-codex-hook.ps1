<#
.SYNOPSIS
  Register Vibe Display hooks into Codex CLI's config.toml.

.DESCRIPTION
  Edits %USERPROFILE%\.codex\config.toml so Codex CLI fires our fail-open
  forwarder on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop.
  Ported from pulse-island's register-hook.ps1, adapted to POST to our server.

.PARAMETER ServerUrl
  Base URL of the Vibe Display server. Default: http://127.0.0.1:7331

.PARAMETER UsePowerShellShim
  Use the pure-PowerShell forwarder instead of the node one (when node isn't
  guaranteed on PATH at hook time).

.EXAMPLE
  .\register-codex-hook.ps1
  .\register-codex-hook.ps1 -ServerUrl http://192.168.1.10:7331 -UsePowerShellShim
#>
param(
  [string]$ServerUrl = "http://127.0.0.1:7331",
  [switch]$UsePowerShellShim
)

$ErrorActionPreference = "Stop"
$codexDir = Join-Path $env:USERPROFILE ".codex"
$configPath = Join-Path $codexDir "config.toml"

if (-not (Test-Path $codexDir)) {
  New-Item -ItemType Directory -Path $codexDir -Force | Out-Null
}

# Read existing config (or start fresh).
if (Test-Path $configPath) {
  $config = Get-Content $configPath -Raw
} else {
  $config = ""
}

$here = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent $here

if ($UsePowerShellShim) {
  $shimPath = Join-Path $here "hook-forward.ps1"
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$shimPath`" codex $ServerUrl"
} else {
  $shimPath = Join-Path $here "hook-forward.mjs"
  $command = "node `"$shimPath`" codex $ServerUrl"
}

# Events we subscribe (pulse-island's curated list).
$events = @("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")

# Build the [hooks] block.
$marker = "# >>> vibe-display hooks >>>"
$endMarker = "# <<< vibe-display hooks <<<"

$block = "$marker`r`n[hooks]`r`n"
foreach ($ev in $events) {
  $block += "`"$ev`" = [`"$command`"]`r`n"
}
$block += "$endMarker`r`n"

# Remove any previous vibe-display block, then append ours.
if ($config -match "(?s)(?<=\n)# >>> vibe-display hooks >>>.*?# <<< vibe-display hooks <<<\r?\n") {
  $config = $config -replace "(?s)(?<=\n)# >>> vibe-display hooks >>>.*?# <<< vibe-display hooks <<<\r?\n", ""
}
if ($config -match "# >>> vibe-display hooks >>>") {
  $config = $config -replace "(?s)# >>> vibe-display hooks >>>.*?# <<< vibe-display hooks <<<\r?\n?", ""
}
if (-not $config.EndsWith("`n") -and $config -ne "") { $config += "`n" }
$config += $block

Set-Content -Path $configPath -Value $config -NoNewline:$false -Encoding UTF8

Write-Host "Registered Vibe Display hooks for Codex at: $configPath" -ForegroundColor Green
Write-Host "  events : $($events -join ', ')"
Write-Host "  command: $command"
Write-Host ""
Write-Host "To remove: run unregister-codex-hook.ps1"
