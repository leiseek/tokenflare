#!/usr/bin/env bash
#
# Remove Tokenflare hooks from Codex CLI's config.toml (macOS/Linux).
# Reverse of register-codex-hook.sh.
#
set -euo pipefail

CONFIG_PATH="${HOME}/.codex/config.toml"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "No Codex config.toml found at $CONFIG_PATH — nothing to remove."
  exit 0
fi

MARKER="# >>> tokenflare hooks >>>"
END_MARKER="# <<< tokenflare hooks <<<"

# Remove the managed block (awk). Also drop an orphaned empty [hooks] table
# left behind if we were the only subscriber.
BEFORE="$(cat "$CONFIG_PATH")"

AFTER="$(awk -v ms="$MARKER" -v me="$END_MARKER" '
  $0 ~ ms { inblock=1; next }
  $0 ~ me { inblock=0; next }
  !inblock { print }
' "$CONFIG_PATH")"

# Strip a trailing empty [hooks] table (no keys) if present.
AFTER="$(printf '%s\n' "$AFTER" | awk '
  /^\[hooks\][[:space:]]*$/ { saw_hooks=1; hooks_buf=$0"\n"; next }
  saw_hooks && /^[[:space:]]*[A-Za-z]/ { saw_hooks=0; print hooks_buf; hooks_buf="" }
  saw_headers && !saw_hooks { }
  { if (saw_hooks) hooks_buf=hooks_buf$0"\n"; else print }
')"

if [ "$BEFORE" != "$AFTER" ]; then
  printf '%s\n' "$AFTER" > "$CONFIG_PATH"
  echo "Removed Tokenflare hooks from $CONFIG_PATH"
else
  echo "No Tokenflare hooks block found in $CONFIG_PATH — nothing to remove."
fi
