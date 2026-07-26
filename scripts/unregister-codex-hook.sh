#!/usr/bin/env bash
# Remove only Tokenflare's handlers from ~/.codex/hooks.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is required to update Codex hooks safely" >&2
  exit 1
fi

RESULT="$(node "${SCRIPT_DIR}/manage-hooks.mjs" unregister codex)"
CONFIG_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).path)' "$RESULT")"
echo "Removed Tokenflare hooks from $CONFIG_PATH"
