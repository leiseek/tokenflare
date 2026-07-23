/**
 * Quota value + reset-time formatters.
 *
 * Port of cockpit-tools formatCodexResetTime and the floating-card value
 * builders. Keeps strings compact for a small phone screen.
 */

/** Format a reset time as a compact relative + absolute hint. */
export function formatResetText(
  resetAt: number | string | null | undefined,
  now: number = Date.now(),
): string | undefined {
  const ms = toEpochMs(resetAt);
  if (ms === null) return undefined;

  const diffMs = ms - now;
  if (diffMs <= 0) return "resets soon";

  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `resets in ${mins}m`;

  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) {
    return remMin > 0 ? `resets in ${hours}h ${remMin}m` : `resets in ${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `resets in ${days}d`;
}

/** Format a percentage value as a display string, e.g. "78%". */
export function formatPercent(remaining: number): string {
  if (!Number.isFinite(remaining)) return "--";
  return `${Math.round(remaining)}%`;
}

/** Format a reset-credit count, e.g. "2 left" / "none left". */
export function formatCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "none left";
  return `${count} left`;
}

/** Convert an epoch-ms number, ISO string, or null to epoch-ms or null. */
export function toEpochMs(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
