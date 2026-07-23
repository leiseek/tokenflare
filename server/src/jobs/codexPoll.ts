/**
 * Background job: periodically refresh live Codex usage from wham.
 *
 * Catches ALL errors — never lets a fetch failure crash the server. On failure
 * it leaves the existing metrics in place (so a transient network blip doesn't
 * blank the display) and the source flag flips to "config" only if we never
 * had live data.
 */
import { fetchCodexUsage } from "../quota/codexWham.js";
import { buildCodexMetrics } from "../quota/metrics.js";
import { mergeMetrics, sortMetrics } from "../quota/metrics.js";
import { buildClaudeMetrics } from "../quota/metrics.js";
import type { Store } from "../state/store.js";
import type { CodexConfig, ClaudeConfig } from "../config.js";

export interface PollCtx {
  store: Store;
  codex: CodexConfig;
  claude: ClaudeConfig;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Logger. */
  log?: (msg: string) => void;
}

let timer: NodeJS.Timeout | null = null;

/** Run one poll immediately. Safe to call anytime. */
export async function pollOnce(ctx: PollCtx): Promise<void> {
  const log = ctx.log ?? (() => undefined);
  const result = await fetchCodexUsage({
    autoReadAuthJson: ctx.codex.autoReadAuthJson,
    authJsonPath: ctx.codex.authJsonPath,
    configOauth: ctx.codex.oauth,
    fetchImpl: ctx.fetchImpl,
  });

  if (result.ok && result.data) {
    log(`codex wham ok (source=live)`);
    const codexMetrics = buildCodexMetrics(result.data, "live");
    const claudeMetrics = buildClaudeMetrics(ctx.claude.fallback, "config");
    ctx.store.setMetrics(sortMetrics(mergeMetrics(codexMetrics, claudeMetrics)));
    ctx.store.setSources({ codex: "live" });
  } else {
    log(`codex wham failed: ${result.error ?? "unknown"} — using fallback`);
    // Only rebuild from fallback if we don't already have live metrics; otherwise
    // keep the stale-but-recent live numbers (better than overwriting with config).
    const sources = ctx.store.getSources();
    if (sources.codex !== "live") {
      const codexMetrics = buildCodexMetrics(ctx.codex.fallback, "config");
      const claudeMetrics = buildClaudeMetrics(ctx.claude.fallback, "config");
      ctx.store.setMetrics(sortMetrics(mergeMetrics(codexMetrics, claudeMetrics)));
      ctx.store.setSources({ codex: "config" });
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
