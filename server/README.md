# @tokenflare/server

The host server. Runs on the PC. Responsibilities:

- **Hook ingress** — `POST /api/hooks/:provider` accepts sanitized Codex/Claude hook events.
- **State reducer** — folds events into a task state machine with terminal-protection.
- **Codex quota** — fetches live 5h/7d windows + reset-credit count from OpenAI's `wham` endpoints, auto-reading `~/.codex/auth.json`.
- **REST + WebSocket** — `GET /api/state`, snapshot/delta protocol over `/ws`.
- **PWA host** — serves the static phone display from `../pwa`.

## Run

```bash
npm install        # from repo root
npm start          # = npm run start -w server
npm run dev        # watch mode
npm test           # unit tests
npm run typecheck  # strict tsc --noEmit
```

## Key source map

| File | Role |
|---|---|
| `src/index.ts` | entry: boots store, seeds fallback quota, starts poller, listens |
| `src/server.ts` | HTTP + WS server, REST handlers, static PWA serving |
| `src/config.ts` | config load (file + env), `TOKENFLARE_CONFIG` override |
| `src/state/store.ts` | in-memory authoritative state + revision + broadcast |
| `src/state/reducer.ts` | pure hook→task reducer with terminal-protection |
| `src/hooks/sanitize.ts` | allow-list + secret-reject edge sanitizer |
| `src/hooks/mapEvent.ts` | provider event name → `EvidenceKind` |
| `src/quota/classify.ts` | 4-tier traffic-light classifier + progress normalization |
| `src/quota/metrics.ts` | `QuotaMetric[]` builders (codex 5h/7d/resets, claude 5h/7d) |
| `src/quota/codexWham.ts` | live wham fetcher + 401 retry |
| `src/quota/codexAuth.ts` | reads `~/.codex/auth.json` / config oauth |
| `src/jobs/codexPoll.ts` | periodic wham refresh (fail-open) |

## REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | full `Snapshot` |
| GET | `/api/config` | sanitized config (no secrets) |
| POST | `/api/hooks/:provider` | hook ingress (`codex` \| `claude`) |
| POST | `/api/override/task` | manual task override |
| POST | `/api/quota/mock` | inject mock quota (also sets Claude values) |
| GET | `/ws` | WebSocket |
