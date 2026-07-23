<#
.SYNOPSIS
  Remove Vibe Display hooks from Codex CLI's config.toml (reverse of register).
#>
$ErrorActionPreference = "Stop"
$configPath = Join-Path $env:USERPROFILE ".codex\config.toml"

if (-not (Test-Path $configPath)) {
  Write-Host "No Codex config.toml found at $configPath — nothing to remove."
  exit 0
}

$config = Get-Content $configPath -Raw
$before = $config
$config = $config -replace "(?s)# >>> vibe-display hooks >>>.*?# <<< vibe-display hooks <<<\r?\n?", ""
$config = $config -replace "(?s)\[hooks\]\r?\n(?:(?!^\[).)*?(?=^# >>> vibe-display|\Z)", ""

if ($config.Trim() -ne $before.Trim()) {
  Set-Content -Path $configPath -Value $config -NoNewline:$false -Encoding UTF8
  Write-Host "Removed Vibe Display hooks from $configPath" -ForegroundColor Green
} else {
  Write-Host "No Vibe Display hooks block found in $configPath — nothing to remove."
}
