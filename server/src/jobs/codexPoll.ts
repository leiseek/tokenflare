/**
 * Background job: periodically refresh live Codex usage from wham.
 *
 * Catches ALL errors — never lets a fetch failure crash the server. On failure
 * it leaves the existing metrics in place (so a transient network blip doesn't
 * blank the display) and the source flag flips to "config" only if we never
 * had live data.
 */
import { fetchCodexUsage } from "../quota/codexWham.js";
import { loadCodexAccount } from "../quota/codexAuth.js";
import { buildCodexMetrics } from "../quota/metrics.js";
import { sortMetrics } from "../quota/metrics.js";
import type { Store } from "../state/store.js";
import type { CodexConfig } from "../config.js";

export interface PollCtx {
  store: Store;
  codex: CodexConfig;
  /** Proxy URL for the wham fetcher (socks5://... or http://...). null = direct. */
  proxyUrl?: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Logger. */
  log?: (msg: string) => void;
}

let timer: NodeJS.Timeout | null = null;

/**
 * The label shown above the Codex cards: the account email.
 *
 * Not the account holder's name — the display is meant to sit in the open on a
 * desk, and the email identifies which account the quota belongs to without
 * putting someone's real name on the wall. Undefined when no email is
 * available, in which case the display just says "Codex".
 */
function codexAccountLabel(opts: { autoReadAuthJson: boolean; authJsonPath: string | null }): string | undefined {
  return loadCodexAccount(opts).email || undefined;
}

/** Run one poll immediately. Safe to call anytime. */
export async function pollOnce(ctx: PollCtx): Promise<void> {
  const log = ctx.log ?? (() => undefined);

  // Resolve the fetch implementation: explicit injection > proxy > direct.
  let fetchImpl = ctx.fetchImpl;
  if (!fetchImpl && ctx.proxyUrl) {
    const { createProxiedFetch } = await import("../quota/proxyFetch.js");
    fetchImpl = await createProxiedFetch(ctx.proxyUrl);
  }

  const result = await fetchCodexUsage({
    autoReadAuthJson: ctx.codex.autoReadAuthJson,
    authJsonPath: ctx.codex.authJsonPath,
    configOauth: ctx.codex.oauth,
    fetchImpl,
  });

  if (result.ok && result.data) {
    log(`codex wham ok (source=live, ${ctx.proxyUrl ? "via proxy" : "direct"})`);
    const codexMetrics = buildCodexMetrics(result.data, "live", codexAccountLabel(ctx.codex));
    // Keep any existing (e.g. mock-POSTed) claude cards; only replace the codex ones.
    const existing = ctx.store.getMetrics().filter((m) => m.provider !== "codex");
    ctx.store.setMetrics(sortMetrics([...existing, ...codexMetrics]));
    ctx.store.setSources({ codex: "live" });
  } else {
    log(`codex wham failed: ${result.error ?? "unknown"} — no live data`);
    // No live Codex data. We do NOT fabricate placeholder cards from config
    // fallback — the display shows "not connected" for any provider without
    // real data. Drop stale codex cards; leave any mock-POSTed claude cards
    // intact by only removing the codex ones.
    const sources = ctx.store.getSources();
    if (sources.codex !== "live") {
      const remaining = ctx.store.getMetrics().filter((m) => m.provider !== "codex");
      ctx.store.setMetrics(remaining);
      ctx.store.setSources({ codex: "unavailable" });
    }
  }
}

/** Start the periodic poller. Returns a stop() fn. */
export function startCodexPoll(ctx: PollCtx): () => void {
  // Initial poll (fire and forget; errors caught inside).
  void pollOnce(ctx).catch(() => undefined);

  const intervalMs = Math.max(30, ctx.codex.pollSeconds) * 1000;
  timer = setInterval(() => {
    void pollOnce(ctx).catch(() => undefined);
  }, intervalMs);

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
