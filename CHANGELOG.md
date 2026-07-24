# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/tokenflare/tokenflare/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tokenflare/tokenflare/releases/tag/v1.0.0
