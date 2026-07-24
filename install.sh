#!/usr/bin/env bash
#
# vibe-display installer (macOS/Linux).
#
# Verifies Node.js 20+, runs npm install, builds the server, and (optionally)
# installs the Playwright browser for e2e tests. Safe to re-run.
#
# Usage:
#   ./install.sh                       # full install + build
#   ./install.sh --skip-build          # skip build (run server from source via tsx)
#   ./install.sh --install-test-browser # also install Playwright chromium
#   ./install.sh --force               # reinstall even if node_modules exists
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_BUILD=0
INSTALL_TEST_BROWSER=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)           SKIP_BUILD=1; shift ;;
    --install-test-browser) INSTALL_TEST_BROWSER=1; shift ;;
    --force)                FORCE=1; shift ;;
    -h|--help)
      sed -n '3,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

c_step() { printf '\033[36m==>\033[0m %s\n' "$1"; }
c_ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
c_warn() { printf '    \033[33m%s\033[0m\n' "$1"; }
c_err()  { printf '    \033[31mERROR: %s\033[0m\n' "$1"; }

echo ""
echo "  vibe-display installer"
echo "  ----------------------"
echo ""

# ---- 1. Check Node.js 20+ ----
c_step "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  c_err "Node.js is not installed or not on PATH."
  echo ""
  echo "    vibe-display requires Node.js 20 or later." >&2
  echo "    Install it from https://nodejs.org/ (or use nvm/fnm/volta) and re-run." >&2
  echo ""
  exit 1
fi
NODE_VERSION_RAW="$(node --version)"   # e.g. v24.14.1
NODE_MAJOR="${NODE_VERSION_RAW#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  c_err "Node.js $NODE_VERSION_RAW is too old (need 20+)."
  echo "    Upgrade at https://nodejs.org/" >&2
  exit 1
fi
c_ok "Node.js $NODE_VERSION_RAW found."

# ---- 2. npm install ----
if [ -d "$ROOT/node_modules" ] && [ "$FORCE" -eq 0 ]; then
  c_step "Dependencies already installed (node_modules exists). Use --force to reinstall."
else
  c_step "Installing dependencies (npm install)..."
  (
    cd "$ROOT"
    npm install --no-fund --no-audit
  )
  c_ok "Dependencies installed."
fi

# ---- 3. build ----
if [ "$SKIP_BUILD" -eq 1 ]; then
  c_step "Skipping build (--skip-build). Server will run from source via tsx."
else
  c_step "Building the server (npm run build)..."
  ( cd "$ROOT" && npm run build )
  c_ok "Server built -> server/dist/"
fi

# ---- 4. optional: test browser ----
if [ "$INSTALL_TEST_BROWSER" -eq 1 ]; then
  c_step "Installing Playwright Chromium (for e2e tests)..."
  ( cd "$ROOT" && npx playwright install chromium )
  c_ok "Playwright browser installed."
fi

# ---- 5. summary ----
echo ""
echo "  Done!"
echo ""
echo "  Next:"
echo "    1. Start the server:  npm start"
echo "       (it prints the phone URL in a banner)"
echo "    2. Open that URL on your phone's browser, add to home screen."
echo "    3. (optional) Wire real agent hooks:"
echo "         ./scripts/register-codex-hook.sh"
echo "         ./scripts/register-claude-hook.sh"
echo ""
echo "  Docs: README.md | Uninstall: ./uninstall.sh"
echo ""
