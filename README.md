# Vibe Display 🚦

Turn a decommissioned Android phone into an always-on **vibe-coding status indicator** for **Codex** and **Claude Code**.

The phone sits on your desk in **landscape**, showing at a glance:

- 🟢🟡🔴 **Task status** — a glowing traffic light: is an agent *running*, *waiting* on you, *failed*, or *done*?
- ⏳ **Codex quota** — the **5-hour** window and **7-day** (weekly) window remaining.
- 🔁 **Codex reset count** — how many rate-limit resets are still available.
- 🤖 **Claude Code quota** — 5h and 7d remaining.
- 🎨 **Customizable look** — dark neon default, 5 color-pack themes (Nord, Tokyo Night, Catppuccin, Gruvbox, Synthwave), font selection, animated gradient-mesh background with a reduced-motion toggle.

The **PC is the host** (it has the credentials and the editor hooks). The **phone is the display** (a PWA — open the URL, add to home screen, full-screen kiosk).

---

## Quickstart

```bash
# 1. Install (from the repo root)
npm install

# 2. (one time) install the e2e browser if you want to run tests
npx playwright install chromium

# 3. Start the server (prints the phone URL in a banner)
npm start
```

You'll see:

```
┌──────────────────────────────────────────────┐
│  Vibe Display server is up                    │
│  local:   http://127.0.0.1:7331
│  phone:   http://192.168.1.10:7331            │
│  ws:      /ws                                 │
│  codex:   auto-read ~/.codex/auth.json        │
└──────────────────────────────────────────────┘
```

On the phone (same Wi-Fi): open `http://<your-pc-ip>:7331/` → **Add to Home Screen** → launch full-screen in landscape. Done.

> **No Codex login yet?** The display still works — it shows the fallback values from `config/vibe-display.config.json`. Live Codex numbers appear automatically once you've logged into the Codex CLI (the server reads `~/.codex/auth.json`).

---

## How it works

```
 Codex CLI / Claude Code  ──hook──▶  vibe-display server (PC)  ──WS──▶  PWA (phone)
   fires lifecycle hooks            ingests + reduces state          renders traffic light
                                    fetches live Codex quota          + quota cards
```

- **Hooks** fire on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`. A fail-open shim forwards a **sanitized** copy (prompts/transcripts/secrets stripped) to the server.
- The server **reduces** events into a task state with terminal-protection (a stale late event can't resurrect a failed task; `Stop` ≠ done).
- **Live Codex quota** comes from OpenAI's `wham` endpoints (`/backend-api/wham/usage` + `/rate-limit-reset-credits`), auto-reading your Codex CLI OAuth tokens.
- The phone renders a **snapshot/delta** stream over WebSocket; on reconnect it resyncs via a full snapshot — flaky Wi-Fi won't blank the screen.

See [`docs/specs/2026-07-24-vibe-display-design.md`](docs/specs/2026-07-24-vibe-display-design.md) for the full design.

---

## Wiring up real agent hooks (optional, for live task status)

**Windows (PowerShell):**

```powershell
# Register hooks into Codex CLI's config.toml
.\scripts\register-codex-hook.ps1

# Register hooks into Claude Code's settings.json
.\scripts\register-claude-hook.ps1

# Use the pure-PowerShell shim if node isn't guaranteed on PATH at hook time:
.\scripts\register-codex-hook.ps1 -UsePowerShellShim
```

**macOS / Linux (bash):**

```bash
# Register hooks into Codex CLI's config.toml
./scripts/register-codex-hook.sh

# Register hooks into Claude Code's settings.json
./scripts/register-claude-hook.sh

# Use the pure-bash shim (curl) if node isn't on PATH at hook time:
./scripts/register-codex-hook.sh --sh bash
./scripts/register-claude-hook.sh --sh bash http://192.168.1.10:7331   # custom server URL
```

To remove: `unregister-codex-hook.{ps1,sh}` / `unregister-claude-hook.{ps1,sh}`.

The shim is **fail-open**: it always exits 0 within 1s and never affects the agent if the display server is offline.

---

## Configuration

Edit [`config/vibe-display.config.json`](config/vibe-display.config.json):

```jsonc
{
  "server": { "host": "0.0.0.0", "port": 7331 },
  "codex": {
    "autoReadAuthJson": true,        // read ~/.codex/auth.json automatically
    "pollSeconds": 300,              // refresh interval; 0 = off
    "fallback": {                   // shown when no OAuth / fetch fails
      "fiveHour": { "remaining": 80 },
      "weekly":   { "remaining": 91 },
      "resets":   { "available": 2 }
    }
  },
  "claude": {
    "fallback": {                   // Claude has no public usage API; config-only
      "fiveHour": { "remaining": 38 },
      "weekly":   { "remaining": 67 }
    }
  },
  "display": { "defaultTheme": "neon-dark", "defaultFont": "jetbrains" }
}
```

Env overrides: `VIBE_HOST`, `VIBE_PORT`, `VIBE_CODEX_POLL`, `VIBE_CONFIG`.

---

## Testing

```bash
npm test          # 50 unit tests (sanitize, classify, reducer, metrics, format, store, codexWham)
npm run test:e2e  # 9 Playwright e2e tests (hook -> server -> WS -> rendered DOM, incl. compiled-build PWA serving)
npm run typecheck # strict TypeScript, zero errors
```

## Platforms

The **server** (Node.js) and the **PWA** (browser) run on any OS. The **hook registration scripts** are provided in two flavors:

| Platform | Register / Unregister | Fallback shim (when node isn't on PATH) |
|---|---|---|
| **Windows** | `scripts/*.ps1` (PowerShell) | `hook-forward.ps1` |
| **macOS / Linux** | `scripts/*.sh` (bash) | `hook-forward.sh` (curl-based) |

`.gitattributes` forces `.sh` files to LF so they run correctly after a Windows checkout.

## Manual self-test checklist

1. `npm install && npm start` → banner prints LAN URL.
2. Open `http://<pc-ip>:7331/` on the phone (or a desktop browser in a narrow landscape window) → neon-dark hero + 5 quota cards.
3. `curl -X POST .../api/hooks/codex -d '{"hook_event_name":"SessionStart","session_id":"t1","cwd":"D:/proj"}'` → hero turns **green / RUNNING**.
4. `curl -X POST .../api/hooks/codex -d '{"hook_event_name":"Notification","session_id":"t1","cwd":"D:/proj"}'` → hero turns **amber / WAITING**.
5. `curl -X POST .../api/quota/mock -d '{"codex":{"fiveHour":{"remaining":8}},"claude":{}}'` → Codex 5h card goes **red / critical**.
6. Tap the ⚙ gear → switch theme to *Tokyo Night*, toggle *Reduced motion*, pick a font → changes persist across reloads.

---

## Project layout

```
vibe-display/
├─ server/      Node.js + TypeScript host (hooks, quota fetcher, state, REST + WS)
├─ pwa/         Plain HTML/CSS/JS phone display (no build step)
├─ scripts/     Codex/Claude hook registration + fail-open forwarder shims
├─ config/      vibe-display.config.json
├─ e2e/         Playwright end-to-end tests
└─ docs/specs/  design spec
```

## Privacy

The hook shim keeps only an allow-list (`session_id`, `hook_event_name`, `cwd`, `transcript_path`) and **hard-rejects** any payload containing secret markers (`api_key`, `bearer`, `authorization`, …). Raw prompts and transcripts never leave the agent's machine. The phone receives only status + quota numbers.

## License

MIT.
