# Tokenflare — Design Spec

**Date:** 2026-07-24
**Status:** Implemented (v1.0.0)
**Owner:** Tokenflare contributors

## 1. Overview

### Problem
Turn a decommissioned Android phone into a always-on **vibe coding status indicator** for Codex / Claude Code. The phone sits on the desk, in landscape, showing at a glance:

- **Task status** as a traffic light (red / yellow / green) — is an agent running, waiting, failed, done?
- **Codex quota** — the 5-hour window and the 7-day (weekly) window remaining.
- **Codex reset-credit count** — how many rate-limit resets remain.
- **Claude Code quota** — 5-hour and 7-day windows remaining.
- **Current task** — name + elapsed time + reset-time hints.

The PC is the **host** (it has the credentials and the editor hooks). The phone is the **display** (PWA open in the browser, added to home screen, full-screen kiosk).

### Goals
- Self-contained repo, split into clear subfolders.
- Works on a desk immediately for self-test with mock data (no credentials required).
- Real data when Codex OAuth credentials are supplied.
- Real task status via Codex/Claude provider hooks.
- Cool customizable look: dark neon default, 5 color-pack themes, font selection, animated background, reduced-motion toggle.
- Landscape-first phone layout.

### Non-Goals (this pass)
- Native Android APK packaging (Capacitor/React Native). A PWA is enough.
- Multi-user / multi-tenant / cloud deployment. Single-user, single-desk.
- Storing prompts, transcripts, or credentials beyond the OAuth tokens strictly needed to fetch usage.
- Anthropic live-usage proxy (Anthropic has no public "wham"-style usage endpoint equivalent). Claude quota is sourced from config file or, where possible, derived from local request observation.

---

## 2. Influences from reference projects

