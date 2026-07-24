#!/usr/bin/env bash
#
# vibe-display uninstaller (macOS/Linux).
#
# Reverses what install.sh did and (optionally) what the hook-registration
# scripts did. Removes node_modules, dist, and e2e test artifacts. With
# --remove-hooks, also unregisters the Codex/Claude agent hooks. Never deletes
# source, config, or docs.
#
# Usage:
#   ./uninstall.sh                        # remove build artifacts only
#   ./uninstall.sh --remove-hooks         # also unregister agent hooks (prompts)
#   ./uninstall.sh --remove-hooks --force # no prompts
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOVE_HOOKS=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --remove-hooks) REMOVE_HOOKS=1; shift ;;
    --force)        FORCE=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

c_step() { printf '\033[36m==>\033[0m %s\n' "$1"; }
c_ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
c_warn() { printf '    \033[33m%s\033[0m\n' "$1"; }

confirm() {
  if [ "$FORCE" -eq 1 ]; then return 0; fi
  printf '%s [y/N] ' "$1"
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

echo ""
echo "  vibe-display uninstaller"
echo "  ------------------------"
echo ""

# ---- 1. hooks (optional, with confirmation) ----
if [ "$REMOVE_HOOKS" -eq 1 ]; then
  if confirm "Unregister Codex and Claude agent hooks?"; then
    for s in unregister-codex-hook.sh unregister-claude-hook.sh; do
      p="$ROOT/scripts/$s"
      if [ -f "$p" ]; then bash "$p"; else c_warn "$s not found."; fi
    done
  else
    c_warn "Skipping hook removal."
  fi
else
  c_warn "Leaving agent hooks in place. Re-run with --remove-hooks to remove them."
fi

# ---- 2. build artifacts ----
for t in \
  "$ROOT/node_modules" \
  "$ROOT/server/node_modules" \
  "$ROOT/e2e/node_modules" \
  "$ROOT/server/dist" \
  "$ROOT/e2e/test-results" \
  "$ROOT/e2e/playwright-report"
do
  if [ -e "$t" ]; then
    c_step "Removing $(basename "$t")..."
    rm -rf "$t"
    c_ok "removed."
  fi
done

# ---- 3. done ----
echo ""
echo "  Done."
echo ""
echo "  Source files, config, and docs were left untouched."
echo "  To reinstall: ./install.sh"
echo ""
