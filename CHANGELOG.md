# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-07-26

### Added
- **Claude Code transcript watcher** (`server/src/jobs/claudeWatcher.ts`). Claude
  was tracked through `~/.claude/settings.json` hooks and nothing else, which
  left it strictly less resilient than Codex: an unregistered hook, one pointed
  at the wrong server URL, or a surface that does not dispatch made a session
  invisible with no fallback at all. The watcher tails
  `~/.claude/projects/**/<uuid>.jsonl`, which Claude Code writes regardless of
  surface. Disable with `claude.watch: false` or `TOKENFLARE_CLAUDE_WATCH=0`.

  Claude transcripts carry no explicit lifecycle events, so the turn boundary is
  inferred from what the records do carry: `stop_reason` on assistant messages
  (`tool_use` = working, `end_turn`/`stop_sequence` = done) and
  `system`/`turn_duration`. Sub-agent transcripts under `subagents/` are skipped
  — they belong to a session the rail already shows.

  This finally gives `extractClaudeRecord` and the `"claude"` branch of
  `parseTranscriptWindow` a production caller; both existed but were reachable
  only from tests.

### Fixed
- **Both watchers could swallow an update entirely.** The incremental read
  skipped the first line of each window as "possibly partial", which discards
  the whole update whenever a tick picks up exactly one new record — the normal
  case for a session mid-turn, i.e. precisely when the display needs to move.
  The cursor now advances only past the last complete line, so a record caught
  mid-append is re-read on the next tick instead of lost. This affects the Codex
  watcher shipped in 2.0.0, not just the new one.
- **The e2e suite read the developer's real agent sessions.** Only
  `TOKENFLARE_CODEX_HOME` was redirected to a temp dir; once a Claude watcher
  existed, live sessions on the machine appeared in the rail mid-assertion. Both
  watcher homes are isolated now.

### Changed
- Terminology: what the docs called "Codex Desktop" is the unified **ChatGPT
  desktop app** — OpenAI merged the standalone Codex app into it on 2026-07-09,
  and Codex is a mode inside it. Nothing about the integration changed: the MSIX
  package identity is still `OpenAI.Codex` and it still writes
  `~/.codex/sessions/**/rollout-*.jsonl`, verified against a live session.

## [2.0.0] - 2026-07-26

Major because two things change under an existing install: quota cards that
used to show configured numbers now show *not connected* until a real API call
succeeds, and `config/tokenflare.config.json` is no longer tracked by git.

### Upgrading from 1.0.0

**Back up your config before pulling.** The file was tracked in 1.0.0 and is
removed from the index in this release, so `git pull` will delete it from your
working tree:

```bash
cp config/tokenflare.config.json /tmp/tokenflare.config.backup.json
git pull
cp /tmp/tokenflare.config.backup.json config/tokenflare.config.json   # or re-run the installer
```

Your `proxy`, `server` and `display` settings carry over unchanged. The
`codex.fallback` and `claude.fallback` blocks are ignored now — delete them.
Add `claude.autoReadCredentials: true` (or just copy
`config/tokenflare.config.example.json`) to pick up live Claude quota.

**Re-register your hooks** to receive `StopFailure`, which is what drives the
red light:

```bash
./scripts/register-claude-hook.sh     # scripts\register-claude-hook.ps1 on Windows
```

### Fixed
- **Hook events were silently dropped whenever the agent discussed auth.** The
  edge sanitizer scanned string *values* for words like `password`,
  `authorization` and `credential` and rejected the entire payload on a hit —
  including the task's status transition. Since a coding agent writes those
  words constantly, the traffic light would freeze mid-task for no visible
  reason. Secret matching now applies to payload *keys*; free text is checked
  against narrow patterns for actual credentials (`sk-…`, `ghp_…`, JWTs, PEM
  private keys), and a hit drops the narrative only, never the event.
  This was the main cause of "sessions don't reach the display".
- **Codex reset credits read "none left" on a healthy account.** The parser
  preferred `applicable_available_count`, which is 0 unless you are *currently*
  rate-limited. It now reads `available_count` (what the account actually
  holds), and merges the soonest expiry from `/rate-limit-reset-credits` so the
  card can show when the next credit lapses.
- **Sessions never expired.** Nothing removed a `TaskInstance`, so the rail grew
  without bound and every dead session sat frozen at `RUNNING`. A new sweeper
  demotes a silent session to `idle` after 5 minutes and evicts it after an
  hour; reporting again revives it.
- **A finished Codex turn never showed as done.** The watcher rewrote
  `task_complete` to `running` whenever the transcript file was recent, so the
  completion the traffic light exists to show was suppressed.
- **Codex 5h/7d windows could be swapped** when the API omitted
  `limit_window_seconds`: both branches of the name fallback resolved to "5h".
  `primary_window` is the 7-day window; only `secondary_window` is the 5-hour one.
