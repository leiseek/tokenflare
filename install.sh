#!/usr/bin/env bash
#
# tokenflare installer (macOS/Linux).
#
# Verifies Node.js 20+, interactively configures the outbound proxy, runs npm
# install, builds the server, and optionally installs the Playwright browser.
#
# Usage:
#   ./install.sh                       # full install + build
#   ./install.sh --skip-build          # skip build (run server from source via tsx)
#   ./install.sh --install-test-browser # also install Playwright chromium
#   ./install.sh --force               # reinstall even if node_modules exists
#   ./install.sh --no-prompt           # keep existing proxy config without prompts
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_BUILD=0
INSTALL_TEST_BROWSER=0
FORCE=0
NO_PROMPT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)           SKIP_BUILD=1; shift ;;
    --install-test-browser) INSTALL_TEST_BROWSER=1; shift ;;
    --force)                FORCE=1; shift ;;
    --no-prompt)            NO_PROMPT=1; shift ;;
    -h|--help)
      sed -n '3,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

c_step() { printf '\033[36m==>\033[0m %s\n' "$1"; }
c_ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
c_warn() { printf '    \033[33m%s\033[0m\n' "$1"; }
c_err()  { printf '    \033[31mERROR: %s\033[0m\n' "$1"; }

echo ""
echo "  tokenflare installer"
echo "  ----------------------"
echo ""

# ---- 1. Check Node.js 20+ ----
c_step "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  c_err "Node.js is not installed or not on PATH."
  echo ""
  echo "    tokenflare requires Node.js 20 or later." >&2
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

# ---- 2. proxy configuration ----
CONFIG_PATH="$ROOT/config/tokenflare.config.json"
CONFIG_EXAMPLE="$ROOT/config/tokenflare.config.example.json"
# The real config is gitignored (it holds machine-specific values such as your
# proxy), so a fresh clone starts from the checked-in template.
if [ ! -f "$CONFIG_PATH" ] && [ -f "$CONFIG_EXAMPLE" ]; then
  cp "$CONFIG_EXAMPLE" "$CONFIG_PATH"
  c_ok "Created config/tokenflare.config.json from the example."
fi
if [ "$NO_PROMPT" -eq 1 ]; then
  c_step "Keeping the existing proxy config (--no-prompt)."
