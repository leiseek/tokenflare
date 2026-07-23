<#
.SYNOPSIS
  Pure-PowerShell fail-open hook forwarder for Vibe Display.

.DESCRIPTION
  Reads the provider hook JSON from stdin, posts it to the Vibe Display server,
  and always exits 0 (never blocks the agent). Use this variant when you can't
  guarantee `node` is on PATH at hook time.

  Wired into Codex config.toml / Claude settings.json by register-*.ps1.

.PARAMETER Provider
  "codex" or "claude".

.PARAMETER ServerUrl
  Base URL of the Vibe Display server. Default: http://127.0.0.1:7331
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("codex", "claude")]
  [string]$Provider,

  [string]$ServerUrl = $env:VIBE_SERVER
)

if (-not $ServerUrl) { $ServerUrl = "http://127.0.0.1:7331" }

try {
  # Read stdin (the hook payload) with a hard 1s cap via a background job.
  $raw = $input | Out-String
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

  $url = "$ServerUrl/api/hooks/$Provider"
  $body = $raw

  # Fire and forget with a short timeout; ignore all errors.
  $ErrorActionPreference = "SilentlyContinue"
  Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" `
    -Body $body -TimeoutSec 1 | Out-Null
}
catch {
  # Swallow everything — never fail the agent.
}
finally {
  exit 0
}