- **Startup read up to 2 MB from every historical transcript.** The watcher now
  parks the cursor at EOF for files untouched in 24h without reading them —
  on a tree with hundreds of sessions this was hundreds of megabytes of I/O.
- **The PWA blocked first paint on Google Fonts.** On a LAN-only or
  region-blocked display the page waited on a DNS timeout before rendering.
  The sheet now loads non-blockingly over the local font stacks.
- Removed the dead offset cache in `hook-forward.mjs`: the agent spawns a fresh
  process per hook event, so the in-process `Map` never had a hit.

### Added
- **Live Claude Code quota.** `claudeAuth.ts` + `claudeUsage.ts` read the local
  Claude Code OAuth token (`~/.claude/.credentials.json`, or the login Keychain
  on macOS) and fetch the same 5h / 7d windows the `/usage` command shows,
  including reset times. This replaces the hand-typed `claude.fallback`
  percentages, which looked like live data but were whatever was last typed
  into the config file. The weekly group reports its worst scoped limit — the
  one that will actually stop you. Note: `/api/oauth/usage` is not a documented
  public API; every field is read defensively and any failure degrades to
  "not connected" rather than to a guess.
- **An unreported window renders as `n/a — not reported`** instead of vanishing.
  A card that silently disappears reads as breakage; this says what happened.
- `StopFailure`, `PermissionDenied`, `Elicitation`, `SubagentStart`,
  `PostCompact` and `PostToolBatch` are now mapped for Claude Code —
  `StopFailure` is what finally drives the red light.
- `sweepInstances.ts` plus unit coverage, and e2e coverage for the sanitizer
  regression and the unreported-window state.

### Layout
- **The quota column clipped its last card on the target viewport.** At 800×360
  the five cards plus two provider headers overflowed and Claude 7d was cut off
  the bottom edge. The column is now one shared vertical budget: sections grow
  in proportion to their card count, cards shrink to fit, and a card that gets
  genuinely short drops its reset hint rather than the number.
- **Session labels and status words were truncated to nonsense** —
  `tokenfla…`, `CLAUDE · RU…` — because the elapsed timer held its own column.
  The timer moved to the sub-line (and hides entirely on a very narrow rail),
  so the project name and status always render in full.
- **Type was sized against `vmin`**, i.e. the short edge, so a 1600×900 wall
  rendered text sized for a phone. Sizes now track viewport height, which is
  the real constraint in landscape.
- **Large displays showed a screenful of dead space.** Quota cards stretch to
  fill the column instead of huddling at the top, a short progress update is
  vertically centred rather than pinned under the header, and the quota column
  finally has the same panel surface as the other two.
- An unreported window's card is now compact and drops its (meaningless) bar.
- Provider/phase labels sit with the progress text they describe instead of
  spread across the panel like a second header.
- `e2e/shot.mjs` renders the display at three viewports for design review and
  for the README captures; two e2e tests now assert no clipping and no
  truncation so these cannot regress silently.

