#!/usr/bin/env bash
#
# Remove Tokenflare hooks from Claude Code's settings.json (macOS/Linux).
# Reverse of register-claude-hook.sh. Only drops entries whose command
# references our hook-forward shim; preserves other hooks.
#
set -euo pipefail

CONFIG_PATH="${HOME}/.claude/settings.json"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "No Claude settings.json found at $CONFIG_PATH — nothing to remove."
  exit 0
fi

EVENTS=(SessionStart UserPromptSubmit PreToolUse PostToolUse Notification Stop)

# Prefer jq (cleanest); fall back to node; fall back to python3.
if command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  # Single pass: for each event under .hooks, drop entries whose command
  # references our shim; then drop any event that became empty; then drop
  # .hooks if it became empty. One jq invocation, no shell loop.
  jq '
    def cleaned_entry(e):
      e as $e
      | ($e | map(
          select((.hooks // [])
                 | map(.command // "")
                 | any(test("hook-forward\\.(mjs|sh|ps1)"))
                 | not)));
    if .hooks then
      .hooks = ( .hooks
        | to_entries
        | map(.key as $k | .value = cleaned_entry(.value))
        | map(select(.value | length > 0))
        | from_entries
      )
      | (if (.hooks | length) == 0 then del(.hooks) else . end)
    else . end
  ' "$CONFIG_PATH" > "$tmp" && mv "$tmp" "$CONFIG_PATH"

elif command -v node >/dev/null 2>&1; then
  node - "$CONFIG_PATH" "$(IFS=,; echo "${EVENTS[*]}")" <<'JSEOF'
    const fs = require("fs");
    const path = process.argv[2];
    const events = process.argv[3].split(",");
    let s;
    try { s = JSON.parse(fs.readFileSync(path, "utf8")); } catch { process.exit(0); }
    if (!s.hooks) process.exit(0);
    const re = /hook-forward\.(mjs|sh|ps1)/;
    for (const ev of events) {
      if (!Array.isArray(s.hooks[ev])) continue;
      s.hooks[ev] = s.hooks[ev].filter((entry) => {
        const cmds = (entry.hooks || []).map((h) => h.command || "").join("\n");
        return !re.test(cmds);
      });
      if (s.hooks[ev].length === 0) delete s.hooks[ev];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
    fs.writeFileSync(path, JSON.stringify(s, null, 2));
JSEOF

elif command -v python3 >/dev/null 2>&1; then
  python3 - "$CONFIG_PATH" "$(IFS=,; echo "${EVENTS[*]}")" <<'PYEOF'
import json, re, sys
path, events = sys.argv[1], sys.argv[2].split(",")
try:
    with open(path) as f:
        s = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(s.get("hooks"), dict):
    sys.exit(0)
pat = re.compile(r"hook-forward\.(mjs|sh|ps1)")
for ev in events:
    arr = s["hooks"].get(ev)
    if not isinstance(arr, list):
        continue
    kept = []
    for entry in arr:
        cmds = "\n".join(h.get("command", "") for h in entry.get("hooks", []))
        if not pat.search(cmds):
            kept.append(entry)
    if kept:
        s["hooks"][ev] = kept
    else:
        s["hooks"].pop(ev, None)
if not s["hooks"]:
    s.pop("hooks", None)
with open(path, "w") as f:
    json.dump(s, f, indent=2)
PYEOF
else
  echo "error: need jq, node, or python3 on PATH to edit settings.json" >&2
  exit 1
fi

echo "Removed Tokenflare hooks from $CONFIG_PATH"
