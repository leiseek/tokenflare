/**
 * Background job: periodically refresh live Claude Code usage.
 *
 * Mirrors codexPoll.ts. Catches ALL errors — a fetch failure never crashes the
 * server, and never fabricates numbers: on failure the Claude cards are dropped
 * and the display says "not connected" rather than showing stale or made-up
 * percentages.
 */
import { fetchClaudeUsage } from "../quota/claudeUsage.js";
import { buildClaudeMetrics, sortMetrics } from "../quota/metrics.js";
import type { Store } from "../state/store.js";
import type { ClaudeConfig } from "../config.js";

export interface ClaudePollCtx {
  store: Store;
  claude: ClaudeConfig;
  /** Proxy URL for the usage fetch (socks5://... or http://...). null = direct. */
  proxyUrl?: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

let timer: NodeJS.Timeout | null = null;

/** Run one poll immediately. Safe to call anytime; never throws. */
export async function pollClaudeOnce(ctx: ClaudePollCtx): Promise<void> {
  const log = ctx.log ?? (() => undefined);

  let fetchImpl = ctx.fetchImpl;
  if (!fetchImpl && ctx.proxyUrl) {
    const { createProxiedFetch } = await import("../quota/proxyFetch.js");
    fetchImpl = await createProxiedFetch(ctx.proxyUrl);
  }

  const result = await fetchClaudeUsage({
    autoReadCredentials: ctx.claude.autoReadCredentials,
    credentialsPath: ctx.claude.credentialsPath,
    configOauth: ctx.claude.oauth,
    fetchImpl,
  });

  const others = ctx.store.getMetrics().filter((m) => m.provider !== "claude");

  if (result.ok && result.data) {
    const cards = buildClaudeMetrics(result.data, "live", accountLabel(ctx.claude, result.plan));
    log(`claude usage ok (source=live, ${cards.length} window(s), ${ctx.proxyUrl ? "via proxy" : "direct"})`);
    ctx.store.setMetrics(sortMetrics([...others, ...cards]));
    ctx.store.setSources({ claude: "live" });
  } else {
    log(`claude usage failed: ${result.error ?? "unknown"} — no live data`);
    // Only clear if we never had live data; a transient blip must not blank a
    // display that was showing real numbers a moment ago.
    if (ctx.store.getSources().claude !== "live") {
      ctx.store.setMetrics(sortMetrics(others));
      ctx.store.setSources({ claude: "unavailable" });
    }
  }
}

/** Display name shown above the Claude cards, e.g. "Claude Code · max". */
function accountLabel(cfg: ClaudeConfig, plan?: string): string {
  const base = cfg.accountName || "Claude Code";
  return plan ? `${base} · ${plan}` : base;
}

/** Start the periodic poller. Returns a stop() fn. */
export function startClaudePoll(ctx: ClaudePollCtx): () => void {
  void pollClaudeOnce(ctx).catch(() => undefined);

  const intervalMs = Math.max(30, ctx.claude.pollSeconds) * 1000;
  timer = setInterval(() => {
    void pollClaudeOnce(ctx).catch(() => undefined);
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
