/**
 * Vibe Display server entry point.
 *
 * Boots the in-memory store, seeds it with fallback quota (so the display is
 * never blank), starts the Codex wham poller, and listens on the configured
 * host:port. Prints a startup banner with the LAN URL to open on the phone.
 */
import os from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./state/store.js";
import { createServer } from "./server.js";
import { buildCodexMetrics, buildClaudeMetrics, mergeMetrics, sortMetrics } from "./quota/metrics.js";
import { startCodexPoll } from "./jobs/codexPoll.js";

function main(): void {
  const config = loadConfig();
  const store = new Store();

  // Seed metrics from config fallback so the display is populated immediately
  // (before the first wham poll completes).
  const seedMetrics = sortMetrics(
    mergeMetrics(
      buildCodexMetrics(config.codex.fallback, "config"),
      buildClaudeMetrics(config.claude.fallback, "config"),
    ),
  );
  store.setMetrics(seedMetrics, { silent: true });
  store.setSources({ codex: "config", claude: "config" }, { silent: true });

  // Start the background Codex poller (fail-open; errors are logged, not fatal).
  const stopPoll = startCodexPoll({
    store,
    codex: config.codex,
    claude: config.claude,
    log: (m) => console.log(`[codex] ${m}`),
  });

  const server = createServer({ config, store });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[error] port ${config.server.port} is already in use.`);
      console.error(`        Set VIBE_PORT (or config.server.port) to a free port, or stop the other process.`);
      console.error(`        Example: VIBE_PORT=7332 npm start`);
    } else {
      console.error(`\n[error] server failed: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(config.server.port, config.server.host, () => {
    const port = config.server.port;
    const host = config.server.host;
    const lanIps = collectLanIps();
    console.log("┌──────────────────────────────────────────────┐");
    console.log("│  Vibe Display server is up                    │");
    console.log(`│  local:   http://127.0.0.1:${port}              `);
    for (const ip of lanIps.slice(0, 3)) {
      console.log(`│  phone:   http://${ip}:${port}`.padEnd(48) + "│");
    }
    console.log("│  ws:      /ws                                 │");
    console.log("│  codex:   " + (config.codex.autoReadAuthJson ? "auto-read ~/.codex/auth.json" : "config oauth").padEnd(34) + " │");
    console.log("└──────────────────────────────────────────────┘");
  });

  // Graceful shutdown.
  const shutdown = (sig: string) => {
    console.log(`\n[${sig}] shutting down...`);
    stopPoll();
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
