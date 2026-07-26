#!/usr/bin/env bash
#
# Codex/Claude hook shim — fail-open forwarder (macOS/Linux).
#
# Reads the provider's hook JSON from stdin, posts a sanitized copy to the
# Tokenflare server, and exits 0 regardless of outcome. The hook must NEVER
# block or fail the agent: all I/O is wrapped, with a hard 1s timeout.
#
# Usage:  hook-forward.sh <codex|claude> [serverUrl]
#
# Wired into Codex's config.toml / Claude's settings.json by the register-*.sh
# scripts. Use this when you can't guarantee `node` is on PATH at hook time
# (the node shim hook-forward.mjs is preferred when node is available).

set -u

PROVIDER="${1:-}"
SERVER_URL="${2:-${TOKENFLARE_SERVER:-http://127.0.0.1:7331}}"

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

# Sanitize before transmission. If neither jq nor python3 is available, fail
# open without sending rather than leaking prompt/tool content.
SAFE_PAYLOAD=""
if command -v jq >/dev/null 2>&1; then
  SAFE_PAYLOAD="$(printf '%s' "$PAYLOAD" | jq -c '
    with_entries(select(.key == "session_id"
      or .key == "hook_event_name"
      or .key == "cwd"
      or .key == "transcript_path"))
    | with_entries(select(.value | type == "string"))
  ' 2>/dev/null || true)"
elif command -v python3 >/dev/null 2>&1; then
  SAFE_PAYLOAD="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    keys = ("session_id", "hook_event_name", "cwd", "transcript_path")
    print(json.dumps({k: data[k] for k in keys if isinstance(data.get(k), str)}))
except Exception:
    pass
' 2>/dev/null || true)"
fi
if [ -z "$SAFE_PAYLOAD" ]; then
  exit 0
fi

# Fire-and-forget POST with a hard 1s timeout. Ignore all errors.
# curl is always present on macOS (system) and virtually every Linux distro.
curl -s -o /dev/null \
  --max-time 1 \
  --connect-timeout 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$SAFE_PAYLOAD" \
  "${SERVER_URL}/api/hooks/${PROVIDER}" 2>/dev/null

exit 0
