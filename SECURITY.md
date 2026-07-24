# Security Policy

## Supported Versions

vibe-display is a single-user, single-desk developer tool. Only the latest
release receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public issue**.

Instead, email **vibe-display@example.com** with a description and, if
possible, a reproduction. We will acknowledge receipt within 48 hours and
aim to issue a fix within 14 days for confirmed vulnerabilities.

## Security Design

vibe-display is built with a **fail-open, content-scrubbing** discipline
inherited from observe-only agent-monitoring patterns:

- **Edge sanitization.** Hook payloads are reduced to an allow-list
  (`session_id`, `hook_event_name`, `cwd`, `transcript_path`) at ingestion.
  Raw prompts, transcripts, tool inputs/outputs, and model identifiers are
  dropped and never travel past the sanitizer.
- **Secret rejection.** Any payload whose key or string value contains a
  secret marker (`api_key`, `secret`, `password`, `credential`, `bearer`,
  `authorization`, `access_token`, `refresh_token`, …) is hard-rejected with
  HTTP 400. The rejection reason logs the *key name* only — never the value.
- **Fail-open hooks.** The hook forwarder shims wrap all I/O in try/catch
  with a hard 1-second timeout and always exit 0. If the display server is
  offline, the agent is completely unaffected.
- **No secrets over the wire to the phone.** The PWA receives only task
  status + quota percentages. OAuth tokens live on the PC host and are read
  locally from `~/.codex/auth.json`; they are never sent to the phone.
- **LAN bind, no auth (by default).** The server binds to `0.0.0.0` for
  convenience on a trusted home/office network. If you expose it beyond a
  trusted LAN, set up a reverse proxy with auth, or bind to `127.0.0.1` and
  tunnel.
