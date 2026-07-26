#!/usr/bin/env bash
#
# Register Tokenflare lifecycle hooks in ~/.claude/settings.json.
#
set -euo pipefail

SERVER_URL="${TOKENFLARE_SERVER:-http://127.0.0.1:7331}"
SHIM="node"

while [ $# -gt 0 ]; do
  case "$1" in
    --sh) SHIM="${2:?--sh requires node or bash}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) SERVER_URL="$1"; shift ;;
  esac
done

if [ "$SHIM" != "node" ] && [ "$SHIM" != "bash" ]; then
  echo "error: --sh must be node or bash" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is required to update Claude Code hooks safely" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANAGER="${SCRIPT_DIR}/manage-hooks.mjs"
if [ "$SHIM" = "bash" ]; then
  COMMAND="bash \"${SCRIPT_DIR}/hook-forward.sh\" claude \"${SERVER_URL}\""
else
  COMMAND="node \"${SCRIPT_DIR}/hook-forward.mjs\" claude \"${SERVER_URL}\""
fi

RESULT="$(node "$MANAGER" register claude "$COMMAND")"
CONFIG_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).path)' "$RESULT")"
EVENTS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).events.join(", "))' "$RESULT")"
echo "Registered Tokenflare lifecycle hooks for Claude Code."
echo "  config : $CONFIG_PATH"
echo "  events : $EVENTS"
echo "To remove: ./scripts/unregister-claude-hook.sh"
