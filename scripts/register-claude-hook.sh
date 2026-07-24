#!/usr/bin/env bash
#
# Register Tokenflare hooks into Claude Code's settings.json (macOS/Linux).
#
# Edits ~/.claude/settings.json so Claude Code fires our fail-open forwarder on
# SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification
# (waiting), and Stop. Ported from register-claude-hook.ps1 for non-Windows.
#
# Usage:
#   ./register-claude-hook.sh
#   ./register-claude-hook.sh http://192.168.1.10:7331
#   ./register-claude-hook.sh --sh bash            # use bash shim (no node needed)
#
# Remove with: ./unregister-claude-hook.sh
#
set -euo pipefail

SERVER_URL="${TOKENFLARE_SERVER:-http://127.0.0.1:7331}"
SHIM="node"

while [ $# -gt 0 ]; do
  case "$1" in
    --sh)
      SHIM="${2:?--sh requires an argument (node|bash)}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,14p' "$0"
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

CLAUDE_DIR="${HOME}/.claude"
CONFIG_PATH="${CLAUDE_DIR}/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$CLAUDE_DIR"

case "$SHIM" in
  node)
    SHIM_PATH="${SCRIPT_DIR}/hook-forward.mjs"
    COMMAND="node \"${SHIM_PATH}\" claude ${SERVER_URL}"
    ;;
  bash)
    SHIM_PATH="${SCRIPT_DIR}/hook-forward.sh"
    COMMAND="bash \"${SHIM_PATH}\" claude ${SERVER_URL}"
    ;;
esac

# Claude Code expects hooks under settings.hooks.<EventName> = [{hooks:[{type:"command",command:"..."}]}]
# We need JSON editing. Prefer jq if available; fall back to node; fall back to python3.
EVENTS=(SessionStart UserPromptSubmit PreToolUse PostToolUse Notification Stop)

# Ensure a settings.json exists (empty object if not).
if [ ! -f "$CONFIG_PATH" ]; then
  echo '{}' > "$CONFIG_PATH"
fi

write_with_jq() {
  local tmp
  tmp="$(mktemp)"
  local cmd_json
  cmd_json=$(printf '%s' "$COMMAND" | jq -R .)
  # Build the full hooks object with all events, then merge.
  local hooks_obj="{"
  local first=1
  for ev in "${EVENTS[@]}"; do
    if [ $first -eq 0 ]; then hooks_obj+=","; fi
    first=0
    hooks_obj+="\"${ev}\":[{\"hooks\":[{\"type\":\"command\",\"command\":${cmd_json}}]}]"
  done
  hooks_obj+="}"
  jq --argjson hooks "$hooks_obj" '.hooks = $hooks' "$CONFIG_PATH" > "$tmp" && mv "$tmp" "$CONFIG_PATH"
}

write_with_node() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const command = process.argv[2];
    const events = process.argv[3].split(",");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    s.hooks = {};
    for (const ev of events) {
      s.hooks[ev] = [{ hooks: [{ type: "command", command }] }];
    }
    fs.writeFileSync(path, JSON.stringify(s, null, 2));
  ' "$CONFIG_PATH" "$COMMAND" "$(IFS=,; echo "${EVENTS[*]}")"
}

write_with_python() {
  python3 - "$CONFIG_PATH" "$COMMAND" "$(IFS=,; echo "${EVENTS[*]}")" <<'PYEOF'
import json, sys
path, command, events = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
try:
    with open(path) as f:
        s = json.load(f)
except Exception:
    s = {}
s["hooks"] = {ev: [{"hooks": [{"type": "command", "command": command}]}] for ev in events}
with open(path, "w") as f:
    json.dump(s, f, indent=2)
PYEOF
}

if command -v jq >/dev/null 2>&1; then
  write_with_jq
elif command -v node >/dev/null 2>&1; then
  write_with_node
elif command -v python3 >/dev/null 2>&1; then
  write_with_python
else
  echo "error: need jq, node, or python3 on PATH to edit settings.json" >&2
  exit 1
fi

echo "Registered Tokenflare hooks for Claude Code at: $CONFIG_PATH"
echo "  events : ${EVENTS[*]}"
echo "  command: $COMMAND"
echo ""
echo "To remove: ./unregister-claude-hook.sh"