### Security
- **Cross-origin writes are no longer allowed.** The server listens on
  `0.0.0.0` and advertised `Access-Control-Allow-Origin: *` for every method,
  so any page the phone visited could drive the display via
  `/api/hooks/*`, `/api/override/task` or `/api/quota/mock`. Reads stay open;
  mutating routes no longer emit CORS headers, so browsers block them. The
  hook shim is unaffected (it isn't a browser and does no preflight).
- `GET /api/config` no longer exposes the config fallback block to LAN clients.
- `config/tokenflare.config.json` is now gitignored and generated from
  `config/tokenflare.config.example.json`, so a machine-specific proxy setting
  is not committed to the repository.

### Changed
- **No fabricated quota placeholders.** Cards are only built from real data:
  live Codex wham numbers, live Claude usage, or an explicit
  `POST /api/quota/mock` payload. The config `codex.fallback`/`claude.fallback`
  blocks are no longer seeded or used to fill gaps — a provider with no data
  shows an explicit *not connected* note instead of fake percentages.
- **5h card only when the API returns it.** ChatGPT does not return a 5-hour
  window for every plan. Rather than omitting the card (which read as
  breakage), it renders as *n/a — not reported*; it fills in automatically once
  the API reports the window again.
- **Account name headers above each provider's quota cards.** Codex decodes the
  account `name`/`email` (e.g. "Example User") from the `id_token` in
  `~/.codex/auth.json`; Claude shows "Claude Code" (configurable via
  `claude.accountName`). Each provider's cards are grouped under its label.

### Added
- `decodeAccountFromIdToken` / `loadCodexAccount` in `codexAuth.ts` — extract the
  account identity from the OAuth id_token JWT for the display header.
- **Codex transcript watcher** (`server/src/jobs/codexWatcher.ts`): tails
  `~/.codex/sessions/**/*.jsonl` to reconstruct live Codex state. Codex Desktop
  (and the VSCode extension) do not dispatch `hooks.json` command hooks — that's
  a CLI-only feature — so Desktop sessions were previously invisible. The watcher
  derives status from `task_started`/`task_complete` records and extracts visible
  assistant text, writing through the same store path as hooks. Configurable via
  `codex.watch` / `codex.watchIntervalMs` / `TOKENFLARE_CODEX_CODEX_HOME`. First
  sight reads only the tail + recent files, so historical sessions never flood
  the display on startup.
- **Multi-instance state model**: each tool/session is an independent
  `TaskInstance` keyed `${provider}:${sessionId}`, so concurrent Codex + Claude
  (or several sessions) are tracked side by side instead of clobbering a single
  global slot. The PWA left rail now renders one card per session (each with its
  own project name + status + elapsed); tapping a card pins the progress panel.
- **Shared transcript parser** (`server/src/hooks/transcriptParse.ts`): single
  source of truth for extracting visible assistant text from Codex/Claude
  transcripts, used by both the hook forwarder and the watcher.
- **Incremental hook narrative**: `hook-forward.mjs` now keeps a per-transcript
  byte offset and reads only the newly-appended tail, firing on every event
  (including non-tool ones) so plain assistant replies are no longer dropped.

### Changed
- Codex hook registration now installs the **5 events Codex CLI actually
  supports** (`SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop`);
  `PermissionRequest`/`SessionEnd` (Claude-only) are no longer registered.
- The progress panel renders **only the selected instance's latest** narrative
  entry (previously showed up to 8 historical entries per provider).
- PWA layout reworked: session list rail + active-instance detail bar + progress
  + quota grid, with a portrait-mode horizontal session scroller.
- `config/tokenflare.config.json` `proxy` reset to `null` (was a leftover
  machine-specific SOCKS proxy).

### Fixed
- Codex sessions now surface regardless of launch surface (Desktop/CLI/subagent)
  via the transcript watcher.
- Claude narrative no longer misses non-tool assistant replies or suffers
  duplicate/resend of older text.
- Concurrent providers no longer overwrite each other's task/label/status.

## [1.0.0] - 2026-07-24

First public release. Turn a decommissioned Android phone into an always-on
status indicator for Codex and Claude Code.

### Added
- **Server** (`server/`, Node.js + TypeScript): hook ingress with edge
  content-sanitization (allow-list + secret-reject), terminal-protected task
  state reducer, live Codex quota fetcher (`wham` usage + rate-limit reset
  credits, auto-reads `~/.codex/auth.json` with OAuth refresh-on-401),
  4-tier traffic-light classifier with the remaining/used footgun fixed,
  snapshot/delta WebSocket protocol with reconnect resync, serves the PWA.
- **PWA** (`pwa/`, plain HTML/CSS/JS, no build step): landscape fullscreen
  display — hero traffic-light left, quota-cards grid right. Neon-dark
  default theme, 5 color packs (Nord, Tokyo Night, Catppuccin, Gruvbox,
  Synthwave), font selection (JetBrains Mono / Inter / system), animated
  gradient-mesh / aurora background with reduced-motion toggle.
- **Hook registration** (`scripts/`): PowerShell (Windows) + bash (macOS/Linux)
  scripts for Codex CLI and Claude Code, with fail-open forwarder shims (node
  + PowerShell + bash/curl variants). `.gitattributes` forces `.sh` to LF.
- **Testing**: 50 unit tests (Node's built-in test runner, `node:test`) covering
  sanitize, classify, reducer, metrics, format, store, codexWham. 9 Playwright
  e2e tests covering hook → server → WebSocket → rendered DOM, including a
  regression test that the compiled build serves the PWA.
- **Config** (`config/tokenflare.config.json`): all quota has sensible
  fallbacks so the display works immediately with zero credentials.
- **Privacy**: hooks keep only an allow-list (`session_id`, `hook_event_name`,
  `cwd`, `transcript_path`); payloads containing secret markers are
  hard-rejected with 400. Raw prompts/transcripts never leave the agent host.

### Fixed
- Compiled build (`server/dist`) now correctly resolves the PWA directory
  (previously returned "file not found" due to a relative-path bug that only
  manifested under the compiled artifact, not under tsx).
- `EADDRINUSE` now produces a friendly error + exit 1 instead of a raw stack
  trace.
- Codex `config.toml` command strings correctly escape inner double quotes.
- Claude hook unregister no longer leaves empty `"Event": []` keys behind.

[Unreleased]: https://github.com/leiseek/tokenflare/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/leiseek/tokenflare/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/leiseek/tokenflare/releases/tag/v1.0.0
