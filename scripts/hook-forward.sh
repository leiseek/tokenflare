#!/usr/bin/env bash
#
# Codex/Claude hook shim — fail-open forwarder (macOS/Linux).
#
# Reads the provider's hook JSON from stdin, posts a sanitized copy to the
# Vibe Display server, and exits 0 regardless of outcome. The hook must NEVER
# block or fail the agent: all I/O is wrapped, with a hard 1s timeout.
#
# Usage:  hook-forward.sh <codex|claude> [serverUrl]
#
# Wired into Codex's config.toml / Claude's settings.json by the register-*.sh
# scripts. Use this when you can't guarantee `node` is on PATH at hook time
# (the node shim hook-forward.mjs is preferred when node is available).

set -u

PROVIDER="${1:-}"
SERVER_URL="${2:-${VIBE_SERVER:-http://127.0.0.1:7331}}"

# Bad invocation — but we still exit 0 to never block the agent.
if [ "$PROVIDER" != "codex" ] && [ "$PROVIDER" != "claude" ]; then
  exit 0
fi

# Always exit 0, no matter what.
trap 'exit 0' EXIT

# Read stdin with a size cap (256 KiB). If stdin is a TTY, there's no payload.
PAYLOAD=""
if [ -t 0 ]; then
  exit 0
fi
PAYLOAD=$(head -c 262144)
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

# Fire-and-forget POST with a hard 1s timeout. Ignore all errors.
# curl is always present on macOS (system) and virtually every Linux distro.
curl -s -o /dev/null \
  --max-time 1 \
  --connect-timeout 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "${SERVER_URL}/api/hooks/${PROVIDER}" 2>/dev/null

exit 0