elif [ -f "$CONFIG_PATH" ]; then
  c_step "Configuring the network proxy for Codex quota requests..."
  CURRENT_PROXY="$(node -e '
    try {
      const c = require(process.argv[1]);
      process.stdout.write(c.proxy?.url || "");
    } catch {}
  ' "$CONFIG_PATH")"

  KEEP_CURRENT=0
  if [ -n "$CURRENT_PROXY" ]; then
    c_ok "Current proxy: $CURRENT_PROXY"
    while true; do
      read -r -p "    Keep this proxy? [Y/n] " ANSWER
      case "$ANSWER" in
        ""|y|Y|yes|YES|Yes) KEEP_CURRENT=1; break ;;
        n|N|no|NO|No) break ;;
        *) c_warn "Please enter y or n." ;;
      esac
    done
  fi

  if [ "$KEEP_CURRENT" -eq 0 ]; then
    while true; do
      read -r -p "    Use a proxy? [y/N] " ANSWER
      case "$ANSWER" in
        ""|n|N|no|NO|No) USE_PROXY=0; break ;;
        y|Y|yes|YES|Yes) USE_PROXY=1; break ;;
        *) c_warn "Please enter y or n." ;;
      esac
    done

    PROXY_URL=""
    if [ "$USE_PROXY" -eq 1 ]; then
      echo "    1) HTTP"
      echo "    2) SOCKS5 (DNS also goes through the proxy)"
      while true; do
        read -r -p "    Proxy type [1/2] " PROXY_TYPE
        case "$PROXY_TYPE" in
          1|http|HTTP|Http) SCHEME="http"; break ;;
          2|sock|SOCK|Sock|socks|SOCKS|Socks|socks5|SOCKS5|Socks5) SCHEME="socks5h"; break ;;
          *) c_warn "Choose 1 for HTTP or 2 for SOCKS5." ;;
        esac
      done

      read -r -p "    Proxy IP or hostname [127.0.0.1] " PROXY_HOST
      PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
      if [[ "$PROXY_HOST" == *:* && "$PROXY_HOST" != \[* ]]; then
        PROXY_HOST="[$PROXY_HOST]"
      fi
      while true; do
        read -r -p "    Proxy port " PROXY_PORT
        if [[ "$PROXY_PORT" =~ ^[0-9]+$ ]] && [ "$PROXY_PORT" -ge 1 ] && [ "$PROXY_PORT" -le 65535 ]; then
          break
        fi
        c_warn "Enter a port from 1 to 65535."
      done
      PROXY_URL="${SCHEME}://${PROXY_HOST}:${PROXY_PORT}"
    fi

    node - "$CONFIG_PATH" "$PROXY_URL" <<'NODE'
const fs = require("node:fs");
const [configPath, proxyUrl] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.proxy = proxyUrl ? { url: proxyUrl } : null;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
    if [ -n "$PROXY_URL" ]; then
      c_ok "Proxy saved: $PROXY_URL"
    else
      c_ok "Proxy disabled; Tokenflare will connect directly."
    fi
  fi
else
  c_warn "Config file not found: $CONFIG_PATH (skipping proxy setup)."
fi

# ---- 3. npm install ----
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

# ---- 4. build ----
if [ "$SKIP_BUILD" -eq 1 ]; then
  c_step "Skipping build (--skip-build). Server will run from source via tsx."
else
  c_step "Building the server (npm run build)..."
  ( cd "$ROOT" && npm run build )
  c_ok "Server built -> server/dist/"
fi

# ---- 5. optional: test browser ----
if [ "$INSTALL_TEST_BROWSER" -eq 1 ]; then
  c_step "Installing Playwright Chromium (for e2e tests)..."
  ( cd "$ROOT" && npx playwright install chromium )
  c_ok "Playwright browser installed."
fi

# ---- 6. connect coding-agent hooks ----
if [ "$NO_PROMPT" -eq 1 ]; then
  c_step "Skipping interactive Codex/Claude Code hook setup (--no-prompt)."
else
  c_step "Connecting coding agents for live task status..."
  CODEX_DEFAULT="N"
  if command -v codex >/dev/null 2>&1; then CODEX_DEFAULT="Y"; fi
  while true; do
    if [ "$CODEX_DEFAULT" = "Y" ]; then
      read -r -p "    Connect Codex now? [Y/n] " ANSWER
      case "$ANSWER" in ""|y|Y|yes|YES|Yes) CONNECT_CODEX=1; break ;; n|N|no|NO|No) CONNECT_CODEX=0; break ;; esac
    else
      read -r -p "    Codex was not detected. Register its hooks anyway? [y/N] " ANSWER
      case "$ANSWER" in y|Y|yes|YES|Yes) CONNECT_CODEX=1; break ;; ""|n|N|no|NO|No) CONNECT_CODEX=0; break ;; esac
    fi
    c_warn "Please enter y or n."
  done
  if [ "$CONNECT_CODEX" -eq 1 ]; then
    bash "$ROOT/scripts/register-codex-hook.sh"
  fi

  CLAUDE_DEFAULT="N"
  if command -v claude >/dev/null 2>&1; then CLAUDE_DEFAULT="Y"; fi
  while true; do
    if [ "$CLAUDE_DEFAULT" = "Y" ]; then
      read -r -p "    Connect Claude Code now? [Y/n] " ANSWER
      case "$ANSWER" in ""|y|Y|yes|YES|Yes) CONNECT_CLAUDE=1; break ;; n|N|no|NO|No) CONNECT_CLAUDE=0; break ;; esac
    else
      read -r -p "    Claude Code was not detected. Register its hooks anyway? [y/N] " ANSWER
      case "$ANSWER" in y|Y|yes|YES|Yes) CONNECT_CLAUDE=1; break ;; ""|n|N|no|NO|No) CONNECT_CLAUDE=0; break ;; esac
    fi
    c_warn "Please enter y or n."
  done
  if [ "$CONNECT_CLAUDE" -eq 1 ]; then
    bash "$ROOT/scripts/register-claude-hook.sh"
  fi
fi

# ---- 7. summary ----
echo ""
echo "  Done!"
echo ""
echo "  Next:"
echo "    1. Start the server:  npm start"
echo "       (it prints the phone URL in a banner)"
echo "    2. Open that URL on your phone's browser, add to home screen."
echo "    3. Codex/Claude Code hooks can be changed anytime:"
echo "         ./scripts/register-*-hook.sh / unregister-*-hook.sh"
echo ""
echo "  Docs: README.md | Uninstall: ./uninstall.sh"
echo ""
