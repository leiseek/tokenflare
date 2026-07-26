/**
 * Tokenflare server entry point.
 *
 * Boots the in-memory store, starts the Codex wham poller + transcript watcher,
 * and listens on the configured host:port. Prints a startup banner with the LAN
 * URL to open on the phone. Quota cards are only populated from real live data;
 * the display shows "not connected" until then (no fabricated placeholders).
 */
import os from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./state/store.js";
import { createServer } from "./server.js";
import { startCodexPoll } from "./jobs/codexPoll.js";
import { startClaudePoll } from "./jobs/claudePoll.js";
import { startCodexWatcher } from "./jobs/codexWatcher.js";
import { startClaudeWatcher } from "./jobs/claudeWatcher.js";
import { startInstanceSweeper } from "./jobs/sweepInstances.js";

function main(): void {
  const config = loadConfig();
  const store = new Store();

  // Seed with NO quota cards: we only show real data. The display renders an
  // explicit "not connected" state until the first live wham poll succeeds
  // (Codex) or a mock/config POST supplies Claude numbers. Fabricated fallback
  // placeholders were removed so the user never sees fake percentages.
  store.setMetrics([], { silent: true });
  store.setSources({ codex: "unavailable", claude: "unavailable" }, { silent: true });

  // Start the background Codex poller (fail-open; errors are logged, not fatal).
  const stopPoll = startCodexPoll({
    store,
    codex: config.codex,
    proxyUrl: config.proxy?.url ?? null,
    log: (m) => console.log(`[codex] ${m}`),
  });

  // Same for Claude Code: live 5h/7d usage read via the local OAuth credentials.
  const stopClaudePoll = startClaudePoll({
    store,
    claude: config.claude,
    proxyUrl: config.proxy?.url ?? null,
    log: (m) => console.log(`[claude] ${m}`),
  });

  // Age out sessions that stopped reporting, so the rail shows what is actually
  // running instead of accumulating every session since boot.
  const stopSweeper = startInstanceSweeper({ store });

  // Codex desktop-app/CLI session transcript watcher. Reconstructs live state by
  // tailing ~/.codex/sessions (hooks.json is a CLI-only feature, so Desktop
  // sessions would otherwise be invisible). Fail-open; never crashes the server.
  const stopWatch = config.codex.watch
    ? startCodexWatcher({
        store,
        codexHome: process.env.TOKENFLARE_CODEX_HOME,
        intervalMs: config.codex.watchIntervalMs,
        log: (m) => console.log(`[codex] ${m}`),
      })
    : () => undefined;

  // Claude Code transcript watcher. Hooks remain the primary signal, but this
  // keeps a session visible when they are not registered or do not fire — the
  // same safety net Codex already had. Fail-open; never crashes the server.
  const stopClaudeWatch = config.claude.watch
    ? startClaudeWatcher({
        store,
        claudeHome: process.env.TOKENFLARE_CLAUDE_HOME,
        intervalMs: config.claude.watchIntervalMs,
        log: (m) => console.log(`[claude] ${m}`),
      })
    : () => undefined;

  const server = createServer({ config, store });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[error] port ${config.server.port} is already in use.`);
      console.error(`        This usually means a previous Tokenflare instance is still running.`);
      console.error(`        Run \`npm run kill-port\` (or \`npm run restart\`) to free it, then start again.`);
      console.error(`        Or set TOKENFLARE_PORT to a different port, e.g. TOKENFLARE_PORT=7332 npm start`);
    } else {
      console.error(`\n[error] server failed: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(config.server.port, config.server.host, () => {
    const port = config.server.port;
    const lanIps = collectLanIps();
    // Render a consistent banner box. Every content line is padded to the same
    // inner width so the right border `│` always lines up. Inner width = 46.
    const INNER = 46;
    const line = (content: string) => {
      // Visible length: content may contain wide chars (none here, but be safe).
      // Pad with spaces; if content is longer than INNER, it overflows gracefully.
      const pad = Math.max(0, INNER - content.length);
      console.log("│  " + content + " ".repeat(pad) + " │");
    };
    console.log("┌" + "─".repeat(INNER + 2) + "┐");
    line("Tokenflare server is up");
    line("local:   http://127.0.0.1:" + port);
    for (const ip of lanIps.slice(0, 3)) {
      line("phone:   http://" + ip + ":" + port);
    }
    line("ws:      /ws");
    line("codex:   " + (config.codex.autoReadAuthJson ? "auto-read ~/.codex/auth.json" : "config oauth"));
    line("watch:   " + (config.codex.watch ? "tailing ~/.codex/sessions" : "codex watch off"));
    line("         " + (config.claude.watch ? "tailing ~/.claude/projects" : "claude watch off"));
    console.log("└" + "─".repeat(INNER + 2) + "┘");
  });

  // Graceful shutdown.
  const shutdown = (sig: string) => {
    console.log(`\n[${sig}] shutting down...`);
    stopPoll();
    stopClaudePoll();
    stopSweeper();
    stopWatch();
    stopClaudeWatch();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Collect non-internal IPv4 addresses for the banner. */
function collectLanIps(): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

main();
