<#
.SYNOPSIS
  Remove Tokenflare hooks from Claude Code's settings.json (reverse of register).
#>
$ErrorActionPreference = "Stop"
$configPath = Join-Path $env:USERPROFILE ".claude\settings.json"

if (-not (Test-Path $configPath)) {
  Write-Host "No Claude settings.json found at $configPath — nothing to remove."
  exit 0
}

$settings = @{}
try {
  $settings = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable
} catch {
  Write-Host "settings.json could not be parsed — leaving it untouched."
  exit 0
}

if ($settings.ContainsKey("hooks")) {
  $events = @("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop")
  foreach ($ev in $events) {
    if ($settings["hooks"].ContainsKey($ev)) {
      # Drop only entries whose command mentions tokenflare's hook-forward shim.
      $filtered = @()
      foreach ($entry in @($settings["hooks"][$ev])) {
        $commands = @($entry.hooks | ForEach-Object { $_.command } | Where-Object { $_ })
        $keep = $true
        foreach ($c in $commands) {
          if ($c -match "hook-forward\.(mjs|ps1)") { $keep = $false; break }
        }
        if ($keep) { $filtered += $entry }
      }
      if ($filtered.Count -gt 0) {
        $settings["hooks"][$ev] = $filtered
      } else {
        $settings["hooks"].Remove($ev)
      }
    }
  }
  if ($settings["hooks"].Count -eq 0) { $settings.Remove("hooks") }
}

$json = $settings | ConvertTo-Json -Depth 10
Set-Content -Path $configPath -Value $json -Encoding UTF8
Write-Host "Removed Tokenflare hooks from $configPath" -ForegroundColor Green
