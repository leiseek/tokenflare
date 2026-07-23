/**
 * Quota metric builders.
 *
 * Turns raw quota data (from the wham fetcher, the config fallback, or a mock
 * POST) into the normalized QuotaMetric[] the PWA renders. This is where the
 * 5h/7d/resets windows get assembled — mirroring cockpit-tools'
 * buildCodexAccountPresentation + getCodexQuotaWindows.
 */
import type { QuotaMetric, QuotaSource } from "../state/types.js";
import { classify, progressForDisplay } from "./classify.js";
import { formatCount, formatPercent, formatResetText, toEpochMs } from "./format.js";

/** Codex raw shape produced by the wham fetcher / config fallback / mock. */
export interface CodexQuotaInput {
  fiveHour?: { remaining?: number; resetAt?: number | string | null };
  weekly?: { remaining?: number; resetAt?: number | string | null };
  resets?: { available?: number; nextExpiresAt?: number | string | null };
}

/** Claude raw shape (config-only). */
export interface ClaudeQuotaInput {
  fiveHour?: { remaining?: number };
  weekly?: { remaining?: number };
}

/** Build Codex metrics from input. Source is whatever the caller asserts. */
export function buildCodexMetrics(input: CodexQuotaInput, source: QuotaSource): QuotaMetric[] {
  const out: QuotaMetric[] = [];
  const now = Date.now();

  const fh = input.fiveHour;
  if (fh) {
    const remaining = clampNum(fh.remaining, 0, 100);
    out.push({
      key: "codex_5h",
      label: "Codex 5h",
      provider: "codex",
      window: "5h",
      semantics: "remaining",
      percentage: remaining,
      quotaClass: classify(remaining, "remaining"),
      valueText: formatPercent(remaining),
      progressPercent: progressForDisplay(remaining, "remaining"),
      resetText: formatResetText(fh.resetAt, now),
      nextResetAt: toEpochMs(fh.resetAt),
      source,
    });
  }

  const wk = input.weekly;
  if (wk) {
    const remaining = clampNum(wk.remaining, 0, 100);
    out.push({
      key: "codex_7d",
      label: "Codex 7d",
      provider: "codex",
      window: "7d",
      semantics: "remaining",
      percentage: remaining,
      quotaClass: classify(remaining, "remaining"),
      valueText: formatPercent(remaining),
      progressPercent: progressForDisplay(remaining, "remaining"),
      resetText: formatResetText(wk.resetAt, now),
      nextResetAt: toEpochMs(wk.resetAt),
      source,
    });
  }

  const rs = input.resets;
  if (rs) {
    const available = Math.max(0, Math.floor(clampNum(rs.available, 0, 999)));
    out.push({
      key: "codex_resets",
      label: "Resets",
      provider: "codex",
      window: "resets",
      semantics: "count",
      percentage: available,
      quotaClass: classify(available, "count"),
      valueText: formatCount(available),
      progressPercent: progressForDisplay(available, "count"),
      resetText: formatResetText(rs.nextExpiresAt, now),
      nextResetAt: toEpochMs(rs.nextExpiresAt),
      source,
    });
  }

  return out;
}

/** Build Claude metrics from input (config-only). */
export function buildClaudeMetrics(input: ClaudeQuotaInput, source: QuotaSource): QuotaMetric[] {
  const out: QuotaMetric[] = [];

  const fh = input.fiveHour;
  if (fh) {
    const remaining = clampNum(fh.remaining, 0, 100);
    out.push({
      key: "claude_5h",
      label: "Claude 5h",
      provider: "claude",
      window: "5h",
      semantics: "remaining",
      percentage: remaining,
      quotaClass: classify(remaining, "remaining"),
      valueText: formatPercent(remaining),
      progressPercent: progressForDisplay(remaining, "remaining"),
      source,
    });
  }

  const wk = input.weekly;
  if (wk) {
    const remaining = clampNum(wk.remaining, 0, 100);
    out.push({
      key: "claude_7d",
      label: "Claude 7d",
      provider: "claude",
      window: "7d",
      semantics: "remaining",
      percentage: remaining,
      quotaClass: classify(remaining, "remaining"),
      valueText: formatPercent(remaining),
      progressPercent: progressForDisplay(remaining, "remaining"),
      source,
    });
  }

  return out;
}

/** Merge two metric arrays by key; later wins. */
export function mergeMetrics(a: QuotaMetric[], b: QuotaMetric[]): QuotaMetric[] {
  const map = new Map<string, QuotaMetric>();
  for (const m of a) map.set(m.key, m);
  for (const m of b) map.set(m.key, m);
  return [...map.values()];
}

/** Stable display order: codex 5h, codex 7d, resets, claude 5h, claude 7d. */
export function sortMetrics(metrics: QuotaMetric[]): QuotaMetric[] {
  const order = ["codex_5h", "codex_7d", "codex_resets", "claude_5h", "claude_7d"];
  return [...metrics].sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

function clampNum(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
