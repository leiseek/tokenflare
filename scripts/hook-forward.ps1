<#
.SYNOPSIS
  Pure-PowerShell fail-open hook forwarder for Tokenflare.

.DESCRIPTION
  Reads the provider hook JSON from stdin, posts it to the Tokenflare server,
  and always exits 0 (never blocks the agent). Use this variant when you can't
  guarantee `node` is on PATH at hook time.

  Wired into Codex config.toml / Claude settings.json by register-*.ps1.

.PARAMETER Provider
  "codex" or "claude".

.PARAMETER ServerUrl
  Base URL of the Tokenflare server. Default: http://127.0.0.1:7331
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("codex", "claude")]
  [string]$Provider,

  [string]$ServerUrl = $env:TOKENFLARE_SERVER
)

if (-not $ServerUrl) { $ServerUrl = "http://127.0.0.1:7331" }

try {
  # Read and sanitize stdin before transmitting anything.
  $raw = $input | Out-String
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
  $payload = $raw | ConvertFrom-Json
  $safe = [ordered]@{}
  foreach ($key in @("session_id", "hook_event_name", "cwd", "transcript_path")) {
    $property = $payload.PSObject.Properties[$key]
    if ($property -and $property.Value -is [string]) { $safe[$key] = $property.Value }
  }
  if (-not $safe.Contains("session_id") -and -not $safe.Contains("hook_event_name")) { exit 0 }

  $url = "$ServerUrl/api/hooks/$Provider"
  $body = $safe | ConvertTo-Json -Compress

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
