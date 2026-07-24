<#
.SYNOPSIS
  Register Tokenflare hooks into Claude Code's settings.json.

.DESCRIPTION
  Edits %USERPROFILE%\.claude\settings.json so Claude Code fires our fail-open
  forwarder on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  Notification (waiting), and Stop. Ported from pulse-island's
  register-claude-hook.ps1, adapted to POST to our server.

.PARAMETER ServerUrl
  Base URL of the Tokenflare server. Default: http://127.0.0.1:7331

.PARAMETER UsePowerShellShim
  Use the pure-PowerShell forwarder instead of the node one.

.EXAMPLE
  .\register-claude-hook.ps1
#>
param(
  [string]$ServerUrl = "http://127.0.0.1:7331",
  [switch]$UsePowerShellShim
)

$ErrorActionPreference = "Stop"
$claudeDir = Join-Path $env:USERPROFILE ".claude"
$configPath = Join-Path $claudeDir "settings.json"

if (-not (Test-Path $claudeDir)) {
  New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
}

$settings = @{}
if (Test-Path $configPath) {
  try {
    $settings = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable
  } catch {
    $settings = @{}
  }
} else {
  $settings = @{}
}

$here = Split-Path -Parent $PSCommandPath
if ($UsePowerShellShim) {
  $shimPath = Join-Path $here "hook-forward.ps1"
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$shimPath`" claude $ServerUrl"
} else {
  $shimPath = Join-Path $here "hook-forward.mjs"
  $command = "node `"$shimPath`" claude $ServerUrl"
}

$events = @("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop")

# Claude Code expects hooks under settings.hooks.<EventName> = [{ hooks: [{ type: "command", command: "..." }] }]
if (-not $settings.ContainsKey("hooks")) { $settings["hooks"] = @{} }
foreach ($ev in $events) {
  $settings["hooks"][$ev] = @(
    @{
      hooks = @(
        @{ type = "command"; command = $command }
      )
    }
  )
}

$json = $settings | ConvertTo-Json -Depth 10
Set-Content -Path $configPath -Value $json -Encoding UTF8

Write-Host "Registered Tokenflare hooks for Claude Code at: $configPath" -ForegroundColor Green
Write-Host "  events : $($events -join ', ')"
Write-Host "  command: $command"
Write-Host ""
Write-Host "To remove: run unregister-claude-hook.ps1"
