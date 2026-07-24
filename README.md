<div align="center">

# 🔥 Tokenflare

**A visual dashboard for vibe coding with Codex & Claude Code.**

See your agent's task status at a glance (a glowing traffic light), watch your
Codex 5h/7d quota and remaining reset credits drain in real time, and track
your Claude Code usage — all on a dedicated always-on display. Point a browser
at it, or repurpose an old phone into a desk status panel.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey.svg)](#platforms)
[![Tests](https://img.shields.io/badge/tests-50%20unit%20%2B%2010%20e2e-brightgreen.svg)](#testing)

</div>

---

## ✨ What you get

| | |
|---|---|
| 🟢🟡🔴 **Traffic-light task status** | A glowing dot + status word: *running / waiting / failed / done*. Pulsing glow in green/amber/red/blue. Driven by real Codex & Claude Code lifecycle hooks. |
| ⏳ **Codex 5h / 7d quota** | Live remaining % for both windows, straight from OpenAI's `wham` API, with reset-time hints. |
| 🔁 **Codex reset count** | How many rate-limit reset credits you still have. |
| 🤖 **Claude Code quota** | 5h and 7d remaining (config-sourced). |
| 🎨 **Cool customizable look** | Neon-dark default + 5 themes (Nord, Tokyo Night, Catppuccin, Gruvbox, Synthwave), 3 fonts (JetBrains Mono / Inter / system), animated gradient-mesh / aurora background, reduced-motion toggle. All persisted on the phone. |
| 🔒 **Private by design** | Hooks keep only an allow-list of fields; prompts, transcripts, and secrets are stripped at the edge and never sent to the phone. |

---

## 📸 Screenshots

<!-- TODO: drop a screenshot of the landscape hero+quota layout here once you have a real phone capture. -->
<!-- <p align="center"><img src="docs/img/screenshot.png" width="720" alt="tokenflare on a phone"></p> -->

> _Screenshot coming soon — see the [layout sketch](#-layout) below for the arrangement._

---

## 🚀 Quickstart (60 seconds)

```bash
git clone https://github.com/tokenflare/tokenflare.git
cd tokenflare

# Windows
.\install.ps1

# macOS / Linux
./install.sh

# Start the server (prints your phone URL in a banner)
npm start
```

You'll see:

```
┌──────────────────────────────────────────────┐
│  Tokenflare server is up                    │
│  local:   http://127.0.0.1:7331
│  phone:   http://192.168.1.10:7331            │   ← open this on your phone
│  ws:      /ws                                 │
│  codex:   auto-read ~/.codex/auth.json        │
└──────────────────────────────────────────────┘
```

On the phone (same Wi-Fi): open that URL → **Add to Home Screen** → launch
full-screen in landscape. You're done.

> **No Codex login yet?** The display still works — it shows fallback values
> from `config/tokenflare.config.json`. Live Codex numbers appear
> automatically once you've logged into the Codex CLI (the server reads
> `~/.codex/auth.json`).

---

## 🔌 Wiring real agent hooks (for live task status)

Without hooks you still get quota display; with hooks you also get the live
traffic-light task status.

**Windows (PowerShell):**
```powershell
.\scripts\register-codex-hook.ps1
.\scripts\register-claude-hook.ps1
# Use the pure-PowerShell shim if node isn't on PATH at hook time:
.\scripts\register-codex-hook.ps1 -UsePowerShellShim
```

**macOS / Linux (bash):**
```bash
./scripts/register-codex-hook.sh
./scripts/register-claude-hook.sh
# Use the pure-bash (curl) shim if node isn't on PATH at hook time:
./scripts/register-codex-hook.sh --sh bash
```

Remove anytime: `unregister-codex-hook.{ps1,sh}` / `unregister-claude-hook.{ps1,sh}`.

> The hook forwarder is **fail-open**: it always exits 0 within 1 second. If
> the display server is offline, your agent is completely unaffected.

---

## 🗂 Layout

```
+--------------------------+-----------------------------+
|  HERO (40%)              |  QUOTA GRID (60%)           |
|  ● RUNNING               |  Codex 5h   ████░░ 78%      |
|  Refactoring auth        |  Codex 7d   █████░ 91%      |
|  tokenflare            |  Resets     2 left          |
|  04:12                   |  Claude 5h  ██░░░░ 38%      |
|  12:34  ⚙                |  Claude 7d  ████░░ 67%      |
+--------------------------+-----------------------------+
```

Tap the ⚙ gear to switch theme, font, background, reduced-motion, or server URL.

---

## ⚙️ Configuration

Edit [`config/tokenflare.config.json`](config/tokenflare.config.json):

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
    "fallback": {                   // no public usage API; config-only
      "fiveHour": { "remaining": 38 },
      "weekly":   { "remaining": 67 }
    }
  },
  "display": { "defaultTheme": "neon-dark", "defaultFont": "jetbrains" }
}
```

Env overrides: `TOKENFLARE_HOST`, `TOKENFLARE_PORT`, `TOKENFLARE_CODEX_POLL`, `TOKENFLARE_CONFIG`,
`TOKENFLARE_PWA_DIR`. See [`docs/specs/2026-07-24-tokenflare-design.md`](docs/specs/2026-07-24-tokenflare-design.md)
for the full design.

---

## 🧪 Testing

```bash
npm run typecheck   # strict TypeScript, zero errors
npm test            # 50 unit tests (sanitize, classify, reducer, metrics, format, store, codexWham)
npm run test:e2e    # 9 Playwright e2e tests (hook -> server -> WS -> rendered DOM)
```

## 📋 Manual self-test checklist

1. `install.{ps1,sh}` then `npm start` → banner prints your LAN URL.
2. Open the URL on the phone (or a desktop browser in a narrow landscape window) → neon-dark hero + 5 quota cards.
3. `curl -X POST .../api/hooks/codex -d '{"hook_event_name":"SessionStart","session_id":"t1","cwd":"D:/proj"}'` → hero turns **green / RUNNING**.
4. `curl -X POST .../api/hooks/codex -d '{"hook_event_name":"Notification","session_id":"t1","cwd":"D:/proj"}'` → hero turns **amber / WAITING**.
5. `curl -X POST .../api/quota/mock -d '{"codex":{"fiveHour":{"remaining":8}},"claude":{}}'` → Codex 5h card goes **red / critical**.
6. Tap ⚙ → switch theme to *Tokyo Night*, toggle *Reduced motion*, pick a font → changes persist across reloads.

---

## 🌐 Platforms

| Component | Windows | macOS / Linux |
|---|---|---|
| Server (Node.js) | ✅ | ✅ |
| PWA (any phone browser) | ✅ | ✅ |
| Hook registration | `scripts/*.ps1` (PowerShell) | `scripts/*.sh` (bash) |
| Fallback shim (no node on PATH) | `hook-forward.ps1` | `hook-forward.sh` (curl) |
| Install / Uninstall | `install.ps1` / `uninstall.ps1` | `install.sh` / `uninstall.sh` |

> Requires Node.js 20+. The installers check this and tell you how to upgrade.

---

## 🗺️ How it works

```
 Codex CLI / Claude Code  ──hook──▶  tokenflare server (PC)  ──WebSocket──▶  PWA (phone)
   fires lifecycle hooks            ingests + reduces state             renders traffic light
                                    fetches live Codex quota              + quota cards
```

- **Hooks** fire on `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Notification`, `Stop`. A fail-open shim forwards a
  **sanitized** copy (prompts/transcripts/secrets stripped) to the server.
- The server **reduces** events into a task state with terminal-protection
  (a stale late event can't resurrect a failed task; `Stop` ≠ done).
- **Live Codex quota** comes from OpenAI's `wham` endpoints, auto-reading your
  Codex CLI OAuth tokens.
- The phone renders a **snapshot/delta** stream over WebSocket; on reconnect it
  resyncs via a full snapshot — flaky Wi-Fi won't blank the screen.

---

## 🛠️ Troubleshooting

<details>
<summary><b>The phone can't open the URL</b></summary>

- Make sure the phone is on the **same Wi-Fi** as the PC.
- Check your PC firewall isn't blocking port `7331` (the default).
- Use the LAN IP from the banner, not `127.0.0.1` (that only works on the PC itself).
- If the server bound to `127.0.0.1` only, set `TOKENFLARE_HOST=0.0.0.0` and restart.
</details>

<details>
<summary><b>"port 7331 is already in use"</b></summary>

Another process (often a previous server instance) holds the port. Either stop
it, or run on a different port:
```bash
TOKENFLARE_PORT=7332 npm start
```
</details>

<details>
<summary><b>Codex quota shows fallback values, not live numbers</b></summary>

Live numbers require Codex CLI OAuth tokens. Run `codex` once and log in so it
writes `~/.codex/auth.json`. The server reads it automatically. If it still
shows fallbacks, check the server console for `[codex] codex wham failed: ...`.
</details>

<details>
<summary><b>Claude quota never updates</b></summary>

Anthropic exposes no public usage API equivalent to Codex's `wham`. Claude
quota comes from `config/tokenflare.config.json` (`claude.fallback`) and is
updated by editing the file or POSTing to `/api/quota/mock`. Claude **task
status** (the traffic light) still tracks live via hooks.
</details>

<details>
<summary><b>bash scripts fail with <code>bash\r: No such file or directory</code></b></summary>

The scripts got CRLF line endings (e.g. edited on Windows). `.gitattributes`
forces `.sh` to LF — run `git add --renormalize .` and re-checkout. Or run
`dos2unix scripts/*.sh install.sh uninstall.sh`.
</details>

<details>
<summary><b>Settings (theme/font) don't persist</b></summary>

They're stored in the phone browser's `localStorage`. Private/incognito mode,
or clearing site data, resets them. They're per-device by design.
</details>

---

## 🔒 Privacy

- Hooks keep only an allow-list (`session_id`, `hook_event_name`, `cwd`,
  `transcript_path`). Everything else is dropped at ingestion.
- Payloads containing secret markers (`api_key`, `bearer`, `authorization`, …)
  are **hard-rejected** with HTTP 400. The error logs the key *name*, never the value.
- OAuth tokens stay on the PC; the phone receives only status + quota numbers.
- See [`SECURITY.md`](SECURITY.md) for the full model.

---

## 📦 Uninstall

```bash
# Windows
.\uninstall.ps1                  # remove build artifacts
.\uninstall.ps1 -RemoveHooks     # also unregister agent hooks (prompts)

# macOS / Linux
./uninstall.sh                   # remove build artifacts
./uninstall.sh --remove-hooks    # also unregister agent hooks (prompts)
```

Source, config, and docs are never deleted.

---

## 🤝 Contributing

Contributions welcome! Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. In short:
open an issue to discuss, match the code style, add tests, keep `typecheck` +
`npm test` + `npm run test:e2e` green, follow Conventional Commits.

## 📄 License

[MIT](LICENSE) — © tokenflare contributors.

---

<div align="center">

A glowing panel for your vibe coding sessions. 🔥

</div>
