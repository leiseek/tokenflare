#!/usr/bin/env bash
#
# Register Tokenflare hooks into Codex CLI's config.toml (macOS/Linux).
#
# Edits ~/.codex/config.toml so Codex CLI fires our fail-open forwarder on
# SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop.
# Ported from register-codex-hook.ps1 for non-Windows hosts.
#
# Usage:
#   ./register-codex-hook.sh                          # node shim, default URL
#   ./register-codex-hook.sh http://192.168.1.10:7331 # node shim, custom URL
#   ./register-codex-hook.sh --sh bash                 # use bash shim (no node needed)
#   ./register-codex-hook.sh --sh bash http://host:7331
#
# Remove with: ./unregister-codex-hook.sh
#
set -euo pipefail

SERVER_URL="${TOKENFLARE_SERVER:-http://127.0.0.1:7331}"
SHIM="node"

# Parse args: --sh <node|bash> [serverUrl]
while [ $# -gt 0 ]; do
  case "$1" in
    --sh)
      SHIM="${2:?--sh requires an argument (node|bash)}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      SERVER_URL="$1"
      shift
      ;;
  esac
done

if [ "$SHIM" != "node" ] && [ "$SHIM" != "bash" ]; then
  echo "error: --sh must be 'node' or 'bash'" >&2
  exit 1
fi

CODEX_DIR="${HOME}/.codex"
CONFIG_PATH="${CODEX_DIR}/config.toml"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$CODEX_DIR"

# Pick the shim command.
case "$SHIM" in
  node)
    SHIM_PATH="${SCRIPT_DIR}/hook-forward.mjs"
    COMMAND="node \"${SHIM_PATH}\" codex ${SERVER_URL}"
    ;;
  bash)
    SHIM_PATH="${SCRIPT_DIR}/hook-forward.sh"
    COMMAND="bash \"${SHIM_PATH}\" codex ${SERVER_URL}"
    ;;
esac

# Read existing config (or start empty).
touch "$CONFIG_PATH"
CONFIG="$(cat "$CONFIG_PATH" 2>/dev/null || true)"

# Build the managed block. Codex's [hooks] table maps event -> [command].
EVENTS=(SessionStart UserPromptSubmit PreToolUse PostToolUse Notification Stop)

MARKER="# >>> tokenflare hooks >>>"
END_MARKER="# <<< tokenflare hooks <<<"

BLOCK=""
BLOCK+="\n[hooks]\n"
# TOML basic strings use double quotes and require escaping inner double quotes.
COMMAND_ESCAPED="${COMMAND//\"/\\\"}"
for ev in "${EVENTS[@]}"; do
  # event = ["escaped command"]
  BLOCK+="\"${ev}\" = [\"${COMMAND_ESCAPED}\"]\n"
done

# Remove any previous managed block, then append ours.
# Use awk for portable multi-line block removal.
CONFIG_CLEAN="$(printf '%s\n' "$CONFIG" | awk -v ms="$MARKER" -v me="$END_MARKER" '
  $0 ~ ms { inblock=1; next }
  $0 ~ me { inblock=0; next }
  !inblock { print }
')"

# Write back: cleaned config + managed block.
{
  printf '%s\n' "$CONFIG_CLEAN"
  printf '%s\n' "$MARKER"
  printf '%b' "$BLOCK"
  printf '%s\n' "$END_MARKER"
} > "$CONFIG_PATH"

echo "Registered Tokenflare hooks for Codex at: $CONFIG_PATH"
echo "  events : ${EVENTS[*]}"
echo "  command: $COMMAND"
echo ""
echo "To remove: ./unregister-codex-hook.sh"
