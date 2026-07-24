# Contributing to vibe-display

Thanks for your interest in improving vibe-display! This is a small project,
so the process is lightweight.

## Quick contribution guide

1. **Open an issue first** for anything beyond a typo or obvious bug fix — a
   short design discussion saves everyone time.
2. Fork the repo and create a branch off `main`.
3. Make your change. Match the surrounding code style (TypeScript strict for
   the server; plain ES modules for the PWA; idiomatic PowerShell/bash for
   scripts).
4. **Add or update tests** for any behavior change:
   - Pure logic → unit test in `server/test/`
   - End-to-end behavior → Playwright test in `e2e/tests/`
5. Make sure everything is green:
   ```bash
   npm run typecheck   # strict tsc, zero errors
   npm test            # 50 unit tests
   npm run test:e2e    # 9 Playwright e2e tests
   ```
6. Commit with a clear message. We follow [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
7. Open a pull request referencing the issue.

## Project layout

```
server/   Node.js + TypeScript host (hooks, quota, state, REST + WS)
pwa/      Plain HTML/CSS/JS phone display (no build step)
scripts/  Hook registration + fail-open forwarder shims (Win PS1 + mac sh)
e2e/      Playwright end-to-end tests
config/   Default config
docs/     Design spec
```

## Development

```bash
npm install
npm run dev          # server with watch mode
npm test             # unit tests
npm run test:e2e     # e2e (needs: npx playwright install chromium)
```

## Design principles (please respect these)

- **Observe-only / fail-open.** Nothing vibe-display does should ever be able
  to block, change, or break the agent. Hooks must always exit 0 within 1s.
- **Content-scrubbing at the edge.** Raw prompts, transcripts, and credentials
  never travel past the sanitizer. If you add a new hook field, it must be on
  the allow-list *deliberately*.
- **Snapshot/delta, never event replay.** The phone resyncs via a full
  snapshot on reconnect — don't introduce a dependency on replaying missed
  events.
- **No build step for the PWA.** The phone display is plain JS served as
  static files. Don't add a bundler.

## Licensing

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