| Pattern | Source | How we use it |
|---|---|---|
| Provider hook → lifecycle mapping (`Started/Activity/Waiting/Completed/Failed`) | pulse-island (`pulse-codex-adapter`, `pulse-claude-adapter`) | Server ingests sanitized hook events into a task state machine |
| Edge content sanitation (drop `prompt`/`transcript_path`/`tool_input`; reject `api_key`/`secret`) | pulse-island `parse_codex_hook` | Hook forwarder keeps only allow-listed fields |
| Terminal-protection reducer (don't let stale `Stop` overwrite a real `Completed`) | pulse-island `pulse-reducer` | Status state machine |
| Snapshot/delta protocol over reconnect | pulse-island `IslandMessage` | Phone can reconnect and resync without replaying events |
| `UnifiedQuotaMetric` shape (`label`, `percentage`, `quotaClass`, `valueText`, `resetText`, `progressPercent`) | cockpit-tools `platformAccountPresentation.ts` | Single normalized metric type for all quota cards |
| 4-tier classifier `high/medium/low/critical` with thresholds 80/40/10 | cockpit-tools `getCodexQuotaClass` | Traffic-light coloring |
| Codex 5h + weekly window builder | cockpit-tools `getCodexQuotaWindows` | `buildCodexMetrics` |
| `reset_credits_available` + next-expiry formatting | cockpit-tools `CodexAccountsPage` reset-credit logic | Reset-count card |
| Status color palette (green/amber/red/blue) + glow `text-shadow` / `box-shadow` | pulse-island `rgb_for_token`, cockpit-tools CSS | Neon-dark default theme |
| 5 color-pack themes via CSS variables | cockpit-tools `base.css` | Theme switcher |
| Live Codex "wham" usage fetch (`/backend-api/wham/usage`, `/backend-api/wham/rate-limit-reset-credits`) + OAuth refresh on 401 | new-api `codex_wham_usage.go`, `codex_usage.go` | Codex quota source when OAuth creds provided |
| `{success, message, data}` response envelope | new-api `common/gin.go` | Server REST responses |

---

## 3. Architecture

```
                PC (host)                                              Phone (display)
 ┌─────────────────────────────────────────────┐                ┌────────────────────────────┐
 │ Codex CLI  ─┐                               │                │                            │
 │ Claude Code ┘ fire provider hooks           │                │   PWA (HTML/CSS/JS)        │
 │              on lifecycle events            │                │   - hero traffic light     │
 │         │                                   │                │   - quota cards grid       │
 │         ▼  sanitized event (stdin JSON,     │   HTTP (REST)  │   - animated bg            │
 │   vibe-hook.exe  / hook shim script  ───────┼──────────────▶ │   <── GET /api/state ──┐    │
 │   (allow-list only: session_id, event, cwd) │  WebSocket      │   <── WS push ─────────┤    │
 │         │                                   │  /ws (state)    │                        ▼    │
 │         ▼                                   │◀──────────────▶│   settings: theme, font,  │
 │  vibe-server (Node.js + TS)                 │                │   background, reduced-mtn │
 │   ├─ hook ingress + reducer                 │                │                            │
 │   ├─ codex wham fetcher (live, OAuth)       │                │   landscape, full-screen   │
 │   ├─ claude quota (config/observed)         │                └────────────────────────────┘
 │   ├─ config file fallback (mock/manual)     │
 │   ├─ REST API (/api/state, /api/config)     │
 │   ├─ WebSocket broadcast                    │
 │   └─ serves PWA static assets               │
 └─────────────────────────────────────────────┘
```

### Topology
- **One host process** (`vibe-server`) on the PC: ingests hook events, fetches quota, holds the single source of truth, exposes REST + WebSocket, and serves the PWA.
- **One display** (PWA) on the phone: connects over the LAN to the host, renders, and subscribes to live updates. Reconnects and re-syncs via a full snapshot on reconnect.
- The host is authoritative; the phone is a thin view. The phone persists only its own *display preferences* (theme/font/background) locally; all *data* comes from the host.

### Data flow
1. Agent fires a provider hook → hook shim parses stdin JSON, keeps only allow-listed fields, POSTs `POST /api/hooks/:provider` to the host (or writes via the WS).
2. Host reducer folds the event into the task state machine; broadcasts a delta over WS.
3. Separately, a background ticker on the host polls Codex wham usage every N minutes (when OAuth creds configured) and folds new quota numbers into state; broadcasts a delta.
4. PWA renders the latest snapshot; ignores deltas older than the last snapshot revision; on reconnect, requests `GET /api/state` for a full snapshot.

---

## 4. Repository layout

```
tokenflare/        (repo root)
├─ docs\
│  └─ specs\
│     └─ 2026-07-24-tokenflare-design.md      ← this file
├─ server\                                       ← host (Node.js + TS)
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ README.md
│  ├─ src\
│  │  ├─ index.ts                                ← entry: starts HTTP+WS server
│  │  ├─ config.ts                               ← load config.json5 / env
│  │  ├─ server.ts                               ← http + ws setup
│  │  ├─ state\
│  │  │  ├─ store.ts                             ← in-memory authoritative state + revision
│  │  │  ├─ reducer.ts                           ← hook event → task state (terminal-protected)
│  │  │  └─ types.ts                             ← TaskState, QuotaMetric, Snapshot, Delta
│  │  ├─ hooks\
│  │  │  ├─ ingest.ts                            ← POST /api/hooks/:provider handler
│  │  │  ├─ sanitize.ts                          ← allow-list + secret-reject logic
│  │  │  └─ mapEvent.ts                          ← provider event name → EvidenceKind
│  │  ├─ quota\
│  │  │  ├─ classify.ts                          ← percentage → high/medium/low/critical
│  │  │  ├─ metrics.ts                           ← build UnifiedQuotaMetric[] for state
│  │  │  ├─ codexWham.ts                         ← live wham fetcher + OAuth refresh
│  │  │  ├─ claudeQuota.ts                       ← config/observed claude quota
│  │  │  └─ format.ts                            ← reset-time + value formatters
│  │  ├─ api\
│  │  │  ├─ rest.ts                              ← GET /api/state, /api/config, POST /api/override
│  │  │  └─ ws.ts                                ← /ws subscribe/broadcast + snapshot/delta protocol
│  │  └─ jobs\
│  │     └─ codexPoll.ts                         ← periodic wham refresh
│  └─ test\
│     ├─ reducer.test.ts
│     ├─ classify.test.ts
│     ├─ sanitize.test.ts
│     ├─ metrics.test.ts
│     └─ format.test.ts
├─ pwa\                                          ← display (static PWA)
│  ├─ index.html
│  ├─ manifest.webmanifest                        ← landscape, fullscreen, standalone
│  ├─ sw.js                                       ← service worker (cache shell)
│  ├─ styles\
│  │  ├─ base.css                                 ← neon-dark default tokens
│  │  ├─ themes.css                               ← 5 color packs via [data-theme]
│  │  └─ components.css                           ← hero, cards, bars, glow
│  ├─ js\
│  │  ├─ app.js                                   ← main: WS client + render loop
│  │  ├─ render.js                                ← snapshot → DOM
│  │  ├─ settings.js                              ← theme/font/background persistence
│  │  └─ client.js                                ← WS reconnect + snapshot/delta handling
│  └─ types.d.ts                                  ← shared types for editor help (not compiled)
│  └─ README.md
├─ scripts\
│  ├─ register-codex-hook.ps1                     ← wire Codex hooks (port from pulse-island)
│  ├─ register-claude-hook.ps1                    ← wire Claude hooks
│  ├─ unregister-codex-hook.ps1
│  └─ unregister-claude-hook.ps1
├─ config\
│  └─ tokenflare.config.json                    ← example config (quota fallback, ports, codex oauth)
├─ e2e\                                           ← Playwright
│  ├─ playwright.config.ts
│  └─ tests\
│     └─ end-to-end.test.ts                        ← inject hook → assert DOM
├─ package.json                                   ← workspace root (npm workspaces)
├─ README.md                                      ← quickstart + architecture
└─ .gitignore
```

---

## 5. Data model (host state + wire protocol)

All wire payloads are JSON. Enumerate the canonical types:

### 5.1 `EvidenceKind` (provider-neutral hook event)
```ts
type EvidenceKind =
  | "started"      // SessionStart
  | "activity"     // UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd
  | "waiting"      // PermissionRequest / Notification
  | "completed"    // explicit task completion (manual override or future Stop+flag)
  | "failed";      // error / abort
```
> Mapping rule copied from pulse-island: `Stop`/`SessionEnd` map to **`activity`**, *not* `completed` — the agent finishing a response ≠ the user's task being done.

### 5.2 `TaskStatus` (traffic-light state, derived by reducer)
```ts
type TaskStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "observed";
```
Color mapping (host computes, phone renders):
- `running` → green `#49c980`
- `waiting` → amber `#ffb84d`
- `failed`  → red `#ff6369`
- `completed` → blue `#699eff`
- `idle` / `observed` → muted grey `#7f8490`

### 5.3 `TaskState`
```ts
interface TaskState {
  taskId: string;            // session_id from hook, or "manual"
  provider: "codex" | "claude" | "manual";
  cwdLabel: string;          // basename of cwd, sanitized
  status: TaskStatus;
  startedAt: number | null;  // epoch ms
  lastActivityAt: number | null;
  label: string;             // best-effort label
}
```
> **`label` source:** Codex/Claude hooks do not expose the user's prompt or task description (we deliberately drop them for privacy, per §5.1). So `label` defaults to the `cwdLabel` (the project folder name). A richer label can be set via `POST /api/override/task` (manual) — e.g. the user tags the current task from the settings panel. The hero shows `label` then `cwdLabel` as a subline so the project context is never lost.

### 5.4 `QuotaMetric` (the `UnifiedQuotaMetric` port)
```ts
type QuotaClass = "high" | "medium" | "low" | "critical";

interface QuotaMetric {
  key: string;               // "codex_5h", "codex_7d", "codex_resets", "claude_5h", "claude_7d"
  label: string;             // "Codex 5h"
  provider: "codex" | "claude";
  window?: "5h" | "7d" | "resets";
  semantics: "remaining" | "used" | "count";   // ★ critical: how to read `percentage`
  percentage: number;        // 0..100 in the metric's semantics
  quotaClass: QuotaClass;    // pre-classified by host
  valueText: string;         // "78%" / "2 left" / "$4.20 left"
  resetText?: string;        // "resets 14:30"
  progressPercent?: number;  // for the bar (normalized so bigger=better remaining for display)
  nextResetAt?: number | null; // epoch ms
  source: "live" | "config" | "observed";
}
```
> **Semantics footgun, fixed:** cockpit-tools mixed remaining/used across providers. We make the metric carry its `semantics` explicitly and **normalize the progress bar to "fraction remaining"** so the bar always reads "more filled = more quota left", independent of source. Classifier thresholds (see 5.6) are applied *after* normalizing to remaining.

### 5.5 `Snapshot` (full state, sent on connect + on `GET /api/state`)
```ts
interface Snapshot {
  revision: number;          // monotonic
  serverTime: number;        // epoch ms
  task: TaskState | null;    // current/last task
  metrics: QuotaMetric[];    // quota cards
  source: { codex: "live"|"config"|"observed"; claude: "config"|"observed" };
}
```

### 5.6 Classifier (port of `getCodexQuotaClass`)
Input is **remaining percent** (0..100, higher = more left). Thresholds:
- `>= 80` → `high` (green)
- `>= 40` → `medium` (amber)
- `>= 10` → `low` (orange-strong)
- `< 10`  → `critical` (red)

For `semantics: "used"` metrics, convert first: `remaining = 100 - usedPercent`. For `semantics: "count"` (reset credits), classify directly: `2+→high, 1→medium, 0→critical`.

### 5.7 WebSocket protocol
- Connect: `ws://<host>:<port>/ws`
- Client → server: `{ type: "hello", client: "pwa", since?: revision }`
- Server → client:
  - `{ type: "snapshot", data: Snapshot }` — on connect, on `since` gap, or on client request
  - `{ type: "delta", data: Partial<Snapshot> & { revision } }` — incremental updates
  - `{ type: "pong" }` — keepalive response
- Client sends `{ type: "ping" }` every 25s. If no message in 60s, client forces reconnect and re-hello.
- **Snapshot/delta discipline (from pulse-island):** server tracks a monotonic `revision`. If a client's `since` is more than `MAX_DELTA_GAP` (e.g. 50) revisions behind, server sends a full snapshot instead of a delta. This is what makes a flaky phone WiFi resilient.

---

## 6. Server (host) — `server/`

### 6.1 Tech
- Runtime: Node.js 20+ (LTS).
- Language: TypeScript 5, strict mode.
- HTTP: Node built-in `http` (or `fastify` if richer routing needed — start with built-in to keep deps minimal).
- WebSocket: `ws` library.
- Config: `config/tokenflare.config.json` + env overrides.
- No DB. In-memory authoritative state (single desk, single process). State is rebuilt on restart from hooks; quota is re-fetched.

### 6.2 Config schema (`config/tokenflare.config.json`)
```jsonc
{
  "server": { "host": "0.0.0.0", "port": 7331 },
  "codex": {
    "oauth": null,                       // or { "access_token": "...", "refresh_token": "...", "account_id": "...", "expires_at": 0 }
    "pollSeconds": 300,                  // refresh interval; 0 = no polling
    "fallback": {                        // used when oauth null or fetch fails
      "fiveHour":  { "remaining": 80, "resetAt": "2026-07-24T14:30:00" },
      "weekly":    { "remaining": 91, "resetAt": "2026-07-28T09:00:00" },
      "resets":    { "available": 2, "nextExpiresAt": "2026-07-25T00:00:00" }
    }
  },
  "claude": {
    "fallback": {
      "fiveHour":  { "remaining": 38 },
      "weekly":    { "remaining": 67 }
    }
  },
  "display": { "defaultTheme": "neon-dark", "defaultFont": "jetbrains" }
}
```

### 6.3 REST endpoints
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Serve the PWA (`index.html`) |
| `GET` | `/api/state` | Full `Snapshot` |
| `GET` | `/api/config` | Sanitized server config (no secrets) |
| `POST` | `/api/hooks/:provider` | Hook ingress (`:provider` ∈ `codex\|claude`); body = sanitized event |
| `POST` | `/api/override/task` | Manual task override (status, label); sets `provider:"manual"` |
| `POST` | `/api/quota/mock` | Inject mock quota (for self-test; also used for Claude config values) |
| `GET` | `/ws` (upgrade) | WebSocket |

> Claude quota has no live endpoint in scope, so `POST /api/quota/mock` doubles as the way to set Claude values from the config file at startup and from manual input. There is no separate `/api/quota/claude` route.

### 6.4 Hook ingress + sanitizer
`sanitize.ts` — given a raw hook JSON object:
- **Allow-list** keys: `session_id`, `hook_event_name` (Codex) / `hook_event_name`+`cwd` (Claude), `cwd`. Drop everything else (`prompt`, `transcript_path`, `tool_input`, `tool_output`, `last_assistance_message`, `model`, `tool_use_id`).
- **Hard-reject** if any key/value contains secret markers: `api_key`, `secret`, `password`, `credential`, `bearer`, `authorization`, `token` (except `session_id`). Return 400 without storing.
- Output: `{ provider, taskId: session_id, event: EvidenceKind, cwd, occurredAt }`.

`mapEvent.ts` — provider event name → `EvidenceKind`:
- Codex/Claude `SessionStart` → `started`
- `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd` → `activity`
- `Notification` (Claude) / `PermissionRequest` → `waiting`
- `error`/`abort` signals → `failed`

### 6.5 Reducer (`reducer.ts`)
Pure function: `reduce(prior: TaskState | null, ev: HookEvent, now: number): TaskState`.
- `started` → new `TaskState` (or reset existing).
- `activity` → `status: running`, update `lastActivityAt`. Keep label.
- `waiting` → `status: waiting`.
- `failed` → `status: failed`.
- **Terminal protection:** if `prior.status === "completed" || "failed"`, ignore `activity`/`waiting` for the same `taskId` (a stale late event must not resurrect a terminal task). A new `started` with a *new* `taskId` resets.
- Elapsed time = `now - startedAt`.

### 6.6 Codex wham fetcher (`codexWham.ts`)
Port of new-api `codex_wham_usage.go` to TS (using Node `fetch`):
- `GET https://chatgpt.com/backend-api/wham/usage` with headers `Authorization: Bearer <access_token>`, `chatgpt-account-id: <account_id>`, `originator: codex_cli_rs`, `Accept: application/json`.
- Parse response → primary window (5h) + secondary window (weekly) → `remaining` percent.
- `GET /backend-api/wham/rate-limit-reset-credits` → `reset_credits_available` count + next expiry.
- On 401/403 → refresh OAuth token (POST to OpenAI token endpoint with `refresh_token`), persist back to config, retry once. On second failure → fall back to config fallback values, mark `source: "config"`.
- `codexPoll.ts` runs this on the configured interval; on success/failure folds results into `metrics` and bumps `revision`.

### 6.7 Claude quota (`claudeQuota.ts`)
- No public Anthropic usage endpoint equivalent to wham in scope. **Source = config fallback** (user edits `claude.fallback` in config, or POSTs to `/api/quota/claude`), with `source:"config"`.
- Hook events still drive Claude **task status** normally (the reducer is provider-agnostic).

### 6.8 Jobs
- `codexPoll.ts`: setInterval calling `codexWham.fetchUsage()`. Catches all errors; never crashes the server.

---

## 7. PWA (display) — `pwa/`

### 7.1 Tech & build
- Plain HTML + CSS + **vanilla JavaScript** (ES modules), no framework, **no build step**. The PWA is served as static files by the server and the phone browser imports the `.js` modules directly via `<script type="module">`. This keeps the phone 100% toolchain-free — the user just opens the URL.
- The JS is written as plain ES2020 modules (no TypeScript in the PWA) so nothing needs transpiling. The shared `QuotaMetric` / `Snapshot` *types* live as JSDoc typedef comments + a `.d.ts` for editor help, but are not compiled.
- The only "build" step is `tsc --noEmit` in the **server** dir (run by `npm run build`) for type-checking the TS server; it produces no artifacts.
- **Manifest** forces landscape + fullscreen + standalone; `orientation: "landscape"`, `display: "fullscreen"` (fallback `standalone`), `display_override: ["fullscreen","standalone"]`.

### 7.2 Layout — Hero-left, quota-grid-right
```
+----------------------------------------------------+
|  HERO (40%)              | QUOTA GRID (60%)        |
|                          |                         |
|   o  <status>            |  [Codex 5h]  >>>>> 78%  |
|   <task label>           |  [Codex 7d]  >>>>>> 91% |
|   <cwd>                  |  [Resets]    2 left     |
|   <elapsed>              |  [Claude5h]  >>    38%  |
|                          |  [Claude7d]  >>>>   67% |
|   <clock>   <gear>       |                         |
+----------------------------------------------------+
```
- Hero: large pulsing dot (CSS `box-shadow` glow sized per `quotaClass`/status), status word, task label, elapsed `mm:ss`, live clock, settings gear.
- Quota grid: vertical stack of `QuotaMetric` cards. Each card: label, big `valueText` colored by `quotaClass` with `text-shadow` glow, thin progress bar (gradient + glow) sized to `progressPercent`, small `resetText`.
- Settings overlay (gear): theme select, font select, background animation on/off + style, reduced-motion toggle, server URL. Persisted to `localStorage`.

### 7.3 Theming
- `base.css` defines CSS custom properties: `--bg`, `--fg`, `--state-running`, `--state-waiting`, `--state-failed`, `--state-completed`, `--state-idle`, `--glow`, plus the 4 `--quota-*` colors.
- `themes.css` defines 5 color packs via `[data-theme="nord"]` etc. (port cockpit-tools palettes). The neon-dark default is the no-attribute base.
- Theme applied by setting `document.documentElement.dataset.theme`.

### 7.4 Fonts
- Offer: **JetBrains Mono** (mono, default for the "vibe" terminal feel), **Inter** (clean sans), **system**.
- Loaded via Google Fonts `<link>` with `display=swap` (or self-hosted woff2 if offline). Persisted choice in `localStorage`.

### 7.5 Animated background
- Default: animated **gradient mesh** (multiple radial gradients whose positions drift via CSS `@keyframes`), low opacity, behind content.
- Optional styles: particles (canvas, lightweight), aurora (gradient sweeps). All toggleable; **reduced-motion** (`prefers-reduced-motion` or manual toggle) freezes them.
- Performance: respect `requestAnimationFrame` + visibility; pause when tab hidden. Old phone friendly.

### 7.6 WS client (`client.ts`)
- Connect to `/ws`. On open send `hello`.
- On `snapshot` → replace full render, store `revision`.
- On `delta` → if `delta.revision <= storedRevision` ignore; else shallow-merge fields, re-render changed parts, update `revision`.
- If `delta.revision - storedRevision > MAX_DELTA_GAP` → request `GET /api/state` and treat as snapshot.
- Reconnect with exponential backoff (1s → 2 → 5 → 10, capped 10s). On reconnect always re-hello.

---

## 8. Hook registration (`scripts/`)

Port of pulse-island's `register-hook.ps1` / `register-claude-hook.ps1`, adapted to call our server instead of a named pipe:

- **Codex** (`register-codex-hook.ps1`): edits `%USERPROFILE%\.codex\config.toml`, subscribes `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop` to a shim command that reads stdin JSON and POSTs to `http://127.0.0.1:7331/api/hooks/codex`. `timeout = 1` (fail-open; the hook must never block the agent).
- **Claude** (`register-claude-hook.ps1`): edits `%USERPROFILE%\.claude\settings.json`, subscribes the same events + `Notification` (waiting) to POST to `/api/hooks/claude`.
- The shim: a tiny `node scripts/hook-forward.mjs $Provider` that reads stdin, posts JSON, exits 0 regardless of server response (fail-open). If the server is down, the shim exits 0 immediately.
- **Runtime dependency:** the shim needs `node` on PATH (already required for the server). A pure-PowerShell `hook-forward.ps1` fallback is also provided for users who can't guarantee Node is on PATH at hook time; both do the same thing.
- Uninstall scripts reverse the edits.

**Fail-open contract:** the shim never throws, never blocks >1s, never affects agent behavior if the display server is offline.

---

## 9. Error handling

- **Hook shim** must never block or fail the agent: wrap all I/O in try/catch, hard 1s timeout, always exit 0.
- **wham fetcher** catches network/parse/auth errors, logs, falls back to config values, marks `source:"config"`. Never throws into the poll loop.
- **WS client** never crashes the page: wrap handlers, auto-reconnect, show a small "reconnecting…" badge in the hero without blanking the last known state.
- **Server** starts even with an empty/partial config (all quota falls back to defaults or zeros); never refuses to boot.
- **Secret rejection** returns 400 and logs the *key name* (never the value) that triggered rejection.

---

## 10. Testing strategy

### 10.1 Unit tests (`server/test/*.test.ts`, Node built-in `node:test`)
- `sanitize.test.ts`: allow-list keeps session_id/cwd/event; drops prompt/transcript; rejects objects containing `api_key`/`bearer`/etc.
- `classify.test.ts`: remaining% → class at boundaries 80/40/10; used% converted correctly; count metric thresholds.
- `reducer.test.ts`: started→running; activity updates lastActivity; waiting; failed; **terminal protection** (failed not overwritten by stale activity); elapsed math.
- `metrics.test.ts`: building metrics from wham payload; fallback path; `progressPercent` normalization for remaining vs used.
- `format.test.ts`: reset-time formatting ("resets 14:30"), value text shapes.

### 10.2 End-to-end (`e2e/tests/end-to-end.test.ts`, Playwright)
- Boot server with a test config (wham fetcher mocked/stubbed to a local fixture; no network).
- Playwright loads the PWA from the server URL in a landscape viewport (e.g. 800×360).
- Inject a `started` hook via `POST /api/hooks/codex`, assert hero shows green "RUNNING".
- Inject `waiting`, assert hero turns amber.
- Inject mock quota via `POST /api/quota/mock`, assert the quota card renders the value + correct color class.
- Test snapshot/delta: open a second page after several deltas, assert it resyncs via snapshot.
- Test reconnect: kill+restart WS, assert page resyncs without blanking.
- Test reduced-motion toggles the animation class.

### 10.3 Manual self-test checklist (in root README)
1. `npm install` (workspaces), `npm run build`, `npm test` (unit), `npm run e2e` (Playwright).
2. `npm start` → server on `:7331`.
3. Open `http://<pc-ip>:7331/` on the phone (or desktop browser in landscape) → see neon-dark hero + quota grid.
4. `curl -X POST .../api/quota/mock -d '{...}'` → bars update live.
5. `curl -X POST .../api/hooks/codex -d '{"hook_event_name":"SessionStart","session_id":"t1","cwd":"D:/proj"}'` → hero turns green.
6. Run `scripts/register-codex-hook.ps1`, start a real Codex session, watch the hero track it.

---

## 11. Out of scope / future

- Native APK via Capacitor (PWA is enough for "废弃手机显示屏").
- Claude live-usage proxy (no public equivalent endpoint in scope; config/observed only).
- Multi-task/multi-agent dashboard (single current task this pass).
- Auth on the server (single desk; bind to LAN; future: shared-secret token).
- Persistence of historical quota trends (current snapshot only).

---

## 12. Resolved design decisions (from user review)

1. **Server bind + auth → LAN open, no auth.** Bind `0.0.0.0:7331`; phone opens `http://<pc-ip>:7331/` on the same LAN. Trusted home/office network assumed. (Future: optional shared-secret token if ever exposed beyond the desk.)
2. **Codex OAuth → auto-read `~/.codex/auth.json`.** The server reads Codex OAuth tokens (and the ChatGPT account id) from the existing Codex CLI auth file at startup, and re-reads it as tokens rotate (Codex CLI rotates that file itself; we just watch it). No manual paste. The manual `codex.oauth` config block remains as an *override* for users without Codex CLI installed.
3. **Claude quota → config/observed only.** No live Anthropic call. Claude 5h/7d come from `config/tokenflare.config.json` `claude.fallback` (and updatable via `POST /api/quota/mock`). Claude **task status** still tracks live via hooks (the reducer is provider-agnostic).
4. **Default theme/font → neon-dark + JetBrains Mono.**
5. **Reset count semantics → `reset_credits_available`** from wham `/rate-limit-reset-credits`, i.e. the number of unused rate-limit reset credits. Matches "Codex 剩余重置次数".

---

## 13. Acceptance criteria (definition of done)

- [ ] Repo with `server/`, `pwa/`, `scripts/`, `e2e/`, `config/`, `docs/`.
- [ ] `npm install && npm run build` succeeds with zero TS errors in `server/` (strict). The PWA needs no build.
- [ ] `npm test` — all unit tests green (sanitize, classify, reducer, metrics, format).
- [ ] `npm run e2e` — Playwright e2e green (hook → DOM, snapshot/delta, reconnect, reduced-motion).
- [ ] Server boots with empty config (no crash); serves PWA at `/`.
- [ ] PWA renders landscape hero-left + quota-grid-right; neon-dark default; theme/font/background switchers work and persist.
- [ ] Mock quota + mock hook POSTs update the display live over WS.
- [ ] Codex wham fetcher works when OAuth configured; falls back to config otherwise.
- [ ] Hook registration scripts exist and are reversible; fail-open shim never blocks the agent.
- [ ] README documents quickstart, self-test checklist, and config reference.
